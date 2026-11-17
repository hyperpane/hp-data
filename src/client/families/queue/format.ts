// A message as the list and its pane show it: a time, a one-line preview,
// pretty JSON when the value parses, and whether it matches a filter.

import type { Message } from '../../../shared/queue.ts';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 14:03:07.120, or with the date when it isn't today. */
export function clock(at: number | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export const fullTime = (at: number | null | undefined) => (at ? new Date(at).toISOString().replace('T', ' ').replace('Z', ' UTC') : '');

/** The value on one line, cut. */
export function preview(m: Message, max = 300): string {
  if (m.binary) return `(binary, base64) ${m.value.slice(0, 80)}`;
  const one = m.value.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) : one;
}

/** The value as indented JSON, when it is JSON. */
export function pretty(value: string): { json: true; value: unknown; text: string } | { json: false; text: string } {
  const t = value.trim();
  if (!t || !'{["'.includes(t[0])) return { json: false, text: value };
  try {
    const v = JSON.parse(t) as unknown;
    return { json: true, value: v, text: JSON.stringify(v, null, 2) };
  } catch {
    return { json: false, text: value };
  }
}

export function matches(m: Message, filter: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  if (m.value.toLowerCase().includes(f)) return true;
  if (m.key?.toLowerCase().includes(f)) return true;
  if (m.offset && m.offset === filter) return true;
  return Object.entries(m.headers ?? {}).some(([k, v]) => k.toLowerCase().includes(f) || v.toLowerCase().includes(f));
}

/** Where a message is: partition:offset, or its id. */
export const placeOf = (m: Message) => (m.partition !== undefined ? `${m.partition}:${m.offset}` : m.id);
