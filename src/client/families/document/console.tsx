// The document family's console: mongosh lines (MongoDB), Dev Tools’
// requests (Elasticsearch, OpenSearch), PartiQL or an API call (DynamoDB).
// ⌘Enter runs the selection, else what's at the cursor: the paragraph, the
// request, the statement. The result is a JSON tree, a table when it's a
// list of flat objects, or text; the text and a history are kept with the tab.

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { Braces, History, Play, Square } from '@hyperpane/icons';
import { Badge, Empty, JsonTree, NodeButton, Spinner, SplitPane, StatusBar, Tabs, ToolButton, Toolbar, useMenu } from '@hyperpane/ui';
import type { CommandResult } from '../../../shared/document.ts';
import type { TabProps } from '../../app/tabs.ts';
import { CodeEditor, statementAt } from '../../ui/code.tsx';
import { Grid } from '../../ui/grid.tsx';
import { ErrorBox, ms } from '../../ui/parts.tsx';
import { flatList, paragraphAt, pretty, requestAt, tableOf } from './format.ts';

const HISTORY = 50;

const PLACEHOLDERS: Record<string, string> = {
  mongodb: 'db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(20)   ·   show dbs   ·   use shop   ·   ⌘Enter runs the paragraph at the cursor',
  elasticsearch: 'GET /_cat/indices?v\n\nPOST /logs/_search\n{ "query": { "match": { "message": "timeout" } } }\n\n⌘Enter sends the request at the cursor',
  dynamodb: 'SELECT * FROM "products" WHERE category = \'books\'\n\nDescribeTable {"TableName": "products"}\n\n⌘Enter runs the statement at the cursor',
};

export function ConsoleView(p: TabProps) {
  const { api, tab } = p;
  const engine = p.kind.engine;
  const mongo = engine === 'mongodb';
  const st = tab.state ?? {};
  const [text, setText] = useState(typeof st.text === 'string' ? st.text : '');
  const [database, setDatabase] = useState(String(st.database ?? tab.ref.database ?? (p.connection.values.database as string | undefined) ?? ''));
  const history = (Array.isArray(st.history) ? st.history : []) as string[];
  const [out, setOut] = useState<(CommandResult & { ran: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<AbortController | null>(null);
  const [view, setView] = useState<'tree' | 'table'>('tree');
  const box = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menu = useMenu();

  const change = (t: string) => {
    setText(t);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => p.setState({ text: t }), 400);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  /** What ⌘Enter means: the selection, else the block at the cursor. */
  const pick = (given: string): string => {
    const el = box.current?.querySelector('.cm-editor') as HTMLElement | null;
    const view = el ? EditorView.findFromDOM(el) : null;
    if (!view) return given;
    const sel = view.state.selection.main;
    const doc = view.state.doc.toString();
    if (!sel.empty) return doc.slice(sel.from, sel.to);
    if (engine === 'elasticsearch') return requestAt(doc, sel.head);
    if (engine === 'dynamodb') return statementAt(doc, sel.head).text || doc;
    return paragraphAt(doc, sel.head);
  };

  const run = async (given: string) => {
    const t = pick(given).trim();
    if (!t) return;
    running?.abort();
    const ac = new AbortController();
    setRunning(ac);
    setError(null);
    try {
      const r = await api.stream<CommandResult>('docCommand', { id: p.connection.id, project: p.project, database: database || undefined, text: t }, ac.signal);
      setOut({ ...r, ran: t });
      if (r.database) setDatabase(r.database);
      setView(flatList(r.result) ? 'table' : 'tree');
      p.setState({ text, history: [t, ...history.filter((h) => h !== t)].slice(0, HISTORY), ...(r.database ? { database: r.database } : {}) });
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning((cur) => (cur === ac ? null : cur));
    }
  };

  const result = out?.result;
  const shown = useMemo(() => pretty(result, mongo), [out]);
  const table = useMemo(() => (view === 'table' && Array.isArray(result) ? tableOf(result, [], mongo) : null), [out, view]);
  const isText = out?.text || typeof result === 'string';
  const items = Array.isArray(result) ? result.length : null;

  const editor = (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <NodeButton variant="primary" title="Run (⌘Enter)" disabled={!!running} onClick={() => void run(text)}>
          <Play />
          Run
        </NodeButton>
        {running && (
          <NodeButton
            variant="danger"
            onClick={() => {
              running.abort();
              setRunning(null);
            }}
          >
            <Square />
            Cancel
          </NodeButton>
        )}
        <ToolButton
          label="History"
          icon={History}
          disabled={!history.length}
          onClick={(e) =>
            menu.open(
              e,
              history.slice(0, 25).map((h) => ({
                label: h.replace(/\s+/g, ' ').slice(0, 90),
                run: () => change(text.trim() ? `${text.replace(/\n*$/, '')}\n\n${h}\n` : `${h}\n`),
              })),
            )
          }
        />
        {mongo && <span className="ms-1 font-mono text-2xs text-[var(--node-muted)]">{database ? `db: ${database}` : 'db: test'}</span>}
        {p.readOnly && (
          <Badge size="sm" shape="rounded" className="ms-auto" title="Changes are refused">
            Read only
          </Badge>
        )}
      </Toolbar>
      <CodeEditor
        value={text}
        onChange={change}
        language={engine === 'dynamodb' ? 'sql' : 'json'}
        placeholder={PLACEHOLDERS[engine] ?? PLACEHOLDERS.mongodb}
        onRun={(t) => void run(t)}
        autoFocus
        className="min-h-0 flex-1"
      />
      {menu.element}
    </div>
  );

  const results = (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      {out && !isText && Array.isArray(result) && result.length > 0 && result.every((x) => x && typeof x === 'object' && !Array.isArray(x)) && (
        <Toolbar>
          <Tabs
            variant="pills"
            label="Show as"
            value={view}
            onValueChange={setView}
            items={[
              { value: 'tree', label: 'JSON' },
              { value: 'table', label: 'Table' },
            ]}
          />
          <NodeButton
            variant="ghost"
            className="ms-auto"
            onClick={() => api.copy(typeof result === 'string' ? result : JSON.stringify(result, null, 2), 'the result')}
          >
            Copy
          </NodeButton>
        </Toolbar>
      )}
      {!out ? (
        !error &&
        (running ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-[var(--node-muted)]">
            <Spinner size="xs" />
            Running
          </div>
        ) : (
          <Empty bordered={false} className="flex-1" icon={<Braces />} title="No result yet" description="Run something with ⌘Enter to see its result here" />
        ))
      ) : isText ? (
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre select-text">
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </pre>
      ) : table ? (
        <Grid columns={table.columns} rows={table.rows} copy={api.copy} empty="Nothing." className="min-h-0 flex-1" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-1.5 py-1 font-mono text-xs">
          <JsonTree value={shown} depth={2} footer className="min-h-0 flex-1" />
        </div>
      )}
      <StatusBar>
        {out && <span>{ms(out.ms)}</span>}
        {out?.status !== undefined && <span className={out.status >= 400 ? 'text-[var(--ansi-1)]' : undefined}>{out.status}</span>}
        {items !== null && (
          <span>
            {items.toLocaleString()} {items === 1 ? 'item' : 'items'}
          </span>
        )}
        {out && <span className="min-w-0 truncate font-mono">{out.ran.replace(/\s+/g, ' ').slice(0, 120)}</span>}
      </StatusBar>
    </div>
  );

  return <SplitPane id="doc-console" direction="column" initial={220} min={80} minOther={80} first={editor} second={results} />;
}
