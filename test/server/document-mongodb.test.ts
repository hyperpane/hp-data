// MongoDB's driver against a real server (docker run -d --name
// hp-data-mongo -p 27017:27017 mongo:8); skipped when nothing answers.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, test } from 'node:test';
import { kindOf, withDefaults } from '../../src/shared/kinds.ts';
import { mongodb } from '../../src/server/drivers/document/mongodb.ts';
import type { CommandResult } from '../../src/shared/document.ts';
import type { DocumentDriver } from '../../src/server/drivers/types.ts';

const up = await new Promise<boolean>((resolve) => {
  const s = net.connect(27017, '127.0.0.1', () => (s.destroy(), resolve(true)));
  s.on('error', () => resolve(false));
  s.setTimeout(1000, () => (s.destroy(), resolve(false)));
});
const skip = up ? false : 'no MongoDB at localhost:27017';
const kind = kindOf('mongodb')!;
const driver = up ? (mongodb({ kind, values: withDefaults(kind, { host: '127.0.0.1' }), folder: null, dataDir: '/tmp', log() {} }) as DocumentDriver) : null!;
const signal = new AbortController().signal;
const ref = { database: 'hp_test', collection: 'people' };
const run = (text: string, database = 'hp_test') => driver.command({ text, database, signal }) as Promise<CommandResult>;

after(async () => {
  if (!up) return;
  await run('db.dropDatabase()').catch(() => {});
  await driver.close();
});

test('info and the tree', { skip }, async () => {
  assert.match((await driver.info()).version, /^MongoDB \d/);
  await run('db.people.deleteMany({})');
  await run('db.people.insertMany([{_id: 1, name: "Ann", age: 41, at: ISODate("2024-01-02T00:00:00Z")}, {_id: 2, name: "Bob", age: 25}, {name: "Cy", age: 33}])');
  const dbs = await driver.children([]);
  assert.ok(dbs.some((d) => d.name === 'hp_test' && d.type === 'database'));
  const colls = await driver.children(['hp_test']);
  const people = colls.find((c) => c.name === 'people')!;
  assert.equal(people.type, 'collection');
  assert.deepEqual(people.open, { tab: 'collection', ref, title: 'people' });
});

test('find with a shell filter, sort, projection, paging', { skip }, async () => {
  const r = await driver.find({ ref, filter: '{age: {$gt: 30}}', sort: '{age: -1}', projection: "{name: 1}", skip: 0, limit: 10 }, signal);
  assert.deepEqual(r.docs, [{ _id: 1, name: 'Ann' }, { _id: (r.docs[1] as { _id: unknown })._id, name: 'Cy' }]);
  assert.equal(r.total, 2);
  assert.deepEqual(r.idFields, ['_id']);
  assert.match(JSON.stringify((r.docs[1] as { _id: unknown })._id), /\$oid/);
  const page = await driver.find({ ref, filter: '', sort: '{age: 1}', skip: 1, limit: 1 }, signal);
  assert.equal((page.docs[0] as { name: string }).name, 'Cy');
  assert.equal(page.total, 3);
  const dated = await driver.find({ ref, filter: '{at: {$gte: ISODate("2024-01-01")}}', skip: 0, limit: 5 }, signal);
  assert.deepEqual((dated.docs[0] as { at: unknown }).at, { $date: '2024-01-02T00:00:00Z' });
});

test('insert, replace, remove', { skip }, async () => {
  const key = (await driver.insert(ref, '{name: "Di", age: NumberInt(19)}')) as { _id: { $oid: string } };
  assert.match(key._id.$oid, /^[0-9a-f]{24}$/);
  await driver.replace(ref, key, `{_id: ObjectId("${key._id.$oid}"), name: "Dee", age: 20}`);
  const r = await driver.find({ ref, filter: `{_id: ObjectId("${key._id.$oid}")}`, skip: 0, limit: 1 }, signal);
  assert.deepEqual(r.docs, [{ _id: key._id, name: 'Dee', age: 20 }]);
  await assert.rejects(driver.replace(ref, key, '{_id: 5, name: "x"}'), /can’t change/);
  assert.equal(await driver.remove(ref, [key, { _id: 2 }]), 2);
});

test('the console: mongosh lines', { skip }, async () => {
  const found = await run('db.people.find({}, {_id: 0}).sort({name: 1}).limit(1)');
  assert.deepEqual(found.result, [{ name: 'Ann', age: 41, at: { $date: '2024-01-02T00:00:00Z' } }]);
  assert.equal((await run('db.people.countDocuments({age: {$lt: 50}})')).result, 2);
  assert.deepEqual((await run("db.people.distinct('name')")).result, ['Ann', 'Cy']);
  assert.deepEqual((await run('db.people.aggregate([{$group: {_id: null, n: {$sum: 1}}}])')).result, [{ _id: null, n: 2 }]);
  const used = await run('use admin\ndb.runCommand({ping: 1})');
  assert.equal(used.database, 'admin');
  assert.equal((used.result as { ok: number }).ok, 1);
  assert.ok(((await run('show collections')).result as string[]).includes('people'));
  assert.ok(((await run('show dbs')).result as { name: string }[]).some((d) => d.name === 'hp_test'));
  const upd = (await run('db.people.updateMany({name: /^a/i}, {$set: {seen: true}})')).result as { modifiedCount: number };
  assert.equal(upd.modifiedCount, 1);
  await assert.rejects(run('db.people.fly()'), /isn’t something/);
});
