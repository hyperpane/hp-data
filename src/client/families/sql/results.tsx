// A console's results: a tab per statement that gave rows, and Output
// (every statement run, what it did, how long it took, what failed).

import { useEffect, useState } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import { StatusBar, Tabs, cn } from '@hyperpane/ui';
import type { Cell, QueryResult } from '../../../shared/types.ts';
import type { Api } from '../../lib/api.ts';
import { Grid } from '../../ui/grid.tsx';
import { ErrorBox, ValueViewer, count, ms } from '../../ui/parts.tsx';

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
      <Tabs
        label="Results"
        className="overflow-x-auto [scrollbar-width:none]"
        value={String(tab)}
        onValueChange={(v) => setTab(v === 'output' ? 'output' : Number(v))}
        items={[
          ...withRows.map(({ r, i }, n) => ({
            value: String(i),
            title: `${r.rows.length.toLocaleString()}${r.truncated ? '+' : ''} rows`,
            label: (
              <>
                {withRows.length > 1 ? `Result ${n + 1}` : 'Result'}{' '}
                <span className="text-[10px] text-[var(--node-muted)]">
                  {r.rows.length}
                  {r.truncated ? '+' : ''}
                </span>
              </>
            ),
          })),
          {
            value: 'output',
            title: 'Output',
            label: error ? (
              <span className="flex items-center gap-1.5">
                Output
                <span className="size-1.5 rounded-full bg-[#f85149]" />
              </span>
            ) : (
              'Output'
            ),
          },
        ]}
        end={running && <span className="text-[var(--node-muted)]">Running</span>}
      />
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
          <StatusBar>
            <span>
              {count(shown.rows.length, 'row')}
              {shown.truncated ? ' (more not fetched: raise the limit, or add LIMIT)' : ''}
            </span>
            <span>{ms(shown.ms)}</span>
            {shown.statement && <span className="truncate font-mono">{shown.statement.replace(/\s+/g, ' ').slice(0, 160)}</span>}
          </StatusBar>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] select-text">
          {error && <ErrorBox error={error} onClose={onClearError} className="m-2" />}
          {log.length === 0 && !error && (
            <div className="p-4 font-sans text-[var(--node-muted)]">Run a statement with ⌘Enter: the one at the cursor, or what’s selected</div>
          )}
          {[...log].reverse().map((l) => (
            <div key={l.n} className="flex items-start gap-2 border-b border-[color-mix(in_srgb,var(--node-border)_60%,transparent)] px-2 py-1">
              {l.ok ? <CircleCheck className="mt-px size-3.5 flex-none text-[#3fb950]" /> : <CircleX className="mt-px size-3.5 flex-none text-[#f85149]" />}
              <span className="w-16 flex-none text-[var(--node-muted)]">{new Date(l.at).toLocaleTimeString()}</span>
              <span className="min-w-0 flex-1 truncate" title={l.statement}>
                {l.statement.replace(/\s+/g, ' ')}
              </span>
              <span className={cn('flex-none', l.ok ? 'text-[var(--node-muted)]' : 'max-w-[50%] truncate text-[#f85149]')} title={l.said}>
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
