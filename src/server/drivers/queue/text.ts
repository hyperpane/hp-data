// What the queue drivers share: bytes as a message's text (or base64 when
// they aren't UTF-8), a value capped to what a window should get, the
// newest of several lists, and a ref's names checked.

import { PluginError } from '@hyperpane/sdk/server';
import type { Ref } from '../../../shared/types.ts';
import type { Message } from '../../../shared/queue.ts';

/** The most of a value sent to a window: past this it's cut, and says so. */
export const MAX_VALUE = 1024 * 1024;

const strict = new TextDecoder('utf-8', { fatal: true });

/** Bytes as text, or as base64 when they aren't UTF-8 (or have control
 * characters a text wouldn't). */
export function decode(b: Uint8Array | null | undefined): { text: string; binary: boolean; size: number; cut: boolean } {
  if (!b) return { text: '', binary: false, size: 0, cut: false };
  const size = b.byteLength;
  const cut = size > MAX_VALUE;
  const part = cut ? b.subarray(0, MAX_VALUE) : b;
  try {
    const text = strict.decode(part, { stream: cut });
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(text)) return { text, binary: false, size, cut };
  } catch {}
  return { text: Buffer.from(part).toString('base64'), binary: true, size, cut };
}

/** A header's value as text: kafkajs gives a Buffer, a string, or a list. */
export function headerText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(headerText).join(', ');
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) {
    const d = decode(v);
    return d.binary ? `base64:${d.text}` : d.text;
  }
  return String(v);
}

/** The newest `limit` messages of all those given, oldest first (by time,
 * then offset). */
export function newest(all: Message[], limit: number): Message[] {
  return sortByTime(all).slice(-limit);
}

/** The oldest `limit` messages, oldest first. */
export function oldest(all: Message[], limit: number): Message[] {
  return sortByTime(all).slice(0, limit);
}

export function sortByTime(all: Message[]): Message[] {
  return [...all].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.partition ?? 0) - (b.partition ?? 0) || cmpOffset(a.offset, b.offset));
}

/** Offsets are 64-bit: compared as big integers. */
export function cmpOffset(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A ref from a request: only its string fields. */
export function refOf(v: unknown): Ref {
  const out: Ref = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of ['topic', 'queue', 'exchange', 'vhost'] as const) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'string') out[k] = x;
  }
  return out;
}

/** The topic or queue a ref names, or a sentence saying it's missing. */
export function nameOf(ref: Ref, what: 'topic' | 'queue'): string {
  const n = ref[what];
  if (!n) throw new PluginError(`Which ${what}? None was named.`);
  return n;
}

/** Waits, or stops early (resolving) when the signal aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
