// The SQL family: statement splitting, the SQL an edit becomes, and each
// driver against a real server (skipped when none answers: start them
// with docker, see the README's Develop).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { kindOf, withDefaults } from '../../src/shared/kinds.ts';
import { readsOnly, splitStatements } from '../../src/shared/sql.ts';
import { browseSql, editStatements } from '../../src/server/drivers/sql/common.ts';
import { clickhouse } from '../../src/server/drivers/sql/clickhouse.ts';
import { mysql } from '../../src/server/drivers/sql/mysql.ts';
import { postgres } from '../../src/server/drivers/sql/postgres.ts';
import { sqlite } from '../../src/server/drivers/sql/sqlite.ts';
import type { SqlDriver } from '../../src/server/drivers/types.ts';

const up = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });

const make = (factory: (c: never) => SqlDriver, kind: string, values: Record<string, string | number | boolean>, folder: string | null = null): SqlDriver =>
  factory({ kind: kindOf(kind)!, values: withDefaults(kindOf(kind)!, values), folder, dataDir: os.tmpdir(), log: () => {} } as never);

const signal = new AbortController().signal;

describe('SQL text', () => {
  test('splits statements, keeping quotes, comments and dollar quotes whole', () => {
    assert.deepEqual(splitStatements("select 1; select ';' -- a ; comment\n; select $$a;b$$;"), ['select 1', "select ';' -- a ; comment", 'select $$a;b$$']);
    assert.deepEqual(splitStatements('  ;; -- only a comment\n'), []);
    assert.deepEqual(splitStatements("insert into t values ('it''s; fine'); /* x; */ select 2"), ["insert into t values ('it''s; fine')", '/* x; */ select 2']);
  });
  test('tells reads from writes', () => {
    assert.ok(readsOnly('SELECT * FROM t'));
    assert.ok(readsOnly('  -- hi\n with a as (select 1) select * from a'));
    assert.ok(!readsOnly('with a as (delete from t returning *) select * from a'));
    assert.ok(!readsOnly('UPDATE t SET a = 1'));
    assert.ok(!readsOnly('explain analyze delete from t'));
    assert.ok(readsOnly('explain select 1'));
  });
  test('an edit is bound, never pasted in', () => {
    const s = editStatements('postgres', { schema: 'public', table: 'users' }, [
      { op: 'insert', values: { name: "O'Brien" } },
      { op: 'update', key: { id: 3 }, set: { name: 'x', note: null } },
      { op: 'delete', key: { id: 7 } },
    ]);
    assert.deepEqual(
      s.map((x) => x.sql),
      [
        'DELETE FROM "public"."users" WHERE "id" = $1',
        'UPDATE "public"."users" SET "name" = $1, "note" = $2 WHERE "id" = $3',
        'INSERT INTO "public"."users" ("name") VALUES ($1)',
      ],
    );
    assert.deepEqual(s[1].params, ['x', null, 3]);
    assert.equal(
      editStatements('mysql', { database: 'shop', table: 't' }, [{ op: 'delete', key: { a: 1, b: null } }])[0].sql,
      'DELETE FROM `shop`.`t` WHERE `a` = ? AND `b` IS NULL',
    );
  });
  test('a filter is one condition', () => {
    assert.match(
      browseSql('sqlite', { table: { table: 't' }, offset: 10, limit: 5, where: 'a > 1', order: [{ column: 'b', desc: true }] }).select,
      /^SELECT \* FROM "t" WHERE a > 1 ORDER BY "b" DESC LIMIT 5 OFFSET 10$/,
    );
    assert.throws(() => browseSql('sqlite', { table: { table: 't' }, offset: 0, limit: 5, where: '1=1; drop table t' }), /leave out/);
  });
});

describe('SQLite', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hp-data-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  test('runs, browses, edits by rowid and by key', async () => {
    const d = make(sqlite as never, 'sqlite', { file: 'app.db', create: true }, dir);
    const [, , r] = await d.query(
      "create table notes (body text, n integer); insert into notes values ('a', 1), ('b', 9007199254740993); select * from notes",
      { limit: 1, signal },
    );
    assert.equal(r.rows.length, 1);
    assert.ok(r.truncated);
    const page = await d.browse({ table: { table: 'notes' }, offset: 0, limit: 10 }, signal);
    assert.equal(page.columns[0].name, '_rowid_');
    assert.ok(page.editable);
    assert.equal(page.total, 2);
    assert.equal(page.rows[1][2], '9007199254740993');
    await d.apply({ table: 'notes' }, [{ op: 'update', key: { _rowid_: 1 }, set: { body: 'changed' } }]);
    assert.equal((await d.query('select body from notes where rowid = 1', { limit: 5, signal }))[0].rows[0][0], 'changed');
    await assert.rejects(d.apply({ table: 'notes' }, [{ op: 'delete', key: { _rowid_: 99 } }]), /changed or removed/);
    const tree = await d.children([]);
    assert.equal(tree[0].name, 'tables');
    assert.deepEqual(
      (await d.children(['tables'])).map((n) => n.name),
      ['notes'],
    );
    assert.match((await d.describe({ table: 'notes' })).ddl, /CREATE TABLE notes/);
    await d.close();
  });
  test('says when the file isn’t there', async () => {
    const d = make(sqlite as never, 'sqlite', { file: 'nope.db' }, dir);
    await assert.rejects(d.info(), /There’s no file/);
  });
});

describe('PostgreSQL', async () => {
  const live = await up(5432);
  const d = live ? make(postgres as never, 'postgresql', { host: 'localhost', user: 'postgres', password: 'postgres', database: 'shop' }) : null;
  after(() => d?.close());
  test('info, tree, describe', { skip: !live && 'no PostgreSQL on :5432' }, async () => {
    assert.match((await d!.info()).version, /^PostgreSQL \d+/);
    const dbs = await d!.children([]);
    assert.ok(dbs.some((x) => x.name === 'shop' && x.expand));
    const schemas = await d!.children(['shop']);
    assert.ok(schemas.some((s) => s.name === 'public') && schemas.some((s) => s.name === 'analytics'));
    const tables = await d!.children(['shop', 'public', 'tables']);
    assert.deepEqual(tables.map((t) => t.name).sort(), ['customers', 'orders', 'products']);
    const info = await d!.describe({ database: 'shop', schema: 'public', table: 'orders' });
    assert.ok(info.columns.find((c) => c.name === 'id')?.key);
    assert.equal(info.foreignKeys.length, 2);
    assert.match(info.ddl, /DEFAULT nextval/);
  });
  test('a console: cursor cap, several statements, a transaction across runs, cancel', { skip: !live && 'no PostgreSQL' }, async () => {
    const [r] = await d!.query('select * from orders', { limit: 100, signal });
    assert.equal(r.rows.length, 100);
    assert.ok(r.truncated);
    assert.equal(r.columns.find((c) => c.name === 'placed_at')?.type, 'timestamptz');
    const many = await d!.query("select 1 as a; select 'x'::text as b, null as c", { limit: 10, signal });
    assert.deepEqual(
      many.map((m) => m.rows[0]),
      [[1], ['x', null]],
    );
    await d!.query('begin; create temp table t (a int); insert into t values (1)', { limit: 10, signal });
    const [inTx] = await d!.query('select count(*) from t', { limit: 10, signal });
    assert.equal(inTx.rows[0][0], '1');
    await d!.query('rollback', { limit: 10, signal });
    await assert.rejects(d!.query('select nope from orders', { limit: 10, signal }), /column "nope" does not exist/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(d!.query('select pg_sleep(5)', { limit: 10, signal: ac.signal }), /Cancelled|canceling/);
  });
  test('browse and edit in one transaction', { skip: !live && 'no PostgreSQL' }, async () => {
    const page = await d!.browse(
      {
        table: { database: 'shop', schema: 'public', table: 'customers' },
        offset: 0,
        limit: 20,
        where: "country = 'DE'",
        order: [{ column: 'id', desc: true }],
      },
      signal,
    );
    assert.ok(page.editable);
    assert.ok(page.total! > 0 && page.rows.length <= 20);
    const id = page.rows[0][0];
    const old = page.rows[0][1];
    await d!.apply({ database: 'shop', schema: 'public', table: 'customers' }, [{ op: 'update', key: { id }, set: { name: 'Renamed' } }]);
    assert.equal((await d!.query(`select name from customers where id = ${id}`, { limit: 1, signal }))[0].rows[0][0], 'Renamed');
    await assert.rejects(
      d!.apply({ database: 'shop', schema: 'public', table: 'customers' }, [
        { op: 'update', key: { id }, set: { name: String(old) } },
        { op: 'delete', key: { id: -1 } },
      ]),
      /changed or removed/,
    );
    assert.equal((await d!.query(`select name from customers where id = ${id}`, { limit: 1, signal }))[0].rows[0][0], 'Renamed');
    await d!.apply({ database: 'shop', schema: 'public', table: 'customers' }, [{ op: 'update', key: { id }, set: { name: String(old) } }]);
    const c = await d!.completions('shop');
    assert.ok(c.tables.some((t) => t.name === 'events' && t.schema === 'analytics'));
  });
});

describe('MySQL', async () => {
  const live = await up(3306);
  const d = live ? make(mysql as never, 'mysql', { host: '127.0.0.1', user: 'root', password: 'mysql', database: 'shop' }) : null;
  after(() => d?.close());
  test('info, tree, console, browse, edit', { skip: !live && 'no MySQL on :3306' }, async () => {
    assert.match((await d!.info()).version, /^MySQL 8/);
    assert.ok((await d!.children([])).some((x) => x.name === 'shop'));
    assert.deepEqual(
      (await d!.children(['shop', 'tables'])).map((t) => t.name),
      ['customers', 'orders', 'products'],
    );
    const [r] = await d!.query('select * from orders', { limit: 50, signal });
    assert.equal(r.rows.length, 50);
    assert.ok(r.truncated);
    const page = await d!.browse({ table: { database: 'shop', table: 'products' }, offset: 0, limit: 10 }, signal);
    assert.ok(page.editable);
    assert.equal(page.total, 60);
    assert.equal(typeof page.rows[0][3], 'string');
    const id = page.rows[0][0];
    await d!.apply({ database: 'shop', table: 'products' }, [{ op: 'update', key: { id }, set: { stock: 7 } }]);
    await d!.apply({ database: 'shop', table: 'products' }, [{ op: 'update', key: { id }, set: { stock: 7 } }]);
    assert.match((await d!.describe({ database: 'shop', table: 'orders' })).ddl, /FOREIGN KEY/);
  });
});

describe('ClickHouse', async () => {
  const live = await up(8123);
  const d = live ? make(clickhouse as never, 'clickhouse', { host: 'localhost', user: 'default', password: 'clickhouse' }) : null;
  test('info, tree, console with a server-side cap', { skip: !live && 'no ClickHouse on :8123' }, async () => {
    assert.match((await d!.info()).version, /^ClickHouse \d/);
    assert.ok((await d!.children(['default'])).some((t) => t.name === 'hits'));
    const [r] = await d!.query('select * from hits', { limit: 25, signal });
    assert.equal(r.rows.length, 25);
    assert.ok(r.truncated);
    assert.equal(r.columns[0].type, 'DateTime');
    await assert.rejects(d!.query('select nope from hits', { limit: 5, signal }), /nope/);
    const page = await d!.browse({ table: { database: 'default', table: 'hits' }, offset: 0, limit: 5 }, signal);
    assert.equal(page.total, 20000);
    assert.equal(page.editable, false);
  });
});
