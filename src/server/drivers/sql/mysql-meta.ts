// MySQL's tree (databases; Tables, Views and Routines; a table's columns
// and indexes) and a table described, from information_schema and SHOW
// CREATE TABLE.

import { PluginError } from '@hyperpane/sdk/server';
import type { TreeNode } from '../../../shared/types.ts';
import type { TableInfo, TableRef } from '../../../shared/sql.ts';
import type { MyQuery } from './mysql.ts';

const SYSTEM = "('information_schema','performance_schema','mysql','sys')";

const rows = (n: number | null) => (n === null || n < 0 ? '' : n < 1000 ? `${n} rows` : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K rows` : `${(n / 1e6).toFixed(1)}M rows`);

export async function myChildren(q: MyQuery, path: string[], home: string, system = false): Promise<TreeNode[]> {
  const [db, folder, table] = path;
  if (path.length === 0) {
    const dbs = await q<{ s: string; n: number }>(`SELECT s.schema_name AS s, (SELECT COUNT(*) FROM information_schema.tables t WHERE t.table_schema = s.schema_name) AS n FROM information_schema.schemata s ${home || system ? '' : `WHERE s.schema_name NOT IN ${SYSTEM}`} ORDER BY s.schema_name = ? DESC, s.schema_name`, [home]);
    return dbs.filter((d) => system || !home || d.s === home || !SYSTEM.includes(`'${d.s}'`)).map((d) => ({ name: d.s, type: 'database', detail: d.n ? String(d.n) : undefined, expand: d.s === home || dbs.length === 1, open: { tab: 'console', ref: { database: d.s }, title: d.s } }));
  }
  if (path.length === 1) {
    const [c] = await q<{ tables: number; views: number; routines: number }>(
      `SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE') AS tables,
              (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_type = 'VIEW') AS views,
              (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = ?) AS routines`,
      [db, db, db],
    );
    const out: TreeNode[] = [{ name: 'tables', label: 'Tables', type: 'folder', detail: String(c.tables), expand: true }];
    if (Number(c.views)) out.push({ name: 'views', label: 'Views', type: 'folder', detail: String(c.views) });
    if (Number(c.routines)) out.push({ name: 'routines', label: 'Routines', type: 'folder', detail: String(c.routines) });
    return out;
  }
  if (path.length === 2) {
    if (folder === 'routines') {
      const r = await q<{ n: string; t: string }>('SELECT routine_name AS n, routine_type AS t FROM information_schema.routines WHERE routine_schema = ? ORDER BY 1', [db]);
      return r.map((x) => ({ name: x.n, type: 'function', detail: x.t.toLowerCase(), leaf: true }));
    }
    const t = await q<{ n: string; r: number | null }>(`SELECT table_name AS n, table_rows AS r FROM information_schema.tables WHERE table_schema = ? AND table_type ${folder === 'views' ? "= 'VIEW'" : "<> 'VIEW'"} ORDER BY 1`, [db]);
    return t.map((x) => ({ name: x.n, type: folder === 'views' ? 'view' : 'table', detail: folder === 'views' ? undefined : rows(x.r === null ? null : Number(x.r)), open: { tab: 'table', ref: { database: db, table: x.n }, title: x.n } }));
  }
  if (path.length === 3) {
    const cols = await q<{ n: string; t: string; k: string; nl: string }>('SELECT column_name AS n, column_type AS t, column_key AS k, is_nullable AS nl FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', [db, table]);
    const idx = await q<{ n: string; c: string }>("SELECT index_name AS n, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS c FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name ORDER BY index_name = 'PRIMARY' DESC, index_name", [db, table]);
    return [
      ...cols.map((c): TreeNode => ({ name: c.n, type: c.k === 'PRI' ? 'key' : 'column', detail: `${c.t}${c.nl === 'YES' ? '?' : ''}`, leaf: true })),
      ...idx.map((i): TreeNode => ({ name: `index:${i.n}`, label: i.n, type: 'index', detail: i.c, leaf: true })),
    ];
  }
  return [];
}

export async function myDescribe(q: MyQuery, t: TableRef): Promise<TableInfo> {
  if (!t.database) throw new PluginError('Pick a database first.');
  const cols = await q<{ n: string; t: string; k: string; nl: string; d: string | null; x: string }>(
    'SELECT column_name AS n, column_type AS t, column_key AS k, is_nullable AS nl, column_default AS d, extra AS x FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
    [t.database, t.table],
  );
  if (!cols.length) throw new PluginError(`There’s no table ${t.database}.${t.table}.`);
  const stats = await q<{ n: string; c: string; u: number }>('SELECT index_name AS n, column_name AS c, non_unique AS u FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index', [t.database, t.table]);
  const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean }>();
  for (const s of stats) {
    const i = indexes.get(s.n) ?? { name: s.n, columns: [], unique: Number(s.u) === 0, primary: s.n === 'PRIMARY' };
    i.columns.push(s.c);
    indexes.set(s.n, i);
  }
  const fkRows = await q<{ n: string; c: string; rt: string; rs: string; rc: string }>(
    'SELECT constraint_name AS n, column_name AS c, referenced_table_name AS rt, referenced_table_schema AS rs, referenced_column_name AS rc FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position',
    [t.database, t.table],
  );
  const fks = new Map<string, { name: string; columns: string[]; table: string; to: string[] }>();
  for (const f of fkRows) {
    const k = fks.get(f.n) ?? { name: f.n, columns: [], table: `${f.rs}.${f.rt}`, to: [] };
    k.columns.push(f.c);
    k.to.push(f.rc);
    fks.set(f.n, k);
  }
  let ddl = '';
  try {
    const [r] = await q<Record<string, string>>(`SHOW CREATE TABLE \`${t.database.replace(/`/g, '``')}\`.\`${t.table.replace(/`/g, '``')}\``);
    ddl = `${r['Create Table'] ?? r['Create View'] ?? ''};`;
  } catch {}
  const [est] = await q<{ r: number | null }>('SELECT table_rows AS r FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [t.database, t.table]);
  return {
    columns: cols.map((c) => ({ name: c.n, type: c.t, key: c.k === 'PRI' || undefined, nullable: c.nl === 'YES', hasDefault: c.d !== null || /auto_increment|DEFAULT_GENERATED/i.test(c.x), readOnly: /VIRTUAL|STORED GENERATED/i.test(c.x) || undefined })),
    indexes: [...indexes.values()],
    foreignKeys: [...fks.values()],
    ddl,
    rows: est?.r === null || est?.r === undefined ? null : Number(est.r),
  };
}
