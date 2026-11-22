// A console's results: a tab per statement that gave rows, and Output
// (every statement run, what it did, how long it took, what failed).

import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, SquareTerminal } from 'lucide-react';
import { Empty, Spinner, StatusBar, Tabs, cn } from '@hyperpane/ui';
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
                <span className="text-2xs font-normal text-[var(--node-muted)] tabular-nums">
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
                <span className="size-1.5 rounded-full bg-[var(--ansi-1)]" />
              </span>
            ) : (
              'Output'
            ),
          },
        ]}
        end={
          running && (
            <span className="flex items-center gap-1.5 pe-1.5 text-2xs text-[var(--node-muted)]">
              <Spinner size="xs" />
              Running
            </span>
          )
        }
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
        <div className="flex min-h-0 flex-1 flex-col overflow-auto text-xs select-text">
          {error && <ErrorBox error={error} onClose={onClearError} />}
          {log.length === 0 && !error && (
            <Empty
              bordered={false}
              className="flex-1"
              icon={<SquareTerminal />}
              title="Nothing run yet"
              description="⌘Enter runs the statement at the cursor, or what’s selected"
            />
          )}
          {[...log].reverse().map((l) => (
            <div key={l.n} className="flex min-h-7 flex-none items-start gap-2 border-b border-[var(--node-border)] px-2.5 py-1.5">
              {l.ok ? (
                <CircleCheck className="mt-px size-3.5 flex-none text-[var(--ansi-2)]" />
              ) : (
                <CircleX className="mt-px size-3.5 flex-none text-[var(--ansi-1)]" />
              )}
              <span className="w-16 flex-none text-2xs leading-4 text-[var(--node-muted)] tabular-nums">{new Date(l.at).toLocaleTimeString()}</span>
              <span className="min-w-0 flex-1 truncate font-mono leading-4" title={l.statement}>
                {l.statement.replace(/\s+/g, ' ')}
              </span>
              <span className={cn('flex-none leading-4', l.ok ? 'text-[var(--node-muted)]' : 'max-w-[50%] truncate text-[var(--ansi-1)]')} title={l.said}>
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
