// PostgreSQL's tree, as DataGrip lays it out: databases, their schemas,
// then Tables, Views, Functions and Sequences, and a table's columns and
// indexes.

import type { TreeNode } from '../../../shared/types.ts';
import type { PgQuery } from './postgres.ts';

const HIDE = "nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'";

const rows = (n: number) => (n < 0 ? '' : n < 1000 ? `${n} rows` : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K rows` : `${(n / 1e6).toFixed(1)}M rows`);

export async function pgChildren(q: PgQuery, path: string[], home: string, only: string, system = false): Promise<TreeNode[]> {
  const HIDDEN = system ? "nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'" : HIDE;
  const [db, schema, folder, table] = path;
  if (path.length === 0) {
    const dbs = only
      ? [{ datname: only, size: null as string | null }]
      : await q<{ datname: string; size: string | null }>(`SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY datname = $1 DESC, datname`, [home]).catch(() => q<{ datname: string; size: string | null }>(`SELECT datname, NULL AS size FROM pg_database WHERE NOT datistemplate ORDER BY datname`));
    return dbs.map((d) => ({ name: d.datname, type: 'database', detail: d.size ?? undefined, expand: d.datname === home, open: { tab: 'console', ref: { database: d.datname }, title: d.datname } }));
  }
  if (path.length === 1) {
    const s = await q<{ nspname: string; tables: number }>(
      `SELECT n.nspname, (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')) AS tables
         FROM pg_namespace n WHERE ${HIDDEN} ORDER BY n.nspname = 'public' DESC, n.nspname`,
      [],
      db,
    );
    return s.map((x) => ({ name: x.nspname, type: 'schema', detail: x.tables ? String(x.tables) : undefined, expand: s.length === 1 || (x.nspname === 'public' && x.tables > 0) }));
  }
  if (path.length === 2) {
    const [c] = await q<{ tables: number; views: number; functions: number; sequences: number }>(
      `SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','f')) AS tables,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('v','m')) AS views,
              (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1) AS functions,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S') AS sequences`,
      [schema],
      db,
    );
    const out: TreeNode[] = [{ name: 'tables', label: 'Tables', type: 'folder', detail: String(c.tables), expand: true }];
    if (c.views) out.push({ name: 'views', label: 'Views', type: 'folder', detail: String(c.views) });
    if (c.functions) out.push({ name: 'functions', label: 'Functions', type: 'folder', detail: String(c.functions) });
    if (c.sequences) out.push({ name: 'sequences', label: 'Sequences', type: 'folder', detail: String(c.sequences) });
    return out;
  }
  if (path.length === 3) {
    if (folder === 'tables' || folder === 'views') {
      const kinds = folder === 'tables' ? "('r','p','f')" : "('v','m')";
      const t = await q<{ relname: string; reltuples: number; relkind: string }>(`SELECT c.relname, c.reltuples::bigint::float8 AS reltuples, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ${kinds} ORDER BY c.relname`, [schema], db);
      return t.map((x) => ({ name: x.relname, type: folder === 'tables' ? 'table' : 'view', detail: folder === 'tables' ? rows(x.reltuples) : x.relkind === 'm' ? 'materialized' : undefined, open: { tab: 'table', ref: { database: db, schema, table: x.relname }, title: x.relname } }));
    }
    if (folder === 'functions') {
      const f = await q<{ name: string; args: string; kind: string }>(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name, pg_get_function_result(p.oid) AS args, p.prokind AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 ORDER BY 1 LIMIT 2000`, [schema], db);
      return f.map((x) => ({ name: x.name, type: 'function', detail: x.kind === 'p' ? 'procedure' : (x.args ?? undefined), leaf: true }));
    }
    if (folder === 'sequences') {
      const s = await q<{ relname: string }>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY 1`, [schema], db);
      return s.map((x) => ({ name: x.relname, type: 'sequence', leaf: true }));
    }
    return [];
  }
  if (path.length === 4) {
    const cols = await q<{ attname: string; type: string; notnull: boolean; pk: boolean }>(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [schema, table],
      db,
    );
    const idx = await q<{ name: string; def: string }>(`SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 ORDER BY 1`, [schema, table], db);
    return [
      ...cols.map((c): TreeNode => ({ name: c.attname, type: c.pk ? 'key' : 'column', detail: `${c.type}${c.notnull ? '' : '?'}`, leaf: true })),
      ...idx.map((i): TreeNode => ({ name: `index:${i.name}`, label: i.name, type: 'index', detail: /\((.*)\)/.exec(i.def)?.[1], leaf: true })),
    ];
  }
  return [];
}
