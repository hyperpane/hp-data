// A console tab for Redis or etcd, as redis-cli is: a prompt with the
// server and database, a command line with its history (↑ and ↓), and
// each reply printed as redis-cli prints it, with how long it took.
// `clear` (or ⌘K) empties the transcript; it and the history are kept
// with the tab, the last few hundred of each.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';
import { ToolButton, cn } from '@hyperpane/ui';
import { address } from '../../../shared/kinds.ts';
import type { KvReply } from '../../../shared/kv.ts';
import type { TabProps } from '../../app/tabs.ts';
import { useFollow } from '../../lib/hooks.ts';
import { ms } from '../../ui/parts.tsx';
import { callsOf } from './lib.ts';

interface Entry {
  prompt: string;
  line: string;
  text: string;
  error?: boolean;
  ms?: number;
}

const KEEP = 300;
const HISTORY = 200;

export function ConsoleView(p: TabProps) {
  const { tab, api } = p;
  const st = (tab.state ?? {}) as { entries?: Entry[]; history?: string[]; db?: string };
  const [entries, setEntries] = useState<Entry[]>(st.entries ?? []);
  const [history, setHistory] = useState<string[]>(st.history ?? []);
  const [db, setDb] = useState<string | undefined>(st.db ?? tab.ref.database);
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const at = useRef<number | null>(null);
  const draft = useRef('');
  const input = useRef<HTMLInputElement>(null);
  const follow = useFollow(entries.length);
  const etcd = p.kind.engine === 'etcd';
  const calls = useMemo(() => callsOf(p, db), [p.connection.id, p.project, db, api]);
  const prompt = etcd
    ? `${address(p.kind, p.connection.values)}>`
    : `${address(p.kind, { ...p.connection.values, db: 0 })}${db && db !== '0' ? `[${db}]` : ''}>`;

  useEffect(() => {
    if (p.visible) input.current?.focus();
  }, [p.visible]);

  const keep = (e: Entry[], h: string[], d = db) => p.setState({ entries: e.slice(-KEEP), history: h.slice(-HISTORY), db: d });

  const run = async () => {
    const text = line.trim();
    if (!text || busy) return;
    const h = history.at(-1) === text ? history : [...history, text].slice(-HISTORY);
    setHistory(h);
    setLine('');
    at.current = null;
    if (/^clear$/i.test(text)) {
      setEntries([]);
      keep([], h);
      return;
    }
    setBusy(true);
    let entry: Entry;
    let nextDb = db;
    try {
      const r = await calls.call<{ reply: KvReply; ms: number }>('kvCommand', { line: text });
      entry = { prompt, line: text, text: r.reply.text, error: r.reply.error, ms: r.ms };
      if (r.reply.db !== undefined) nextDb = String(r.reply.db);
    } catch (e) {
      entry = { prompt, line: text, text: `(error) ${e instanceof Error ? e.message : String(e)}`, error: true };
    }
    setBusy(false);
    setDb(nextDb);
    setEntries((old) => {
      const next = [...old, entry].slice(-KEEP);
      keep(next, h, nextDb);
      return next;
    });
    follow.toEnd();
    queueMicrotask(() => input.current?.focus());
  };

  const recall = (by: number) => {
    if (!history.length) return;
    if (at.current === null) draft.current = line;
    const i = at.current === null ? (by < 0 ? history.length - 1 : null) : at.current + by;
    if (i === null) return;
    if (i >= history.length) {
      at.current = null;
      setLine(draft.current);
      return;
    }
    at.current = Math.max(0, i);
    setLine(history[at.current]);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col font-mono text-xs" onMouseUp={() => !window.getSelection()?.toString() && input.current?.focus()}>
      <div className="absolute top-1.5 right-2.5 z-10">
        <ToolButton
          label="Clear (⌘K)"
          icon={Eraser}
          onClick={() => {
            setEntries([]);
            keep([], history);
          }}
        />
      </div>
      <div ref={follow.ref} onScroll={follow.onScroll} className="min-h-0 flex-1 overflow-auto px-3 py-2 leading-[18px] select-text">
        {!entries.length && (
          <div className="pe-8 pb-2 font-sans text-xs text-[var(--node-muted)]">
            {etcd
              ? 'etcd’s console: get, get --prefix, ls, count, put (--ttl), del (--prefix), version. '
              : 'Commands as in redis-cli: SET k "a b", HGETALL user:1, SCAN 0 MATCH user:*. '}
            ↑ and ↓ go through what you ran; clear empties this.
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="pb-1">
            <div className="flex gap-2">
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">
                <span className="text-[var(--node-muted)]">{e.prompt} </span>
                {e.line}
              </span>
              {e.ms !== undefined && <span className="flex-none font-sans text-2xs text-[var(--node-muted)] tabular-nums">{ms(e.ms)}</span>}
            </div>
            <div className={cn('break-all whitespace-pre-wrap', e.error && 'text-[var(--ansi-1)]')}>{e.text}</div>
          </div>
        ))}
      </div>
      <form
        className="flex h-10 flex-none items-center gap-2 border-t border-[var(--node-border)] px-3 touch:h-12"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <span className="flex-none text-[var(--node-muted)]">{prompt}</span>
        <input
          ref={input}
          value={line}
          onChange={(e) => {
            setLine(e.target.value);
            at.current = null;
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              recall(-1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              recall(1);
            } else if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'l')) {
              e.preventDefault();
              setEntries([]);
              keep([], history);
            }
          }}
          spellCheck={false}
          autoComplete="off"
          aria-label="Command"
          placeholder={busy ? 'Waiting for the reply' : ''}
          className="min-w-0 flex-1 bg-transparent text-[var(--node-fg)] outline-none placeholder:text-[var(--node-muted)]"
        />
      </form>
    </div>
  );
}
