// The document family's pure parts: relaxed JSON with the shell's
// literals, mongosh lines, Dev Tools requests, DynamoDB's attribute
// values, and telling writes from reads in a console.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRelaxed } from '../../src/server/drivers/document/relaxed.ts';
import { parseShell, shellWrites } from '../../src/server/drivers/document/shell.ts';
import { devToolsWrites, parseDevTools } from '../../src/server/drivers/document/devtools.ts';
import { marshall, unmarshall } from '../../src/server/drivers/document/dynamo-json.ts';
import { partiqlWrites, selectOf, splitStatements } from '../../src/server/drivers/document/dynamodb.ts';
import { parseSort, searchBody } from '../../src/server/drivers/document/elasticsearch.ts';

test('relaxed JSON: plain JSON as it is', () => {
  assert.deepEqual(parseRelaxed('{"a": [1, 2.5, -3e2, true, null, "x\\n"]}'), { a: [1, 2.5, -300, true, null, 'x\n'] });
  assert.equal(parseRelaxed('  '), undefined);
});

test('relaxed JSON: unquoted keys, single quotes, trailing commas, comments', () => {
  assert.deepEqual(parseRelaxed("{ age: { $gt: 30, }, 'name': 'Ann', address.city: 'Oslo', // why\n /* more */ }"), { age: { $gt: 30 }, name: 'Ann', 'address.city': 'Oslo' });
});

test('relaxed JSON: the shell’s literals as Extended JSON', () => {
  assert.deepEqual(parseRelaxed('ObjectId("64b7f0c2a1b2c3d4e5f60718")'), { $oid: '64b7f0c2a1b2c3d4e5f60718' });
  assert.deepEqual(parseRelaxed('ISODate("2024-01-02T03:04:05Z")'), { $date: '2024-01-02T03:04:05.000Z' });
  assert.deepEqual(parseRelaxed('new Date("2024-01-02")'), { $date: '2024-01-02T00:00:00.000Z' });
  assert.deepEqual(parseRelaxed('NumberLong("9007199254740993")'), { $numberLong: '9007199254740993' });
  assert.deepEqual(parseRelaxed('NumberInt(5)'), { $numberInt: '5' });
  assert.deepEqual(parseRelaxed('NumberDecimal("1.10")'), { $numberDecimal: '1.10' });
  assert.deepEqual(parseRelaxed('{name: /^an[/]n\\//i}'), { name: { $regularExpression: { pattern: '^an[/]n/', options: 'i' } } });
  assert.deepEqual(parseRelaxed('[MinKey, MaxKey(), undefined]'), [{ $minKey: 1 }, { $maxKey: 1 }, null]);
  assert.deepEqual(parseRelaxed('9007199254740993'), { $numberLong: '9007199254740993' });
  assert.match((parseRelaxed('ObjectId()') as { $oid: string }).$oid, /^[0-9a-f]{24}$/);
});

test('relaxed JSON: mistakes say where', () => {
  assert.throws(() => parseRelaxed('{a: 1,\n b: }'), /line 2, column 5/);
  assert.throws(() => parseRelaxed('{a: "x}'), /isn’t closed/);
  assert.throws(() => parseRelaxed('ObjectId("12")'), /24 hexadecimal/);
  assert.throws(() => parseRelaxed('{a: 1} x'), /after the value/);
});

test('mongosh: a find with its cursor’s methods', () => {
  const [s] = parseShell('db.users.find({age:{$gt:30}}).sort({name:1}).limit(20)');
  assert.deepEqual(s, {
    kind: 'collection',
    database: undefined,
    collection: 'users',
    calls: [
      { name: 'find', args: [{ age: { $gt: 30 } }] },
      { name: 'sort', args: [{ name: 1 }] },
      { name: 'limit', args: [20] },
    ],
  });
});

test('mongosh: show, use, db’s own, getCollection, several statements', () => {
  const s = parseShell('use shop\nshow collections;\ndb.runCommand({ping: 1})\ndb.getCollection("a.b")\n  .aggregate([{$match: {}}])\ndb.system.users.findOne()\ndb');
  assert.deepEqual(
    s.map((x) => x.kind),
    ['use', 'show', 'db', 'collection', 'collection', 'db'],
  );
  assert.equal((s[0] as { database: string }).database, 'shop');
  assert.equal((s[3] as { collection: string }).collection, 'a.b');
  assert.equal((s[4] as { collection: string }).collection, 'system.users');
  assert.deepEqual(parseShell('db.getSiblingDB("x").stats()')[0], { kind: 'db', database: 'x', calls: [{ name: 'stats', args: [] }] });
  assert.throws(() => parseShell('db.users'), /Say what to do/);
  assert.throws(() => parseShell('users.find()'), /isn’t something/);
});

test('mongosh: writes told from reads', () => {
  assert.equal(shellWrites('db.users.find()'), false);
  assert.equal(shellWrites('db.users.insertOne({a: 1})'), true);
  assert.equal(shellWrites('db.runCommand({ping: 1})'), false);
  assert.equal(shellWrites('db.runCommand({drop: "users"})'), true);
  assert.equal(shellWrites('db.users.drop()'), true);
});

test('Dev Tools: requests, bodies, NDJSON, comments', () => {
  const r = parseDevTools('# indices\nGET /_cat/indices?v\n\nPOST logs/_search\n{\n  query: {match_all: {}}, // relaxed\n}\nPOST _bulk\n{"index": {"_index": "logs"}}\n{"msg": "hi"}\n');
  assert.deepEqual(r[0], { method: 'GET', path: '/_cat/indices?v' });
  assert.deepEqual(r[1], { method: 'POST', path: '/logs/_search', body: '{"query":{"match_all":{}}}' });
  assert.deepEqual(r[2], { method: 'POST', path: '/_bulk', body: '{"index":{"_index":"logs"}}\n{"msg":"hi"}\n', ndjson: true });
  assert.throws(() => parseDevTools('{"a": 1}'), /starts with a method/);
  assert.equal(devToolsWrites('POST /logs/_search\n{}'), false);
  assert.equal(devToolsWrites('GET /_cluster/health'), false);
  assert.equal(devToolsWrites('DELETE /logs'), true);
  assert.equal(devToolsWrites('POST /logs/_doc\n{"a": 1}'), true);
});

test('Elasticsearch: the filter, the sort', () => {
  assert.deepEqual(searchBody(''), { query: { match_all: {} } });
  assert.deepEqual(searchBody('status:500'), { query: { query_string: { query: 'status:500' } } });
  assert.deepEqual(searchBody('q=a'), { query: { query_string: { query: 'a' } } });
  assert.deepEqual(searchBody('{match: {msg: "x"}}'), { query: { match: { msg: 'x' } } });
  assert.deepEqual(searchBody('{query: {term: {a: 1}}, aggs: {}}'), { query: { term: { a: 1 } }, aggs: {} });
  assert.deepEqual(parseSort('ts:desc, name'), [{ ts: { order: 'desc' } }, { name: { order: 'asc' } }]);
  assert.deepEqual(parseSort('{"ts": "desc"}'), { ts: 'desc' });
});

test('DynamoDB: attribute values both ways', () => {
  const item = { id: { S: 'p1' }, price: { N: '12.5' }, big: { N: '12345678901234567890' }, ok: { BOOL: true }, none: { NULL: true as const }, tags: { SS: ['a', 'b'] }, dims: { M: { w: { N: '2' } } }, list: { L: [{ S: 'x' }, { N: '1' }] }, raw: { B: 'AAE=' } };
  const plain = unmarshall(item);
  assert.deepEqual(plain, { id: 'p1', price: 12.5, big: '12345678901234567890', ok: true, none: null, tags: ['a', 'b'], dims: { w: 2 }, list: ['x', 1], raw: { $binary: 'AAE=' } });
  assert.deepEqual(marshall({ id: 'p1', price: 12.5, dims: { w: 2 }, list: ['x', 1], none: null, raw: { $binary: 'AAE=' } }), { id: { S: 'p1' }, price: { N: '12.5' }, dims: { M: { w: { N: '2' } } }, list: { L: [{ S: 'x' }, { N: '1' }] }, none: { NULL: true }, raw: { B: 'AAE=' } });
});

test('DynamoDB: PartiQL', () => {
  assert.equal(selectOf('products', ''), 'SELECT * FROM "products"');
  assert.equal(selectOf('my"t', 'price > 10', 'id, name'), 'SELECT "id", "name" FROM "my""t" WHERE price > 10');
  assert.equal(selectOf('t', 'WHERE a = 1'), 'SELECT * FROM "t" WHERE a = 1');
  assert.deepEqual(splitStatements("SELECT * FROM t WHERE a = 'x;y'; DELETE FROM t WHERE id = 1;"), ["SELECT * FROM t WHERE a = 'x;y'", 'DELETE FROM t WHERE id = 1']);
  assert.equal(partiqlWrites('SELECT * FROM "t"'), false);
  assert.equal(partiqlWrites("UPDATE t SET a = 1 WHERE id = 'x'"), true);
  assert.equal(partiqlWrites('DescribeTable {"TableName": "t"}'), false);
  assert.equal(partiqlWrites('DeleteTable {"TableName": "t"}'), true);
});
