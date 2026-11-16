// RabbitMQ, through its management HTTP API only (no AMQP): virtual hosts,
// their queues and exchanges as a tree, a queue's figures, consumers and
// bindings, messages looked at (taken and put back, so they come back
// marked redelivered), published through the default exchange or another,
// and queues made, emptied and deleted. A tail isn't offered: the API can't
// see new messages without taking them.

import { PluginError } from '@hyperpane/sdk/server';
import type { Ref, TreeNode } from '../../../shared/types.ts';
import type { Message, PeekRequest } from '../../../shared/queue.ts';
import { basic, json, statusError } from '../../net/http.ts';
import type { Factory, QueueDriver } from '../types.ts';
import { bytes } from './format.ts';
import { tlsOf } from '../../net/tls.ts';

interface RabbitQueue {
  name: string;
  vhost: string;
  type?: string;
  durable?: boolean;
  auto_delete?: boolean;
  exclusive?: boolean;
  state?: string;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
  memory?: number;
  message_bytes?: number;
  arguments?: Record<string, unknown>;
  message_stats?: { publish_details?: { rate: number }; deliver_get_details?: { rate: number } };
  consumer_details?: {
    consumer_tag: string;
    prefetch_count?: number;
    ack_required?: boolean;
    channel_details?: { connection_name?: string; peer_host?: string; user?: string };
  }[];
}

interface RabbitGot {
  payload: string;
  payload_encoding: 'string' | 'base64';
  payload_bytes: number;
  redelivered: boolean;
  exchange: string;
  routing_key: string;
  message_count: number;
  properties:
    | {
        headers?: Record<string, unknown>;
        timestamp?: number;
        message_id?: string;
        content_type?: string;
        correlation_id?: string;
        delivery_mode?: number;
        type?: string;
        app_id?: string;
        [k: string]: unknown;
      }
    | [];
}

const MAX_PEEK = 1000;

export function toMessage(m: RabbitGot, i: number): Message {
  const props = Array.isArray(m.properties) ? {} : m.properties;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(props.headers ?? {})) headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
  const meta: Record<string, string | number | boolean> = {
    redelivered: m.redelivered,
    exchange: m.exchange || '(default)',
    'routing key': m.routing_key,
    size: m.payload_bytes,
  };
  for (const k of ['message_id', 'content_type', 'correlation_id', 'type', 'app_id', 'delivery_mode'] as const)
    if (props[k] !== undefined) meta[k.replace('_', ' ')] = props[k] as string | number;
  if (m.payload_encoding === 'string' && m.payload_bytes > Buffer.byteLength(m.payload)) meta.truncated = true;
  return {
    id: `${i}:${props.message_id ?? ''}`,
    key: m.routing_key || null,
    value: m.payload,
    binary: m.payload_encoding === 'base64' || undefined,
    headers,
    at: typeof props.timestamp === 'number' ? props.timestamp * 1000 : null,
    meta,
  };
}

export const rabbitmq: Factory = (ctx) => {
  const v = ctx.values;
  const base =
    String(v.url ?? '')
      .trim()
      .replace(/\/+$/, '') || 'http://localhost:15672';
  const tlsOpts = tlsOf(v);
  if (!/^https?:\/\//.test(base)) throw new PluginError('The management URL starts with http:// or https://, like http://localhost:15672.');
  const auth = basic(v.user ?? 'guest', v.password ?? '');
  const only = String(v.vhost ?? '').trim();
  const e = encodeURIComponent;

  const api = <T>(path: string, o: { method?: string; body?: unknown; signal?: AbortSignal } = {}) =>
    json<T>(
      {
        url: `${base}/api${path}`,
        method: o.method ?? 'GET',
        headers: o.method === 'DELETE' ? { ...auth, accept: '*/*' } : auth,
        json: o.body,
        signal: o.signal,
        timeout: 20_000,
        tls: tlsOpts,
      },
      (status, text) =>
        status === 404
          ? `${statusError(status, text).replace(/^404: /, '')}: it isn’t there (deleted, or the wrong virtual host?).`
          : statusError(status, text),
    );

  const where = (ref: Ref) => {
    const vhost = ref.vhost ?? (only || '/');
    if (ref.queue) return { vhost, kind: 'queue' as const, name: ref.queue, path: `/queues/${e(vhost)}/${e(ref.queue)}` };
    if (ref.exchange !== undefined)
      return { vhost, kind: 'exchange' as const, name: ref.exchange, path: `/exchanges/${e(vhost)}/${e(ref.exchange || 'amq.default')}` };
    throw new PluginError('Which queue or exchange? None was named.');
  };

  const driver: QueueDriver = {
    family: 'queue',

    async info() {
      const o = await api<{ rabbitmq_version?: string; product_name?: string; product_version?: string; cluster_name?: string; erlang_version?: string }>(
        '/overview',
      );
      return {
        version: `${o.product_name ?? 'RabbitMQ'} ${o.product_version ?? o.rabbitmq_version ?? ''}`.trim(),
        detail: [o.cluster_name ? `cluster ${o.cluster_name}` : null, `user ${v.user || 'guest'}`, o.erlang_version ? `Erlang ${o.erlang_version}` : null]
          .filter(Boolean)
          .join(', '),
      };
    },

    async children(path) {
      if (!path.length) {
        const vhosts = only ? [{ name: only }] : await api<{ name: string; messages?: number }[]>('/vhosts');
        return vhosts.map((h): TreeNode => ({ name: h.name, type: 'database', expand: vhosts.length === 1 }));
      }
      const [vhost, folder] = path;
      if (path.length === 1)
        return [
          { name: 'Queues', type: 'folder', expand: true },
          { name: 'Exchanges', type: 'folder' },
        ];
      if (folder === 'Queues' && path.length === 2) {
        const qs = await api<RabbitQueue[]>(`/queues/${e(vhost)}?columns=name,messages_ready,messages,type`);
        return qs
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (q): TreeNode => ({
              name: q.name,
              type: 'queue',
              leaf: true,
              detail: (q.messages_ready ?? 0).toLocaleString('en-US'),
              open: { tab: 'queue', ref: { vhost, queue: q.name }, title: q.name },
            }),
          );
      }
      if (folder === 'Exchanges' && path.length === 2) {
        const xs = await api<{ name: string; type: string; internal?: boolean }[]>(`/exchanges/${e(vhost)}?columns=name,type,internal`);
        return xs
          .filter((x) => x.name !== '')
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (x): TreeNode => ({
              name: x.name,
              type: 'exchange',
              leaf: true,
              detail: x.type,
              open: { tab: 'queue', ref: { vhost, exchange: x.name }, title: x.name },
            }),
          );
      }
      return [];
    },

    async describe(ref) {
      const w = where(ref);
      if (w.kind === 'queue') {
        const q = await api<RabbitQueue>(w.path);
        const binds = await api<{ source: string; destination: string; routing_key: string }[]>(`${w.path}/bindings`);
        const rate = (x?: { rate: number }) => (x ? `${x.rate.toFixed(1)}/s` : '0/s');
        const stats = [
          { label: 'Ready', value: (q.messages_ready ?? 0).toLocaleString('en-US') },
          { label: 'Unacked', value: (q.messages_unacknowledged ?? 0).toLocaleString('en-US') },
          { label: 'Total', value: (q.messages ?? 0).toLocaleString('en-US') },
          { label: 'Consumers', value: String(q.consumers ?? 0) },
          { label: 'Publish', value: rate(q.message_stats?.publish_details) },
          { label: 'Deliver', value: rate(q.message_stats?.deliver_get_details) },
          {
            label: 'Type',
            value: `${q.type ?? 'classic'}${q.durable ? ', durable' : ''}${q.auto_delete ? ', auto-delete' : ''}${q.exclusive ? ', exclusive' : ''}`,
          },
        ];
        if (q.state) stats.push({ label: 'State', value: q.state });
        if (q.message_bytes !== undefined) stats.push({ label: 'Bytes', value: bytes(q.message_bytes) });
        return {
          stats,
          consumers: (q.consumer_details ?? []).map((c) => ({
            name: c.consumer_tag,
            detail: [
              c.channel_details?.connection_name ?? c.channel_details?.peer_host,
              c.prefetch_count ? `prefetch ${c.prefetch_count}` : null,
              c.ack_required ? 'manual ack' : 'auto ack',
            ]
              .filter(Boolean)
              .join(', '),
          })),
          bindings: binds.map((b) => ({ source: b.source || '(default)', destination: b.destination, routingKey: b.routing_key })),
        };
      }
      const x = await api<{
        name: string;
        type: string;
        durable: boolean;
        auto_delete: boolean;
        internal: boolean;
        message_stats?: { publish_in_details?: { rate: number } };
      }>(w.path);
      const binds = await api<{ source: string; destination: string; destination_type: string; routing_key: string }[]>(
        `/exchanges/${e(w.vhost)}/${e(w.name || 'amq.default')}/bindings/source`,
      );
      return {
        stats: [
          { label: 'Type', value: x.type },
          { label: 'Durable', value: x.durable ? 'yes' : 'no' },
          { label: 'Bindings', value: String(binds.length) },
          { label: 'Publish in', value: `${(x.message_stats?.publish_in_details?.rate ?? 0).toFixed(1)}/s` },
          ...(x.internal ? [{ label: 'Internal', value: 'yes' }] : []),
        ],
        bindings: binds.map((b) => ({
          source: b.source || '(default)',
          destination: `${b.destination}${b.destination_type === 'exchange' ? ' (exchange)' : ''}`,
          routingKey: b.routing_key,
        })),
      };
    },

    async peek(r: PeekRequest, signal) {
      const w = where(r.ref);
      if (w.kind !== 'queue') throw new PluginError('An exchange keeps no messages: open a queue bound to it to see them.');
      const got = await api<RabbitGot[]>(`${w.path}/get`, {
        method: 'POST',
        body: { count: Math.max(1, Math.min(MAX_PEEK, r.limit)), ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 1024 * 1024 },
        signal,
      });
      return got.map(toMessage);
    },

    async tail() {
      throw new PluginError('RabbitMQ can’t show new messages without taking them off the queue: use Refresh to look again.');
    },

    async publish(r) {
      const w = where(r.ref);
      const exchange = w.kind === 'exchange' ? w.name || 'amq.default' : 'amq.default';
      const routing = w.kind === 'queue' ? w.name : (r.routingKey ?? r.key ?? '');
      const properties: Record<string, unknown> = { delivery_mode: 2 };
      if (r.headers && Object.keys(r.headers).length) properties.headers = r.headers;
      if (r.key && w.kind === 'queue') properties.message_id = r.key;
      const res = await api<{ routed: boolean }>(`/exchanges/${e(w.vhost)}/${e(exchange)}/publish`, {
        method: 'POST',
        body: { properties, routing_key: routing, payload: r.value, payload_encoding: 'string' },
      });
      if (!res?.routed)
        throw new PluginError(
          w.kind === 'queue'
            ? 'It wasn’t routed: the queue may have gone.'
            : `Nothing is bound to “${w.name}” for routing key “${routing}”: the message was dropped.`,
        );
      return {};
    },

    async create(ref, o) {
      const w = where(ref);
      const type = (o as { type?: string }).type;
      await api(w.path, {
        method: 'PUT',
        body:
          w.kind === 'queue'
            ? { durable: o.durable ?? true, auto_delete: false, arguments: {} }
            : { type: type || 'direct', durable: o.durable ?? true, auto_delete: false, internal: false, arguments: {} },
      });
    },

    async remove(ref) {
      await api(where(ref).path, { method: 'DELETE' });
    },

    async purge(ref) {
      const w = where(ref);
      if (w.kind !== 'queue') throw new PluginError('Only a queue can be purged.');
      await api(`${w.path}/contents`, { method: 'DELETE' });
    },

    async close() {},
  };
  return driver;
};
