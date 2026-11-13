// The kv family's calls (Redis, Valkey, Dragonfly, etcd): keys by pattern,
// a key's value, changes to it, and a console's command. Each takes
// `{ id, project?, db?, … }`; `db` is a Redis database's number (a keys
// tab's `ref.database`). Changes are refused on a connection marked read
// only, and so are console commands that don't only read.

import { PluginError } from '@hyperpane/sdk/server';
import { kindOf } from '../../shared/kinds.ts';
import type { KeyValue } from '../../shared/kv.ts';
import { readsOnly, tokenize } from '../drivers/kv/cli.ts';
import type { KvDriver, KvEdit } from '../drivers/types.ts';
import { type Deps, type Group, idOf, int, projectOf, writable } from './context.ts';

type Req = { id?: unknown; project?: unknown; db?: unknown; [k: string]: unknown };

/** A database's number, or undefined for the connection's own. */
export function dbOf(req: Req): number | undefined {
  if (req.db === undefined || req.db === null || req.db === '') return undefined;
  const n = Number(req.db);
  if (!Number.isInteger(n) || n < 0) throw new PluginError(`“${String(req.db)}” isn’t a database number.`);
  return n;
}

function keyOf(v: unknown, what = 'key'): string {
  if (typeof v !== 'string' || v === '') throw new PluginError(`Which ${what}?`);
  return v;
}

/** A TTL: seconds, null for none, undefined to keep what it has. */
function ttlOf(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === -1) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new PluginError('A TTL is a number of seconds, more than 0.');
  return Math.round(n);
}

/** `*`, `?`, `[` and `\` escaped, so a pattern matches only that key. */
export const literal = (key: string) => key.replace(/[*?[\]\\]/g, '\\$&');

const EDITS = new Set(['hset', 'hdel', 'lset', 'lpush', 'rpush', 'lrem', 'sadd', 'srem', 'zadd', 'zrem', 'xadd', 'xdel']);

export function kv(d: Deps): Group {
  const { sessions } = d;
  const driver = (req: Req): Promise<KvDriver> => sessions.family(idOf(req), 'kv', projectOf(req));
  const change = async (req: Req): Promise<KvDriver> => {
    await writable(d, idOf(req));
    return driver(req);
  };

  return {
    calls: {
      /** `{ pattern = '*', cursor = '0', count = 200 }` → ScanResult. */
      kvScan: async (req: Req) =>
        (await driver(req)).scan({ db: dbOf(req), pattern: typeof req.pattern === 'string' && req.pattern ? req.pattern : '*', cursor: typeof req.cursor === 'string' ? req.cursor : '0', count: int(req.count, 200, 1, 5000) }),

      /** `{ key, offset = 0, limit = 200 }` → KvValue. */
      kvGet: async (req: Req) => (await driver(req)).get({ db: dbOf(req), key: keyOf(req.key), offset: int(req.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit: int(req.limit, 200, 1, 10_000) }),

      /** `{ key, value: KeyValue, ttl?, create? }`: writes the key whole;
       * `create` refuses when it's there already. */
      kvSet: async (req: Req) => {
        const key = keyOf(req.key);
        const value = req.value as KeyValue | undefined;
        if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new PluginError('What value?');
        const db = dbOf(req);
        const kv = await change(req);
        if (req.create) {
          const there = await kv.scan({ db, pattern: literal(key), cursor: '0', count: 1 });
          if (there.keys.some((k) => k.key === key)) throw new PluginError(`There’s already a key “${key}”.`);
        }
        await kv.set({ db, key, value, ttl: ttlOf(req.ttl) });
        return null;
      },

      /** `{ key, op: KvEdit }`: one field, item or member. */
      kvEdit: async (req: Req) => {
        const op = req.op as KvEdit | undefined;
        if (!op || !EDITS.has(op.op)) throw new PluginError('What change?');
        await (await change(req)).edit({ db: dbOf(req), key: keyOf(req.key), op });
        return null;
      },

      /** `{ keys: string[] }` → how many were removed. */
      kvRemove: async (req: Req) => {
        const keys = Array.isArray(req.keys) ? req.keys.filter((k): k is string => typeof k === 'string' && k !== '') : [];
        if (!keys.length) throw new PluginError('Which keys?');
        return (await change(req)).remove({ db: dbOf(req), keys });
      },

      /** `{ key, to }`; refused when `to` is there already. */
      kvRename: async (req: Req) => {
        await (await change(req)).rename({ db: dbOf(req), key: keyOf(req.key), to: keyOf(req.to, 'name') });
        return null;
      },

      /** `{ key, ttl }`: seconds, or null to keep it for good. */
      kvExpire: async (req: Req) => {
        await (await change(req)).expire({ db: dbOf(req), key: keyOf(req.key), ttl: ttlOf(req.ttl) ?? null });
        return null;
      },

      /** `{ line }` → `{ reply: KvReply, ms }`. */
      kvCommand: async (req: Req) => {
        const line = typeof req.line === 'string' ? req.line.trim() : '';
        if (!line) throw new PluginError('Type a command.');
        const id = idOf(req);
        const conn = await d.registry.get(id);
        if (conn.readOnly) {
          const args = tokenize(line).map((b) => b.toString('utf8'));
          const etcd = kindOf(conn.kind)?.engine === 'etcd';
          const reads = etcd ? ['get', 'ls', 'count', 'version', 'help'].includes((args[0] ?? '').toLowerCase()) : readsOnly(args);
          if (!reads) throw new PluginError(`“${conn.name}” is read only, and ${(args[0] ?? '').toUpperCase()} may change things.`);
        }
        return (await driver(req)).command({ db: dbOf(req), line });
      },
    },
  };
}
