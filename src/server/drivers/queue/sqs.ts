// Amazon SQS (and what speaks it: LocalStack, ElasticMQ), with its JSON
// protocol signed by hand (aws/sigv4.ts): queues as a tree with how many
// messages each has, a queue's attributes, messages looked at with a
// visibility timeout of 0 (so they stay where they are, though each look
// counts as a receive), published (with a group and a deduplication id for
// FIFO queues), and queues made, emptied and deleted. Live polls every few
// seconds and sends messages it hasn't seen.

import { randomUUID } from 'node:crypto';
import { PluginError } from '@hyperpane/sdk/server';
import type { Ref, TreeNode } from '../../../shared/types.ts';
import type { Message, PeekRequest } from '../../../shared/queue.ts';
import { awsError, type Credentials, credentialsOf, sha256hex, sign } from '../../aws/sigv4.ts';
import { request } from '../../net/http.ts';
import type { Factory, QueueDriver } from '../types.ts';
import { duration } from './format.ts';
import { nameOf, pause } from './text.ts';

export interface SqsMessage {
  MessageId: string;
  ReceiptHandle?: string;
  Body: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<string, { DataType: string; StringValue?: string; BinaryValue?: string }>;
}

const MAX_PEEK = 1000;
/** Receives in a row that bring nothing new before a peek stops. */
const DRY = 3;
const TAIL_EVERY = 2_000;
const SEEN_MAX = 50_000;

export function toMessage(m: SqsMessage): Message {
  const a = m.Attributes ?? {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.MessageAttributes ?? {})) headers[k] = v.StringValue ?? (v.BinaryValue ? `base64:${v.BinaryValue}` : '');
  const meta: Record<string, string | number | boolean> = {};
  if (a.ApproximateReceiveCount) meta['receive count'] = Number(a.ApproximateReceiveCount);
  if (a.ApproximateFirstReceiveTimestamp) meta['first received'] = new Date(Number(a.ApproximateFirstReceiveTimestamp)).toISOString();
  if (a.SenderId) meta.sender = a.SenderId;
  if (a.MessageDeduplicationId) meta['deduplication id'] = a.MessageDeduplicationId;
  if (a.SequenceNumber) meta.sequence = a.SequenceNumber;
  if (a.DeadLetterQueueSourceArn) meta['dead-lettered from'] = a.DeadLetterQueueSourceArn;
  return { id: m.MessageId, key: a.MessageGroupId ?? null, value: m.Body, headers, at: a.SentTimestamp ? Number(a.SentTimestamp) : null, meta };
}

/** The queue's name from its URL (the last part of the path). */
export const queueName = (url: string) => decodeURIComponent(url.replace(/\/+$/, '').split('/').pop() ?? url);

export const sqs: Factory = (ctx) => {
  const v = ctx.values;
  const region = String(v.region ?? '').trim() || 'us-east-1';
  const endpoint = (String(v.endpoint ?? '').trim() || `https://sqs.${region}.amazonaws.com`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(endpoint)) throw new PluginError('The endpoint starts with http:// or https://, like http://localhost:4566.');
  let creds: Promise<Credentials> | null = null;
  const urls = new Map<string, string>();

  async function call<T = Record<string, unknown>>(op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    creds ??= credentialsOf(v).catch((e) => {
      creds = null;
      throw e;
    });
    const credentials = await creds;
    const text = JSON.stringify(body);
    const url = new URL(`${endpoint}/`);
    const headers = sign({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${op}` },
      payloadHash: sha256hex(text),
      region,
      service: 'sqs',
      credentials,
    });
    const res = await request({ method: 'POST', url, headers, body: text, signal, timeout: 30_000 });
    const out = res.body.toString('utf8');
    if (res.status >= 400) throw new PluginError(awsError(res.status, out));
    try {
      return (out ? JSON.parse(out) : {}) as T;
    } catch {
      throw new PluginError(`${endpoint} doesn’t speak SQS’s JSON protocol (it said: ${out.slice(0, 120)}).`);
    }
  }

  async function urlOf(ref: Ref): Promise<string> {
    const name = nameOf(ref, 'queue');
    let u = urls.get(name);
    if (!u) {
      u = (await call<{ QueueUrl: string }>('GetQueueUrl', { QueueName: name })).QueueUrl;
      urls.set(name, u);
    }
    return u;
  }

  async function listUrls(): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await call<{ QueueUrls?: string[]; NextToken?: string }>('ListQueues', { MaxResults: 1000, ...(token ? { NextToken: token } : {}) });
      out.push(...(r.QueueUrls ?? []));
      token = r.NextToken;
    } while (token && out.length < 10_000);
    return out;
  }

  const receive = (QueueUrl: string, max: number, wait: number, signal?: AbortSignal) =>
    call<{ Messages?: SqsMessage[] }>(
      'ReceiveMessage',
      {
        QueueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(10, max)),
        VisibilityTimeout: 0,
        WaitTimeSeconds: wait,
        AttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      },
      signal,
    ).then((r) => r.Messages ?? []);

  /** Receives until `limit` different messages, or nothing new comes. */
  async function collect(QueueUrl: string, limit: number, seen: Set<string>, signal: AbortSignal): Promise<SqsMessage[]> {
    const out: SqsMessage[] = [];
    let dry = 0;
    while (out.length < limit && dry < DRY && !signal.aborted) {
      const got = await receive(QueueUrl, limit - out.length, 0, signal);
      const fresh = got.filter((m) => !seen.has(m.MessageId));
      for (const m of fresh) seen.add(m.MessageId);
      out.push(...fresh);
      dry = fresh.length ? 0 : dry + 1;
    }
    return out;
  }

  const driver: QueueDriver = {
    family: 'queue',

    async info() {
      await call('ListQueues', { MaxResults: 1 });
      const local = !/amazonaws\.com$/.test(new URL(endpoint).hostname);
      return { version: local ? `SQS at ${new URL(endpoint).host}` : 'Amazon SQS', detail: region };
    },

    async children(path) {
      if (path.length) return [];
      const list = await listUrls();
      for (const u of list) urls.set(queueName(u), u);
      const counts = new Map<string, string>();
      // A few at a time: one GetQueueAttributes a queue.
      for (let i = 0; i < Math.min(list.length, 500); i += 8) {
        await Promise.all(
          list.slice(i, i + 8).map(async (u) => {
            const r = await call<{ Attributes?: Record<string, string> }>('GetQueueAttributes', {
              QueueUrl: u,
              AttributeNames: ['ApproximateNumberOfMessages'],
            }).catch(() => null);
            const n = r?.Attributes?.ApproximateNumberOfMessages;
            if (n !== undefined) counts.set(u, Number(n).toLocaleString('en-US'));
          }),
        );
      }
      return list
        .map((u): TreeNode => {
          const name = queueName(u);
          return { name, type: 'queue', leaf: true, detail: counts.get(u), open: { tab: 'queue', ref: { queue: name }, title: name } };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async describe(ref) {
      const QueueUrl = await urlOf(ref);
      const a = (await call<{ Attributes?: Record<string, string> }>('GetQueueAttributes', { QueueUrl, AttributeNames: ['All'] })).Attributes ?? {};
      const n = (k: string) => Number(a[k] ?? 0).toLocaleString('en-US');
      const stats = [
        { label: 'Available', value: n('ApproximateNumberOfMessages') },
        { label: 'In flight', value: n('ApproximateNumberOfMessagesNotVisible') },
        { label: 'Delayed', value: n('ApproximateNumberOfMessagesDelayed') },
        { label: 'Type', value: a.FifoQueue === 'true' ? `FIFO${a.ContentBasedDeduplication === 'true' ? ', content dedup' : ''}` : 'Standard' },
      ];
      if (a.VisibilityTimeout) stats.push({ label: 'Visibility', value: duration(Number(a.VisibilityTimeout) * 1000) });
      if (a.MessageRetentionPeriod) stats.push({ label: 'Retention', value: duration(Number(a.MessageRetentionPeriod) * 1000) });
      if (a.DelaySeconds && a.DelaySeconds !== '0') stats.push({ label: 'Delay', value: duration(Number(a.DelaySeconds) * 1000) });
      if (a.RedrivePolicy) {
        try {
          const p = JSON.parse(a.RedrivePolicy) as { deadLetterTargetArn?: string; maxReceiveCount?: number };
          stats.push({ label: 'Dead letters', value: `${queueName((p.deadLetterTargetArn ?? '').replace(/:/g, '/'))} after ${p.maxReceiveCount}` });
        } catch {}
      }
      if (a.CreatedTimestamp) stats.push({ label: 'Created', value: new Date(Number(a.CreatedTimestamp) * 1000).toISOString().slice(0, 16).replace('T', ' ') });
      if (a.QueueArn) stats.push({ label: 'ARN', value: a.QueueArn });
      return { stats };
    },

    async peek(r: PeekRequest, signal) {
      const QueueUrl = await urlOf(r.ref);
      const got = await collect(QueueUrl, Math.max(1, Math.min(MAX_PEEK, r.limit)), new Set(), signal);
      return got.map(toMessage).sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
    },

    async tail(ref, emit, signal) {
      const QueueUrl = await urlOf(ref);
      const seen = new Set<string>();
      // What's there already isn't new.
      await collect(QueueUrl, MAX_PEEK, seen, signal);
      while (!signal.aborted) {
        const got = await receive(QueueUrl, 10, seen.size ? 0 : 10, signal).catch((e) => {
          if (signal.aborted) return [];
          throw e;
        });
        let fresh = 0;
        for (const m of got) {
          if (seen.has(m.MessageId)) continue;
          seen.add(m.MessageId);
          fresh++;
          if (!emit(toMessage(m))) return;
        }
        if (seen.size > SEEN_MAX) seen.clear();
        if (!fresh) await pause(TAIL_EVERY, signal);
      }
    },

    async publish(r) {
      const QueueUrl = await urlOf(r.ref);
      const fifo = QueueUrl.endsWith('.fifo');
      const headers = { ...(r.headers ?? {}) };
      const dedup = headers.MessageDeduplicationId;
      delete headers.MessageDeduplicationId;
      const body: Record<string, unknown> = { QueueUrl, MessageBody: r.value };
      if (Object.keys(headers).length)
        body.MessageAttributes = Object.fromEntries(Object.entries(headers).map(([k, x]) => [k, { DataType: 'String', StringValue: x }]));
      if (fifo) {
        body.MessageGroupId = r.key || 'default';
        body.MessageDeduplicationId = dedup || randomUUID();
      } else if (r.key) throw new PluginError('Only a FIFO queue has message groups: leave the group empty.');
      if (!r.value) throw new PluginError('SQS doesn’t take an empty message: give it a body.');
      const res = await call<{ MessageId?: string }>('SendMessage', body);
      return { id: res.MessageId };
    },

    async create(ref) {
      const name = nameOf(ref, 'queue');
      const attrs: Record<string, string> = name.endsWith('.fifo') ? { FifoQueue: 'true' } : {};
      const r = await call<{ QueueUrl: string }>('CreateQueue', { QueueName: name, Attributes: attrs });
      urls.set(name, r.QueueUrl);
    },

    async remove(ref) {
      const QueueUrl = await urlOf(ref);
      await call('DeleteQueue', { QueueUrl });
      urls.delete(nameOf(ref, 'queue'));
    },

    async purge(ref) {
      await call('PurgeQueue', { QueueUrl: await urlOf(ref) });
    },

    async close() {},
  };
  return driver;
};
