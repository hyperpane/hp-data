// A SQL console: the editor on top (the connection's dialect, its tables
// and columns completed), the results below. ⌘Enter runs the statement at
// the cursor (or the selection), Run All runs everything; a run can be
// cancelled. The text stays with the tab.

import { useEffect, useRef, useState } from 'react';
import { Play, PlayCircle, Square } from 'lucide-react';
import { Badge, NodeButton, Picker, SplitPane, Toolbar, ToolbarSeparator, cn } from '@hyperpane/ui';
import { readsOnly, splitStatements } from '../../../shared/sql.ts';
import type { QueryResult, TreeNode } from '../../../shared/types.ts';
import type { TabProps } from '../../app/tabs.ts';
import { useRowsPort } from '../../lib/hooks.ts';
import { CodeEditor } from '../../ui/code.tsx';
import { softField } from '../../ui/parts.tsx';
import { Results, type RunLog } from './results.tsx';

const LIMITS = ['100', '500', '1000', '5000', '20000'] as const;

const dialectOf = (engine: string) => (engine === 'postgres' ? 'postgres' : engine === 'mysql' ? 'mysql' : engine === 'sqlite' ? 'sqlite' : 'standard');

const starter = (engine: string, database?: string) =>
  engine === 'sqlite'
    ? "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%';\n"
    : engine === 'clickhouse'
      ? 'SHOW TABLES;\n'
      : engine === 'mysql'
        ? 'SHOW TABLES;\n'
        : `-- ${database ?? 'the database'}\nSELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2;\n`;

export function SqlConsole({ tab, connection, kind, api, project, setState, visible }: TabProps) {
  const s = tab.state ?? {};
  const [text, setText] = useState<string>(typeof s.text === 'string' ? s.text : starter(kind.engine, tab.ref.database));
  const [database, setDatabase] = useState<string>(typeof s.database === 'string' ? s.database : (tab.ref.database ?? ''));
  const [limit, setLimit] = useState<(typeof LIMITS)[number]>(
    (LIMITS as readonly string[]).includes(String(s.limit))
      ? (String(s.limit) as (typeof LIMITS)[number])
      : (LIMITS as readonly string[]).includes(String(connection.values.rowLimit))
        ? (String(connection.values.rowLimit) as (typeof LIMITS)[number])
        : '500',
  );
  const [databases, setDatabases] = useState<string[]>([]);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [results, setResults] = useState<QueryResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<RunLog[]>([]);
  const [running, setRunning] = useState<AbortController | null>(null);
  const n = useRef(0);
  const editor = useRef<{ run(): void; focus(): void } | null>(null);
  const sendRows = useRowsPort(connection.name, visible);

  // What's typed, kept with the tab a little after the last key.
  useEffect(() => {
    const t = setTimeout(() => setState({ text, database, limit }), 400);
    return () => clearTimeout(t);
  }, [text, database, limit]);

  useEffect(() => {
    if (kind.engine === 'sqlite') return;
    void api.call<TreeNode[]>('children', { id: connection.id, path: [], project }).then(
      (nodes) => setDatabases(nodes.filter((x) => x.type === 'database').map((x) => x.name)),
      () => {},
    );
  }, [connection.id]);

  useEffect(() => {
    if (!visible) return;
    void api
      .call<{ tables: { schema?: string; name: string; columns: string[] }[] }>('completions', { id: connection.id, project, database: database || undefined })
      .then(
        (c) => {
          const out: Record<string, string[]> = {};
          for (const t of c.tables) {
            out[t.schema ? `${t.schema}.${t.name}` : t.name] = t.columns;
            if (!out[t.name]) out[t.name] = t.columns;
          }
          setSchema(out);
        },
        () => {},
      );
  }, [connection.id, database, visible]);

  const run = async (sql: string) => {
    if (!sql.trim() || running) return;
    if (connection.values.confirmWrites && !splitStatements(sql).every(readsOnly)) {
      const first = splitStatements(sql).find((x) => !readsOnly(x)) ?? sql;
      if (
        !(await api.confirm(
          `Run this on ${connection.name}?`,
          `It looks like it changes data:\n\n${first.length > 300 ? first.slice(0, 300) : first}`,
          'Run',
          true,
        ))
      )
        return;
    }
    const ac = new AbortController();
    setRunning(ac);
    setError(null);
    const at = Date.now();
    try {
      const r = await api.stream<QueryResult[]>('query', { id: connection.id, project, sql, limit: Number(limit), database: database || undefined }, ac.signal);
      setResults(r);
      // The last with rows, the one shown first.
      sendRows(r.findLast((x) => x.columns.length > 0));
      setLog((l) =>
        [
          ...l,
          ...r.map((x) => ({
            n: ++n.current,
            at,
            statement: x.statement ?? sql,
            ok: true,
            said: x.command || (x.columns.length ? `${x.rows.length} rows` : 'Done'),
            ms: x.ms,
          })),
        ].slice(-300),
      );
    } catch (e) {
      const message = ac.signal.aborted ? 'Cancelled.' : (e as Error).message;
      setError(message);
      setLog((l) => [...l, { n: ++n.current, at, statement: sql, ok: false, said: message }].slice(-300));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <NodeButton
          variant="primary"
          disabled={!!running}
          onClick={() => editor.current?.run()}
          title="Run the statement at the cursor, or the selection (⌘Enter)"
        >
          <Play />
          Run
        </NodeButton>
        <NodeButton variant="ghost" disabled={!!running} onClick={() => void run(text)} title="Run everything in the console">
          <PlayCircle />
          Run All
        </NodeButton>
        {running && (
          <NodeButton variant="danger" onClick={() => running.abort()}>
            <Square />
            Cancel
          </NodeButton>
        )}
        <ToolbarSeparator />
        {databases.length > 0 && (
          <Picker
            label="The database statements run in"
            size="sm"
            className={cn('max-w-48', softField)}
            value={database}
            options={[
              ...(database && !databases.includes(database) ? [{ value: database, label: database }] : []),
              ...(!database ? [{ value: '', label: 'Default database' }] : []),
              ...databases.map((d) => ({ value: d, label: d })),
            ]}
            onValueChange={setDatabase}
          />
        )}
        <Picker
          label="The most rows a statement gives"
          size="sm"
          className={softField}
          value={limit}
          options={LIMITS.map((l) => ({ value: l, label: `${Number(l).toLocaleString()} rows` }))}
          onValueChange={(v) => setLimit(v as typeof limit)}
        />
        {connection.readOnly && (
          <Badge size="sm" shape="rounded" className="ms-1">
            Read only
          </Badge>
        )}
        <span className="ms-auto truncate ps-2 text-2xs text-[var(--node-muted)] max-sm:hidden touch:hidden">⌘Enter runs the statement at the cursor</span>
      </Toolbar>
      <SplitPane
        id={`console.${kind.family}`}
        direction="column"
        initial={220}
        min={80}
        minOther={80}
        first={<EditorRunner text={text} setText={setText} dialect={dialectOf(kind.engine)} schema={schema} onRun={run} handle={editor} />}
        second={<Results results={results} error={error} log={log} running={!!running} api={api} onClearError={() => setError(null)} />}
      />
    </div>
  );
}

/** The editor; Run in the toolbar runs as ⌘Enter does (it knows the cursor). */
function EditorRunner({
  text,
  setText,
  dialect,
  schema,
  onRun,
  handle,
}: {
  text: string;
  setText(t: string): void;
  dialect: string;
  schema: Record<string, string[]>;
  onRun(sql: string): void;
  handle: { current: { run(): void; focus(): void } | null };
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CodeEditor value={text} onChange={setText} language="sql" dialect={dialect} schema={schema} onRun={onRun} handle={handle} className="flex-1" autoFocus />
    </div>
  );
}
