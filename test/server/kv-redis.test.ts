// The Redis driver against a real server (REDIS_URL, else
// localhost:6379; skipped when nothing answers there): the tree, SCAN,
// every type read, written whole and in parts, TTLs, renames, the console
// and its replies, errors in words, and the calls with a read-only
// connection. It works in database 15 and empties it after.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { invoke, testHost } from '@hyperpane/sdk/testing';
import { kindOf, withDefaults } from '../../src/shared/kinds.ts';
import type { KvReply, KvValue } from '../../src/shared/kv.ts';
import type { ScanResult } from '../../src/shared/kv.ts';
import { redis } from '../../src/server/drivers/kv/redis.ts';
import type { KvDriver } from '../../src/server/drivers/types.ts';
import { make } from '../../src/server/plugin.ts';

const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const HOST = url.hostname;
const PORT = Number(url.port || 6379);
const DB = 15;

const reachable = await new Promise<boolean>((resolve) => {
  const s = net.connect({ host: HOST, port: PORT }, () => (s.destroy(), resolve(true)));
  s.on('error', () => resolve(false));
  s.setTimeout(1000, () => (s.destroy(), resolve(false)));
});

const make_ = (values: Record<string, string | number | boolean> = {}): KvDriver => {
  const kind = kindOf('redis')!;
  return redis({ kind, values: withDefaults(kind, { host: HOST, port: PORT, ...values }), folder: null, dataDir: '/tmp', log: () => {} }) as KvDriver;
};

describe('redis', { skip: !reachable && `nothing answers at ${HOST}:${PORT}` }, () => {
  let d: KvDriver;
  const cmd = async (line: string) => ((await d.command({ db: DB, line })).reply as KvReply).text;
  before(async () => {
    d = make_();
    await cmd('FLUSHDB');
  });
  after(async () => {
    await cmd('FLUSHDB');
    await d.close();
  });

  test('says what it is, and lists databases', async () => {
    const info = await d.info();
    assert.match(info.version, /^(Redis|Valkey|Dragonfly) \d/);
    const top = await d.children([]);
    assert.equal(top[0].name, 'db0');
    assert.deepEqual(top[0].open, { tab: 'keys', ref: { database: '0' }, title: 'db0' });
    assert.ok(top.some((n) => n.type === 'info'));
    const server = await d.children(['info']);
    assert.ok(server.some((n) => n.name === 'Version'));
  });

  test('writes and reads every type', async () => {
    await d.set({ db: DB, key: 's', value: { type: 'string', value: 'héllo' }, ttl: 100 });
    await d.set({ db: DB, key: 'h', value: { type: 'hash', fields: [{ field: 'a', value: '1' }, { field: 'b', value: '2' }], total: 2 } });
    await d.set({ db: DB, key: 'l', value: { type: 'list', items: ['x', 'y', 'z'], total: 3 } });
    await d.set({ db: DB, key: 'st', value: { type: 'set', members: ['m2', 'm1'], total: 2 } });
    await d.set({ db: DB, key: 'z', value: { type: 'zset', members: [{ member: 'a', score: 1.5 }, { member: 'b', score: -2 }], total: 2 } });
    await d.set({ db: DB, key: 'x', value: { type: 'stream', entries: [{ id: '', fields: { f: 'v' } }], total: 1 } });

    const s = (await d.get({ db: DB, key: 's' })) as KvValue;
    assert.equal(s.type, 'string');
    assert.equal(s.type === 'string' && s.value, 'héllo');
    assert.ok(s.ttl > 90 && s.ttl <= 100);
    assert.equal(s.size, 6);
    const h = await d.get({ db: DB, key: 'h' });
    assert.deepEqual(h.type === 'hash' && h.fields.map((f) => f.field).sort(), ['a', 'b']);
    const l = await d.get({ db: DB, key: 'l', offset: 1, limit: 1 });
    assert.deepEqual(l.type === 'list' && [l.items, l.total], [['y'], 3]);
    const st = await d.get({ db: DB, key: 'st' });
    assert.deepEqual(st.type === 'set' && st.members, ['m1', 'm2']);
    const z = await d.get({ db: DB, key: 'z' });
    assert.deepEqual(z.type === 'zset' && z.members, [{ member: 'b', score: -2 }, { member: 'a', score: 1.5 }]);
    const x = await d.get({ db: DB, key: 'x' });
    assert.deepEqual(x.type === 'stream' && x.entries[0].fields, { f: 'v' });

    // A string rewritten keeps its TTL unless told.
    await d.set({ db: DB, key: 's', value: { type: 'string', value: 'again' } });
    assert.ok((await d.get({ db: DB, key: 's' })).ttl > 0);
    await d.set({ db: DB, key: 's', value: { type: 'string', value: 'again' }, ttl: null });
    assert.equal((await d.get({ db: DB, key: 's' })).ttl, -1);
  });

  test('binary values and keys round-trip', async () => {
    await cmd('SET "bin\\x00key" "\\x00\\x01\\xff"');
    const page = await d.scan({ db: DB, pattern: 'bin*', cursor: '0', count: 10 });
    assert.equal(page.keys[0].key, 'bin\\x00key');
    const v = await d.get({ db: DB, key: page.keys[0].key });
    assert.deepEqual(v.type === 'string' && [v.value, v.binary], ['\\x00\\x01\\xff', true]);
    await d.set({ db: DB, key: page.keys[0].key, value: { type: 'string', value: '\\x00\\x02', binary: true } });
    assert.equal(await cmd('GET "bin\\x00key"'), '"\\x00\\x02"');
  });

  test('changes parts of values', async () => {
    await d.edit({ db: DB, key: 'h', op: { op: 'hset', field: 'c', value: '3' } });
    await d.edit({ db: DB, key: 'h', op: { op: 'hdel', field: 'a' } });
    assert.equal(await cmd('HGET h c'), '"3"');
    assert.equal(await cmd('HEXISTS h a'), '(integer) 0');
    await d.edit({ db: DB, key: 'l', op: { op: 'lrem', index: 1 } });
    await d.edit({ db: DB, key: 'l', op: { op: 'lpush', value: 'w' } });
    await d.edit({ db: DB, key: 'l', op: { op: 'lset', index: 2, value: 'Z' } });
    assert.equal(await cmd('LRANGE l 0 -1'), '1) "w"\n2) "x"\n3) "Z"');
    await d.edit({ db: DB, key: 'z', op: { op: 'zadd', member: 'c', score: 10 } });
    await d.edit({ db: DB, key: 'z', op: { op: 'zrem', member: 'a' } });
    assert.equal(await cmd('ZCARD z'), '(integer) 2');
    await d.edit({ db: DB, key: 'x', op: { op: 'xadd', fields: { k: 'v2' } } });
    const x = await d.get({ db: DB, key: 'x' });
    assert.equal(x.type === 'stream' && x.entries.length, 2);
    await d.edit({ db: DB, key: 'x', op: { op: 'xdel', id: x.type === 'stream' ? x.entries[0].id : '' } });
    assert.equal(await cmd('XLEN x'), '(integer) 1');
  });

  test('scans, renames, expires, removes', async () => {
    await cmd('MSET page:1 a page:2 b page:3 c');
    const all: string[] = [];
    let cursor = '0';
    do {
      const r: ScanResult = await d.scan({ db: DB, pattern: 'page:*', cursor, count: 1 });
      all.push(...r.keys.map((k) => k.key));
      assert.ok(r.total! >= 3);
      cursor = r.cursor;
    } while (cursor !== '0');
    assert.deepEqual([...new Set(all)].sort(), ['page:1', 'page:2', 'page:3']);
    assert.deepEqual((await d.scan({ db: DB, pattern: 'page:2', cursor: '0', count: 10 })).keys.map((k) => [k.key, k.type, k.ttl]), [['page:2', 'string', -1]]);

    await d.rename({ db: DB, key: 'page:1', to: 'page:one' });
    await assert.rejects(d.rename({ db: DB, key: 'page:one', to: 'page:2' }), /already a key “page:2”/);
    await d.expire({ db: DB, key: 'page:one', ttl: 50 });
    assert.ok((await d.get({ db: DB, key: 'page:one' })).ttl > 40);
    await d.expire({ db: DB, key: 'page:one', ttl: null });
    assert.equal((await d.get({ db: DB, key: 'page:one' })).ttl, -1);
    assert.equal(await d.remove({ db: DB, keys: ['page:one', 'page:2', 'nope'] }), 2);
    await assert.rejects(d.get({ db: DB, key: 'page:2' }), /no key “page:2”/);
  });

  test('the console prints as redis-cli and keeps its database', async () => {
    assert.equal(await cmd('SET k "a b"'), 'OK');
    assert.equal(await cmd('GET k'), '"a b"');
    assert.equal(await cmd('GET missing'), '(nil)');
    assert.equal(await cmd('INCR n'), '(integer) 1');
    const err = (await d.command({ db: DB, line: 'INCR k' })).reply as KvReply;
    assert.equal(err.error, true);
    assert.match(err.text, /^\(error\) ERR value is not an integer/);
    const sel = await d.command({ line: 'SELECT 14' });
    assert.equal((sel.reply as KvReply).db, 14);
    assert.equal(typeof sel.ms, 'number');
    assert.equal(((await d.command({ line: 'GET k' })).reply as KvReply).text, '(nil)');
    await assert.rejects(d.command({ db: DB, line: 'SUBSCRIBE x' }), /doesn’t subscribe/);
    await assert.rejects(d.command({ db: DB, line: 'SET k "open' }), /isn’t closed/);
  });

  test('says why it can’t connect or sign in', async () => {
    await assert.rejects(make_({ port: 1 }).info(), /Nothing answers at/);
    await assert.rejects(make_({ password: 'nope' }).info(), /no password|Wrong user name or password/);
    // An ACL user: signs in with user and password, refused with a wrong one.
    await cmd('ACL SETUSER hp-data-test on >secret ~* &* +@all');
    try {
      const u = make_({ user: 'hp-data-test', password: 'secret' });
      assert.match((await u.info()).detail ?? '', /as hp-data-test/);
      await u.close();
      await assert.rejects(make_({ user: 'hp-data-test', password: 'wrong' }).info(), /Wrong user name or password/);
    } finally {
      await cmd('ACL DELUSER hp-data-test');
    }
    await assert.rejects(d.scan({ db: 999, pattern: '*', cursor: '0', count: 10 }), /no such database/);
  });

  test('the calls, and a read-only connection', async () => {
    const plugin = make()(testHost({ id: 'data' }));
    const save = (name: string, readOnly: boolean) => invoke<{ id: string }>(plugin, { op: 'save', connection: { name, kind: 'redis', readOnly, values: { host: HOST, port: PORT } } });
    const rw = (await save('rw', false)).id;
    const ro = (await save('ro', true)).id;
    try {
      await invoke(plugin, { op: 'kvSet', id: rw, db: String(DB), key: 'new', value: { type: 'string', value: 'v' }, create: true });
      await assert.rejects(invoke(plugin, { op: 'kvSet', id: rw, db: DB, key: 'new', value: { type: 'string', value: 'v' }, create: true }), /already a key/);
      const page = await invoke<ScanResult>(plugin, { op: 'kvScan', id: ro, db: DB, pattern: 'new' });
      assert.equal(page.keys[0].key, 'new');
      await assert.rejects(invoke(plugin, { op: 'kvRemove', id: ro, db: DB, keys: ['new'] }), /read only/);
      await assert.rejects(invoke(plugin, { op: 'kvCommand', id: ro, db: DB, line: 'DEL new' }), /read only/);
      const got = await invoke<{ reply: KvReply }>(plugin, { op: 'kvCommand', id: ro, db: DB, line: 'GET new' });
      assert.equal(got.reply.text, '"v"');
      assert.equal(await invoke(plugin, { op: 'kvRemove', id: rw, db: DB, keys: ['new'] }), 1);
    } finally {
      await plugin.shutdown?.();
    }
  });
});
