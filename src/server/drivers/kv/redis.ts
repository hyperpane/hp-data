// The Redis driver (Valkey and Dragonfly too: the same protocol), with
// its own RESP client (client.ts): the databases for the tree, keys by
// SCAN with their types and TTLs, values (redis-values.ts), and a console
// that prints replies as redis-cli does (cli.ts). The console has its own
// connection, so a BLPOP or a MULTI there doesn't hold up the keys tab.

import { PluginError } from '@hyperpane/sdk/server';
import type { TreeNode } from '../../../shared/types.ts';
import type { KeyEntry, ScanResult } from '../../../shared/kv.ts';
import type { KvReply } from '../../../shared/kv.ts';
import { since } from '../cells.ts';
import type { DriverContext, Factory, KvDriver } from '../types.ts';
import { format, refused, tokenize } from './cli.ts';
import { globPrefix } from './etcd-keys.ts';
import { RespClient, replyError } from './client.ts';
import { editValue, getValue, keyType, type Run, setValue, ttlOf } from './redis-values.ts';
import { type Arg, type Reply, RespError } from './resp.ts';
import { KeyNames, bytesOf } from './text.ts';
import { tlsOf } from '../../net/tls.ts';

const str = (r: Reply): string => (Buffer.isBuffer(r) ? r.toString('utf8') : r === null ? '' : String(r));

/** INFO's text as sections of fields. */
export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** INFO keyspace's `db0:keys=5,expires=0,avg_ttl=0` as keys per database. */
export function keyspace(info: Record<string, string>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [k, v] of Object.entries(info)) {
    const m = /^db(\d+)$/.exec(k);
    if (m) out.set(Number(m[1]), Number(/keys=(\d+)/.exec(v)?.[1] ?? 0));
  }
  return out;
}

/** No `*`, `?` or `[` (but escaped ones): one key by its name. */
const isLiteral = (p: string) => !/[*?[]/.test(p.replace(/\\./g, ''));
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;

export const redis: Factory = (ctx: DriverContext): KvDriver => {
  const v = ctx.values;
  const opts = {
    host: String(v.host ?? 'localhost'),
    port: Number(v.port ?? 6379),
    tls: v.tls === true || v.tls === 'true',
    tlsOptions: tlsOf(v),
    insecure: !!v.tlsInsecure,
    user: v.user ? String(v.user) : undefined,
    password: v.password ? String(v.password) : undefined,
    name: 'hyperpane-data',
  };
  const defaultDb = Math.max(0, Math.trunc(Number(v.db ?? 0)) || 0);
  const names = new KeyNames();
  let main: RespClient | null = null;
  let console_: RespClient | null = null;
  let consoleDb = defaultDb;

  const live = (c: RespClient | null) => (c && !c.closed ? c : null);
  const client = () => (main = live(main) ?? new RespClient(opts));

  const run = (db: number | undefined): Run => {
    const n = db ?? defaultDb;
    const check = (r: Reply) => {
      if (r instanceof RespError) throw replyError(r, client().where);
      return r;
    };
    return {
      one: async (args) => check(await client().call(args, n)),
      many: async (cmds) => (await client().pipeline(cmds, n)).map(check),
      bytes: (s) => names.bytes(s),
      name: (b) => names.name(b),
    };
  };

  return {
    family: 'kv',

    async info() {
      const r = run(undefined);
      const info = parseInfo(str(await r.one(['INFO', 'server'])));
      const product = info.dragonfly_version ? 'Dragonfly' : info.valkey_version || info.server_name === 'valkey' ? 'Valkey' : 'Redis';
      const version = info.dragonfly_version?.replace(/^df-v?/, '') ?? info.valkey_version ?? info.redis_version ?? '';
      const detail = [
        info.redis_mode && info.redis_mode !== 'standalone' ? info.redis_mode : null,
        opts.user ? `as ${opts.user}` : null,
        opts.tls ? 'TLS' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return { version: `${product} ${version}`.trim(), detail: detail || undefined };
    },

    async children(path) {
      const r = run(undefined);
      if (path[0] === 'info') {
        const info = parseInfo(str(await r.one(['INFO'])));
        const rows: [string, string | undefined][] = [
          ['Version', info.dragonfly_version ?? info.valkey_version ?? info.redis_version],
          ['Mode', info.redis_mode],
          ['Role', info.role],
          ['Uptime', info.uptime_in_seconds ? `${Math.round(Number(info.uptime_in_seconds) / 3600)} h` : undefined],
          ['Clients', info.connected_clients],
          ['Memory', info.used_memory_human],
          ['Peak memory', info.used_memory_peak_human],
          ['Max memory', info.maxmemory_human],
          ['Eviction', info.maxmemory_policy],
          ['Commands run', info.total_commands_processed],
          ['Persistence', [info.aof_enabled === '1' ? 'AOF' : null, info.rdb_last_save_time ? 'RDB' : null].filter(Boolean).join(', ') || undefined],
          ['OS', info.os],
        ];
        return rows.filter(([, x]) => x).map(([label, x]) => ({ name: label, type: 'info', detail: x, leaf: true }) satisfies TreeNode);
      }
      if (path.length) return [];
      const [conf, ks] = await client().pipeline([
        ['CONFIG', 'GET', 'databases'],
        ['INFO', 'keyspace'],
      ]);
      const count = Array.isArray(conf) && conf.length >= 2 ? Number(str(conf[1])) || 16 : 16;
      const keys = ks instanceof RespError ? new Map<number, number>() : keyspace(parseInfo(str(ks)));
      const dbs = count <= 16 ? Array.from({ length: count }, (_, i) => i) : [...new Set([0, defaultDb, ...keys.keys()])].sort((a, b) => a - b);
      const nodes: TreeNode[] = dbs.map((i) => ({
        name: `db${i}`,
        type: 'database',
        detail: keys.get(i) ? plural(keys.get(i)!, 'key') : undefined,
        leaf: true,
        open: { tab: 'keys', ref: { database: String(i) }, title: `db${i}` },
      }));
      nodes.push({ name: 'info', label: 'Server', type: 'info' });
      return nodes;
    },

    async scan({ db, pattern, cursor, count }) {
      const r = run(db);
      const p = pattern || '*';
      let found: Buffer[] = [];
      let next = cursor || '0';
      if (isLiteral(p)) {
        // One key by its name: no need to walk them all.
        const k = r.bytes(globPrefix(p));
        if (Number(await r.one(['EXISTS', k]))) found = [k];
        next = '0';
      } else {
        const t0 = Date.now();
        do {
          const [c, keys] = (await r.one(['SCAN', next, 'MATCH', p, 'COUNT', Math.max(count, 100)])) as Reply[];
          next = str(c);
          found.push(...(keys as Buffer[]));
        } while (next !== '0' && found.length < count && Date.now() - t0 < 1500);
      }
      const meta = found.length
        ? await client().pipeline(
            found.flatMap((k) => [['TYPE', k] as Arg[], ['PTTL', k] as Arg[]]),
            db ?? defaultDb,
          )
        : [];
      const keys: KeyEntry[] = found.map((k, i) => ({ key: names.name(k), type: keyType(meta[i * 2]), ttl: ttlOf(meta[i * 2 + 1]) }));
      const size = await r.one(['DBSIZE']);
      return { keys, cursor: next, total: Number(size) } satisfies ScanResult;
    },

    get: ({ db, key, offset, limit }) => getValue(run(db), key, Math.max(0, offset ?? 0), Math.max(1, Math.min(limit ?? 500, 10_000))),

    set: ({ db, key, value, ttl }) => setValue(run(db), key, value, ttl, bytesOf),

    edit: ({ db, key, op }) => editValue(run(db), key, op),

    async remove({ db, keys }) {
      if (!keys.length) return 0;
      const r = run(db);
      const ks = keys.map((k) => r.bytes(k));
      const got = await client().call(['UNLINK', ...ks], db ?? defaultDb);
      return Number(got instanceof RespError ? await r.one(['DEL', ...ks]) : got);
    },

    async rename({ db, key, to }) {
      if (!to) throw new PluginError('Give the key a name.');
      if (to === key) return;
      const r = run(db);
      const ok = await r.one(['RENAMENX', r.bytes(key), Buffer.from(to, 'utf8')]);
      if (Number(ok) === 0) throw new PluginError(`There’s already a key “${to}”.`);
    },

    async expire({ db, key, ttl }) {
      const r = run(db);
      const k = r.bytes(key);
      if (ttl === null || ttl < 0) {
        await r.one(['PERSIST', k]);
        return;
      }
      if (!(ttl > 0)) throw new PluginError('A TTL is a number of seconds, more than 0.');
      if (Number(await r.one(['EXPIRE', k, Math.round(ttl)])) === 0) throw new PluginError(`There’s no key “${key}” now.`);
    },

    async command({ db, line }) {
      const args = tokenize(line);
      if (!args.length) throw new PluginError('Type a command.');
      const name = args[0].toString('utf8').toUpperCase();
      const no = refused(name) ?? (name === 'HELLO' && args[1] && args[1].toString() !== '2' ? 'The console speaks RESP2: HELLO 3 isn’t for it.' : null);
      if (no) throw new PluginError(no);
      console_ = live(console_) ?? new RespClient(opts);
      const c = console_;
      if (db !== undefined && db !== consoleDb) consoleDb = db;
      const t0 = performance.now();
      const reply = await c.call(args, consoleDb);
      const ms = since(t0);
      const out: KvReply = { text: format(reply), error: reply instanceof RespError || undefined };
      if (name === 'SELECT' && reply === 'OK') {
        consoleDb = Number(args[1]?.toString());
        c.db = consoleDb;
        out.db = consoleDb;
      } else if (reply instanceof RespError && reply.code === 'MOVED') out.text += `\n${replyError(reply, c.where).message}`;
      return { reply: out, ms };
    },

    async close() {
      main?.close();
      console_?.close();
      main = console_ = null;
    },
  };
};
