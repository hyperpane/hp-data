// How the window shows and edits documents (families/document/format.ts):
// the shell's literals, text that the server reads back as it was, a page
// as a table, and the block of a console at the cursor.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyOf, oneLine, paragraphAt, pretty, requestAt, tableOf, toText } from '../../src/client/families/document/format.ts';
import { parseRelaxed } from '../../src/server/drivers/document/relaxed.ts';

const doc = { _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' }, at: { $date: '2024-01-02T00:00:00Z' }, n: { $numberLong: '9007199254740993' }, re: { $regularExpression: { pattern: 'a/b', options: 'i' } }, tags: ['x'], nested: { a: 1 } };

test('MongoDB’s wrappers as the shell writes them', () => {
  assert.deepEqual(pretty(doc, true), { _id: "ObjectId('64b7f0c2a1b2c3d4e5f60718')", at: "ISODate('2024-01-02T00:00:00Z')", n: "NumberLong('9007199254740993')", re: '/a\\/b/i', tags: ['x'], nested: { a: 1 } });
  assert.deepEqual(pretty(doc, false), doc);
  assert.match(oneLine(doc, true), /^\{ _id: ObjectId\('64b7f0c2a1b2c3d4e5f60718'\), at: ISODate/);
});

test('text to edit reads back as the same document', () => {
  const t = toText(doc, true);
  assert.match(t, /"_id": ObjectId\("64b7f0c2a1b2c3d4e5f60718"\)/);
  assert.deepEqual(parseRelaxed(t), { ...doc, at: { $date: '2024-01-02T00:00:00.000Z' } });
  assert.deepEqual(parseRelaxed(toText({ a: [1, { b: null }], s: 'q"' }, false)), { a: [1, { b: null }], s: 'q"' });
});

test('a page as a table, keys', () => {
  const t = tableOf([{ b: 1, _id: 1 }, { _id: 2, c: { d: 1 } }], ['_id'], false);
  assert.deepEqual(t.columns.map((c) => c.name), ['_id', 'b', 'c']);
  assert.deepEqual(t.rows, [[1, 1, null], [2, null, { d: 1 }]]);
  assert.deepEqual(keyOf({ _id: 'a', _index: 'logs-1', x: 1 }, ['_id']), { _id: 'a', _index: 'logs-1' });
  assert.equal(keyOf({ x: 1 }, ['pk']), null);
});

test('the block at the cursor', () => {
  const text = 'show dbs\n\ndb.a.find()\n  .limit(1)\n\n\ndb.b.find()';
  assert.equal(paragraphAt(text, text.indexOf('limit')), 'db.a.find()\n  .limit(1)');
  assert.equal(paragraphAt(text, 0), 'show dbs');
  assert.equal(paragraphAt(text, text.indexOf('limit(1)') + 10), 'db.a.find()\n  .limit(1)');
  const dev = 'GET /_cat/indices?v\n\nPOST /logs/_search\n{\n  "size": 1\n}\nGET /';
  assert.equal(requestAt(dev, dev.indexOf('size')), 'POST /logs/_search\n{\n  "size": 1\n}');
  assert.equal(requestAt(dev, 2), 'GET /_cat/indices?v\n');
});
