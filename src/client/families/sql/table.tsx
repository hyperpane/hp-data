// A table's tab, as DataGrip's: Data (a page of rows, a WHERE filter, the
// order from the header, paging, cells edited in place and rows added or
// deleted, all saved together in one transaction), Structure (columns,
// indexes, foreign keys) and DDL.

import { useEffect, useMemo, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Plus, RefreshCw, RotateCcw, SquareTerminal, Upload } from 'lucide-react';
import { NodeButton, NodeInput, ToolButton, cn } from '@hyperpane/ui';
import { qualified, type Dialect } from '../../../shared/sql.ts';
import type { Cell } from '../../../shared/types.ts';
import type { BrowseResult, RowEdit, TableInfo, TableRef } from '../../../shared/sql.ts';
import type { TabProps } from '../../app/tabs.ts';
import { Grid, type GridEdits, hasEdits, noEdits } from '../../ui/grid.tsx';
import { CodeEditor } from '../../ui/code.tsx';
import { ErrorBox, MiniSelect, StatusLine, Toolbar, ValueViewer, count, ms } from '../../ui/parts.tsx';
import { Structure } from './structure.tsx';

const SIZES = ['50', '100', '200', '500', '1000'] as const;

export function SqlTable({ tab, connection, kind, api, project, setState, open, readOnly, visible }: TabProps) {
  const table: TableRef = { database: tab.ref.database, schema: tab.ref.schema, table: tab.ref.table ?? '' };
  const s = tab.state ?? {};
  const [view, setView] = useState<'data' | 'structure' | 'ddl'>((s.view as 'data') ?? 'data');
  const [size, setSize] = useState<(typeof SIZES)[number]>((SIZES as readonly string[]).includes(String(s.size)) ? (String(s.size) as '200') : (SIZES as readonly string[]).includes(String(connection.values.pageSize)) ? (String(connection.values.pageSize) as '200') : '200');
  const [offset, setOffset] = useState(0);
  const [where, setWhere] = useState<string>(typeof s.where === 'string' ? s.where : '');
  const [applied, setApplied] = useState(where);
  const [order, setOrder] = useState<{ column: string; desc: boolean }[]>(Array.isArray(s.order) ? (s.order as { column: string; desc: boolean }[]) : []);
  const [page, setPage] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<GridEdits>(noEdits);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<TableInfo | null>(null);
  const [value, setValue] = useState<{ r: number; c: number; value: Cell } | null>(null);
  const [tick, setTick] = useState(0);
  const dialect = (kind.engine === 'postgres' || kind.engine === 'mysql' || kind.engine === 'sqlite' || kind.engine === 'clickhouse' ? kind.engine : 'postgres') as Dialect;
  const name = qualified(dialect, table);
  const editable = !!page?.editable && !readOnly;

  useEffect(() => setState({ view, size, where: applied, order }), [view, size, applied, order]);

  useEffect(() => {
    if (!visible && page) return;
    const ac = new AbortController();
    setLoading(true);
    api
      .stream<BrowseResult>('browse', { id: connection.id, project, table, offset, limit: Number(size), where: applied, order }, ac.signal)
      .then(
        (r) => {
          setPage(r);
          setError(null);
          setEdits(noEdits());
        },
        (e: Error) => !ac.signal.aborted && setError(e.message),
      )
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
  }, [connection.id, offset, size, applied, JSON.stringify(order), tick, visible && !page]);

  useEffect(() => {
    if (view === 'data' || info) return;
    void api.call<TableInfo>('describe', { id: connection.id, project, table }).then(setInfo, (e: Error) => setError(e.message));
  }, [view]);

  const pending = useMemo(() => {
    if (!page) return [] as RowEdit[];
    const keyCols = page.columns.map((c, i) => ({ c, i })).filter(({ c }) => c.key);
    const keyOf = (r: number) => Object.fromEntries(keyCols.map(({ c, i }) => [c.name, page.rows[r][i]]));
    const out: RowEdit[] = [];
    for (const r of edits.deleted) out.push({ op: 'delete', key: keyOf(r) });
    const byRow = new Map<number, Record<string, Cell>>();
    for (const [k, v] of edits.changed) {
      const [r, c] = k.split(':').map(Number);
      if (edits.deleted.has(r) || r >= page.rows.length) continue;
      byRow.set(r, { ...byRow.get(r), [page.columns[c].name]: v });
    }
    for (const [r, set] of byRow) out.push({ op: 'update', key: keyOf(r), set });
    edits.added.forEach((row, i) => {
      const values: Record<string, Cell> = {};
      row.forEach((v, c) => {
        const k = `${page.rows.length + i}:${c}`;
        const val = edits.changed.has(k) ? edits.changed.get(k)! : v;
        if (val !== null && !page.columns[c].readOnly) values[page.columns[c].name] = val;
      });
      out.push({ op: 'insert', values });
    });
    return out;
  }, [edits, page]);

  const submit = async () => {
    if (!pending.length) return;
    setSaving(true);
    try {
      const r = await api.call<{ affected: number }>('apply', { id: connection.id, project, table, edits: pending });
      api.toast(`Saved: ${count(r.affected, 'row')} changed.`);
      setTick((t) => t + 1);
    } catch (e) {
      api.fail(e);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && hasEdits(edits)) {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [visible, edits, pending]);

  const total = page?.total ?? null;
  const last = total !== null ? Math.max(0, Math.floor((total - 1) / Number(size)) * Number(size)) : null;
  const rowsShown = page?.rows.length ?? 0;
  const go = (o: number) => {
    if (hasEdits(edits)) return api.toast('Save or revert the changes first.', true);
    setOffset(Math.max(0, o));
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <div className="flex h-6 overflow-hidden rounded-[5px] border border-[var(--node-border)]">
          {(['data', 'structure', 'ddl'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={cn('px-2.5 text-[11px]', view === v ? 'bg-[color-mix(in_srgb,var(--node-accent)_22%,transparent)] text-[var(--node-fg)]' : 'text-[var(--node-muted)] hover:text-[var(--node-fg)]')}>
              {v === 'data' ? 'Data' : v === 'structure' ? 'Structure' : 'DDL'}
            </button>
          ))}
        </div>
        {view === 'data' && (
          <>
            <ToolButton label="Refresh" icon={RefreshCw} onClick={() => (hasEdits(edits) ? api.toast('Save or revert the changes first.', true) : setTick((t) => t + 1))} />
            <span className="mx-0.5 h-4 w-px bg-[var(--node-border)]" />
            <ToolButton label="First page" icon={ChevronFirst} disabled={offset === 0} onClick={() => go(0)} />
            <ToolButton label="Previous page" icon={ChevronLeft} disabled={offset === 0} onClick={() => go(offset - Number(size))} />
            <span className="min-w-[90px] text-center text-[11px] text-[var(--node-muted)] tabular-nums">
              {rowsShown ? `${(offset + 1).toLocaleString()}–${(offset + rowsShown).toLocaleString()}` : '0'}
              {total !== null ? ` of ${total.toLocaleString()}` : ''}
            </span>
            <ToolButton label="Next page" icon={ChevronRight} disabled={rowsShown < Number(size) || (total !== null && offset + rowsShown >= total)} onClick={() => go(offset + Number(size))} />
            <ToolButton label="Last page" icon={ChevronLast} disabled={last === null || offset >= last} onClick={() => last !== null && go(last)} />
            <MiniSelect title="Rows per page" value={size} options={SIZES.map((x) => ({ value: x, label: x }))} onChange={(v) => (setSize(v), setOffset(0))} />
            {editable && (
              <>
                <span className="mx-0.5 h-4 w-px bg-[var(--node-border)]" />
                <ToolButton label="Add a row" icon={Plus} onClick={() => setEdits((e) => ({ ...e, added: [...e.added, page!.columns.map(() => null)] }))} />
              </>
            )}
            {hasEdits(edits) && (
              <>
                <NodeButton disabled={saving} onClick={submit} className="border-[#3fb950] text-[#3fb950]" title="⌘S">
                  <Upload className="size-3.5" />
                  Save {count(pending.length, 'change')}
                </NodeButton>
                <NodeButton disabled={saving} onClick={() => setEdits(noEdits())}>
                  <RotateCcw className="size-3.5" />
                  Revert
                </NodeButton>
              </>
            )}
            <span className="ml-auto" />
            <ToolButton label="Open the query in a console" icon={SquareTerminal} onClick={() => open({ key: `${connection.id}:console:${Date.now().toString(36)}`, type: 'console', conn: connection.id, ref: { database: table.database }, title: `${table.table}`, state: { text: `${page?.sql ?? `SELECT * FROM ${name}`};\n` } })} />
          </>
        )}
      </Toolbar>
      {view === 'data' && (
        <div className="flex h-8 flex-none items-center gap-2 border-b border-[var(--node-border)] px-2">
          <span className="font-mono text-[11px] font-semibold text-[#bc8cff]">WHERE</span>
          <NodeInput
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setOffset(0);
                setApplied(where);
                setTick((t) => t + 1);
              } else if (e.key === 'Escape') setWhere(applied);
            }}
            placeholder={`a condition, as in SQL: ${page?.columns[1]?.name ?? 'name'} LIKE 'a%'  (Enter applies)`}
            spellCheck={false}
            className="h-6 flex-1 font-mono text-[11px]"
          />
          {order.length > 0 && (
            <button type="button" className="flex-none font-mono text-[10.5px] text-[var(--node-muted)] hover:text-[var(--node-fg)]" title="Click a column’s header to sort, Shift-click to add; click here to clear" onClick={() => setOrder([])}>
              ORDER BY {order.map((o) => `${o.column}${o.desc ? ' DESC' : ''}`).join(', ')} ×
            </button>
          )}
        </div>
      )}
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      {view === 'data' ? (
        page ? (
          <>
            <Grid
              columns={page.columns}
              rows={page.rows}
              offset={offset}
              editable={editable}
              edits={edits}
              onEdits={setEdits}
              order={order}
              onSort={(column, add) => {
                if (hasEdits(edits)) return api.toast('Save or revert the changes first.', true);
                setOffset(0);
                setOrder((o) => {
                  const cur = o.find((x) => x.column === column);
                  const next = !cur ? { column, desc: false } : !cur.desc ? { column, desc: true } : null;
                  const rest = add ? o.filter((x) => x.column !== column) : [];
                  return next ? [...rest, next] : rest;
                });
              }}
              table={name}
              copy={api.copy}
              onOpenValue={(r, c, v) => setValue({ r, c, value: v })}
              className={cn('flex-1', loading && 'opacity-60')}
              empty={applied ? 'No row matches the filter.' : 'The table is empty.'}
            />
            <StatusLine>
              <span>{count(rowsShown, 'row')}</span>
              <span>{ms(page.ms)}</span>
              {readOnly ? <span>read only</span> : !page.editable && <span>Not editable: {kind.engine === 'clickhouse' ? 'ClickHouse rows aren’t edited one by one' : 'no primary key'}</span>}
              {hasEdits(edits) && <span className="text-[#d29922]">{count(pending.length, 'change')} not saved (⌘S)</span>}
              <span className="ml-auto truncate font-mono">{page.sql}</span>
            </StatusLine>
          </>
        ) : (
          !error && <div className="p-6 text-center text-[var(--node-muted)]">Loading {table.table}…</div>
        )
      ) : view === 'structure' ? (
        info ? <Structure info={info} copy={api.copy} /> : <div className="p-6 text-center text-[var(--node-muted)]">Loading…</div>
      ) : (
        <CodeEditor value={info?.ddl ?? '-- Loading…'} language="sql" dialect={dialect === 'clickhouse' ? 'standard' : dialect} readOnly className="flex-1" />
      )}
      {value && page && (
        <ValueViewer
          title={`${page.columns[value.c].name} · row ${offset + value.r + 1}`}
          value={value.value}
          copy={api.copy}
          onClose={() => setValue(null)}
          onSave={editable && !page.columns[value.c].readOnly ? (text) => setEdits((e) => ({ ...e, changed: new Map(e.changed).set(`${value.r}:${value.c}`, text) })) : undefined}
        />
      )}
    </div>
  );
}
