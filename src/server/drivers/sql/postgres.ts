// PostgreSQL (and what speaks its protocol: CockroachDB, TimescaleDB,
// Supabase, Neon, Redshift), with `pg`. A pool per database for the tree
// and table pages; a client of its own per database for consoles, so a
// BEGIN in one run is still open in the next. A SELECT without a limit is
// read through a cursor, so a big table gives its first rows, not all.

import pg from 'pg';
import { PluginError } from '@hyperpane/sdk/server';
import { ident, readsOnly, splitStatements, verb } from '../../../shared/sql.ts';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
import type { Column, QueryResult } from '../../../shared/types.ts';
import type { BrowseRequest, BrowseResult, RowEdit, TableInfo, TableRef } from '../../../shared/sql.ts';
import { since, toCell } from '../cells.ts';
import type { DriverContext, SqlDriver } from '../types.ts';
import { browseSql, cap, editStatements } from './common.ts';
import { pgChildren } from './postgres-tree.ts';
import { pgDescribe } from './postgres-describe.ts';
import { tlsOf } from '../../net/tls.ts';

// Dates, times, numerics and int8 as the server writes them: no time zone
// shifts, no lost digits.
const RAW = new Set([1082, 1083, 1114, 1184, 1266, 1700, 20, 1186]);
const types = { getTypeParser: (oid: number, format?: string) => (RAW.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')) };

export function pgError(e: unknown, where: string): Error {
  const err = e as Error & { code?: string; position?: string; detail?: string; hint?: string };
  const say: Record<string, string> = {
    '28P01': 'The password is wrong for that user.',
    '28000': 'That user may not sign in (pg_hba.conf, or no such role).',
    '3D000': `There’s no such database on ${where}.`,
    '57P03': `${where} is starting up: try again in a moment.`,
    '53300': `${where} has no connections left.`,
  };
  if (err.code === '57014') return new PluginError(/timeout/i.test(err.message) ? 'It ran longer than the statement timeout (Options), and was stopped.' : 'Cancelled.');
  if (err.code && say[err.code]) return new PluginError(say[err.code]);
  if (err.code === 'ECONNREFUSED') return new PluginError(`Nothing answers at ${where}: is PostgreSQL running, on that port?`);
  if (err.code === 'ENOTFOUND') return new PluginError(`There’s no host ${where.replace(/:\d+$/, '')}.`);
  if (/self[- ]signed|certificate/i.test(err.message)) return new PluginError(`${err.message}: set SSL to “On, any certificate” to accept it.`);
  if (/does not support SSL|SSL off|no pg_hba.conf entry.*SSL off/i.test(err.message)) return new PluginError(`${err.message}. Try another SSL setting.`);
  const parts = [err.message, err.detail ? `Detail: ${err.detail}` : null, err.hint ? `Hint: ${err.hint}` : null].filter(Boolean);
  return new PluginError(parts.join('\n'));
}

export const postgres = (ctx: DriverContext): SqlDriver => {
  const v = ctx.values;
  const where = `${v.host}:${v.port ?? 5432}`;
  const home = String(v.database ?? '') || 'postgres';
  const own = tlsOf(v);
  const ssl = v.ssl === 'require' ? { ...own, rejectUnauthorized: false } : v.ssl === 'verify' ? { ...own } : false;
  const pools = new Map<string, pg.Pool>();
  const consoles = new Map<string, { client: pg.Client; inTx: boolean; busy: Promise<unknown> }>();
  const typeNames = new Map<number, string>();
  const timeoutMs = Math.max(0, Math.round(Number(v.queryTimeout || 0) * 1000));
  const init = [
    v.searchPath ? `SET search_path TO ${String(v.searchPath).split(',').map((x) => ident('postgres', x.trim())).filter((x) => x !== '""').join(', ')}` : '',
    v.timezone ? `SET TIME ZONE ${lit(String(v.timezone))}` : '',
    timeoutMs ? `SET statement_timeout = ${timeoutMs}` : '',
    String(v.initSql ?? '').trim(),
  ]
    .filter(Boolean)
    .join(';\n');

  const config = (database: string): pg.ClientConfig => ({
    host: String(v.host),
    port: Number(v.port ?? 5432),
    user: String(v.user ?? '') || undefined,
    password: v.password ? String(v.password) : undefined,
    database,
    ssl,
    connectionTimeoutMillis: Number(v.timeout ?? 10) * 1000,
    application_name: String(v.applicationName || 'hyperpane Data'),
    types,
  });

  const pool = (database = home) => {
    let p = pools.get(database);
    if (!p) {
      p = new pg.Pool({ ...config(database), max: 4, idleTimeoutMillis: 60_000 });
      p.on('error', (e) => ctx.log(`postgres pool: ${e.message}`));
      pools.set(database, p);
    }
    return p;
  };

  // A pooled client, having run what runs on connect (once each).
  const ready = new WeakSet<pg.PoolClient>();
  const take = async (database: string): Promise<pg.PoolClient> => {
    const client = await pool(database).connect();
    if (init && !ready.has(client)) {
      try {
        await client.query(init);
      } catch (e) {
        client.release(true);
        throw new PluginError(`What runs on connect failed: ${(pgError(e, where) as Error).message}`);
      }
      ready.add(client);
    }
    return client;
  };

  const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = [], database = home): Promise<R[]> => {
    try {
      const client = await take(database);
      try {
        return (await client.query<R>(sql, params)).rows;
      } finally {
        client.release();
      }
    } catch (e) {
      throw pgError(e, where);
    }
  };

  const loadTypes = async (database: string) => {
    if (typeNames.size) return;
    for (const r of await q<{ oid: number; typname: string }>('SELECT oid::int, typname FROM pg_type', [], database)) typeNames.set(r.oid, r.typname);
  };

  const columnsOf = (fields: pg.FieldDef[], keys: Set<string> = new Set()): Column[] => fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID), key: keys.has(f.name) || undefined }));

  const consoleFor = async (database: string) => {
    let c = consoles.get(database);
    if (!c) {
      const client = new pg.Client(config(database));
      client.on('error', (e) => {
        ctx.log(`postgres console: ${e.message}`);
        consoles.delete(database);
      });
      try {
        await client.connect();
        if (init) await client.query(init);
      } catch (e) {
        throw pgError(e, where);
      }
      c = { client, inTx: false, busy: Promise.resolve() };
      consoles.set(database, c);
    }
    return c;
  };

  async function runOne(c: { client: pg.Client; inTx: boolean }, statement: string, limit: number): Promise<QueryResult> {
    const t0 = performance.now();
    const v0 = verb(statement);
    const cursor = readsOnly(statement) && ['SELECT', 'WITH', 'TABLE', 'VALUES'].includes(v0) && !/\blimit\s+\d+\s*$/i.test(statement);
    if (cursor) {
      const own = !c.inTx;
      if (own) await c.client.query('BEGIN');
      try {
        await c.client.query(`DECLARE hp_data_cursor NO SCROLL CURSOR FOR ${statement}`);
        const r = await c.client.query({ text: `FETCH ${limit + 1} FROM hp_data_cursor`, rowMode: 'array' });
        await c.client.query('CLOSE hp_data_cursor');
        if (own) await c.client.query('COMMIT');
        const { rows, truncated } = cap(r.rows as unknown[][], limit);
        return { statement, columns: columnsOf(r.fields), rows: rows.map((row) => row.map(toCell)), command: `SELECT ${rows.length}`, affected: null, ms: since(t0), truncated };
      } catch (e) {
        if (own) await c.client.query('ROLLBACK').catch(() => {});
        else await c.client.query('CLOSE hp_data_cursor').catch(() => {});
        throw e;
      }
    }
    const r = (await c.client.query({ text: statement, rowMode: 'array' })) as pg.QueryResult & { command: string };
    if (/^(BEGIN|START)$/.test(v0)) c.inTx = true;
    else if (/^(COMMIT|END|ROLLBACK|ABORT)$/.test(v0) && !/\bto\s+savepoint\b/i.test(statement)) c.inTx = false;
    const results = Array.isArray(r) ? (r as pg.QueryResult[]).at(-1)! : r;
    const { rows, truncated } = cap((results.rows ?? []) as unknown[][], limit);
    return {
      statement,
      columns: results.fields?.length ? columnsOf(results.fields) : [],
      rows: rows.map((row) => row.map(toCell)),
      command: [results.command, results.rowCount ?? ''].join(' ').trim(),
      affected: results.fields?.length ? null : (results.rowCount ?? null),
      ms: since(t0),
      truncated,
    };
  }

  const cancel = async (client: pg.Client, database: string) => {
    const pid = (client as unknown as { processID?: number }).processID;
    if (pid) await q('SELECT pg_cancel_backend($1)', [pid], database).catch(() => {});
  };

  return {
    family: 'sql',

    async info() {
      const [r] = await q<{ version: string; user: string; db: string }>('SELECT version() AS version, current_user AS user, current_database() AS db');
      const m = /^(\w+(?:DB)?)\s+(?:CCL\s+)?v?([\d.]+\w*)/.exec(r.version);
      return { version: m ? `${m[1]} ${m[2]}` : r.version.split(' on ')[0], detail: `${r.user} @ ${r.db}` };
    },

    children: (path) => pgChildren(q, path, home, String(v.database ?? ''), !!v.showSystem),

    async query(sql, o) {
      const database = o.database || home;
      const statements = splitStatements(sql);
      if (!statements.length) throw new PluginError('There’s nothing to run.');
      await loadTypes(database);
      const c = await consoleFor(database);
      const run = c.busy.then(async () => {
        const results: QueryResult[] = [];
        const onAbort = () => void cancel(c.client, database);
        o.signal.addEventListener('abort', onAbort, { once: true });
        try {
          for (const s of statements) {
            try {
              results.push(await runOne(c, s, o.limit));
            } catch (e) {
              const err = pgError(e, where);
              (err as Error & { results?: QueryResult[] }).results = results;
              if (results.length) err.message = `Statement ${results.length + 1} of ${statements.length}: ${err.message}`;
              throw err;
            }
          }
          return results;
        } finally {
          o.signal.removeEventListener('abort', onAbort);
        }
      });
      c.busy = run.catch(() => {});
      return run;
    },

    async browse(r: BrowseRequest, signal): Promise<BrowseResult> {
      const database = r.table.database || home;
      await loadTypes(database);
      const info = await pgDescribe(q, database, r.table);
      const keys = new Set(info.columns.filter((c) => c.key).map((c) => c.name));
      const { select, count } = browseSql('postgres', r);
      const t0 = performance.now();
      const client = await take(database);
      const onAbort = () => void cancel(client as unknown as pg.Client, database);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await client.query({ text: select, rowMode: 'array' });
        const ms = since(t0);
        let total: number | null = null;
        try {
          await client.query('SET statement_timeout = 1500');
          total = Number((await client.query(count)).rows[0].n);
        } catch {
          total = null;
        } finally {
          await client.query(`SET statement_timeout = ${timeoutMs}`).catch(() => {});
        }
        const byName = new Map(info.columns.map((c) => [c.name, c]));
        const columns = columnsOf(res.fields, keys).map((c) => ({ ...c, ...byName.get(c.name), type: byName.get(c.name)?.type ?? c.type }));
        return { columns, rows: (res.rows as unknown[][]).map((row) => row.map(toCell)), ms, total, editable: keys.size > 0, sql: select, command: `SELECT ${res.rowCount}` };
      } catch (e) {
        throw pgError(e, where);
      } finally {
        signal.removeEventListener('abort', onAbort);
        client.release();
      }
    },

    describe: (t: TableRef): Promise<TableInfo> => pgDescribe(q, t.database || home, t),

    async apply(t: TableRef, edits: RowEdit[]) {
      const statements = editStatements('postgres', t, edits);
      const client = await take(t.database || home);
      let affected = 0;
      try {
        await client.query('BEGIN');
        for (const s of statements) {
          const r = await client.query(s.sql, s.params);
          if (!/^INSERT/.test(s.sql) && r.rowCount === 0) throw new PluginError('A row was changed or removed by someone else since it was read: refresh, and make the change again.');
          affected += r.rowCount ?? 0;
        }
        await client.query('COMMIT');
        return { affected };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e instanceof PluginError ? e : pgError(e, where);
      } finally {
        client.release();
      }
    },

    async completions(database) {
      const rows = await q<{ schema: string; name: string; columns: string[] }>(
        `SELECT c.table_schema AS schema, c.table_name AS name, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM information_schema.columns c
          WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
          GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 3000`,
        [],
        database || home,
      );
      return { tables: rows.map((r) => ({ schema: r.schema === 'public' ? undefined : r.schema, name: r.name, columns: r.columns })) };
    },

    async close() {
      for (const c of consoles.values()) await c.client.end().catch(() => {});
      consoles.clear();
      await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
      pools.clear();
    },
  };
};

export type PgQuery = <R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[], database?: string) => Promise<R[]>;
