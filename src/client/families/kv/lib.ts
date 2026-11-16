// What the kv family's views share: a tab's calls (its connection, its
// project, its database put in), each type's color and short name, TTLs
// in a few characters, and keys grouped into a tree by `:`.

import type { KeyEntry, KeyType } from '../../../shared/kv.ts';
import type { Api } from '../../lib/api.ts';
import type { TabProps } from '../../app/tabs.ts';

export interface Calls {
  call<T = unknown>(op: string, payload?: Record<string, unknown>): Promise<T>;
  db: string | undefined;
}

/** A tab's calls: `{ id, project, db }` and the rest. */
export function callsOf(p: Pick<TabProps, 'api' | 'connection' | 'project'>, db: string | undefined): Calls {
  return { db, call: (op, payload = {}) => p.api.call(op, { id: p.connection.id, project: p.project ?? undefined, db, ...payload }) };
}

/** Runs a change: its error as a toast, true when it went through. */
export async function attempt(api: Api, fn: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await fn();
    if (done) api.toast(done);
    return true;
  } catch (e) {
    api.fail(e);
    return false;
  }
}

export const TYPE_INFO: Record<KeyType, { label: string; color: string }> = {
  string: { label: 'STR', color: '#3fb950' },
  hash: { label: 'HASH', color: '#58a6ff' },
  list: { label: 'LIST', color: '#d29922' },
  set: { label: 'SET', color: '#bc8cff' },
  zset: { label: 'ZSET', color: '#f778ba' },
  stream: { label: 'STREAM', color: '#39c5cf' },
  json: { label: 'JSON', color: '#e3b341' },
  other: { label: '?', color: '#8b949e' },
};

export const TYPE_NAMES: Record<KeyType, string> = {
  string: 'String',
  hash: 'Hash',
  list: 'List',
  set: 'Set',
  zset: 'Sorted set',
  stream: 'Stream',
  json: 'JSON',
  other: 'Other',
};

/** Seconds left as "45 s", "12 min", "3 h", "9 d"; '' for none. */
export function ttlText(ttl: number): string {
  if (ttl < 0) return '';
  if (ttl < 60) return `${ttl} s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)} min`;
  if (ttl < 86400 * 2) return `${Math.round(ttl / 3600)} h`;
  return `${Math.round(ttl / 86400)} d`;
}

/** A TTL as typed: "90", "90s", "15m", "2h", "7d" as seconds; null when it
 * isn't one. */
export function parseTtl(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|d)?\s*$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * ({ s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400 }[(m[2] ?? 's').toLowerCase()] ?? 1);
  return n > 0 ? Math.round(n) : null;
}

export interface KeyFolder {
  kind: 'folder';
  /** The path to it, `user:` for `user:1`. */
  prefix: string;
  name: string;
  /** Keys under it, however deep. */
  count: number;
  children: KeyNode[];
}
export type KeyNode = KeyFolder | { kind: 'key'; name: string; entry: KeyEntry };

/** Keys as a tree by a separator: `user:1:name` under `user` › `1`.
 * Folders first, each level by name. */
export function keyTree(keys: KeyEntry[], sep = ':'): KeyNode[] {
  const root: KeyFolder = { kind: 'folder', prefix: '', name: '', count: 0, children: [] };
  const folders = new Map<string, KeyFolder>([['', root]]);
  for (const e of keys) {
    const parts = sep ? e.key.split(sep) : [e.key];
    let parent = root;
    root.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join(sep) + sep;
      let f = folders.get(prefix);
      if (!f) {
        f = { kind: 'folder', prefix, name: parts[i], count: 0, children: [] };
        folders.set(prefix, f);
        parent.children.push(f);
      }
      f.count++;
      parent = f;
    }
    parent.children.push({ kind: 'key', name: parts.length > 1 ? parts.at(-1)! : e.key, entry: e });
  }
  const sort = (nodes: KeyNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
    for (const n of nodes) if (n.kind === 'folder') sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** The text pretty when it's JSON (an object or an array), else null. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
