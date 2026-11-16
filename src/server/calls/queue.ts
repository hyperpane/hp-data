// The queue family's calls: a topic's or a queue's figures, messages
// looked at, published, and topics or queues made, emptied and deleted;
// and the subscription qTail, new messages as they come. Each names its
// connection (`id`) and what it's about (`ref`); changes are refused on a
// connection marked read only.

import { PluginError } from '@hyperpane/sdk/server';
import type { Message, PeekRequest, PublishRequest } from '../../shared/queue.ts';
import { refOf } from '../drivers/queue/text.ts';
import { type Deps, type Group, idOf, int, projectOf, writable } from './context.ts';

/** How often a running tail tells the session it's in use. */
const TOUCH_EVERY = 60_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const optInt = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : int(v, 0, 0, 1_000_000));

export function headersOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k.trim()) out[k.trim()] = x == null ? '' : String(x);
  return Object.keys(out).length ? out : undefined;
}

export function peekOf(req: Record<string, unknown>): PeekRequest {
  const from = req.from === 'earliest' || req.from === 'offset' ? req.from : 'latest';
  return { ref: refOf(req.ref), limit: int(req.limit, 50, 1, 1000), from, partition: optInt(req.partition), offset: str(req.offset) };
}

export function publishOf(req: Record<string, unknown>): PublishRequest {
  if (typeof req.value !== 'string') throw new PluginError('Give the message a value.');
  return {
    ref: refOf(req.ref),
    key: str(req.key),
    value: req.value,
    headers: headersOf(req.headers),
    partition: optInt(req.partition),
    routingKey: str(req.routingKey),
  };
}

export function queue(d: Deps): Group {
  const { sessions } = d;
  const driver = (req: { id?: unknown; project?: unknown }) => sessions.family(idOf(req), 'queue', projectOf(req));
  const change = async (req: { id?: unknown; project?: unknown }) => {
    await writable(d, idOf(req));
    return driver(req);
  };
  return {
    calls: {
      qDescribe: async (req) => (await driver(req)).describe(refOf(req.ref)),
      qPeek: async (req, ctx) => (await driver(req)).peek(peekOf(req), ctx.signal),
      qPublish: async (req) => (await change(req)).publish(publishOf(req)),
      qCreate: async (req) => {
        const o = {
          partitions: optInt(req.partitions),
          replication: optInt(req.replication),
          durable: req.durable === undefined ? undefined : !!req.durable,
          type: str(req.type),
        };
        await (await change(req)).create(refOf(req.ref), o);
        return null;
      },
      qRemove: async (req) => {
        await (await change(req)).remove(refOf(req.ref));
        return null;
      },
      qPurge: async (req) => {
        await (await change(req)).purge(refOf(req.ref));
        return null;
      },
    },
    subscriptions: {
      /** New messages from now, one event each, until it's cancelled. */
      qTail: async (req, out) => {
        const id = idOf(req);
        const q = await driver(req);
        const keep = setInterval(() => sessions.touch(id), TOUCH_EVERY);
        try {
          await q.tail(refOf(req.ref), (m: Message) => out.emit(m), out.signal);
        } finally {
          clearInterval(keep);
        }
      },
    },
  };
}
