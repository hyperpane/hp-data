// The DynamoDB driver against DynamoDB Local (docker run -d --name
// hp-data-dynamodb -p 8000:8000 amazon/dynamodb-local); skipped when
// nothing answers.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, test } from 'node:test';
import { kindOf, withDefaults } from '../../src/shared/kinds.ts';
import { dynamodb } from '../../src/server/drivers/document/dynamodb.ts';
import type { DocFindResult } from '../../src/shared/document.ts';
import type { DocumentDriver } from '../../src/server/drivers/types.ts';

const up = await new Promise<boolean>((resolve) => {
  const s = net.connect(8000, '127.0.0.1', () => {
    s.destroy();
    resolve(true);
  });
  s.on('error', () => resolve(false));
  s.setTimeout(1000, () => {
    s.destroy();
    resolve(false);
  });
});
const skip = up ? false : 'no DynamoDB Local at localhost:8000';
const kind = kindOf('dynamodb')!;
const driver = up
  ? (dynamodb({
      kind,
      values: withDefaults(kind, { endpoint: 'http://localhost:8000', accessKeyId: 'test', secretAccessKey: 'test' }),
      folder: null,
      dataDir: '/tmp',
      log() {},
    }) as DocumentDriver)
  : null!;
const signal = new AbortController().signal;
const ref = { collection: 'hp_test_orders' };
const run = (text: string) => driver.command({ text, signal });

after(async () => {
  if (up) await run('DeleteTable {TableName: "hp_test_orders"}').catch(() => {});
});

test('info, a table made, the tree', { skip }, async () => {
  assert.equal((await driver.info()).version, 'DynamoDB Local');
  await run('DeleteTable {TableName: "hp_test_orders"}').catch(() => {});
  await run(
    'CreateTable {TableName: "hp_test_orders", AttributeDefinitions: [{AttributeName: "customer", AttributeType: "S"}, {AttributeName: "n", AttributeType: "N"}], KeySchema: [{AttributeName: "customer", KeyType: "HASH"}, {AttributeName: "n", KeyType: "RANGE"}], BillingMode: "PAY_PER_REQUEST"}',
  );
  for (let i = 1; i <= 5; i++) await driver.insert(ref, { customer: i % 2 ? 'ann' : 'bob', n: i, total: i * 10.5, items: [{ sku: `s${i}` }] });
  const node = (await driver.children([])).find((n) => n.name === 'hp_test_orders')!;
  assert.equal(node.open?.tab, 'collection');
});

test('find: a page at a time, a WHERE, keys', { skip }, async () => {
  const first = (await driver.find({ ref, filter: '', skip: 0, limit: 2 }, signal)) as DocFindResult;
  assert.deepEqual(first.idFields, ['customer', 'n']);
  assert.equal(first.docs.length, 2);
  assert.ok(first.next);
  const rest = (await driver.find({ ref, filter: '', skip: 0, limit: 10, token: first.next! } as never, signal)) as DocFindResult;
  assert.equal(rest.docs.length, 3);
  const ann = await driver.find({ ref, filter: "customer = 'ann' AND total > 20", projection: 'n', skip: 0, limit: 10 }, signal);
  assert.deepEqual(ann.docs, [{ n: 3 }, { n: 5 }]);
});

test('insert refuses a key that’s there, replace, remove', { skip }, async () => {
  await assert.rejects(driver.insert(ref, { customer: 'ann', n: 1 }), /already there/);
  await driver.replace(ref, { customer: 'ann', n: 1 }, '{customer: "ann", n: 1, total: 99}');
  await driver.replace(ref, { customer: 'ann', n: 3 }, { customer: 'ann', n: 33, total: 1 });
  const r = await driver.find({ ref, filter: "customer = 'ann'", skip: 0, limit: 10 }, signal);
  assert.deepEqual(
    r.docs.map((d) => [(d as { n: number }).n, (d as { total: number }).total]),
    [
      [1, 99],
      [5, 52.5],
      [33, 1],
    ],
  );
  assert.equal(await driver.remove(ref, [{ customer: 'ann', n: 33 }]), 1);
});

test('the console: PartiQL and the API', { skip }, async () => {
  const sel = await run(`SELECT * FROM "hp_test_orders" WHERE customer = 'bob'`);
  assert.equal((sel.result as unknown[]).length, 2);
  await run(`UPDATE "hp_test_orders" SET total = 0 WHERE customer = 'bob' AND n = 2`);
  const d = await run('DescribeTable {"TableName": "hp_test_orders"}');
  assert.equal((d.result as { Table: { TableName: string } }).Table.TableName, 'hp_test_orders');
});
