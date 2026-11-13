// The document family's calls (MongoDB, Elasticsearch and OpenSearch,
// DynamoDB): documents found a page at a time, inserted, replaced and
// removed, and a console's text run. Changes are refused on a connection
// marked read only, and so is console text that looks like one.

import { PluginError } from '@hyperpane/sdk/server';
import type { CommandResult, DocCommandCall, DocFindCall, DocFindResult, DocInsertCall, DocRemoveCall, DocReplaceCall } from '../../shared/document.ts';
import { kindOf } from '../../shared/kinds.ts';
import type { Ref } from '../../shared/types.ts';
import { devToolsWrites } from '../drivers/document/devtools.ts';
import { partiqlWrites } from '../drivers/document/dynamodb.ts';
import { shellWrites } from '../drivers/document/shell.ts';
import { type Deps, type Group, idOf, int, projectOf, writable } from './context.ts';

const refOf = (v: unknown): Ref => {
  if (!v || typeof v !== 'object') throw new PluginError('Pick a collection.');
  return v as Ref;
};
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Console text that changes something, by the connection's engine. */
export function consoleWrites(engine: string, t: string): boolean {
  if (engine === 'mongodb') return shellWrites(t);
  if (engine === 'elasticsearch') return devToolsWrites(t);
  if (engine === 'dynamodb') return partiqlWrites(t);
  return false;
}

export function document(d: Deps): Group {
  const driver = (req: { id?: unknown; project?: unknown }) => d.sessions.family(idOf(req), 'document', projectOf(req));
  return {
    calls: {
      docFind: async (req: DocFindCall, ctx): Promise<DocFindResult> => {
        const drv = await driver(req);
        return drv.find(
          {
            ref: refOf(req.ref),
            filter: text(req.filter),
            sort: text(req.sort),
            projection: text(req.projection),
            skip: int(req.skip, 0, 0, 1e9),
            limit: int(req.limit, 50, 1, 10_000),
            token: typeof req.token === 'string' && req.token ? req.token : undefined,
          } as DocFindCall,
          ctx.signal,
        );
      },
      docInsert: async (req: DocInsertCall) => {
        const id = idOf(req);
        await writable(d, id);
        const drv = await driver(req);
        if (req.doc === undefined || req.doc === null || req.doc === '') throw new PluginError('There’s no document to insert.');
        return { key: await drv.insert(refOf(req.ref), req.doc) };
      },
      docReplace: async (req: DocReplaceCall) => {
        const id = idOf(req);
        await writable(d, id);
        const drv = await driver(req);
        if (!req.key || typeof req.key !== 'object') throw new PluginError('Which document? Its id is missing.');
        await drv.replace(refOf(req.ref), req.key, req.doc);
        return null;
      },
      docRemove: async (req: DocRemoveCall) => {
        const id = idOf(req);
        await writable(d, id);
        const drv = await driver(req);
        const keys = Array.isArray(req.keys) ? req.keys.filter((k) => k && typeof k === 'object') : [];
        return { removed: await drv.remove(refOf(req.ref), keys) };
      },
      docCommand: async (req: DocCommandCall, ctx): Promise<CommandResult> => {
        const id = idOf(req);
        const t = text(req.text);
        if (!t.trim()) throw new PluginError('Type something to run.');
        const c = await d.registry.get(id);
        const engine = kindOf(c.kind)?.engine ?? '';
        if (consoleWrites(engine, t)) await writable(d, id);
        const drv = await driver(req);
        return (await drv.command({ database: typeof req.database === 'string' && req.database ? req.database : undefined, text: t, signal: ctx.signal })) as CommandResult;
      },
    },
  };
}
