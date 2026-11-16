// The Elasticsearch / OpenSearch driver against a real server (OpenSearch 2
// with security off at localhost:9200); skipped when nothing answers.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { kindOf, withDefaults } from '../../src/shared/kinds.ts';
import { elasticsearch } from '../../src/server/drivers/document/elasticsearch.ts';
import type { CommandResult } from '../../src/shared/document.ts';
import type { DocumentDriver } from '../../src/server/drivers/types.ts';

const up = await fetch('http://127.0.0.1:9200/', { signal: AbortSignal.timeout(1500) }).then(
  (r) => r.ok,
  () => false,
);
const skip = up ? false : 'no Elasticsearch or OpenSearch at localhost:9200';
const kind = kindOf('opensearch')!;
const driver = up
  ? (elasticsearch({ kind, values: withDefaults(kind, { url: 'http://127.0.0.1:9200' }), folder: null, dataDir: '/tmp', log() {} }) as DocumentDriver)
  : null!;
const signal = new AbortController().signal;
const ref = { collection: 'hp-test-logs' };
const run = (text: string) => driver.command({ text, signal }) as Promise<CommandResult>;

after(async () => {
  if (up) await run('DELETE /hp-test-logs').catch(() => {});
});

test('info, and an index in the tree', { skip }, async () => {
  assert.match((await driver.info()).version, /^(OpenSearch|Elasticsearch) \d/);
  await run('DELETE /hp-test-logs').catch(() => {});
  await run('PUT /hp-test-logs\n{mappings: {properties: {level: {type: "keyword"}, n: {type: "integer"}, msg: {type: "text"}}}}');
  const bulk = await run(
    'POST /_bulk?refresh=true\n{"index": {"_index": "hp-test-logs", "_id": "a"}}\n{"level": "error", "n": 1, "msg": "disk full"}\n{"index": {"_index": "hp-test-logs", "_id": "b"}}\n{"level": "info", "n": 2, "msg": "started"}\n{"index": {"_index": "hp-test-logs", "_id": "c"}}\n{"level": "error", "n": 3, "msg": "timeout"}',
  );
  assert.equal((bulk.result as { errors: boolean }).errors, false);
  const tree = await driver.children([]);
  const node = tree.find((n) => n.name === 'hp-test-logs')!;
  assert.equal(node.type, 'collection');
  assert.match(node.detail ?? '', /^3/);
  assert.ok(!tree.some((n) => n.name.startsWith('.')));
});

test('find: query string, DSL, sort, source, paging', { skip }, async () => {
  const qs = await driver.find({ ref, filter: 'level:error', sort: 'n:desc', skip: 0, limit: 10 }, signal);
  assert.equal(qs.total, 2);
  assert.deepEqual(
    qs.docs.map((d) => (d as { _id: string })._id),
    ['c', 'a'],
  );
  const dsl = await driver.find({ ref, filter: '{match: {msg: "disk"}}', projection: 'level', skip: 0, limit: 10 }, signal);
  assert.deepEqual(dsl.docs, [{ _id: 'a', level: 'error' }]);
  const page = await driver.find({ ref, filter: '', sort: '{"n": "asc"}', skip: 1, limit: 1 }, signal);
  assert.deepEqual(page.docs, [{ _id: 'b', level: 'info', n: 2, msg: 'started' }]);
  assert.equal(page.total, 3);
});

test('insert, replace, remove', { skip }, async () => {
  assert.deepEqual(await driver.insert(ref, '{_id: "d", level: "warn", n: 4}'), { _id: 'd' });
  const auto = (await driver.insert(ref, { level: 'debug', n: 5 })) as { _id: string };
  await driver.replace(ref, { _id: 'd' }, { _id: 'd', level: 'warn', n: 40 });
  const r = await driver.find({ ref, filter: 'n:40', skip: 0, limit: 5 }, signal);
  assert.deepEqual(r.docs, [{ _id: 'd', level: 'warn', n: 40 }]);
  assert.equal(await driver.remove(ref, [{ _id: 'd' }, auto]), 2);
});

test('the console: Dev Tools requests, text answers', { skip }, async () => {
  const cat = await run('GET /_cat/indices?v');
  assert.equal(cat.text, true);
  assert.match(cat.result as string, /hp-test-logs/);
  const search = await run('POST /hp-test-logs/_count\n{query: {term: {level: "error"}}}');
  assert.equal((search.result as { count: number }).count, 2);
  const missing = await run('GET /hp-test-nothing/_search');
  assert.equal(missing.status, 404);
});
