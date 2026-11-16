// ClickHouse, over its HTTP interface (port 8123): no driver to install.
// What reads comes back as JSONCompact with its columns' types; a result
// is capped on the server (max_result_rows, break), and a run that's
// cancelled is killed by its query id. Tables are read only here: rows in
// ClickHouse aren't edited one by one.

import { randomUUID } from 'node:crypto';
import { PluginError } from '@hyperpane/sdk/server';
import { splitStatements, verb } from '../../../shared/sql.ts';
import type { QueryResult, TreeNode } from '../../../shared/types.ts';
import type { BrowseRequest, BrowseResult, TableInfo, TableRef } from '../../../shared/sql.ts';
import { request } from '../../net/http.ts';
import { since, toCell } from '../cells.ts';
import type { DriverContext, SqlDriver } from '../types.ts';
import { browseSql } from './common.ts';
import { tlsOf } from '../../net/tls.ts';

const READS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'EXISTS', 'CHECK']);
const SYSTEM = "('system','INFORMATION_SCHEMA','information_schema')";

interface Compact {
  meta: { name: string; type: string }[];
  data: unknown[][];
  rows: number;
  statistics?: { elapsed: number };
}

const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const clickhouse = (ctx: DriverContext): SqlDriver => {
  const v = ctx.values;
  const base = `${v.https ? 'https' : 'http'}://${v.host}:${v.port ?? 8123}/`;
  const home = String(v.database ?? '') || 'default';
  const tls = tlsOf(v);
  const auth: Record<string, string> = { 'X-ClickHouse-User': String(v.user || 'default') };
  if (v.password) auth['X-ClickHouse-Key'] = String(v.password);

  async function send(
    sql: string,
    o: { database?: string; format?: boolean; limit?: number; signal?: AbortSignal; id?: string } = {},
  ): Promise<{ text: string; compact: Compact | null; summary: Record<string, string> }> {
    const url = new URL(base);
    url.searchParams.set('database', o.database || home);
    if (o.id) url.searchParams.set('query_id', o.id);
    if (o.limit) {
      url.searchParams.set('max_result_rows', String(o.limit + 1));
      url.searchParams.set('result_overflow_mode', 'break');
    }
    url.searchParams.set('output_format_json_quote_64bit_integers', '1');
    if (v.timezone) url.searchParams.set('session_timezone', String(v.timezone));
    if (Number(v.queryTimeout) > 0) url.searchParams.set('max_execution_time', String(Number(v.queryTimeout)));
    const body = o.format && !/\bformat\s+\w+\s*$/i.test(sql) ? `${sql}\nFORMAT JSONCompact` : sql;
    const res = await request({
      method: 'POST',
      url,
      headers: { ...auth, 'content-type': 'text/plain; charset=utf-8' },
      body,
      signal: o.signal,
      timeout: 300_000,
      tls,
    });
    const text = res.body.toString('utf8');
    if (res.status >= 400) {
      const m = /Code: (\d+)\.\s*DB::Exception: ([\s\S]*?)(?:\s*\(\w+\)\s*\(version[^)]*\))?\s*$/.exec(text);
      if (res.status === 401 || /AUTHENTICATION_FAILED|Authentication failed/.test(text)) throw new PluginError('The user or password is wrong.');
      throw new PluginError(m ? m[2].trim() : text.trim().slice(0, 1000) || `HTTP ${res.status}`);
    }
    let summary: Record<string, string> = {};
    try {
      summary = JSON.parse(String(res.headers['x-clickhouse-summary'] ?? '{}'));
    } catch {}
    let compact: Compact | null = null;
    if (o.format) {
      try {
        compact = JSON.parse(text) as Compact;
      } catch {}
    }
    return { text, compact, summary };
  }

  const rows = async <T = Record<string, unknown>>(sql: string, database?: string): Promise<T[]> => {
    const r = await send(sql, { database, format: true });
    return (r.compact?.data ?? []).map((row) => Object.fromEntries(r.compact!.meta.map((m, i) => [m.name, row[i]])) as T);
  };

  async function runOne(statement: string, o: { database?: string; limit: number; signal: AbortSignal }): Promise<QueryResult> {
    const t0 = performance.now();
    const id = randomUUID();
    const reads = READS.has(verb(statement));
    const onAbort = () => void send(`KILL QUERY WHERE query_id = ${lit(id)} SYNC`).catch(() => {});
    o.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await send(statement, { database: o.database, format: reads, limit: reads ? o.limit : undefined, signal: o.signal, id });
      if (r.compact) {
        const truncated = r.compact.data.length > o.limit;
        const data = truncated ? r.compact.data.slice(0, o.limit) : r.compact.data;
        return {
          statement,
          columns: r.compact.meta.map((m) => ({ name: m.name, type: m.type })),
          rows: data.map((row) => row.map(toCell)),
          command: `${verb(statement)} ${data.length}`,
          affected: null,
          ms: since(t0),
          truncated,
        };
      }
      const written = Number(r.summary.written_rows ?? 0);
      const text = r.text.trim();
      return {
        statement,
        columns: text ? [{ name: 'result', type: 'String' }] : [],
        rows: text ? text.split('\n').map((l) => [l]) : [],
        command: `${verb(statement)}${written ? ` ${written}` : ''}`,
        affected: written || null,
        ms: since(t0),
      };
    } finally {
      o.signal.removeEventListener('abort', onAbort);
    }
  }

  const describe = async (t: TableRef): Promise<TableInfo> => {
    const db = t.database || home;
    const cols = await rows<{ name: string; type: string; default_kind: string; is_in_primary_key: number; is_in_sorting_key: number }>(
      `SELECT name, type, default_kind, is_in_primary_key, is_in_sorting_key FROM system.columns WHERE database = ${lit(db)} AND table = ${lit(t.table)} ORDER BY position`,
    );
    if (!cols.length) throw new PluginError(`There’s no table ${db}.${t.table}.`);
    const [meta] = await rows<{ create_table_query: string; total_rows: string | null }>(
      `SELECT create_table_query, total_rows FROM system.tables WHERE database = ${lit(db)} AND name = ${lit(t.table)}`,
    );
    const sorting = cols.filter((c) => Number(c.is_in_sorting_key)).map((c) => c.name);
    return {
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        key: Number(c.is_in_primary_key) ? true : undefined,
        nullable: /^Nullable\(/.test(c.type),
        hasDefault: !!c.default_kind,
        readOnly: c.default_kind === 'MATERIALIZED' || c.default_kind === 'ALIAS' || undefined,
      })),
      indexes: sorting.length ? [{ name: 'ORDER BY', columns: sorting, unique: false, primary: true }] : [],
      foreignKeys: [],
      ddl: meta?.create_table_query ? `${meta.create_table_query};` : '',
      rows: meta?.total_rows === null || meta?.total_rows === undefined ? null : Number(meta.total_rows),
    };
  };

  return {
    family: 'sql',

    async info() {
      const [r] = await rows<{ v: string; u: string }>('SELECT version() AS v, currentUser() AS u');
      return { version: `ClickHouse ${r.v}`, detail: `${r.u} @ ${home}` };
    },

    async children(path: string[]): Promise<TreeNode[]> {
      if (path.length === 0) {
        const dbs = await rows<{ name: string; n: string }>(
          `SELECT d.name AS name, (SELECT count() FROM system.tables t WHERE t.database = d.name) AS n FROM system.databases d WHERE ${v.showSystem ? '1' : `d.name NOT IN ${SYSTEM}`} ORDER BY d.name = ${lit(home)} DESC, d.name`,
        );
        return dbs.map((d) => ({
          name: d.name,
          type: 'database',
          detail: Number(d.n) ? d.n : undefined,
          expand: d.name === home,
          open: { tab: 'console', ref: { database: d.name }, title: d.name },
        }));
      }
      if (path.length === 1) {
        const ts = await rows<{ name: string; engine: string; total_rows: string | null }>(
          `SELECT name, engine, total_rows FROM system.tables WHERE database = ${lit(path[0])} ORDER BY name`,
        );
        return ts.map((t) => ({
          name: t.name,
          type: /View/.test(t.engine) ? 'view' : 'table',
          detail: t.total_rows !== null ? `${Number(t.total_rows).toLocaleString('en')} rows` : t.engine,
          open: { tab: 'table', ref: { database: path[0], table: t.name }, title: t.name },
        }));
      }
      if (path.length === 2) {
        const info = await describe({ database: path[0], table: path[1] });
        return info.columns.map((c) => ({ name: c.name, type: c.key ? 'key' : 'column', detail: c.type, leaf: true }));
      }
      return [];
    },

    async query(sql, o) {
      const statements = splitStatements(sql);
      if (!statements.length) throw new PluginError('There’s nothing to run.');
      const results: QueryResult[] = [];
      for (const s of statements) {
        try {
          results.push(await runOne(s, { database: o.database, limit: o.limit, signal: o.signal }));
        } catch (e) {
          const err = e instanceof PluginError ? e : new PluginError((e as Error).message);
          if (results.length) err.message = `Statement ${results.length + 1} of ${statements.length}: ${err.message}`;
          throw err;
        }
      }
      return results;
    },

    async browse(r: BrowseRequest, signal): Promise<BrowseResult> {
      const table = { ...r.table, database: r.table.database || home };
      const info = await describe(table);
      const { select, count } = browseSql('clickhouse', { ...r, table });
      const res = await runOne(select, { database: table.database, limit: r.limit, signal });
      let total: number | null = null;
      try {
        total = Number((await rows<{ n: string }>(count, table.database))[0].n);
      } catch {}
      const byName = new Map(info.columns.map((c) => [c.name, c]));
      return { ...res, columns: res.columns.map((c) => ({ ...c, ...byName.get(c.name) })), total, editable: false, sql: select };
    },

    describe,

    async apply() {
      throw new PluginError('ClickHouse tables aren’t edited row by row: use ALTER TABLE … UPDATE or INSERT in a console.');
    },

    async completions(database) {
      const cols = await rows<{ database: string; table: string; name: string }>(
        `SELECT database, table, name FROM system.columns WHERE database NOT IN ${SYSTEM} ORDER BY database, table, position LIMIT 20000`,
      );
      const map = new Map<string, { schema?: string; name: string; columns: string[] }>();
      for (const c of cols) {
        const k = `${c.database}.${c.table}`;
        const t = map.get(k) ?? { schema: c.database === (database || home) ? undefined : c.database, name: c.table, columns: [] };
        t.columns.push(c.name);
        map.set(k, t);
      }
      return { tables: [...map.values()] };
    },

    async close() {},
  };
};
