// SQS for real, at ElasticMQ on localhost:9324 (docker run -d --name
// hp-data-sqs -p 9324:9324 softwaremill/elasticmq-native), with its JSON
// protocol; skipped when nothing answers there.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { KINDS, withDefaults } from '../../src/shared/kinds.ts';
import type { Message } from '../../src/shared/queue.ts';
import { sqs } from '../../src/server/drivers/queue/sqs.ts';
import type { QueueDriver } from '../../src/server/drivers/types.ts';

const up = await fetch('http://localhost:9324/', { method: 'POST', headers: { 'x-amz-target': 'AmazonSQS.ListQueues', 'content-type': 'application/x-amz-json-1.0' }, body: '{}', signal: AbortSignal.timeout(1500) }).then(
  (r) => r.ok,
  () => false,
);
const skip = up ? false : 'ElasticMQ isn’t at localhost:9324';
const kind = KINDS.find((k) => k.id === 'sqs')!;
const queue = `hp-test-${Date.now().toString(36)}`;
const ref = { queue };
const signal = new AbortController().signal;
let d: QueueDriver;

before(async () => {
  if (!up) return;
  d = sqs({ kind, values: withDefaults(kind, { accessKeyId: 'x', secretAccessKey: 'x', endpoint: 'http://localhost:9324', region: 'elasticmq' }), folder: null, dataDir: '/tmp', log: () => {} }) as QueueDriver;
  await d.create(ref, {});
  await d.create({ queue: `${queue}.fifo` }, {});
});
after(async () => {
  if (!up) return;
  await d.remove(ref).catch(() => {});
  await d.remove({ queue: `${queue}.fifo` }).catch(() => {});
  await d.close();
});

test('info and the tree', { skip }, async () => {
  assert.match((await d.info()).version, /SQS/);
  const qs = await d.children([]);
  assert.deepEqual(qs.find((q) => q.name === queue)?.open, { tab: 'queue', ref, title: queue });
});

test('publish, then peek more than ten: they stay', { skip }, async () => {
  for (let i = 0; i < 14; i++) await d.publish({ ref, value: JSON.stringify({ i }), headers: { n: String(i) } });
  const got = await d.peek({ ref, limit: 50 }, signal);
  assert.equal(got.length, 14);
  assert.equal(new Set(got.map((m) => m.id)).size, 14);
  assert.ok(got.every((m) => m.headers?.n !== undefined));
  assert.equal((await d.peek({ ref, limit: 3 }, signal)).length, 3);
  const info = await d.describe(ref);
  assert.equal(info.stats.find((s) => s.label === 'Available')?.value, '14');
});

test('FIFO: a group, and a key on a standard queue is refused', { skip }, async () => {
  await d.publish({ ref: { queue: `${queue}.fifo` }, key: 'g1', value: 'first' });
  const [m] = await d.peek({ ref: { queue: `${queue}.fifo` }, limit: 5 }, signal);
  assert.equal(m.key, 'g1');
  await assert.rejects(d.publish({ ref, key: 'g', value: 'x' }), /FIFO/);
});

test('a tail sends only what it hasn’t seen', { skip }, async () => {
  const ctl = new AbortController();
  const got: Message[] = [];
  const done = d.tail(ref, (m) => (got.push(m), true), ctl.signal);
  await new Promise((r) => setTimeout(r, 1500));
  await d.publish({ ref, value: 'new one' });
  for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 250));
  ctl.abort();
  await done;
  assert.deepEqual(got.map((m) => m.value), ['new one']);
});

test('purge, and a missing queue', { skip }, async () => {
  await d.purge(ref);
  assert.deepEqual(await d.peek({ ref, limit: 10 }, signal), []);
  await assert.rejects(d.describe({ queue: `${queue}-missing` }));
});
