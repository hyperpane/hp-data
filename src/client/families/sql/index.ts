// The SQL family's tabs (a console, a table) and its tree items' actions:
// a console in a database or schema, a table's first rows in a console,
// its name or SELECT copied.

import type { TreeActions, Views } from '../../app/tabs.ts';
import { qualified, type Dialect } from '../../../shared/sql.ts';
import { SqlConsole } from './console.tsx';
import { SqlTable } from './table.tsx';

export const views: Views = {
  console: SqlConsole,
  table: SqlTable,
};

const dialectOf = (engine: string): Dialect => (engine === 'mysql' || engine === 'sqlite' || engine === 'clickhouse' ? engine : 'postgres');

export const actions: TreeActions = ({ node, connection, kind, open, api }) => {
  if (!node) return [];
  const ref = node.open?.ref ?? {};
  const consoleIn = (database: string | undefined, text?: string, title?: string) =>
    open({ key: `${connection.id}:console:${Date.now().toString(36)}`, type: 'console', conn: connection.id, ref: database ? { database } : {}, title: title ?? database ?? connection.name, state: text ? { text } : undefined });
  if (node.type === 'database') return [{ label: 'New Console Here', run: () => consoleIn(node.name) }];
  if (node.type === 'table' || node.type === 'view') {
    const name = qualified(dialectOf(kind.engine), { database: ref.database, schema: ref.schema, table: ref.table ?? node.name });
    const select = `SELECT * FROM ${name} LIMIT 100;\n`;
    return [
      { label: 'Select in a Console', run: () => consoleIn(ref.database, select, node.name) },
      { label: 'Copy Qualified Name', run: () => api.copy(name, 'the name') },
      { label: 'Copy SELECT', run: () => api.copy(select.trim(), 'the statement') },
    ];
  }
  return [];
};

