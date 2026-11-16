// SQLite, with Node's own node:sqlite: a file on the server (relative to
// the project's folder), nothing to install. Big integers stay exact; a
// table without a primary key is edited by its rowid.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { PluginError } from '@hyperpane/sdk/server';
import { ident } from '../../../shared/sql.ts';
import { splitStatements, verb } from '../../../shared/sql.ts';
import type { Column, QueryResult, TreeNode } from '../../../shared/types.ts';
import type { BrowseRequest, BrowseResult, RowEdit, TableInfo, TableRef } from '../../../shared/sql.ts';
import { since, toCell } from '../cells.ts';
import type { DriverContext, SqlDriver } from '../types.ts';
import { browseSql, editStatements } from './common.ts';

type Row = Record<string, unknown>;

function sqliteFile(file: string, folder: string | null): string {
  const f = file.trim().replace(/^~(?=\/|$)/, os.homedir());
  if (path.isAbsolute(f)) return f;
  if (!folder) throw new PluginError('A relative path is in a project’s folder: open Data in a project, or give the whole path.');
  return path.join(folder, f);
}

const sqlErr = (e: unknown) => new PluginError((e as Error).message.replace(/^SqliteError: /, ''));

export const sqlite = (ctx: DriverContext): SqlDriver => {
  const file = sqliteFile(String(ctx.values.file ?? ''), ctx.folder);
  const readOnly = !!ctx.values.readonly;
  let db: DatabaseSync | null = null;
  const open = () => {
    if (db) return db;
    if (!existsSync(file) && !ctx.values.create) throw new PluginError(`There’s no file ${file}: check the path, or tick “Create the file if it isn’t there”.`);
    try {
      db = new DatabaseSync(file, { readOnly, timeout: 3000 } as ConstructorParameters<typeof DatabaseSync>[1]);
    } catch (e) {
      throw sqlErr(e);
    }
    return db;
  };
  const all = (sql: string, ...params: unknown[]): Row[] => {
    try {
      const s = open().prepare(sql);
      s.setReadBigInts(true);
      return s.all(...(params as never[])) as Row[];
    } catch (e) {
      throw sqlErr(e);
    }
  };

  const columnsOf = (s: StatementSync): Column[] =>
    (s as unknown as { columns(): { name: string; type: string | null }[] }).columns().map((c) => ({ name: c.name, type: c.type?.toLowerCase() || undefined }));

  function run(statement: string, limit: number): QueryResult {
    const t0 = performance.now();
    const s = open().prepare(statement);
    s.setReadBigInts(true);
    const columns = columnsOf(s);
    if (columns.length) {
      const rows: unknown[][] = [];
      let truncated = false;
      for (const r of s.iterate() as Iterable<Row>) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        rows.push(Object.values(r).map(toCell));
      }
      return { statement, columns, rows: rows as QueryResult['rows'], command: `${verb(statement)} ${rows.length}`, affected: null, ms: since(t0), truncated };
    }
    const r = s.run();
    return { statement, columns: [], rows: [], command: `${verb(statement)} ${Number(r.changes)}`, affected: Number(r.changes), ms: since(t0) };
  }

  const describe = (t: TableRef): TableInfo => {
    const cols = all(`PRAGMA table_xinfo(${ident('sqlite', t.table)})`);
    if (!cols.length) throw new PluginError(`There’s no table ${t.table}.`);
    const indexes = all(`PRAGMA index_list(${ident('sqlite', t.table)})`).map((i) => ({
      name: String(i.name),
      unique: Number(i.unique) === 1,
      primary: i.origin === 'pk',
      columns: all(`PRAGMA index_info(${ident('sqlite', String(i.name))})`).map((c) => String(c.name)),
    }));
    const fkMap = new Map<number, { name: string; columns: string[]; table: string; to: string[] }>();
    for (const f of all(`PRAGMA foreign_key_list(${ident('sqlite', t.table)})`)) {
      const id = Number(f.id);
      const k = fkMap.get(id) ?? { name: `fk_${id}`, columns: [], table: String(f.table), to: [] };
      k.columns.push(String(f.from));
      k.to.push(String(f.to ?? ''));
      fkMap.set(id, k);
    }
    const [m] = all("SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')", t.table);
    const ddl = [
      m?.sql ? `${m.sql};` : '',
      ...all("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type = 'index' AND sql IS NOT NULL", t.table).map((r) => `${r.sql};`),
    ]
      .filter(Boolean)
      .join('\n');
    let rows: number | null = null;
    try {
      rows = Number(all(`SELECT COUNT(*) AS n FROM ${ident('sqlite', t.table)}`)[0].n);
    } catch {}
    return {
      columns: cols.map((c) => ({
        name: String(c.name),
        type: String(c.type || '').toLowerCase() || undefined,
        key: Number(c.pk) > 0 || undefined,
        nullable: Number(c.notnull) === 0,
        hasDefault: c.dflt_value !== null || (Number(c.pk) > 0 && /^integer$/i.test(String(c.type))),
        readOnly: Number(c.hidden) > 1 || undefined,
      })),
      indexes,
      foreignKeys: [...fkMap.values()],
      ddl,
      rows,
    };
  };

  const isView = (name: string) => all('SELECT type FROM sqlite_master WHERE name = ?', name)[0]?.type === 'view';
  const withoutRowid = (name: string) => /without\s+rowid/i.test(String(all('SELECT sql FROM sqlite_master WHERE name = ?', name)[0]?.sql ?? ''));

  return {
    family: 'sql',

    async info() {
      const [r] = all('SELECT sqlite_version() AS v');
      return { version: `SQLite ${r.v}`, detail: `${path.basename(file)}${readOnly ? ' · read only' : ''}` };
    },

    async children(p: string[]): Promise<TreeNode[]> {
      if (p.length === 0) {
        const counts = all("SELECT type, COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type");
        const n = (t: string) => Number(counts.find((c) => c.type === t)?.n ?? 0);
        const out: TreeNode[] = [{ name: 'tables', label: 'Tables', type: 'folder', detail: String(n('table')), expand: true }];
        if (n('view')) out.push({ name: 'views', label: 'Views', type: 'folder', detail: String(n('view')) });
        if (n('trigger')) out.push({ name: 'triggers', label: 'Triggers', type: 'folder', detail: String(n('trigger')) });
        return out;
      }
      if (p.length === 1) {
        const type = p[0] === 'tables' ? 'table' : p[0] === 'views' ? 'view' : 'trigger';
        return all("SELECT name, tbl_name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", type).map((r) => ({
          name: String(r.name),
          type: type === 'trigger' ? 'trigger' : (type as 'table' | 'view'),
          detail: type === 'trigger' ? `on ${r.tbl_name}` : undefined,
          leaf: type === 'trigger',
          open: type === 'trigger' ? undefined : { tab: 'table', ref: { table: String(r.name) }, title: String(r.name) },
        }));
      }
      if (p.length === 2) {
        const info = describe({ table: p[1] });
        return [
          ...info.columns.map(
            (c): TreeNode => ({ name: c.name, type: c.key ? 'key' : 'column', detail: `${c.type ?? 'any'}${c.nullable ? '?' : ''}`, leaf: true }),
          ),
          ...info.indexes
            .filter((i) => !i.primary)
            .map((i): TreeNode => ({ name: `index:${i.name}`, label: i.name, type: 'index', detail: i.columns.join(', '), leaf: true })),
        ];
      }
      return [];
    },

    async query(sql, o) {
      const statements = splitStatements(sql);
      if (!statements.length) throw new PluginError('There’s nothing to run.');
      const results: QueryResult[] = [];
      for (const s of statements) {
        if (o.signal.aborted) throw new PluginError('Cancelled.');
        try {
          results.push(run(s, o.limit));
        } catch (e) {
          const err = sqlErr(e);
          if (results.length) err.message = `Statement ${results.length + 1} of ${statements.length}: ${err.message}`;
          throw err;
        }
      }
      return results;
    },

    async browse(r: BrowseRequest): Promise<BrowseResult> {
      const info = describe(r.table);
      const view = isView(r.table.table);
      const byRowid = !view && !info.columns.some((c) => c.key) && !withoutRowid(r.table.table);
      const { select, count } = browseSql('sqlite', r);
      const sql = byRowid ? select.replace(/^SELECT \*/, 'SELECT _rowid_, *') : select;
      const t0 = performance.now();
      let res: QueryResult;
      try {
        res = run(sql, r.limit);
      } catch (e) {
        throw sqlErr(e);
      }
      const byName = new Map(info.columns.map((c) => [c.name, c]));
      const columns = res.columns.map((c, i) =>
        byRowid && i === 0 ? { name: '_rowid_', type: 'rowid', key: true, readOnly: true } : { ...c, ...byName.get(c.name) },
      );
      let total: number | null = null;
      try {
        total = Number(all(count)[0].n);
      } catch {}
      return { ...res, columns, ms: since(t0), total, editable: !view && !readOnly && columns.some((c) => c.key), sql };
    },

    describe: async (t) => describe(t),

    async apply(t: TableRef, edits: RowEdit[]) {
      if (readOnly) throw new PluginError('The file is open read only.');
      const d = open();
      let affected = 0;
      d.exec('BEGIN');
      try {
        for (const s of editStatements('sqlite', t, edits)) {
          const st = d.prepare(s.sql);
          const r = st.run(...(s.params.map((x) => (typeof x === 'boolean' ? Number(x) : x)) as never[]));
          if (!/^INSERT/.test(s.sql) && Number(r.changes) === 0)
            throw new PluginError('A row was changed or removed since it was read: refresh, and make the change again.');
          affected += Number(r.changes);
        }
        d.exec('COMMIT');
        return { affected };
      } catch (e) {
        try {
          d.exec('ROLLBACK');
        } catch {}
        throw e instanceof PluginError ? e : sqlErr(e);
      }
    },

    async completions() {
      const tables = all("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
      return {
        tables: tables.map((t) => ({ name: String(t.name), columns: all(`PRAGMA table_info(${ident('sqlite', String(t.name))})`).map((c) => String(c.name)) })),
      };
    },

    async close() {
      try {
        db?.close();
      } catch {}
      db = null;
    },
  };
};
