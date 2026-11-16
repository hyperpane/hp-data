// What the SQL drivers share: the SELECT a table's page is, the
// statements an edit is (with placeholders, values bound, never pasted
// in), and a DDL put together from columns when the database has none.

import { PluginError } from '@hyperpane/sdk/server';
import { type Dialect, ident, qualified } from '../../../shared/sql.ts';
import type { Cell, Column } from '../../../shared/types.ts';
import type { BrowseRequest, RowEdit, TableInfo, TableRef } from '../../../shared/sql.ts';
import { fromCell } from '../cells.ts';

export interface Statement {
  sql: string;
  params: unknown[];
}

/** `$1` for PostgreSQL, `?` for the rest. */
const placeholder = (d: Dialect, n: number) => (d === 'postgres' ? `$${n}` : '?');

/** A WHERE as typed: refused when it would end the statement. */
function checkWhere(where: string): string {
  const w = where.trim().replace(/;+\s*$/, '');
  if (/;/.test(w.replace(/'(?:[^']|'')*'/g, "''"))) throw new PluginError('The filter is one condition: leave out the “;”.');
  return w;
}

export function browseSql(d: Dialect, r: BrowseRequest): { select: string; count: string } {
  const from = qualified(d, r.table);
  const where = r.where?.trim() ? ` WHERE ${checkWhere(r.where)}` : '';
  const order = r.order?.length ? ` ORDER BY ${r.order.map((o) => `${ident(d, o.column)}${o.desc ? ' DESC' : ''}`).join(', ')}` : '';
  const limit = Math.max(1, Math.min(10_000, Math.trunc(r.limit)));
  const offset = Math.max(0, Math.trunc(r.offset));
  return {
    select: `SELECT * FROM ${from}${where}${order} LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''}`,
    count: `SELECT COUNT(*) AS n FROM ${from}${where}`,
  };
}

/** One statement per edit, in order: deletes, updates, inserts. */
export function editStatements(d: Dialect, t: TableRef, edits: RowEdit[]): Statement[] {
  const table = qualified(d, t);
  const out: Statement[] = [];
  const keyed = (key: Record<string, Cell>, params: unknown[]) => {
    const names = Object.keys(key);
    if (!names.length) throw new PluginError('This table has no primary key, so a row can’t be told apart: change it with a statement in a console.');
    return names
      .map((k) => {
        const v = key[k];
        if (v === null) return `${ident(d, k)} IS NULL`;
        params.push(fromCell(v));
        return `${ident(d, k)} = ${placeholder(d, params.length)}`;
      })
      .join(' AND ');
  };
  const order = { delete: 0, update: 1, insert: 2 };
  for (const e of [...edits].sort((a, b) => order[a.op] - order[b.op])) {
    const params: unknown[] = [];
    if (e.op === 'delete') out.push({ sql: `DELETE FROM ${table} WHERE ${keyed(e.key, params)}`, params });
    else if (e.op === 'update') {
      const sets = Object.entries(e.set).map(([k, v]) => {
        params.push(fromCell(v));
        return `${ident(d, k)} = ${placeholder(d, params.length)}`;
      });
      if (!sets.length) continue;
      const where = keyed(e.key, params);
      out.push({ sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, params });
    } else {
      const names = Object.keys(e.values);
      if (!names.length) out.push({ sql: d === 'mysql' ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES`, params });
      else {
        const marks = names.map((k) => {
          params.push(fromCell(e.values[k]));
          return placeholder(d, params.length);
        });
        out.push({ sql: `INSERT INTO ${table} (${names.map((k) => ident(d, k)).join(', ')}) VALUES (${marks.join(', ')})`, params });
      }
    }
  }
  return out;
}

/** A CREATE TABLE from what's known of it. */
export function ddlOf(d: Dialect, t: TableRef, info: Pick<TableInfo, 'columns' | 'indexes' | 'foreignKeys'>): string {
  const lines = info.columns.map((c) => `  ${ident(d, c.name)} ${c.type ?? ''}${c.nullable === false ? ' NOT NULL' : ''}`.trimEnd());
  const pk = info.columns.filter((c) => c.key).map((c) => ident(d, c.name));
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
  for (const f of info.foreignKeys)
    lines.push(
      `  CONSTRAINT ${ident(d, f.name)} FOREIGN KEY (${f.columns.map((c) => ident(d, c)).join(', ')}) REFERENCES ${f.table} (${f.to.map((c) => ident(d, c)).join(', ')})`,
    );
  const idx = info.indexes
    .filter((i) => !i.primary)
    .map((i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${ident(d, i.name)} ON ${qualified(d, t)} (${i.columns.map((c) => ident(d, c)).join(', ')});`);
  return [`CREATE TABLE ${qualified(d, t)} (\n${lines.join(',\n')}\n);`, ...idx].join('\n');
}

/** Rows as arrays in the columns' order. */
export const rowsOf = (columns: Column[], rows: Record<string, unknown>[], cell: (v: unknown) => Cell): Cell[][] =>
  rows.map((r) => columns.map((c) => cell(r[c.name])));

/** At most `limit` rows, and whether there were more. */
export function cap<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  return rows.length > limit ? { rows: rows.slice(0, limit), truncated: true } : { rows, truncated: false };
}
