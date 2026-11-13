// A Redis key's value, read a page at a time and written whole or a part
// at a time: strings, hashes, lists, sets, sorted sets, streams, and
// RedisJSON's documents. Whole writes are one MULTI … EXEC, so a key is
// never seen half written.

import { PluginError } from '@hyperpane/sdk/server';
import type { KeyType, KeyValue } from '../../../shared/kv.ts';
import type { KvValue } from '../../../shared/kv.ts';
import type { KvEdit } from '../types.ts';
import { type Arg, type Reply, RespError } from './resp.ts';
import { show } from './text.ts';

/** The commands of one database, error replies thrown as PluginErrors. */
export interface Run {
  one(args: Arg[]): Promise<Reply>;
  many(cmds: Arg[][]): Promise<Reply[]>;
  /** A name shown (a key, a field, a member) as its bytes. */
  bytes(s: string): Buffer;
  /** Bytes as a name shown, remembered when they aren't UTF-8. */
  name(b: Buffer): string;
}

/** A string's bytes sent at most. */
export const STRING_MAX = 1 << 20;
/** A hash or set this big or smaller is read whole, then paged. */
const WHOLE_MAX = 10_000;

const TYPES: Record<string, KeyType> = { string: 'string', hash: 'hash', list: 'list', set: 'set', zset: 'zset', stream: 'stream', 'ReJSON-RL': 'json' };

export const keyType = (t: Reply): KeyType => TYPES[String(t)] ?? 'other';

/** PTTL's answer as seconds left, -1 for none. */
export const ttlOf = (pttl: Reply): number => (typeof pttl === 'number' && pttl >= 0 ? Math.ceil(pttl / 1000) : -1);

const str = (r: Reply): string => (Buffer.isBuffer(r) ? r.toString('utf8') : r === null ? '' : String(r));
const num = (r: Reply): number => (typeof r === 'bigint' ? Number(r) : typeof r === 'number' ? r : Number(str(r)));
const arr = (r: Reply): Reply[] => (Array.isArray(r) ? r : []);
const buf = (r: Reply): Buffer => (Buffer.isBuffer(r) ? r : Buffer.from(str(r)));

export function score(r: Reply): number {
  const s = str(r).toLowerCase();
  return s === 'inf' || s === '+inf' ? Infinity : s === '-inf' ? -Infinity : Number(s);
}

export async function getValue(run: Run, key: string, offset: number, limit: number): Promise<KvValue> {
  const k = run.bytes(key);
  const [t, pttl] = await run.many([
    ['TYPE', k],
    ['PTTL', k],
  ]);
  if (String(t) === 'none') throw new PluginError(`There’s no key “${key}” now: it may have expired or been removed.`);
  const ttl = ttlOf(pttl);
  const type = keyType(t);
  const end = offset + limit - 1;
  switch (type) {
    case 'string': {
      const [len, v] = await run.many([
        ['STRLEN', k],
        ['GETRANGE', k, 0, STRING_MAX - 1],
      ]);
      const { text, binary } = show(buf(v));
      return { type, value: text, binary: binary || undefined, ttl, size: num(len), truncated: num(len) > STRING_MAX || undefined };
    }
    case 'list': {
      const [len, items] = await run.many([
        ['LLEN', k],
        ['LRANGE', k, offset, end],
      ]);
      return { type, items: arr(items).map((b) => show(buf(b)).text), total: num(len), ttl, offset };
    }
    case 'hash': {
      const total = num(await run.one(['HLEN', k]));
      const flat = total <= WHOLE_MAX ? arr(await run.one(['HGETALL', k])) : await scanned(run, 'HSCAN', k, offset + limit, 2);
      const fields: { field: string; value: string }[] = [];
      for (let i = offset * 2; i < Math.min(flat.length, (offset + limit) * 2); i += 2) fields.push({ field: run.name(buf(flat[i])), value: show(buf(flat[i + 1])).text });
      return { type, fields, total, ttl, offset };
    }
    case 'set': {
      const total = num(await run.one(['SCARD', k]));
      const all = total <= WHOLE_MAX ? arr(await run.one(['SMEMBERS', k])) : await scanned(run, 'SSCAN', k, offset + limit, 1);
      const members = all.slice(offset, offset + limit).map((b) => run.name(buf(b)));
      return { type, members: total <= WHOLE_MAX ? members.sort() : members, total, ttl, offset };
    }
    case 'zset': {
      const [len, flat] = await run.many([
        ['ZCARD', k],
        ['ZRANGE', k, offset, end, 'WITHSCORES'],
      ]);
      const f = arr(flat);
      const members: { member: string; score: number }[] = [];
      for (let i = 0; i < f.length; i += 2) members.push({ member: run.name(buf(f[i])), score: score(f[i + 1]) });
      return { type, members, total: num(len), ttl, offset };
    }
    case 'stream': {
      const [len, list] = await run.many([
        ['XLEN', k],
        ['XREVRANGE', k, '+', '-', 'COUNT', offset + limit],
      ]);
      const entries = arr(list)
        .slice(offset)
        .map((e) => {
          const [id, kv] = arr(e);
          const fields: Record<string, string> = {};
          const f = arr(kv);
          for (let i = 0; i < f.length; i += 2) fields[show(buf(f[i])).text] = show(buf(f[i + 1])).text;
          return { id: str(id), fields };
        });
      return { type, entries, total: num(len), ttl, offset };
    }
    case 'json': {
      const v = await run.one(['JSON.GET', k]);
      let value: unknown = str(v);
      try {
        value = JSON.parse(str(v));
      } catch {}
      return { type, value, ttl };
    }
    default:
      return { type: 'other', value: `A ${String(t)} value: the console can read it with its module’s commands.`, ttl };
  }
}

/** HSCAN or SSCAN until `need` items (× `per`: a field and its value). */
async function scanned(run: Run, cmd: 'HSCAN' | 'SSCAN', k: Buffer, need: number, per: number): Promise<Reply[]> {
  const out: Reply[] = [];
  const seen = new Set<string>();
  let cursor = '0';
  do {
    const [next, items] = arr(await run.one([cmd, k, cursor, 'COUNT', 1000]));
    cursor = str(next);
    const it = arr(items);
    for (let i = 0; i < it.length; i += per) {
      const id = buf(it[i]).toString('latin1');
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(...it.slice(i, i + per));
    }
  } while (cursor !== '0' && out.length < need * per);
  return out;
}

/** The commands that write a whole value. */
function writes(k: Buffer, value: KeyValue, bytes: (s: string) => Buffer): Arg[][] {
  const need = (n: number, what: string) => {
    if (!n) throw new PluginError(`A ${value.type === 'zset' ? 'sorted set' : value.type} needs ${what}: Redis doesn’t keep empty ones.`);
  };
  switch (value.type) {
    case 'hash':
      need(value.fields.length, 'a field');
      return [['HSET', k, ...value.fields.flatMap((f) => [bytes(f.field), f.value])]];
    case 'list':
      need(value.items.length, 'an item');
      return [['RPUSH', k, ...value.items]];
    case 'set':
      need(value.members.length, 'a member');
      return [['SADD', k, ...value.members.map(bytes)]];
    case 'zset':
      need(value.members.length, 'a member');
      return [['ZADD', k, ...value.members.flatMap((m) => [scoreArg(m.score), bytes(m.member)])]];
    case 'stream':
      need(value.entries.length, 'an entry');
      return value.entries.map((e) => {
        const f = Object.entries(e.fields);
        if (!f.length) throw new PluginError('A stream entry needs a field.');
        return ['XADD', k, e.id && e.id !== '*' ? e.id : '*', ...f.flat()];
      });
    case 'json':
      return [['JSON.SET', k, '$', JSON.stringify(value.value)]];
    default:
      throw new PluginError('That type can’t be written here: use the console.');
  }
}

const scoreArg = (n: number) => (n === Infinity ? '+inf' : n === -Infinity ? '-inf' : String(n));

/** Writes a key whole. `ttl` undefined keeps the key's TTL, null drops it. */
export async function setValue(run: Run, key: string, value: KeyValue, ttl: number | null | undefined, bytesOf: (text: string, binary?: boolean) => Buffer): Promise<void> {
  const k = run.bytes(key);
  if (ttl !== undefined && ttl !== null && !(ttl > 0)) throw new PluginError('A TTL is a number of seconds, more than 0.');
  if (value.type === 'string') {
    const v = bytesOf(value.value, value.binary);
    await run.one(['SET', k, v, ...(ttl === undefined ? ['KEEPTTL'] : ttl === null ? [] : ['EX', Math.round(ttl)])]);
    return;
  }
  let keep: number | null = null;
  if (ttl === undefined) {
    const p = await run.one(['PTTL', k]);
    keep = typeof p === 'number' && p > 0 ? p : null;
  }
  const cmds = writes(k, value, run.bytes);
  const expire: Arg[][] = ttl ? [['EXPIRE', k, Math.round(ttl)]] : keep ? [['PEXPIRE', k, keep]] : [];
  await transaction(run, [['DEL', k], ...cmds, ...expire]);
}

/** Commands in MULTI … EXEC; any error in them thrown. */
export async function transaction(run: Run, cmds: Arg[][]): Promise<Reply[]> {
  const replies = await run.many([['MULTI'], ...cmds, ['EXEC']]);
  const exec = replies.at(-1);
  const results = arr(exec ?? null);
  const failed = results.find((r) => r instanceof RespError) as RespError | undefined;
  if (failed) throw new PluginError(failed.message.replace(/^ERR\s+/, ''));
  if (exec === null) throw new PluginError('The key changed while it was written: try again.');
  return results;
}

const MARK = '__hyperpane_data_removed__';

/** Changes one part of a value. */
export async function editValue(run: Run, key: string, op: KvEdit): Promise<void> {
  const k = run.bytes(key);
  switch (op.op) {
    case 'hset':
      await run.one(['HSET', k, run.bytes(op.field), op.value]);
      return;
    case 'hdel':
      await run.one(['HDEL', k, run.bytes(op.field)]);
      return;
    case 'lset':
      await run.one(['LSET', k, op.index, op.value]);
      return;
    case 'lpush':
    case 'rpush':
      await run.one([op.op.toUpperCase(), k, op.value]);
      return;
    case 'lrem': {
      const mark = `${MARK}${Math.random().toString(36).slice(2)}`;
      await transaction(run, [
        ['LSET', k, op.index, mark],
        ['LREM', k, 1, mark],
      ]);
      return;
    }
    case 'sadd':
    case 'srem':
      await run.one([op.op.toUpperCase(), k, run.bytes(op.member)]);
      return;
    case 'zadd':
      if (!Number.isFinite(op.score)) throw new PluginError('A score is a number.');
      await run.one(['ZADD', k, scoreArg(op.score), run.bytes(op.member)]);
      return;
    case 'zrem':
      await run.one(['ZREM', k, run.bytes(op.member)]);
      return;
    case 'xadd': {
      const f = Object.entries(op.fields ?? {});
      if (!f.length) throw new PluginError('An entry needs a field.');
      await run.one(['XADD', k, '*', ...f.flat()]);
      return;
    }
    case 'xdel':
      await run.one(['XDEL', k, op.id]);
      return;
    default:
      throw new PluginError(`“${(op as { op: string }).op}” isn’t a change Data knows.`);
  }
}
