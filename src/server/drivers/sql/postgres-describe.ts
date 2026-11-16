// A PostgreSQL table described: its columns (type, null, default, key,
// generated), indexes, foreign keys, a CREATE TABLE, and its rows (the
// planner's estimate).

import { PluginError } from '@hyperpane/sdk/server';
import type { TableInfo, TableRef } from '../../../shared/sql.ts';
import { ddlOf } from './common.ts';
import type { PgQuery } from './postgres.ts';

export async function pgDescribe(q: PgQuery, database: string, t: TableRef): Promise<TableInfo> {
  const schema = t.schema || 'public';
  const cols = await q<{ name: string; type: string; notnull: boolean; def: string | null; pk: boolean; generated: string; identity: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            pg_get_expr(d.adbin, d.adrelid) AS def, a.attgenerated::text AS generated, a.attidentity::text AS identity,
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, t.table],
    database,
  );
  if (!cols.length) throw new PluginError(`There’s no table ${schema}.${t.table} in ${database}.`);
  const indexes = await q<{ name: string; columns: string[]; unique: boolean; primary: boolean }>(
    `SELECT i.relname AS name, x.indisunique AS unique, x.indisprimary AS primary,
            ARRAY(SELECT pg_get_indexdef(x.indexrelid, k + 1, true) FROM generate_subscripts(x.indkey, 1) AS k ORDER BY k) AS columns
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 ORDER BY x.indisprimary DESC, i.relname`,
    [schema, t.table],
    database,
  );
  const fks = await q<{ name: string; columns: string[]; table: string; to: string[] }>(
    `SELECT con.conname AS name,
            ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)) AS columns,
            con.confrelid::regclass::text AS table,
            ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = con.confrelid AND attnum = ANY(con.confkey)) AS to
       FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2`,
    [schema, t.table],
    database,
  );
  const [est] = await q<{ n: number }>(
    `SELECT c.reltuples::bigint::float8 AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, t.table],
    database,
  );
  const columns = cols.map((c) => ({
    name: c.name,
    type: c.type,
    key: c.pk || undefined,
    nullable: !c.notnull,
    hasDefault: c.def !== null || !!c.identity || !!c.generated,
    readOnly: c.generated === 's' || c.identity === 'a' ? true : undefined,
  }));
  const info = { columns, indexes, foreignKeys: fks };
  const ddl = ddlOf('postgres', { ...t, schema }, info).replace(/^(\s+"[^"]+" [^\n,]+?)(,?)$/gm, (line, head: string, comma: string) => {
    const name = /"((?:[^"]|"")+)"/.exec(head)?.[1]?.replace(/""/g, '"');
    const c = cols.find((x) => x.name === name);
    return c?.def ? `${head} DEFAULT ${c.def}${comma}` : line;
  });
  return { ...info, ddl, rows: est && est.n >= 0 ? Math.round(est.n) : null };
}
