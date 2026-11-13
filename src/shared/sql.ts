// SQL text, as both ends need it: split into statements (quotes, comments
// and PostgreSQL's dollar quotes taken into account), told whether it
// reads or writes, and names quoted for each dialect.

import type { Cell, Column, QueryResult } from './types.ts';

export type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'clickhouse';

/** Statements in a text, each trimmed, empty ones left out. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) i += text[i] === '\\' && q !== '"' ? 2 : 1;
      i++;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '#' && /(^|\n)\s*$/.test(text.slice(start, i))) {
      // MySQL's # comments, only where a line starts with one.
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(text.slice(i, i + 64))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64))![0];
      const end = text.indexOf(tag, i + tag.length);
      i = end < 0 ? text.length : end + tag.length;
    } else if (c === ';') {
      out.push(text.slice(start, i));
      i++;
      start = i;
    } else i++;
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(s));
}

/** The first word, past comments: SELECT, UPDATE, WITH… */
export function verb(statement: string): string {
  const s = statement.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '');
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? '').toUpperCase();
}

const READS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'PRAGMA', 'VALUES', 'TABLE', 'WITH', 'EXISTS', 'USE', 'SET']);

/** Looks like it only reads (for read-only connections: a guess, the
 * database's own permissions are what count). */
export function readsOnly(statement: string): boolean {
  const v = verb(statement);
  if (!READS.has(v)) return false;
  if (v === 'WITH') return !/\b(insert|update|delete|merge)\b/i.test(statement.replace(/'(?:[^']|'')*'/g, "''"));
  if (v === 'PRAGMA') return !/=/.test(statement);
  if (v === 'EXPLAIN') return !/\banalyze\b/i.test(statement) || readsOnly(statement.replace(/^\s*explain\s+(analyze\s+)?(\([^)]*\)\s*)?/i, ''));
  return true;
}

/** A name quoted for the dialect. */
export function ident(d: Dialect, name: string): string {
  if (d === 'mysql' || d === 'clickhouse') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** schema.table (or db.table), each part quoted. */
export function qualified(d: Dialect, t: { database?: string; schema?: string; table: string }): string {
  const parts: string[] = [];
  if (d === 'postgres' && t.schema) parts.push(t.schema);
  if ((d === 'mysql' || d === 'clickhouse') && t.database) parts.push(t.database);
  if (d === 'sqlite' && t.schema && t.schema !== 'main') parts.push(t.schema);
  parts.push(t.table);
  return parts.map((p) => ident(d, p)).join('.');
}

// ---------------------------------------------------------------- types

export interface TableRef {
  database?: string;
  schema?: string;
  table: string;
}

export interface BrowseRequest {
  table: TableRef;
  offset: number;
  limit: number;
  /** A WHERE clause as typed, without the WHERE. */
  where?: string;
  /** Columns and directions. */
  order?: { column: string; desc: boolean }[];
}

export interface BrowseResult extends QueryResult {
  /** Every row, when counting them was quick; else null. */
  total: number | null;
  /** Rows can be changed (it has a primary key, or a rowid). */
  editable: boolean;
  /** The SELECT it ran, to open in a console. */
  sql: string;
}

export interface TableInfo {
  columns: Column[];
  indexes: { name: string; columns: string[]; unique: boolean; primary: boolean }[];
  foreignKeys: { name: string; columns: string[]; table: string; to: string[] }[];
  /** CREATE TABLE …, as the database has it or as it's put together. */
  ddl: string;
  rows: number | null;
}

export type RowEdit = { op: 'update'; key: Record<string, Cell>; set: Record<string, Cell> } | { op: 'insert'; values: Record<string, Cell> } | { op: 'delete'; key: Record<string, Cell> };
