// Kafka's client, as the driver uses it: kafkajs made from a connection's
// values (brokers, TLS, SASL), its own logging sent to the plugin's log at
// warnings and worse, one admin and one producer opened when first needed,
// and kafkajs's errors said for the user.

import { randomUUID } from 'node:crypto';
import { PluginError } from '@hyperpane/sdk/server';
import { type Admin, Kafka, type KafkaConfig, type Producer, Partitioners, type SASLOptions, logLevel } from 'kafkajs';
import type { Values } from '../../../shared/kinds.ts';
import { type Cluster, makeCluster } from './kafka-fetch.ts';
import { hasOwnTls, tlsOf } from '../../net/tls.ts';

/** The prefix of the groups Data makes to look at a topic (deleted after). */
export const GROUP_PREFIX = 'hyperpane-data-';

export const throwawayGroup = () => `${GROUP_PREFIX}${randomUUID()}`;

export function brokersOf(v: unknown): string[] {
  const list = String(v ?? '')
    .split(/[\s,]+/)
    .map((b) =>
      b
        .trim()
        .replace(/^[a-z+]+:\/\//i, '')
        .replace(/\/+$/, ''),
    )
    .filter(Boolean);
  if (!list.length) throw new PluginError('Give at least one broker, as host:port.');
  return list.map((b) => (/:\d+$/.test(b) ? b : `${b}:9092`));
}

export function saslOf(v: Values): SASLOptions | undefined {
  const m = String(v.sasl ?? 'none');
  if (m === 'none' || !m) return undefined;
  const username = String(v.user ?? '');
  const password = String(v.password ?? '');
  if (!username) throw new PluginError('SASL needs a user.');
  if (m === 'plain') return { mechanism: 'plain', username, password };
  if (m === 'scram-sha-256') return { mechanism: 'scram-sha-256', username, password };
  if (m === 'scram-sha-512') return { mechanism: 'scram-sha-512', username, password };
  throw new PluginError(`SASL ${m} isn’t one Data speaks: use PLAIN or SCRAM.`);
}

function configOf(v: Values, log: (line: string) => void): KafkaConfig {
  return {
    clientId: 'hyperpane-data',
    brokers: brokersOf(v.brokers),
    ssl: v.ssl === true || v.ssl === 'true' ? (hasOwnTls(v) ? { ...tlsOf(v), rejectUnauthorized: !!tlsOf(v).ca } : { rejectUnauthorized: false }) : undefined,
    sasl: saslOf(v),
    connectionTimeout: 5000,
    requestTimeout: 15000,
    retry: { retries: 2, initialRetryTime: 200, maxRetryTime: 2000 },
    logLevel: logLevel.WARN,
    logCreator: () => (e) => {
      if (e.level > logLevel.WARN) return;
      const { message, error } = e.log as { message?: string; error?: string };
      log(`kafka ${e.level === logLevel.ERROR ? 'error' : 'warning'} (${e.namespace}): ${message ?? ''}${error ? `: ${error}` : ''}`);
    },
  };
}

/** A kafkajs error as a sentence. */
export function said(e: unknown): Error {
  if (e instanceof PluginError) return e;
  const err = e as { name?: string; message?: string; type?: string; originalError?: unknown; retriable?: boolean; broker?: string };
  if (err?.name === 'KafkaJSNumberOfRetriesExceeded' && err.originalError) return said(err.originalError);
  const msg = String(err?.message ?? e);
  const where = /(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH)\s+([^\s]+)/.exec(msg)?.[1];
  if (/ECONNREFUSED/.test(msg)) return new PluginError(`Nothing answers at ${where ?? 'the brokers'}: is Kafka running, on that port?`);
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return new PluginError(`There’s no host ${where ?? 'by that name'}: check the brokers.`);
  if (err?.name === 'KafkaJSConnectionTimeout' || /Connection timeout|ETIMEDOUT/.test(msg))
    return new PluginError('The brokers didn’t answer in time: a firewall, a VPN, or the wrong address? (Or TLS where it isn’t.)');
  if (err?.name === 'KafkaJSSASLAuthenticationError') return new PluginError(`Signing in failed: ${msg.replace(/^SASL \S+ authentication failed: /i, '')}`);
  if (/Closed connection|Connection error/i.test(msg) && /ssl|tls/i.test(msg))
    return new PluginError('The brokers closed the connection: TLS where it isn’t, or the other way round?');
  const types: Record<string, string> = {
    TOPIC_ALREADY_EXISTS: 'There’s a topic by that name already.',
    UNKNOWN_TOPIC_OR_PARTITION: 'There’s no such topic (or partition).',
    INVALID_REPLICATION_FACTOR: 'The replication factor is more than there are brokers.',
    INVALID_PARTITIONS: 'The number of partitions isn’t valid.',
    INVALID_TOPIC_EXCEPTION: 'That isn’t a valid topic name: letters, digits, dots, underscores and dashes.',
    TOPIC_AUTHORIZATION_FAILED: 'Not allowed: the user may not do that with this topic.',
    GROUP_AUTHORIZATION_FAILED: 'Not allowed: the user may not use consumer groups.',
    CLUSTER_AUTHORIZATION_FAILED: 'Not allowed: the user may not do that on this cluster.',
    TOPIC_DELETION_DISABLED: 'The brokers don’t allow deleting topics (delete.topic.enable is false).',
    POLICY_VIOLATION: 'The brokers’ policy doesn’t allow that.',
    NON_EMPTY_GROUP: 'The group has members still.',
  };
  if (err?.type && types[err.type]) return new PluginError(types[err.type]);
  return new PluginError(msg.replace(/^KafkaJS\w*: /, ''));
}

/** kafkajs, an admin and a producer, opened as they're first used. */
export class Client {
  readonly kafka: Kafka;
  #admin: Promise<Admin> | null = null;
  #producer: Promise<Producer> | null = null;
  #cluster: Promise<Cluster | null> | null = null;
  readonly #consumers = new Set<{ disconnect(): Promise<void> }>();

  constructor(v: Values, log: (line: string) => void) {
    this.kafka = new Kafka(configOf(v, log));
  }

  admin(): Promise<Admin> {
    if (!this.#admin) {
      const a = this.kafka.admin();
      this.#admin = a.connect().then(
        () => a,
        (e) => {
          this.#admin = null;
          throw said(e);
        },
      );
    }
    return this.#admin;
  }

  producer(): Promise<Producer> {
    if (!this.#producer) {
      const p = this.kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner, allowAutoTopicCreation: false });
      this.#producer = p.connect().then(
        () => p,
        (e) => {
          this.#producer = null;
          throw said(e);
        },
      );
    }
    return this.#producer;
  }

  /** A cluster to fetch from without a group, or null (kafka-fetch.ts). */
  cluster(): Promise<Cluster | null> {
    if (!this.#cluster) {
      const c = makeCluster(this.kafka);
      this.#cluster = c
        ? c.connect().then(
            () => c,
            (e) => {
              this.#cluster = null;
              throw said(e);
            },
          )
        : Promise.resolve(null);
    }
    return this.#cluster;
  }

  /** Runs with the admin; its errors said. */
  async with<T>(fn: (a: Admin) => Promise<T>): Promise<T> {
    const a = await this.admin();
    try {
      return await fn(a);
    } catch (e) {
      throw said(e);
    }
  }

  /** Keeps a consumer to disconnect on close. */
  track(c: { disconnect(): Promise<void> }): () => void {
    this.#consumers.add(c);
    return () => this.#consumers.delete(c);
  }

  async close() {
    const all: Promise<unknown>[] = [...this.#consumers].map((c) => c.disconnect());
    if (this.#admin) all.push(this.#admin.then((a) => a.disconnect()));
    if (this.#producer) all.push(this.#producer.then((p) => p.disconnect()));
    if (this.#cluster) all.push(this.#cluster.then((c) => c?.disconnect()));
    this.#admin = this.#producer = null;
    this.#cluster = null;
    this.#consumers.clear();
    await Promise.allSettled(all);
  }
}
