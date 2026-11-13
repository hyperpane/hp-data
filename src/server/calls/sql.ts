// The SQL family's calls: a console's run, a table's page, a table
// described, edits applied, and names for completion. A run on a read-only
// connection is refused unless every statement looks like it only reads.

import { PluginError } from '@hyperpane/sdk/server';
import { readsOnly, splitStatements } from '../../shared/sql.ts';
import type { BrowseRequest, RowEdit, TableRef } from '../../shared/sql.ts';
import { type Deps, type Group, idOf, int, projectOf, writable } from './context.ts';

const tableOf = (t: unknown): TableRef => {
  const x = (t ?? {}) as Partial<TableRef>;
  if (typeof x.table !== 'string' || !x.table) throw new PluginError('Pick a table first.');
  return { table: x.table, schema: typeof x.schema === 'string' && x.schema ? x.schema : undefined, database: typeof x.database === 'string' && x.database ? x.database : undefined };
};

export function sql(d: Deps): Group {
  const driver = (req: { id?: unknown; project?: unknown }) => d.sessions.family(idOf(req), 'sql', projectOf(req));
  return {
    calls: {
      query: async (req: { id: string; sql: string; limit?: number; database?: string }, { signal }) => {
        const text = String(req.sql ?? '');
        const c = await d.registry.get(idOf(req));
        if (c.readOnly && !splitStatements(text).every(readsOnly)) throw new PluginError(`“${c.name}” is read only, and this looks like it changes something: change that in its settings to run it.`);
        return (await driver(req)).query(text, { limit: int(req.limit, 500, 1, 100_000), database: req.database ? String(req.database) : undefined, signal });
      },
      browse: async (req: BrowseRequest & { id: string }, { signal }) =>
        (await driver(req)).browse(
          {
            table: tableOf(req.table),
            offset: int(req.offset, 0, 0, Number.MAX_SAFE_INTEGER),
            limit: int(req.limit, 200, 1, 10_000),
            where: typeof req.where === 'string' ? req.where : undefined,
            order: Array.isArray(req.order) ? req.order.filter((o) => o && typeof o.column === 'string').map((o) => ({ column: o.column, desc: !!o.desc })) : undefined,
          },
          signal,
        ),
      describe: async (req: { id: string; table: TableRef }) => (await driver(req)).describe(tableOf(req.table)),
      apply: async (req: { id: string; table: TableRef; edits: RowEdit[] }) => {
        await writable(d, idOf(req));
        if (!Array.isArray(req.edits) || !req.edits.length) return { affected: 0 };
        return (await driver(req)).apply(tableOf(req.table), req.edits);
      },
      completions: async (req: { id: string; database?: string }) => (await driver(req)).completions(req.database ? String(req.database) : undefined),
    },
  };
}
