// Reading a Kafka topic without disturbing anyone. A peek is a range per
// partition (the oldest, the newest, or from an offset), fetched from the
// leaders by offset (kafka-fetch.ts), or else by a consumer in a group of
// its own (hyperpane-data-<uuid>) that commits nothing, seeks, collects,
// then leaves and deletes its group. A tail is such a consumer, started at
// each partition's end, sending what comes after.

import type { Consumer, KafkaMessage } from 'kafkajs';
import { PluginError } from '@hyperpane/sdk/server';
import type { Ref } from '../../../shared/types.ts';
import type { Message, PeekRequest } from '../../../shared/queue.ts';
import { type Client, said, throwawayGroup } from './kafka-client.ts';
import { fetchRanges } from './kafka-fetch.ts';
import { decode, headerText, nameOf, newest, oldest } from './text.ts';

/** How long a peek waits in all, and for more once messages stopped. */
const PEEK_TIMEOUT = 20_000;
const QUIET = 2_500;

export interface Range {
  partition: number;
  start: bigint;
  /** One past the last offset to read. */
  end: bigint;
}

export interface Watermarks {
  partition: number;
  low: string;
  high: string;
}

/** Where a peek starts and ends in each partition. */
export function rangesFor(r: Pick<PeekRequest, 'from' | 'partition' | 'offset' | 'limit'>, marks: Watermarks[]): Range[] {
  const n = BigInt(Math.max(1, r.limit));
  const parts = r.partition === undefined || r.partition === null ? marks : marks.filter((m) => m.partition === r.partition);
  if (r.partition !== undefined && r.partition !== null && !parts.length)
    throw new PluginError(`There’s no partition ${r.partition}: the topic has ${marks.length}.`);
  const out: Range[] = [];
  for (const m of parts) {
    const low = BigInt(m.low);
    const high = BigInt(m.high);
    let start: bigint;
    let end: bigint;
    if (r.from === 'offset') {
      let at: bigint;
      try {
        at = BigInt(String(r.offset ?? '').trim() || '0');
      } catch {
        throw new PluginError(`“${r.offset}” isn’t an offset: give a whole number.`);
      }
      start = at < low ? low : at > high ? high : at;
      end = start + n > high ? high : start + n;
    } else if (r.from === 'earliest') {
      start = low;
      end = low + n > high ? high : low + n;
    } else {
      start = high - n < low ? low : high - n;
      end = high;
    }
    if (start < end) out.push({ partition: m.partition, start, end });
  }
  return out;
}

export function toMessage(partition: number, m: KafkaMessage): Message {
  const v = decode(m.value);
  const k = m.key ? decode(m.key) : null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(m.headers ?? {})) headers[name] = headerText(value);
  const meta: Record<string, string | number | boolean> = { size: v.size };
  if (m.value === null) meta.tombstone = true;
  if (v.cut) meta.truncated = true;
  if (k?.binary) meta.binaryKey = true;
  return {
    id: `${partition}:${m.offset}`,
    key: k ? k.text : null,
    value: v.text,
    binary: v.binary || undefined,
    headers,
    at: Number(m.timestamp) || null,
    partition,
    offset: m.offset,
    meta,
  };
}

async function watermarks(c: Client, topic: string): Promise<Watermarks[]> {
  const offs = await c.with((a) => a.fetchTopicOffsets(topic));
  return offs.map((o) => ({ partition: o.partition, low: o.low, high: o.high })).sort((a, b) => a.partition - b.partition);
}

/** A consumer in a group of its own, gone (with its group) when `end` is called. */
async function throwaway(c: Client, topic: string) {
  const groupId = throwawayGroup();
  const consumer: Consumer = c.kafka.consumer({
    groupId,
    allowAutoTopicCreation: false,
    sessionTimeout: 10_000,
    rebalanceTimeout: 10_000,
    heartbeatInterval: 3_000,
    maxWaitTimeInMs: 500,
    retry: { retries: 2 },
  });
  const untrack = c.track(consumer);
  const end = async () => {
    untrack();
    await consumer.disconnect().catch(() => {});
    await c.with((a) => a.deleteGroups([groupId])).catch(() => {});
  };
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: [topic], fromBeginning: false });
  } catch (e) {
    await end();
    throw said(e);
  }
  return { consumer, end };
}

export async function peek(c: Client, r: PeekRequest, signal: AbortSignal): Promise<Message[]> {
  const topic = nameOf(r.ref, 'topic');
  const marks = await watermarks(c, topic);
  const ranges = rangesFor(r, marks);
  if (!ranges.length) return [];
  let got: Message[] | null = null;
  const cluster = await c.cluster().catch(() => null);
  if (cluster) {
    try {
      got = await fetchRanges(cluster, topic, ranges, toMessage, signal);
    } catch (e) {
      // A leader moved, or the private part changed: the slow way.
      await cluster.refreshMetadata().catch(() => {});
      if (e instanceof PluginError) throw e;
    }
  }
  got ??= await withGroup(c, topic, marks, ranges, signal);
  return r.from === 'latest' || !r.from ? newest(got, r.limit) : oldest(got, r.limit);
}

/** A peek by a consumer in a group of its own: seeks, collects, leaves. */
export async function withGroup(c: Client, topic: string, marks: Watermarks[], ranges: Range[], signal: AbortSignal): Promise<Message[]> {
  const byPartition = new Map(ranges.map((x) => [x.partition, { ...x, done: false }]));
  const got: Message[] = [];
  const { consumer, end } = await throwaway(c, topic);
  let finish!: () => void;
  let fail!: (e: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    finish = res;
    fail = rej;
  });
  let quiet: NodeJS.Timeout | undefined;
  const overall = setTimeout(() => finish(), PEEK_TIMEOUT);
  const abort = () => finish();
  signal.addEventListener('abort', abort, { once: true });
  const offCrash = consumer.on(consumer.events.CRASH, (e) => fail(e.payload.error));
  try {
    await consumer.run({
      autoCommit: false,
      eachBatch: async ({ batch }) => {
        const range = byPartition.get(batch.partition);
        if (!range || range.done) return;
        for (const m of batch.messages) {
          const o = BigInt(m.offset);
          if (o < range.start) continue;
          if (o >= range.end) break;
          got.push(toMessage(batch.partition, m));
        }
        // The batch's last offset, control records (not messages) counted.
        const last = batch.isEmpty() ? BigInt(batch.highWatermark) - 1n : BigInt(batch.lastOffset());
        if (last + 1n >= range.end) range.done = true;
        if ([...byPartition.values()].every((x) => x.done)) finish();
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(), QUIET);
      },
    });
    for (const x of ranges) consumer.seek({ topic, partition: x.partition, offset: String(x.start) });
    const others = marks.map((m) => m.partition).filter((p) => !byPartition.has(p));
    if (others.length) consumer.pause([{ topic, partitions: others }]);
    await finished;
  } catch (e) {
    throw said(e);
  } finally {
    clearTimeout(overall);
    clearTimeout(quiet);
    signal.removeEventListener('abort', abort);
    offCrash();
    await end();
  }
  return got;
}

export async function tail(c: Client, ref: Ref, emit: (m: Message) => boolean, signal: AbortSignal): Promise<void> {
  const topic = nameOf(ref, 'topic');
  const marks = await watermarks(c, topic);
  if (signal.aborted) return;
  const { consumer, end } = await throwaway(c, topic);
  let fail!: (e: unknown) => void;
  const crashed = new Promise<never>((_, rej) => (fail = rej));
  const offCrash = consumer.on(consumer.events.CRASH, (e) => fail(e.payload.error));
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ partition, message }) => {
        if (stop.signal.aborted) return;
        if (!emit(toMessage(partition, message))) stop.abort();
      },
    });
    // From each partition's end as it was asked, not as it is once the
    // group has joined: what's sent meanwhile is shown too.
    for (const m of marks) consumer.seek({ topic, partition: m.partition, offset: m.high });
    await Promise.race([
      new Promise<void>((res) => (stop.signal.aborted ? res() : stop.signal.addEventListener('abort', () => res(), { once: true }))),
      crashed,
    ]);
  } catch (e) {
    throw said(e);
  } finally {
    signal.removeEventListener('abort', onAbort);
    offCrash();
    await end();
  }
}
