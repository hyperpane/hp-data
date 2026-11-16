// The etcd driver against a real server (ETCD_URL, else
// http://localhost:2379; skipped when nothing answers there): the tree,
// keys by prefix and glob a page at a time, values with leases as TTLs,
// renames in a transaction, and the console. It works under a prefix of
// its own and removes it after.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { kindOf, withDefaults } from '../../src/shared/kinds.ts';
import type { KvReply } from '../../src/shared/kv.ts';
import { etcd } from '../../src/server/drivers/kv/etcd.ts';
import type { KvDriver } from '../../src/server/drivers/types.ts';

const URL_ = process.env.ETCD_URL ?? 'http://localhost:2379';
const P = `hp-test-${process.pid}/`;

const reachable = await fetch(`${URL_}/version`, { signal: AbortSignal.timeout(1000) }).then(
  (r) => r.ok,
  () => false,
);

const make_ = (values: Record<string, string> = {}): KvDriver => {
  const kind = kindOf('etcd')!;
  return etcd({ kind, values: withDefaults(kind, { url: URL_, ...values }), folder: null, dataDir: '/tmp', log: () => {} }) as KvDriver;
};

describe('etcd', { skip: !reachable && `nothing answers at ${URL_}` }, () => {
  let d: KvDriver;
  const cmd = async (line: string) => ((await d.command({ line })).reply as KvReply).text;
  before(() => {
    d = make_();
  });
  after(async () => {
    await cmd(`del --prefix ${P}`);
    await d.close();
  });

  test('says what it is, and has one keyspace', async () => {
    assert.match((await d.info()).version, /^etcd 3\./);
    const [node] = await d.children([]);
    assert.equal(node.type, 'keyspace');
    assert.equal(node.open?.tab, 'keys');
  });

  test('writes, reads, pages and matches keys', async () => {
    for (const k of ['a/1', 'a/2', 'a/3', 'b/1']) await d.set({ key: P + k, value: { type: 'string', value: `v-${k}` } });
    const seen: string[] = [];
    let cursor = '0';
    do {
      const r = await d.scan({ pattern: `${P}a/*`, cursor, count: 2 });
      seen.push(...r.keys.map((k) => k.key));
      assert.ok(r.keys.every((k) => k.type === 'string' && k.ttl === -1));
      assert.ok(r.total! >= 4);
      cursor = r.cursor;
    } while (cursor !== '0');
    assert.deepEqual(
      seen,
      ['a/1', 'a/2', 'a/3'].map((k) => P + k),
    );
    assert.deepEqual(
      (await d.scan({ pattern: `${P}*/1`, cursor: '0', count: 100 })).keys.map((k) => k.key),
      [`${P}a/1`, `${P}b/1`],
    );
    assert.deepEqual(
      (await d.scan({ pattern: `${P}b/1`, cursor: '0', count: 100 })).keys.map((k) => k.key),
      [`${P}b/1`],
    );
    const v = await d.get({ key: `${P}a/2` });
    assert.equal(v.type === 'string' && v.value, 'v-a/2');
    assert.equal(v.ttl, -1);
    await assert.rejects(d.get({ key: `${P}none` }), /no key/);
    await assert.rejects(d.edit({ key: `${P}a/2`, op: { op: 'hdel', field: 'x' } }), /strings/);
  });

  test('TTLs are leases', async () => {
    await d.set({ key: `${P}t`, value: { type: 'string', value: 'x' }, ttl: 120 });
    assert.ok((await d.get({ key: `${P}t` })).ttl > 100);
    // Rewritten, it keeps its lease.
    await d.set({ key: `${P}t`, value: { type: 'string', value: 'y' } });
    assert.ok((await d.get({ key: `${P}t` })).ttl > 100);
    await d.expire({ key: `${P}t`, ttl: null });
    const v = await d.get({ key: `${P}t` });
    assert.deepEqual([v.ttl, v.type === 'string' && v.value], [-1, 'y']);
    await d.expire({ key: `${P}t`, ttl: 30 });
    assert.ok((await d.get({ key: `${P}t` })).ttl > 20);
  });

  test('renames and removes', async () => {
    await d.rename({ key: `${P}b/1`, to: `${P}b/one` });
    await assert.rejects(d.rename({ key: `${P}b/one`, to: `${P}a/1` }), /already a key/);
    assert.equal((await d.get({ key: `${P}b/one` })).type, 'string');
    assert.equal(await d.remove({ keys: [`${P}b/one`, `${P}nope`] }), 1);
  });

  test('the console', async () => {
    assert.equal(await cmd(`put ${P}c "a b"`), 'OK');
    assert.equal(await cmd(`get ${P}c`), '"a b"');
    assert.equal(await cmd(`get ${P}nope`), '(nil)');
    assert.equal(await cmd(`ls ${P}a/`), `1) "${P}a/1"\n2) "${P}a/2"\n3) "${P}a/3"`);
    assert.equal(await cmd(`count ${P}a/`), '(integer) 3');
    assert.equal(await cmd(`del ${P}c`), '(integer) 1');
    const r = (await d.command({ line: 'frobnicate' })).reply as KvReply;
    assert.equal(r.error, true);
    assert.match(r.text, /doesn’t know “frobnicate”/);
  });

  test('says why it can’t connect', async () => {
    await assert.rejects(make_({ url: 'http://localhost:1' }).info(), /Nothing answers at localhost:1/);
    await assert.rejects(make_({ user: 'root', password: 'x' }).info(), /no authentication|Wrong user/);
  });
});
