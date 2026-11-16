// MySQL (and MariaDB, TiDB, PlanetScale), with `mysql2`. A pool for the
// tree and table pages, a connection of its own for consoles (so USE and a
// BEGIN carry over between runs). Dates and big numbers come as the server
// writes them; a SELECT without a limit gets one, so a big table gives its
// first rows, not all of them.

import mysql from 'mysql2/promise';
import mysqlBase from 'mysql2';
import { PluginError } from '@hyperpane/sdk/server';
import { readsOnly, splitStatements, verb } from '../../../shared/sql.ts';
import type { Column, QueryResult } from '../../../shared/types.ts';
import type { BrowseRequest, BrowseResult, RowEdit, TableInfo, TableRef } from '../../../shared/sql.ts';
import { since, toCell } from '../cells.ts';
import type { DriverContext, SqlDriver } from '../types.ts';
import { browseSql, cap, editStatements } from './common.ts';
import { myChildren, myDescribe } from './mysql-meta.ts';
import { tlsOf } from '../../net/tls.ts';

const TYPE_NAMES = new Map<number, string>(
  Object.entries(mysqlBase.Types as unknown as Record<string, string | number>)
    .filter(([k, v]) => /^\d+$/.test(k) && typeof v === 'string')
    .map(([k, v]) => [Number(k), String(v).toLowerCase()]),
);

function myError(e: unknown, where: string): Error {
  const err = e as Error & { code?: string; errno?: number; sqlMessage?: string };
  const say: Record<string, string> = {
    ER_ACCESS_DENIED_ERROR: 'The user or password is wrong (or that user may not sign in from here).',
    ER_BAD_DB_ERROR: `There’s no such database on ${where}.`,
    ECONNREFUSED: `Nothing answers at ${where}: is MySQL running, on that port?`,
    ENOTFOUND: `There’s no host ${where.replace(/:\d+$/, '')}.`,
    ETIMEDOUT: `${where} didn’t answer in time.`,
    ER_QUERY_INTERRUPTED: 'Cancelled.',
    HANDSHAKE_SSL_ERROR: 'The server doesn’t take TLS: set SSL to Off.',
  };
  if (err.code && say[err.code]) return new PluginError(say[err.code]);
  if (/self[- ]signed|certificate/i.test(err.message)) return new PluginError(`${err.message}: set SSL to “On, any certificate” to accept it.`);
  return new PluginError(err.sqlMessage ?? err.message);
}

type Row = Record<string, unknown>;
export type MyQuery = <R = Row>(sql: string, params?: unknown[]) => Promise<R[]>;

const mysqlDriver = (ctx: DriverContext): SqlDriver => {
  const v = ctx.values;
  const where = `${v.host}:${v.port ?? 3306}`;
  const home = String(v.database ?? '');
  const base: mysql.PoolOptions = {
    host: String(v.host),
    port: Number(v.port ?? 3306),
    user: String(v.user ?? '') || undefined,
    password: v.password ? String(v.password) : undefined,
    database: home || undefined,
    ssl: v.ssl === 'require' ? { ...tlsOf(v), rejectUnauthorized: false } : v.ssl === 'verify' ? { ...tlsOf(v) } : undefined,
    connectTimeout: Number(v.timeout ?? 10) * 1000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    charset: 'utf8mb4',
  };
  const pool = mysql.createPool({ ...base, connectionLimit: 4, waitForConnections: true });
  const init = [
    ...(v.timezone ? [`SET time_zone = '${String(v.timezone).replace(/'/g, "''")}'`] : []),
    ...(Number(v.queryTimeout) > 0 ? [`SET SESSION max_execution_time = ${Math.round(Number(v.queryTimeout) * 1000)}`] : []),
    ...splitStatements(String(v.initSql ?? '')),
  ];
  if (init.length)
    (pool as unknown as { pool: { on(e: string, f: (c: { query(sql: string, cb: (e: Error | null) => void): void }) => void): void } }).pool.on(
      'connection',
      (c) => {
        for (const s of init) c.query(s, (e) => e && ctx.log(`run on connect: ${e.message}`));
      },
    );
  let own: { conn: mysql.Connection; busy: Promise<unknown>; db: string } | null = null;

  const q: MyQuery = async <R = Row>(sql: string, params: unknown[] = []) => {
    try {
      const [rows] = await pool.query(sql, params);
      return rows as R[];
    } catch (e) {
      throw myError(e, where);
    }
  };

  const columnsOf = (fields: mysql.FieldPacket[] | undefined): Column[] =>
    (fields ?? []).map((f) => ({
      name: f.name,
      type: TYPE_NAMES.get(f.columnType ?? f.type ?? -1) ?? undefined,
      key: ((f.flags as number) & 2) !== 0 || undefined,
    }));

  async function consoleConn(database: string) {
    if (!own) {
      try {
        const conn = await mysql.createConnection(base);
        for (const s of init) await conn.query(s);
        conn.on('error', (e: Error) => {
          ctx.log(`mysql own: ${e.message}`);
          own = null;
        });
        own = { conn, busy: Promise.resolve(), db: home };
      } catch (e) {
        throw myError(e, where);
      }
    }
    if (database && database !== own.db) {
      await own.conn.query(`USE \`${database.replace(/`/g, '``')}\``);
      own.db = database;
    }
    return own;
  }

  async function runOne(conn: mysql.Connection, statement: string, limit: number): Promise<QueryResult> {
    const t0 = performance.now();
    const wrap =
      readsOnly(statement) &&
      ['SELECT', 'WITH'].includes(verb(statement)) &&
      !/\blimit\s+\d+(\s*,\s*\d+|\s+offset\s+\d+)?\s*$/i.test(statement) &&
      !/\binto\s+(outfile|dumpfile|@)/i.test(statement);
    let res: [unknown, mysql.FieldPacket[] | undefined];
    try {
      res = (await conn.query({ sql: wrap ? `SELECT * FROM (${statement}) AS hp_data LIMIT ${limit + 1}` : statement, rowsAsArray: true })) as [
        unknown,
        mysql.FieldPacket[],
      ];
    } catch (e) {
      if (!wrap || (e as { code?: string }).code === 'ER_QUERY_INTERRUPTED') throw e;
      res = (await conn.query({ sql: statement, rowsAsArray: true })) as [unknown, mysql.FieldPacket[]];
    }
    const [rows, fields] = res;
    if (Array.isArray(rows) && fields) {
      const c = cap(rows as unknown[][], limit);
      return {
        statement,
        columns: columnsOf(fields),
        rows: c.rows.map((r) => r.map(toCell)),
        command: `${verb(statement)} ${c.rows.length}`,
        affected: null,
        ms: since(t0),
        truncated: c.truncated,
      };
    }
    const h = rows as mysql.ResultSetHeader;
    return {
      statement,
      columns: [],
      rows: [],
      command: `${verb(statement)} ${h.affectedRows ?? ''}`.trim(),
      affected: h.affectedRows ?? null,
      ms: since(t0),
      notices: h.info ? [h.info] : undefined,
    };
  }

  const cancel = async (conn: mysql.Connection) => {
    await q(`KILL QUERY ${Number(conn.threadId)}`).catch(() => {});
  };

  return {
    family: 'sql',

    async info() {
      const [r] = await q<{ v: string; u: string; c: string }>('SELECT VERSION() AS v, CURRENT_USER() AS u, @@version_comment AS c');
      const maria = /mariadb/i.test(r.v);
      const tidb = /tidb/i.test(r.v);
      const version = tidb ? `TiDB ${/TiDB-v?([\d.]+)/.exec(r.v)?.[1] ?? r.v}` : `${maria ? 'MariaDB' : 'MySQL'} ${r.v.split('-')[0]}`;
      return { version, detail: [r.u, home].filter(Boolean).join(' @ ') };
    },

    children: (path) => myChildren(q, path, home, !!v.showSystem),

    async query(sql, o) {
      const statements = splitStatements(sql);
      if (!statements.length) throw new PluginError('There’s nothing to run.');
      const c = await consoleConn(o.database ?? '');
      const run = c.busy.then(async () => {
        const results: QueryResult[] = [];
        const onAbort = () => void cancel(c.conn);
        o.signal.addEventListener('abort', onAbort, { once: true });
        try {
          for (const s of statements) {
            try {
              results.push(await runOne(c.conn, s, o.limit));
              if (verb(s) === 'USE') c.db = s.replace(/^\s*use\s+/i, '').replace(/[`;\s]/g, '');
            } catch (e) {
              const err = myError(e, where);
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
      const table = { ...r.table, database: r.table.database || home };
      const info = await myDescribe(q, table);
      const keys = new Set(info.columns.filter((c) => c.key).map((c) => c.name));
      const { select, count } = browseSql('mysql', { ...r, table });
      const t0 = performance.now();
      const conn = await pool.getConnection();
      const onAbort = () => void cancel(conn.connection as unknown as mysql.Connection);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const [rows, fields] = (await conn.query({ sql: select, rowsAsArray: true })) as [unknown[][], mysql.FieldPacket[]];
        const ms = since(t0);
        let total: number | null = null;
        try {
          const [c] = (await conn.query({ sql: count, timeout: 1500 })) as [Row[], unknown];
          total = Number(c[0].n);
        } catch {
          total = null;
        }
        const byName = new Map(info.columns.map((c) => [c.name, c]));
        const columns = columnsOf(fields).map((c) => ({ ...c, ...byName.get(c.name) }));
        return { columns, rows: rows.map((row) => row.map(toCell)), ms, total, editable: keys.size > 0, sql: select, command: `SELECT ${rows.length}` };
      } catch (e) {
        throw myError(e, where);
      } finally {
        signal.removeEventListener('abort', onAbort);
        conn.release();
      }
    },

    describe: (t: TableRef): Promise<TableInfo> => myDescribe(q, { ...t, database: t.database || home }),

    async apply(t: TableRef, edits: RowEdit[]) {
      const statements = editStatements('mysql', { ...t, database: t.database || home }, edits);
      const conn = await pool.getConnection();
      let affected = 0;
      try {
        await conn.beginTransaction();
        for (const s of statements) {
          const [h] = (await conn.query(s.sql, s.params)) as [mysql.ResultSetHeader, unknown];
          // MySQL counts an UPDATE to the same value as 0 changed: matched rows are what count.
          const matched = /^UPDATE/.test(s.sql) ? Number(/Rows matched: (\d+)/.exec(h.info ?? '')?.[1] ?? h.affectedRows) : h.affectedRows;
          if (!/^INSERT/.test(s.sql) && matched === 0)
            throw new PluginError('A row was changed or removed by someone else since it was read: refresh, and make the change again.');
          affected += h.affectedRows;
        }
        await conn.commit();
        return { affected };
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e instanceof PluginError ? e : myError(e, where);
      } finally {
        conn.release();
      }
    },

    async completions(database) {
      const db = database || home;
      const rows = await q<{ s: string; t: string; c: string }>(
        `SELECT table_schema AS s, table_name AS t, GROUP_CONCAT(column_name ORDER BY ordinal_position SEPARATOR '\\n') AS c
           FROM information_schema.columns
          WHERE ${db ? 'table_schema = ?' : "table_schema NOT IN ('information_schema','performance_schema','mysql','sys')"}
          GROUP BY table_schema, table_name LIMIT 3000`,
        db ? [db] : [],
      );
      return { tables: rows.map((r) => ({ schema: r.s === db ? undefined : r.s, name: r.t, columns: String(r.c ?? '').split('\n') })) };
    },

    async close() {
      if (own) await own.conn.end().catch(() => {});
      own = null;
      await pool.end().catch(() => {});
    },
  };
};

export { mysqlDriver as mysql };
