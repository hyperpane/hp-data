// A collection's tab (a MongoDB collection, an index, a DynamoDB table):
// a filter, a sort and a projection, a line each (Enter runs); a page of
// documents as a list of JSON trees or as a table; paging; and documents
// inserted, edited, duplicated and deleted, unless the connection is read
// only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Plus, RefreshCw, SquareTerminal } from 'lucide-react';
import { NodeButton, NodeInput, Picker, StatusBar, Tabs, ToolButton, Toolbar, cn } from '@hyperpane/ui';
import type { DocFindResult } from '../../../shared/document.ts';
import type { TabProps } from '../../app/tabs.ts';
import { Grid } from '../../ui/grid.tsx';
import { ErrorBox, count, ms } from '../../ui/parts.tsx';
import { DocList } from './docs.tsx';
import { DocEditor, type Editing } from './editor.tsx';
import { keyOf, tableOf, toText } from './format.ts';

interface Query {
  filter: string;
  sort: string;
  projection: string;
}

const PLACEHOLDERS: Record<string, Query & { projectionLabel: string }> = {
  mongodb: { filter: '{ status: "paid", total: { $gt: 20 } }   ·   { _id: ObjectId("…") }', sort: '{ placed: -1 }', projection: '{ name: 1, email: 1 }', projectionLabel: 'Project' },
  elasticsearch: { filter: 'A query string (level:error AND service:api) or a query: { "match": { "message": "timeout" } }', sort: '@timestamp:desc   or   [{ "@timestamp": "desc" }]', projection: 'message, level   or   ["http.*"]', projectionLabel: 'Fields' },
  dynamodb: { filter: 'A PartiQL condition: category = \'books\' AND price > 10   (empty: the whole table, scanned)', sort: '', projection: 'sku, name, price', projectionLabel: 'Attributes' },
};

const LIMITS = ['20', '50', '100', '200', '500'].map((v) => ({ value: v, label: `${v} a page` }));

export function CollectionView(p: TabProps) {
  const { api, tab, readOnly } = p;
  const engine = p.kind.engine;
  const mongo = engine === 'mongodb';
  const dynamo = engine === 'dynamodb';
  const ph = PLACEHOLDERS[engine] ?? PLACEHOLDERS.mongodb;
  const st = tab.state ?? {};
  const [q, setQ] = useState<Query>({ filter: String(st.filter ?? ''), sort: String(st.sort ?? ''), projection: String(st.projection ?? '') });
  const [applied, setApplied] = useState<Query>(q);
  const [limit, setLimit] = useState(Number(st.limit) || 50);
  const [view, setView] = useState<'json' | 'table'>(st.view === 'table' ? 'table' : 'json');
  const [skip, setSkip] = useState(0);
  /** DynamoDB: each page's token and where it starts. */
  const [pages, setPages] = useState<{ token?: string; start: number }[]>([{ start: 0 }]);
  const [result, setResult] = useState<DocFindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [expand, setExpand] = useState(0);
  const running = useRef<AbortController | null>(null);

  const load = async (query: Query, o: { skip: number; token?: string; limit: number }) => {
    running.current?.abort();
    const ac = new AbortController();
    running.current = ac;
    setLoading(true);
    setError(null);
    try {
      const r = await api.stream<DocFindResult>('docFind', { id: p.connection.id, project: p.project, ref: tab.ref, ...query, skip: o.skip, limit: o.limit, token: o.token }, ac.signal);
      if (running.current === ac) setResult(r);
    } catch (e) {
      if (running.current === ac && !ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (running.current === ac) setLoading(false);
    }
  };
  const page = pages[pages.length - 1];
  const reload = () => load(applied, { skip, token: page.token, limit });
  const run = (query = q, l = limit) => {
    setApplied(query);
    setSkip(0);
    setPages([{ start: 0 }]);
    p.setState({ ...query, limit: l });
    void load(query, { skip: 0, limit: l });
  };

  useEffect(() => {
    if (p.visible && !result && !loading && !error) void reload();
  }, [p.visible]);
  useEffect(() => () => running.current?.abort(), []);

  const docs = result?.docs ?? [];
  const idFields = result?.idFields ?? (dynamo ? [] : ['_id']);
  const start = dynamo ? page.start : skip;
  const table = useMemo(() => (view === 'table' ? tableOf(docs, idFields, mongo) : null), [result, view]);
  const hasNext = dynamo ? !!result?.next : result ? (result.total !== null ? skip + docs.length < result.total : docs.length === limit) : false;
  const hasPrev = dynamo ? pages.length > 1 : skip > 0;
  const next = () => {
    if (dynamo) {
      const np = { token: result!.next!, start: page.start + docs.length };
      setPages((ps) => [...ps, np]);
      void load(applied, { skip: 0, token: np.token, limit });
    } else {
      setSkip(skip + limit);
      void load(applied, { skip: skip + limit, limit });
    }
  };
  const prev = () => {
    if (dynamo) {
      const ps = pages.slice(0, -1);
      setPages(ps);
      void load(applied, { skip: 0, token: ps[ps.length - 1].token, limit });
    } else {
      const s = Math.max(0, skip - limit);
      setSkip(s);
      void load(applied, { skip: s, limit });
    }
  };

  const call = (op: string, payload: Record<string, unknown>) => api.call(op, { id: p.connection.id, project: p.project, ref: tab.ref, ...payload });
  const hint = mongo ? 'Shell literals work: ObjectId("…"), ISODate("…"), NumberLong(…).' : dynamo ? (idFields.length ? `The key: ${idFields.join(', ')}.` : undefined) : '_id is the document’s id; the rest is its _source.';
  const without = (d: unknown, fields: string[]) => Object.fromEntries(Object.entries(d as Record<string, unknown>).filter(([k]) => !fields.includes(k)));
  const actions = {
    edit: (i: number) => setEditing({ mode: 'replace', text: toText(docs[i], mongo), key: keyOf(docs[i], idFields) ?? undefined, title: readOnly ? 'Document' : 'Edit document' }),
    duplicate: (i: number) => setEditing({ mode: 'insert', text: toText(dynamo ? docs[i] : without(docs[i], ['_id', '_index']), mongo), title: 'Insert a copy' }),
    copy: (i: number) => api.copy(JSON.stringify(docs[i], null, 2), 'the document'),
    remove: async (i: number) => {
      const key = keyOf(docs[i], idFields);
      if (!key) return api.toast('That document has no id to delete it by.', true);
      if (!(await api.confirm('Delete the document?', `${Object.entries(key).filter(([k]) => k !== '_index').map(([k, v]) => `${k}: ${toText(v, mongo)}`).join(', ')} will be deleted from ${tab.title}.`, 'Delete', true))) return;
      try {
        await call('docRemove', { keys: [key] });
        api.toast('Deleted the document.');
        void reload();
      } catch (e) {
        api.fail(e);
      }
    },
  };
  const newDoc = () => setEditing({ mode: 'insert', text: dynamo && idFields.length ? `{\n${idFields.map((f) => `  ${JSON.stringify(f)}: ""`).join(',\n')}\n}` : '{\n  \n}', title: 'Insert a document' });
  const save = async (text: string) => {
    if (!editing) return;
    if (editing.mode === 'insert') await call('docInsert', { doc: text });
    else await call('docReplace', { key: editing.key, doc: text });
    api.toast(editing.mode === 'insert' ? 'Inserted the document.' : 'Saved the document.');
    void reload();
  };

  const field = (name: keyof Query, label: string, placeholder: string, className?: string) => (
    <label className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="w-[58px] flex-none text-right text-[10.5px] text-[var(--node-muted)]">{label}</span>
      <NodeInput
        spellCheck={false}
        className="h-6 min-w-0 flex-1 font-mono text-[11.5px]"
        placeholder={placeholder}
        value={q[name]}
        onChange={(e) => setQ({ ...q, [name]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            run();
          }
        }}
      />
    </label>
  );

  const pageText = result ? (docs.length ? `${(start + 1).toLocaleString()}–${(start + docs.length).toLocaleString()}` : '0') + (result.total !== null ? ` of ${dynamo && !applied.filter ? '~' : ''}${result.total.toLocaleString()}` : '') : '';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col text-[11.5px]">
      <div className="flex flex-none flex-col gap-1 border-b border-[var(--node-border)] px-2 py-1.5">
        <div className="flex items-center gap-1">
          {field('filter', dynamo ? 'Where' : engine === 'elasticsearch' ? 'Query' : 'Filter', ph.filter, 'flex-1')}
          <NodeButton onClick={() => run()} className="border-[var(--node-accent)] text-[var(--node-accent)]">
            Find
          </NodeButton>
          <NodeButton
            disabled={!q.filter && !q.sort && !q.projection}
            onClick={() => {
              const empty = { filter: '', sort: '', projection: '' };
              setQ(empty);
              run(empty);
            }}
          >
            Reset
          </NodeButton>
        </div>
        <div className="flex items-center gap-1">
          {!dynamo && field('sort', 'Sort', ph.sort, 'flex-1')}
          {field('projection', ph.projectionLabel, ph.projection, 'flex-1')}
        </div>
      </div>
      <Toolbar>
        <Tabs
          variant="pills"
          label="Show as"
          value={view}
          onValueChange={(v) => (setView(v), p.setState({ view: v }))}
          items={[
            { value: 'json', label: 'JSON' },
            { value: 'table', label: 'Table' },
          ]}
        />
        {view === 'json' && (
          <>
            <ToolButton label="Open every document" icon={ChevronsUpDown} onClick={() => setExpand((n) => Math.abs(n) + 1)} />
            <ToolButton label="Close every document" icon={ChevronsDownUp} onClick={() => setExpand((n) => -Math.abs(n) - 1)} />
          </>
        )}
        {!readOnly && <ToolButton label="Insert a document" icon={Plus} onClick={newDoc} />}
        <ToolButton label="Refresh" icon={RefreshCw} onClick={() => void reload()} className={loading ? 'animate-pulse' : undefined} />
        {result?.query && (
          <ToolButton
            label="Open the query in a console"
            icon={SquareTerminal}
            onClick={() => p.open({ type: 'console', conn: p.connection.id, ref: { database: tab.ref.database }, title: `Console · ${tab.title}`, key: `${p.connection.id}:console:${Date.now()}`, state: { text: result.query } })}
          />
        )}
        <div className="ml-auto flex items-center gap-1">
          <span className="text-[11px] text-[var(--node-muted)] tabular-nums">{pageText}</span>
          <ToolButton label="The page before" icon={ChevronLeft} disabled={!hasPrev || loading} onClick={prev} />
          <ToolButton label="The next page" icon={ChevronRight} disabled={!hasNext || loading} onClick={next} />
          <Picker
            label="Documents per page"
            value={String(limit)}
            options={LIMITS}
            onValueChange={(v) => {
              setLimit(Number(v));
              run(applied, Number(v));
            }}
          />
        </div>
      </Toolbar>
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      {!result && loading ? (
        <div className="p-6 text-center text-[var(--node-muted)]">Finding…</div>
      ) : view === 'table' && table ? (
        <Grid
          columns={table.columns}
          rows={table.rows}
          offset={start}
          copy={api.copy}
          empty="No documents match."
          onOpenValue={(r) => actions.edit(r)}
          menu={(r) => [
            { label: readOnly ? 'View the document' : 'Edit the document', run: () => actions.edit(r) },
            readOnly ? null : { label: 'Duplicate the document', run: () => actions.duplicate(r) },
            { label: 'Copy the document as JSON', run: () => actions.copy(r) },
            ...(readOnly ? [] : [null, { label: 'Delete the document', danger: true, run: () => void actions.remove(r) }]),
          ]}
          className={cn('min-h-0 flex-1', loading && 'opacity-60')}
        />
      ) : (
        <div className={cn('flex min-h-0 flex-1 flex-col', loading && 'opacity-60')}>
          <DocList docs={docs} mongo={mongo} readOnly={readOnly} actions={actions} offset={start} expandAll={expand} />
        </div>
      )}
      <StatusBar>
        {result && <span>{count(docs.length, 'document')}</span>}
        {result && <span>{ms(result.ms)}</span>}
        {readOnly && <span>Read only</span>}
        {loading && (
          <button type="button" className="ml-auto hover:text-[var(--node-fg)]" onClick={() => (running.current?.abort(), setLoading(false))}>
            Cancel
          </button>
        )}
      </StatusBar>
      {editing && <DocEditor editing={editing} readOnly={readOnly} hint={hint} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}
