// Kafka for real, at localhost:9092 (docker run -d --name hp-data-kafka
// -p 9092:9092 apache/kafka:latest); skipped when nothing answers there.
// A topic of its own: made, published to, peeked, tailed, emptied, deleted.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { KINDS, withDefaults } from '../../src/shared/kinds.ts';
import type { Message } from '../../src/shared/queue.ts';
import { kafka } from '../../src/server/drivers/queue/kafka.ts';
import { Client } from '../../src/server/drivers/queue/kafka-client.ts';
import { rangesFor, withGroup } from '../../src/server/drivers/queue/kafka-read.ts';
import type { QueueDriver } from '../../src/server/drivers/types.ts';

const up = await new Promise<boolean>((res) => {
  const s = net.connect(9092, '127.0.0.1');
  s.setTimeout(800, () => {
    s.destroy();
    res(false);
  });
  s.on('connect', () => {
    s.end();
    res(true);
  });
  s.on('error', () => res(false));
});
const skip = up ? false : 'Kafka isn’t running at localhost:9092';
const kind = KINDS.find((k) => k.id === 'kafka')!;
const topic = `hp-test-${Date.now().toString(36)}`;
let d: QueueDriver;

before(async () => {
  if (!up) return;
  d = kafka({ kind, values: withDefaults(kind, {}), folder: null, dataDir: '/tmp', log: () => {} }) as QueueDriver;
  await d.create({ topic }, { partitions: 2, replication: 1 });
});
after(async () => {
  if (!up) return;
  await d.remove({ topic }).catch(() => {});
  await d.close();
});

test('info and the tree', { skip }, async () => {
  assert.match((await d.info()).version, /broker/);
  const topics = await d.children(['Topics']);
  assert.ok(topics.some((t) => t.name === topic && t.detail === '2 partitions' && t.open?.ref.topic === topic));
});

test('publish, then peek oldest, newest and from an offset', { skip }, async () => {
  // Apart in time: "the newest" across partitions is by timestamp.
  for (let i = 0; i < 6; i++) {
    await d.publish({ ref: { topic }, key: `k${i}`, value: JSON.stringify({ i }), headers: { n: String(i) }, partition: i % 2 });
    await new Promise((r) => setTimeout(r, 5));
  }
  const ctl = new AbortController();
  const oldest = await d.peek({ ref: { topic }, limit: 10, from: 'earliest' }, ctl.signal);
  assert.equal(oldest.length, 6);
  assert.deepEqual(new Set(oldest.map((m) => m.key)), new Set(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']));
  assert.equal(oldest.find((m) => m.key === 'k3')?.headers?.n, '3');
  const newest = await d.peek({ ref: { topic }, limit: 2, from: 'latest' }, ctl.signal);
  assert.deepEqual(newest.map((m) => m.key).sort(), ['k4', 'k5']);
  const at = await d.peek({ ref: { topic }, limit: 5, from: 'offset', partition: 1, offset: '1' }, ctl.signal);
  assert.deepEqual(
    at.map((m) => m.id),
    ['1:1', '1:2'],
  );
});

test('the slow way, by a group of its own, reads the same', { skip }, async () => {
  const c = new Client(withDefaults(kind, {}), () => {});
  try {
    const marks = (await (await c.admin()).fetchTopicOffsets(topic)).map((o) => ({ partition: o.partition, low: o.low, high: o.high }));
    const got = await withGroup(c, topic, marks, rangesFor({ from: 'earliest', limit: 10 }, marks), new AbortController().signal);
    assert.equal(got.length, 6);
    const groups = (await (await c.admin()).listGroups()).groups.map((g) => g.groupId);
    assert.ok(!groups.some((g) => g.startsWith('hyperpane-data-')), 'its group is gone');
  } finally {
    await c.close();
  }
});

test('describe: partitions and watermarks', { skip }, async () => {
  const info = await d.describe({ topic });
  assert.equal(info.partitions?.length, 2);
  assert.equal(info.stats.find((s) => s.label === 'Messages')?.value, '6');
  assert.deepEqual(
    info.partitions?.map((p) => p.high),
    ['3', '3'],
  );
});

test('a tail sends what’s published after it starts', { skip }, async () => {
  const ctl = new AbortController();
  const got: Message[] = [];
  const done = d.tail(
    { topic },
    (m) => {
      got.push(m);
      return true;
    },
    ctl.signal,
  );
  await new Promise((r) => setTimeout(r, 4000));
  await d.publish({ ref: { topic }, key: 'live', value: 'now' });
  for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 250));
  ctl.abort();
  await done;
  assert.deepEqual(
    got.map((m) => [m.key, m.value]),
    [['live', 'now']],
  );
});

test('purge empties it', { skip }, async () => {
  await d.purge({ topic });
  const info = await d.describe({ topic });
  assert.equal(info.stats.find((s) => s.label === 'Messages')?.value, '0');
  assert.deepEqual(await d.peek({ ref: { topic }, limit: 10, from: 'earliest' }, new AbortController().signal), []);
});

test('creating one that’s there says so', { skip }, async () => {
  await assert.rejects(d.create({ topic }, { partitions: 1 }), /already/);
});
