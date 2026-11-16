// The bucket tab's key handling (client/families/object/paths.ts): names,
// parents, crumbs, rows sorted folders first, and what a file previews as.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crumbs, looksLikeText, nameOf, parentOf, rowsOf, shownAs, sortRows, typeFor } from '../../src/client/families/object/paths.ts';

test('names, parents, crumbs', () => {
  assert.equal(nameOf('a/b/c.txt'), 'c.txt');
  assert.equal(nameOf('a/b/'), 'b');
  assert.equal(parentOf('a/b/c.txt'), 'a/b/');
  assert.equal(parentOf('a/b/'), 'a/');
  assert.equal(parentOf('top.txt'), '');
  assert.deepEqual(crumbs('a/b/'), [
    { name: 'a', prefix: 'a/' },
    { name: 'b', prefix: 'a/b/' },
  ]);
  assert.deepEqual(crumbs(''), []);
});

test('rows: folders first, then by the column', () => {
  const rows = rowsOf(
    [
      {
        prefixes: ['p/z/', 'p/a/'],
        objects: [
          { key: 'p/file10.txt', size: 5, modified: 2 },
          { key: 'p/file2.txt', size: 50, modified: 1 },
        ],
        next: null,
      },
    ],
    'p/',
    false,
  );
  assert.deepEqual(
    sortRows(rows, { column: 'name', desc: false }).map((r) => r.name),
    ['a', 'z', 'file2.txt', 'file10.txt'],
  );
  assert.deepEqual(
    sortRows(rows, { column: 'name', desc: true }).map((r) => r.name),
    ['z', 'a', 'file10.txt', 'file2.txt'],
  );
  assert.deepEqual(
    sortRows(rows, { column: 'size', desc: true }).map((r) => r.name),
    ['a', 'z', 'file2.txt', 'file10.txt'],
  );
  assert.deepEqual(rowsOf([{ prefixes: [], objects: [{ key: 'p/q/r.txt', size: 1, modified: null }], next: null }], 'p/', true)[0].name, 'q/r.txt');
});

test('what a file previews as', () => {
  assert.equal(shownAs('a.png', 'image/png'), 'image');
  assert.equal(shownAs('a.svg', 'binary/octet-stream'), 'image');
  assert.equal(shownAs('a.json', 'application/octet-stream'), 'json');
  assert.equal(shownAs('x', 'application/json; charset=utf-8'), 'json');
  assert.equal(shownAs('a.log', null), 'text');
  assert.equal(shownAs('a.bin', 'application/octet-stream'), 'unknown');
  assert.ok(looksLikeText(new TextEncoder().encode('héllo ü')));
  assert.ok(looksLikeText(new TextEncoder().encode('ü').subarray(0, 1)) === false);
  assert.ok(!looksLikeText(new Uint8Array([1, 0, 2])));
  assert.equal(typeFor('a.json', ''), 'application/json');
  assert.equal(typeFor('a.json', 'text/x'), 'text/x');
});
