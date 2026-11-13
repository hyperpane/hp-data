// A SQL console: the editor on top (the connection's dialect, its tables
// and columns completed), the results below. ⌘Enter runs the statement at
// the cursor (or the selection), Run All runs everything; a run can be
// cancelled. The text stays with the tab.

import { useEffect, useRef, useState } from 'react';
import { Play, PlayCircle, Square } from 'lucide-react';
import { NodeButton } from '@hyperpane/ui';
import { readsOnly, splitStatements } from '../../../shared/sql.ts';
import type { QueryResult, TreeNode } from '../../../shared/types.ts';
import type { TabProps } from '../../app/tabs.ts';
import { CodeEditor } from '../../ui/code.tsx';
import { MiniSelect, Split, Toolbar } from '../../ui/parts.tsx';
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
  const [limit, setLimit] = useState<(typeof LIMITS)[number]>((LIMITS as readonly string[]).includes(String(s.limit)) ? (String(s.limit) as (typeof LIMITS)[number]) : (LIMITS as readonly string[]).includes(String(connection.values.rowLimit)) ? (String(connection.values.rowLimit) as (typeof LIMITS)[number]) : '500');
  const [databases, setDatabases] = useState<string[]>([]);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [results, setResults] = useState<QueryResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<RunLog[]>([]);
  const [running, setRunning] = useState<AbortController | null>(null);
  const n = useRef(0);
  const editor = useRef<{ run(): void; focus(): void } | null>(null);

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
    void api.call<{ tables: { schema?: string; name: string; columns: string[] }[] }>('completions', { id: connection.id, project, database: database || undefined }).then(
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
      if (!(await api.confirm(`Run this on ${connection.name}?`, `It looks like it changes data:\n\n${first.length > 300 ? `${first.slice(0, 300)}…` : first}`, 'Run', true))) return;
    }
    const ac = new AbortController();
    setRunning(ac);
    setError(null);
    const at = Date.now();
    try {
      const r = await api.stream<QueryResult[]>('query', { id: connection.id, project, sql, limit: Number(limit), database: database || undefined }, ac.signal);
      setResults(r);
      setLog((l) => [...l, ...r.map((x) => ({ n: ++n.current, at, statement: x.statement ?? sql, ok: true, said: x.command || (x.columns.length ? `${x.rows.length} rows` : 'Done'), ms: x.ms }))].slice(-300));
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
        <NodeButton disabled={!!running} onClick={() => editor.current?.run()} title="Run the statement at the cursor, or the selection (⌘Enter)" className="text-[#3fb950]">
          <Play className="size-3.5" />
          Run
        </NodeButton>
        <NodeButton disabled={!!running} onClick={() => void run(text)} title="Run everything in the console">
          <PlayCircle className="size-3.5" />
          Run All
        </NodeButton>
        {running && (
          <NodeButton onClick={() => running.abort()} className="text-[#f85149]">
            <Square className="size-3" />
            Cancel
          </NodeButton>
        )}
        <span className="mx-1 h-4 w-px bg-[var(--node-border)]" />
        {databases.length > 0 && <MiniSelect title="The database statements run in" value={database} options={[...(database && !databases.includes(database) ? [{ value: database, label: database }] : []), ...(!database ? [{ value: '', label: 'Default database' }] : []), ...databases.map((d) => ({ value: d, label: d }))]} onChange={setDatabase} />}
        <MiniSelect title="The most rows a statement gives" value={limit} options={LIMITS.map((l) => ({ value: l, label: `${Number(l).toLocaleString()} rows` }))} onChange={(v) => setLimit(v as typeof limit)} />
        {connection.readOnly && <span className="ml-1 rounded-[3px] border border-[var(--node-border)] px-1 text-[10px] text-[var(--node-muted)]">read only</span>}
        <span className="ml-auto truncate text-[10.5px] text-[var(--node-muted)]">⌘Enter runs the statement at the cursor</span>
      </Toolbar>
      <Split
        id={`console.${kind.family}`}
        dir="column"
        initial={220}
        first={<EditorRunner text={text} setText={setText} dialect={dialectOf(kind.engine)} schema={schema} onRun={run} handle={editor} />}
        second={<Results results={results} error={error} log={log} running={!!running} api={api} onClearError={() => setError(null)} />}
      />
    </div>
  );
}

/** The editor; Run in the toolbar runs as ⌘Enter does (it knows the cursor). */
function EditorRunner({ text, setText, dialect, schema, onRun, handle }: { text: string; setText(t: string): void; dialect: string; schema: Record<string, string[]>; onRun(sql: string): void; handle: { current: { run(): void; focus(): void } | null } }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CodeEditor value={text} onChange={setText} language="sql" dialect={dialect} schema={schema} onRun={onRun} handle={handle} className="flex-1" autoFocus />
    </div>
  );
}
