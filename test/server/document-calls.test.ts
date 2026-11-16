// The document family through its calls (calls/document.ts) against a real
// MongoDB at localhost:27017: find, insert, replace, remove, the console,
// and read-only connections refusing changes (console text too).

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { invoke, testHost } from '@hyperpane/sdk/testing';
import { make } from '../../src/server/plugin.ts';

const up = await new Promise<boolean>((resolve) => {
  const s = net.connect(27017, '127.0.0.1', () => {
    s.destroy();
    resolve(true);
  });
  s.on('error', () => resolve(false));
  s.setTimeout(1000, () => {
    s.destroy();
    resolve(false);
  });
});

describe('document calls against MongoDB', { skip: up ? false : 'no MongoDB at localhost:27017' }, () => {
  let plugin: ReturnType<ReturnType<typeof make>>;
  let id = '';
  let ro = '';
  const ref = { database: 'hp_calls', collection: 'things' };
  before(async () => {
    plugin = make()(testHost({ id: 'data' }));
    const save = (name: string, readOnly: boolean) =>
      invoke<{ id: string }>(plugin, { op: 'save', connection: { name, kind: 'mongodb', readOnly, values: { host: '127.0.0.1', port: 27017 } } });
    id = (await save('mongo', false)).id;
    ro = (await save('mongo (read only)', true)).id;
    await invoke(plugin, { op: 'docCommand', id, database: 'hp_calls', text: 'db.things.drop()' }).catch(() => {});
  });
  after(async () => {
    await invoke(plugin, { op: 'docCommand', id, database: 'hp_calls', text: 'db.dropDatabase()' }).catch(() => {});
    await plugin.shutdown?.();
  });

  test('insert, find, replace, remove', async () => {
    const { key } = await invoke<{ key: { _id: { $oid: string } } }>(plugin, { op: 'docInsert', id, ref, doc: '{ name: "lamp", price: 12 }' });
    const found = await invoke<any>(plugin, { op: 'docFind', id, ref, filter: '{price: {$gte: 10}}', skip: 0, limit: 10 });
    assert.equal(found.total, 1);
    assert.deepEqual(found.docs[0], { _id: key._id, name: 'lamp', price: 12 });
    await invoke(plugin, { op: 'docReplace', id, ref, key, doc: { _id: key._id, name: 'lamp', price: 15 } });
    assert.equal((await invoke<any>(plugin, { op: 'docFind', id, ref, filter: '', skip: 0, limit: 10 })).docs[0].price, 15);
    assert.deepEqual(await invoke(plugin, { op: 'docRemove', id, ref, keys: [key] }), { removed: 1 });
  });

  test('read only: changes refused, reads allowed', async () => {
    await assert.rejects(invoke(plugin, { op: 'docInsert', id: ro, ref, doc: '{a: 1}' }), /read only/);
    await assert.rejects(invoke(plugin, { op: 'docRemove', id: ro, ref, keys: [{ _id: 1 }] }), /read only/);
    await assert.rejects(invoke(plugin, { op: 'docCommand', id: ro, database: 'hp_calls', text: 'db.things.deleteMany({})' }), /read only/);
    const r = await invoke<any>(plugin, { op: 'docCommand', id: ro, database: 'hp_calls', text: 'db.things.countDocuments()' });
    assert.equal(r.result, 0);
  });
});
