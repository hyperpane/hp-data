// RabbitMQ for real, through its management API at localhost:15672
// (docker run -d --name hp-data-rabbitmq -p 5672:5672 -p 15672:15672
// rabbitmq:4-management); skipped when nothing answers there.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { KINDS, withDefaults } from '../../src/shared/kinds.ts';
import { rabbitmq } from '../../src/server/drivers/queue/rabbitmq.ts';
import type { QueueDriver } from '../../src/server/drivers/types.ts';

const up = await fetch('http://localhost:15672/api/overview', {
  headers: { authorization: `Basic ${btoa('guest:guest')}` },
  signal: AbortSignal.timeout(1500),
}).then(
  (r) => r.ok,
  () => false,
);
const skip = up ? false : 'RabbitMQ’s management API isn’t at localhost:15672';
const kind = KINDS.find((k) => k.id === 'rabbitmq')!;
const queue = `hp-test-${Date.now().toString(36)}`;
const ref = { vhost: '/', queue };
const signal = new AbortController().signal;
let d: QueueDriver;

before(async () => {
  if (!up) return;
  d = rabbitmq({ kind, values: withDefaults(kind, { password: 'guest' }), folder: null, dataDir: '/tmp', log: () => {} }) as QueueDriver;
  await d.create(ref, { durable: true });
});
after(async () => {
  if (!up) return;
  await d.remove(ref).catch(() => {});
  await d.close();
});

test('info and the tree', { skip }, async () => {
  assert.match((await d.info()).version, /^RabbitMQ \d/);
  assert.ok((await d.children([])).some((n) => n.name === '/'));
  assert.deepEqual(
    (await d.children(['/'])).map((n) => n.name),
    ['Queues', 'Exchanges'],
  );
  const qs = await d.children(['/', 'Queues']);
  assert.deepEqual(qs.find((q) => q.name === queue)?.open, { tab: 'queue', ref, title: queue });
  assert.ok((await d.children(['/', 'Exchanges'])).some((x) => x.name === 'amq.direct' && x.open?.ref.exchange === 'amq.direct'));
});

test('publish, then peek: the messages stay, marked redelivered', { skip }, async () => {
  await d.publish({ ref, value: '{"n":1}', headers: { h: 'x' } });
  await d.publish({ ref, value: 'two' });
  const first = await d.peek({ ref, limit: 10 }, signal);
  assert.deepEqual(
    first.map((m) => m.value),
    ['{"n":1}', 'two'],
  );
  assert.equal(first[0].headers?.h, 'x');
  const again = await d.peek({ ref, limit: 10 }, signal);
  assert.equal(again.length, 2);
  assert.equal(again[0].meta?.redelivered, true);
});

test('an exchange: publish with a routing key, bindings, no peek', { skip }, async () => {
  const x = { vhost: '/', exchange: 'amq.direct' };
  await assert.rejects(d.peek({ ref: x, limit: 1 }, signal), /keeps no messages/);
  await assert.rejects(d.publish({ ref: x, value: 'v', routingKey: `${queue}-nobody` }), /dropped/);
  const info = await d.describe(x);
  assert.equal(info.stats[0].value, 'direct');
});

test('tail says why not', { skip }, async () => {
  await assert.rejects(
    d.tail(ref, () => true, signal),
    /without taking them/,
  );
});

test('describe and purge', { skip }, async () => {
  const info = await d.describe(ref);
  assert.ok(info.bindings?.some((b) => b.routingKey === queue));
  await d.purge(ref);
  assert.deepEqual(await d.peek({ ref, limit: 10 }, signal), []);
});

test('a missing queue says so', { skip }, async () => {
  await assert.rejects(d.describe({ vhost: '/', queue: `${queue}-missing` }), /isn’t there/);
});
