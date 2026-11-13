// The queue family through its calls (calls/queue.ts), against the
// RabbitMQ and SQS (ElasticMQ) of the other queue tests: describe, peek,
// publish, purge, a tail as a subscription, and a read-only connection
// refusing changes. Each part is skipped when its server isn't there.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { invoke, stream, testHost } from '@hyperpane/sdk/testing';
import type { Message, QueueInfo } from '../../src/shared/queue.ts';
import { make } from '../../src/server/plugin.ts';

const answers = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(1500) }).then(
    (r) => r.ok,
    () => false,
  );
const rabbitUp = await answers('http://localhost:15672/api/overview', { headers: { authorization: `Basic ${btoa('guest:guest')}` } });
const sqsUp = await answers('http://localhost:9324/', { method: 'POST', headers: { 'x-amz-target': 'AmazonSQS.ListQueues', 'content-type': 'application/x-amz-json-1.0' }, body: '{}' });

let plugin: ReturnType<ReturnType<typeof make>>;
const save = (name: string, kind: string, values: Record<string, unknown>, readOnly = false, secrets?: Record<string, string>) => invoke<{ id: string }>(plugin, { op: 'save', connection: { name, kind, readOnly, values, secrets } }).then((c) => c.id);

before(() => {
  plugin = make()(testHost({ id: 'data' }));
});
after(async () => {
  await plugin.shutdown?.();
});

describe('RabbitMQ through the calls', { skip: rabbitUp ? false : 'no RabbitMQ at localhost:15672' }, () => {
  const ref = { vhost: '/', queue: `hp-calls-${Date.now().toString(36)}` };
  let id = '';
  let ro = '';
  before(async () => {
    id = await save('rabbit', 'rabbitmq', { url: 'http://localhost:15672', user: 'guest' }, false, { password: 'guest' });
    ro = await save('rabbit (read only)', 'rabbitmq', { url: 'http://localhost:15672', user: 'guest' }, true, { password: 'guest' });
    await invoke(plugin, { op: 'qCreate', id, ref, durable: true });
  });
  after(async () => {
    await invoke(plugin, { op: 'qRemove', id, ref }).catch(() => {});
  });

  test('publish, peek, describe, purge', async () => {
    await invoke(plugin, { op: 'qPublish', id, ref, value: '{"a":1}', headers: { h: 'v' } });
    const got = await invoke<Message[]>(plugin, { op: 'qPeek', id, ref, limit: 10 });
    assert.deepEqual(got.map((m) => [m.value, m.headers?.h]), [['{"a":1}', 'v']]);
    const info = await invoke<QueueInfo>(plugin, { op: 'qDescribe', id, ref });
    assert.ok(info.stats.length > 3);
    await invoke(plugin, { op: 'qPurge', id, ref });
    assert.deepEqual(await invoke(plugin, { op: 'qPeek', id, ref, limit: 10 }), []);
  });

  test('a tail ends with why not', async () => {
    const s = stream(plugin, { op: 'qTail', id, ref });
    assert.match((await s.end) ?? '', /without taking them/);
  });

  test('read only: changes refused, looking allowed', async () => {
    await assert.rejects(invoke(plugin, { op: 'qPublish', id: ro, ref, value: 'x' }), /read only/);
    await assert.rejects(invoke(plugin, { op: 'qPurge', id: ro, ref }), /read only/);
    await assert.rejects(invoke(plugin, { op: 'qRemove', id: ro, ref }), /read only/);
    await assert.rejects(invoke(plugin, { op: 'qCreate', id: ro, ref: { vhost: '/', queue: 'nope' } }), /read only/);
    await invoke(plugin, { op: 'qPeek', id: ro, ref, limit: 1 });
  });
});

describe('SQS through the calls', { skip: sqsUp ? false : 'no ElasticMQ at localhost:9324' }, () => {
  const ref = { queue: `hp-calls-${Date.now().toString(36)}` };
  let id = '';
  before(async () => {
    id = await save('sqs', 'sqs', { accessKeyId: 'x', endpoint: 'http://localhost:9324', region: 'elasticmq' }, false, { secretAccessKey: 'x' });
    await invoke(plugin, { op: 'qCreate', id, ref });
  });
  after(async () => {
    await invoke(plugin, { op: 'qRemove', id, ref }).catch(() => {});
  });

  test('a tail as a subscription: what’s published after it starts', async () => {
    await invoke(plugin, { op: 'qPublish', id, ref, value: 'before' });
    const s = stream<Message>(plugin, { op: 'qTail', id, ref });
    await new Promise((r) => setTimeout(r, 1200));
    await invoke(plugin, { op: 'qPublish', id, ref, value: 'after' });
    const m = await Promise.race([s.next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('nothing came')), 8000))]);
    s.cancel();
    assert.equal(m.value, 'after');
    assert.equal(await s.end, null);
  });
});
