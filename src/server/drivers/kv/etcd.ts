// The etcd driver, over etcd's v3 JSON gateway (/v3/kv/range, put,
// deleterange, txn; leases for TTLs): one keyspace of string values,
// listed by prefix a page at a time, with a token from /v3/auth when
// there's a user. Its console knows a few commands, as etcdctl has them.

import { PluginError } from '@hyperpane/sdk/server';
import type { TreeNode } from '../../../shared/types.ts';
import type { KeyEntry } from '../../../shared/kv.ts';
import type { KvReply, KvValue } from '../../../shared/kv.ts';
import { since } from '../cells.ts';
import { json } from '../../net/http.ts';
import type { DriverContext, Factory, KvDriver } from '../types.ts';
import { format, tokenize } from './cli.ts';
import { b64, globPrefix, globRegex, prefixEnd, unb64 } from './etcd-keys.ts';
import { type Reply, RespError } from './resp.ts';
import { KeyNames, bytesOf, show } from './text.ts';
import { tlsOf } from '../../net/tls.ts';

interface Kv {
  key: string;
  value?: string;
  create_revision?: string;
  mod_revision?: string;
  version?: string;
  lease?: string;
}
interface RangeResponse {
  kvs?: Kv[];
  more?: boolean;
  count?: string;
}

/** What etcd's gateway says, as a sentence. */
export function explain(status: number, text: string): string {
  let said = text.trim();
  try {
    const j = JSON.parse(text) as { message?: string; error?: string };
    said = j.message ?? j.error ?? said;
  } catch {}
  said = said.replace(/^etcdserver:\s*/, '');
  if (/invalid user ID or password|authentication failed/i.test(said)) return 'Wrong user name or password.';
  if (/user name is empty/i.test(said)) return 'This etcd wants a user and a password: put them in the connection’s settings.';
  if (/permission denied/i.test(said)) return 'The user may not do that.';
  if (/authentication is not enabled/i.test(said)) return 'This etcd has no authentication: leave the user and password empty.';
  if (status === 404) return 'That isn’t etcd’s v3 gateway (etcd 3.4 or later): check the endpoint.';
  return `etcd: ${said.slice(0, 400) || status}`;
}

const HELP = [
  'get <key>',
  'get --prefix <prefix>',
  'ls [prefix]',
  'count [prefix]',
  'put <key> <value> [--ttl <seconds>]',
  'del <key>',
  'del --prefix <prefix>',
  'version',
];

export const etcd: Factory = (ctx: DriverContext): KvDriver => {
  const base = String(ctx.values.url ?? 'http://localhost:2379').replace(/\/+$/, '');
  const tlsOpts = tlsOf(ctx.values);
  const user = ctx.values.user ? String(ctx.values.user) : '';
  const password = ctx.values.password ? String(ctx.values.password) : '';
  const names = new KeyNames();
  let token: string | null = null;

  async function auth(): Promise<Record<string, string>> {
    if (!user) return {};
    token ??= (
      await json<{ token: string }>(
        { method: 'POST', url: `${base}/v3/auth/authenticate`, json: { name: user, password }, timeout: 10_000, tls: tlsOpts },
        explain,
      )
    ).token;
    return { authorization: token };
  }

  async function post<T>(path: string, body: unknown, again = true): Promise<T> {
    try {
      return (await json<T>({ method: 'POST', url: `${base}${path}`, json: body, headers: await auth(), timeout: 15_000, tls: tlsOpts }, explain)) ?? ({} as T);
    } catch (e) {
      if (again && token && /invalid auth token|token/i.test((e as Error).message)) {
        token = null;
        return post<T>(path, body, false);
      }
      throw e;
    }
  }

  const keyOf = (s: string) => names.bytes(s);
  const range = (o: { key: Buffer; end?: Buffer; limit?: number; keysOnly?: boolean; countOnly?: boolean }) =>
    post<RangeResponse>('/v3/kv/range', {
      key: b64(o.key),
      range_end: o.end ? b64(o.end) : undefined,
      limit: o.limit,
      keys_only: o.keysOnly,
      count_only: o.countOnly,
    });
  const count = async (prefix: Buffer = Buffer.alloc(0)) =>
    Number((await range({ key: prefix.length ? prefix : Buffer.from([0]), end: prefixEnd(prefix), countOnly: true })).count ?? 0);
  const one = async (key: string): Promise<Kv | null> => (await range({ key: keyOf(key) })).kvs?.[0] ?? null;

  /** Seconds left on leases, by id. */
  async function ttls(leases: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const id of [...new Set(leases)].slice(0, 200)) {
      const r = await post<{ TTL?: string }>('/v3/lease/timetolive', { ID: id }).catch(() => ({ TTL: '-1' }));
      out.set(id, Number(r.TTL ?? -1));
    }
    return out;
  }
  const grant = async (ttl: number) => (await post<{ ID: string }>('/v3/lease/grant', { TTL: Math.round(ttl) })).ID;

  return {
    family: 'kv',

    async info() {
      const r = await json<{ etcdserver?: string; etcdcluster?: string }>({ url: `${base}/version`, timeout: 10_000, tls: tlsOpts }, explain);
      await count(); // signs in, and checks the user may read
      return {
        version: `etcd ${r?.etcdserver ?? ''}`.trim(),
        detail: [r?.etcdcluster ? `cluster ${r.etcdcluster}` : null, user ? `as ${user}` : null].filter(Boolean).join(' · ') || undefined,
      };
    },

    async children(path) {
      if (path.length) return [];
      const n = await count();
      return [
        {
          name: 'keyspace',
          label: 'Keys',
          type: 'keyspace',
          leaf: true,
          detail: `${n.toLocaleString('en-US')} ${n === 1 ? 'key' : 'keys'}`,
          open: { tab: 'keys', ref: {}, title: 'Keys' },
        } satisfies TreeNode,
      ];
    },

    async scan({ pattern, cursor, count: limit }) {
      const p = pattern || '*';
      const literal = !/[*?[]/.test(p.replace(/\\./g, ''));
      let kvs: Kv[];
      let next = '0';
      if (literal) {
        const kv = await one(globPrefix(p));
        kvs = kv ? [kv] : [];
      } else {
        const prefix = Buffer.from(globPrefix(p), 'utf8');
        const start = cursor && cursor !== '0' ? unb64(cursor) : prefix.length ? prefix : Buffer.from([0]);
        const r = await range({ key: start, end: prefixEnd(prefix), limit, keysOnly: true });
        kvs = r.kvs ?? [];
        if (r.more && kvs.length) next = b64(Buffer.concat([unb64(kvs.at(-1)!.key), Buffer.from([0])]));
        const re = globRegex(p);
        kvs = kvs.filter((kv) => re.test(names.name(unb64(kv.key))));
      }
      const left = await ttls(kvs.map((kv) => kv.lease).filter((l): l is string => !!l && l !== '0'));
      const keys: KeyEntry[] = kvs.map((kv) => ({
        key: names.name(unb64(kv.key)),
        type: 'string',
        ttl: kv.lease && kv.lease !== '0' ? (left.get(kv.lease) ?? -1) : -1,
      }));
      return { keys, cursor: next, total: await count() };
    },

    async get({ key }): Promise<KvValue> {
      const kv = await one(key);
      if (!kv) throw new PluginError(`There’s no key “${key}” now: it may have expired or been removed.`);
      const b = unb64(kv.value);
      const { text, binary } = show(b);
      const lease = kv.lease && kv.lease !== '0' ? kv.lease : null;
      const ttl = lease ? ((await ttls([lease])).get(lease) ?? -1) : -1;
      const meta: Record<string, string> = {
        Version: kv.version ?? '1',
        Created: `revision ${kv.create_revision ?? '?'}`,
        Modified: `revision ${kv.mod_revision ?? '?'}`,
      };
      if (lease) meta.Lease = lease;
      return { type: 'string', value: text, binary: binary || undefined, ttl, size: b.length, meta };
    },

    async set({ key, value, ttl }) {
      if (value.type !== 'string') throw new PluginError('etcd keeps strings only.');
      const k = b64(keyOf(key));
      const v = b64(bytesOf(value.value, value.binary));
      if (ttl === undefined) {
        // Keeps the lease the key has, if it has one.
        const kv = await one(key);
        await post('/v3/kv/put', { key: k, value: v, lease: kv?.lease && kv.lease !== '0' ? kv.lease : undefined });
        return;
      }
      await post('/v3/kv/put', { key: k, value: v, lease: ttl ? await grant(ttl) : undefined });
    },

    async edit() {
      throw new PluginError('etcd’s values are strings: there’s nothing inside one to change.');
    },

    async remove({ keys }) {
      let n = 0;
      for (const key of keys) n += Number((await post<{ deleted?: string }>('/v3/kv/deleterange', { key: b64(keyOf(key)) })).deleted ?? 0);
      return n;
    },

    async rename({ key, to }) {
      if (!to) throw new PluginError('Give the key a name.');
      if (to === key) return;
      const kv = await one(key);
      if (!kv) throw new PluginError(`There’s no key “${key}” now.`);
      const r = await post<{ succeeded?: boolean }>('/v3/kv/txn', {
        compare: [
          { key: b64(to), target: 'CREATE', result: 'EQUAL', create_revision: '0' },
          { key: kv.key, target: 'MOD', result: 'EQUAL', mod_revision: kv.mod_revision },
        ],
        success: [
          { request_put: { key: b64(to), value: kv.value ?? '', lease: kv.lease && kv.lease !== '0' ? kv.lease : undefined } },
          { request_delete_range: { key: kv.key } },
        ],
      });
      if (!r.succeeded) throw new PluginError(`There’s already a key “${to}”, or “${key}” changed meanwhile.`);
    },

    async expire({ key, ttl }) {
      const kv = await one(key);
      if (!kv) throw new PluginError(`There’s no key “${key}” now.`);
      if (ttl === null || ttl < 0) await post('/v3/kv/put', { key: kv.key, value: kv.value ?? '' });
      else if (ttl > 0) await post('/v3/kv/put', { key: kv.key, lease: await grant(ttl), ignore_value: true });
      else throw new PluginError('A TTL is a number of seconds, more than 0.');
    },

    async command({ line }) {
      const args = tokenize(line);
      if (!args.length) throw new PluginError('Type a command.');
      const t0 = performance.now();
      let reply: Reply;
      try {
        reply = await runLine(
          args.map((a) => a.toString('utf8')),
          args,
        );
      } catch (e) {
        reply = new RespError((e as Error).message);
      }
      const out: KvReply = { text: format(reply), error: reply instanceof RespError || undefined };
      return { reply: out, ms: since(t0) };
    },

    async close() {
      token = null;
    },
  };

  async function runLine(a: string[], raw: Buffer[]): Promise<Reply> {
    const cmd = a[0].toLowerCase();
    const prefixed = a[1] === '--prefix';
    const target = prefixed ? (raw[2] ?? Buffer.alloc(0)) : raw[1];
    const all = (p: Buffer) => ({ key: p.length ? p : Buffer.from([0]), end: prefixEnd(p) });
    switch (cmd) {
      case 'help':
        return HELP;
      case 'version':
        return JSON.stringify(await json({ url: `${base}/version`, tls: tlsOpts }, explain));
      case 'get': {
        if (!target) return new RespError('get needs a key');
        if (!prefixed) {
          const kv = (await range({ key: target })).kvs?.[0];
          return kv ? unb64(kv.value) : null;
        }
        const kvs = (await range({ ...all(target), limit: 1000 })).kvs ?? [];
        return kvs.flatMap((kv) => [unb64(kv.key), unb64(kv.value)]);
      }
      case 'ls':
        return ((await range({ ...all(raw[1] ?? Buffer.alloc(0)), limit: 1000, keysOnly: true })).kvs ?? []).map((kv) => unb64(kv.key));
      case 'count':
        return count(raw[1] ?? Buffer.alloc(0));
      case 'put': {
        if (raw.length < 3) return new RespError('put needs a key and a value');
        const t = a.indexOf('--ttl');
        const ttl = t > 0 ? Number(a[t + 1]) : 0;
        if (t > 0 && !(ttl > 0)) return new RespError('--ttl is a number of seconds, more than 0');
        await post('/v3/kv/put', { key: b64(raw[1]), value: b64(raw[2]), lease: ttl ? await grant(ttl) : undefined });
        return 'OK';
      }
      case 'del': {
        if (!target) return new RespError('del needs a key');
        const r = await post<{ deleted?: string }>(
          '/v3/kv/deleterange',
          prefixed ? { key: b64(all(target).key), range_end: b64(all(target).end) } : { key: b64(target) },
        );
        return Number(r.deleted ?? 0);
      }
      default:
        return new RespError(`etcd’s console doesn’t know “${a[0]}”. It knows: ${HELP.join(', ')}.`);
    }
  }
};
