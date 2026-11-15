// The Rows port's value (src/client/lib/rows.ts): rows as objects by
// column name, a thousand at most, bytes as a short note.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ROWS, rowsOut } from '../../src/client/lib/rows.ts';

describe('rowsOut', () => {
  test('rows by column name, with the statement and connection', () => {
    const out = rowsOut({ statement: 'SELECT id, name FROM users', columns: [{ name: 'id' }, { name: 'name' }], rows: [[1, 'Ada'], [2, null]], ms: 3 }, 'local');
    assert.deepEqual(out, { columns: ['id', 'name'], rows: [{ id: 1, name: 'Ada' }, { id: 2, name: null }], truncated: false, statement: 'SELECT id, name FROM users', connection: 'local' });
  });

  test('no columns gives null', () => {
    assert.equal(rowsOut({ columns: [], rows: [], ms: 1, command: 'UPDATE 3' }, 'local'), null);
  });

  test('at most a thousand rows, then truncated', () => {
    const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => [i]);
    const out = rowsOut({ columns: [{ name: 'n' }], rows, ms: 1 }, 'local')!;
    assert.equal(out.rows.length, MAX_ROWS);
    assert.equal(out.truncated, true);
    assert.deepEqual(out.rows.at(-1), { n: MAX_ROWS - 1 });
    assert.equal(rowsOut({ columns: [{ name: 'n' }], rows: [[1]], ms: 1, truncated: true }, 'local')!.truncated, true);
  });

  test('bytes become a note; JSON stays as it is', () => {
    const out = rowsOut({ columns: [{ name: 'blob' }, { name: 'doc' }], rows: [[{ $bytes: 'AAEC', size: 3 }, { a: [1, 2] }]], ms: 1 }, 'local')!;
    assert.deepEqual(out.rows[0], { blob: '<bytes 3 B>', doc: { a: [1, 2] } });
  });

  test('a name used twice keeps both values', () => {
    const out = rowsOut({ columns: [{ name: 'id' }, { name: 'id' }, { name: 'id' }], rows: [[1, 2, 3]], ms: 1 }, 'local')!;
    assert.deepEqual(out.columns, ['id', 'id (2)', 'id (3)']);
    assert.deepEqual(out.rows[0], { id: 1, 'id (2)': 2, 'id (3)': 3 });
  });

  test('a statement given overrides the result’s, and none is left out', () => {
    assert.equal(rowsOut({ columns: [{ name: 'n' }], rows: [], ms: 1 }, 'local', 'SELECT * FROM t')!.statement, 'SELECT * FROM t');
    assert.equal('statement' in rowsOut({ columns: [{ name: 'n' }], rows: [], ms: 1 }, 'local')!, false);
  });
});
