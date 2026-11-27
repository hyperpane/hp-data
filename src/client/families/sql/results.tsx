// A console's results: a tab per statement that gave rows, and Output
// (every statement run, what it did, how long it took, what failed).

import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, SquareTerminal } from '@hyperpane/icons';
import { Spinner, Tabs, cn } from '@hyperpane/ui';
import type { Cell, QueryResult } from '../../../shared/types.ts';
import type { Api } from '../../lib/api.ts';
import { Grid } from '../../ui/grid.tsx';
import { footer } from '../../ui/look.ts';
import { Blank, ErrorBox, ValueViewer, count, ms } from '../../ui/parts.tsx';

export interface RunLog {
  n: number;
  at: number;
  statement: string;
  ok: boolean;
  /** "SELECT 500", "UPDATE 3", or the error. */
  said: string;
  ms?: number;
}

export function Results({
  results,
  error,
  log,
  running,
  api,
  onClearError,
}: {
  results: QueryResult[];
  error: string | null;
  log: RunLog[];
  running: boolean;
  api: Api;
  onClearError(): void;
}) {
  const withRows = results.map((r, i) => ({ r, i })).filter(({ r }) => r.columns.length);
  const [tab, setTab] = useState<number | 'output'>('output');
  const [value, setValue] = useState<{ title: string; value: Cell } | null>(null);

  useEffect(() => {
    setTab(withRows.length ? withRows[withRows.length - 1].i : 'output');
  }, [results]);
  useEffect(() => {
    if (error) setTab('output');
  }, [error]);

  const shown = typeof tab === 'number' ? results[tab] : null;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div data-measure="results" className="flex h-11 flex-none items-center gap-2 border-b border-[var(--data-line)] px-2 touch:h-12">
      <Tabs
        label="Results"
        variant="pills"
        className="min-w-0 overflow-x-auto [scrollbar-width:none]"
        value={String(tab)}
        onValueChange={(v) => setTab(v === 'output' ? 'output' : Number(v))}
        items={[
          ...withRows.map(({ r, i }, n) => ({
            value: String(i),
            title: `${r.rows.length.toLocaleString()}${r.truncated ? '+' : ''} rows`,
            label: (
              <span className="flex items-center gap-1.5">
                {withRows.length > 1 ? `Result ${n + 1}` : 'Result'}
                <span className="font-normal text-[var(--node-muted)] tabular-nums">
                  {r.rows.length.toLocaleString()}
                  {r.truncated ? '+' : ''}
                </span>
              </span>
            ),
          })),
          {
            value: 'output',
            title: 'Output',
            label: error ? (
              <span className="flex items-center gap-1.5">
                Output
                <span className="size-1.5 rounded-full bg-[var(--data-error)]" />
              </span>
            ) : (
              'Output'
            ),
          },
        ]}
      />
        {running && (
          <span className="ms-auto flex flex-none items-center gap-1.5 pe-1 text-xs text-[var(--node-muted)]">
            <Spinner size="xs" />
            Running
          </span>
        )}
      </div>
      {shown ? (
        <>
          <Grid
            columns={shown.columns}
            rows={shown.rows}
            copy={api.copy}
            className="flex-1"
            onOpenValue={(r, c, v) => setValue({ title: `${shown.columns[c].name} · row ${r + 1}`, value: v })}
            empty="The statement gave no rows"
          />
          <div className={footer}>
            <span className="text-[var(--node-fg)]">
              {count(shown.rows.length, 'row')}
              {shown.truncated ? <span className="text-[var(--node-muted)]"> (more not fetched: raise the limit, or add LIMIT)</span> : ''}
            </span>
            <span>{ms(shown.ms)}</span>
            {shown.statement && <span className="ms-auto min-w-0 truncate font-mono text-[11px]">{shown.statement.replace(/\s+/g, ' ').slice(0, 160)}</span>}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto text-[13px] select-text">
          {error && <ErrorBox error={error} onClose={onClearError} className="mb-1" />}
          {log.length === 0 && !error && (
            <Blank icon={<SquareTerminal />} title="Nothing run yet">
              ⌘Enter runs the statement at the cursor, or what’s selected
            </Blank>
          )}
          {[...log].reverse().map((l) => (
            <div key={l.n} className="mx-1.5 flex min-h-8 flex-none items-center gap-2.5 rounded-control px-2 py-1 hover:bg-[var(--data-row-hover)]">
              {l.ok ? (
                <CircleCheck className="size-4 flex-none text-[var(--data-ok)]" />
              ) : (
                <CircleX className="size-4 flex-none text-[var(--data-error)]" />
              )}
              <span className="w-[72px] flex-none text-xs text-[var(--node-muted)] tabular-nums">{new Date(l.at).toLocaleTimeString()}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={l.statement}>
                {l.statement.replace(/\s+/g, ' ')}
              </span>
              <span className={cn('flex-none text-xs tabular-nums', l.ok ? 'text-[var(--node-muted)]' : 'max-w-[50%] truncate text-[var(--data-error)]')} title={l.said}>
                {l.said}
                {l.ms !== undefined && ` · ${ms(l.ms)}`}
              </span>
            </div>
          ))}
        </div>
      )}
      {value && <ValueViewer title={value.title} value={value.value} copy={api.copy} onClose={() => setValue(null)} />}
    </div>
  );
}
