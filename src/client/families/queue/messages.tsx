// A topic's or a queue's messages: a toolbar (from the newest, the oldest
// or an offset; a partition; how many; Refresh; Live where the engine can
// tail; a filter over keys, values and headers), the messages as a table,
// and the one selected in a pane beside it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import { NodeButton, NodeInput, cn } from '@hyperpane/ui';
import type { Message } from '../../../shared/queue.ts';
import type { TabProps } from '../../app/tabs.ts';
import { ErrorBox, MiniSelect, Split, StatusLine, Toolbar, count, ms } from '../../ui/parts.tsx';
import type { Caps } from './caps.ts';
import { MessagePane } from './message-pane.tsx';
import { clock, fullTime, matches, placeOf, preview } from './format.ts';

/** The most kept while live: older ones go. */
const LIVE_MAX = 5000;
const LIMITS = ['20', '50', '100', '500', '1000'] as const;

type From = 'latest' | 'earliest' | 'offset';

interface PeekState {
  from: From;
  partition: string;
  offset: string;
  limit: string;
}

export function Messages({ p, caps, base, partitions, onAgain }: { p: TabProps; caps: Caps; base: Record<string, unknown>; partitions: number[]; onAgain(m: Message): void }) {
  const { api } = p;
  const kept = (p.tab.state?.peek as Partial<PeekState>) ?? {};
  const [q, setQ] = useState<PeekState>({ from: 'latest', partition: 'all', offset: '0', limit: '50', ...kept });
  const [list, setList] = useState<Message[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [took, setTook] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const set = (patch: Partial<PeekState>) => {
    const next = { ...q, ...patch };
    setQ(next);
    p.setState({ peek: next });
  };

  const load = async (o: PeekState = q) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    setError(null);
    const t = performance.now();
    try {
      const from = caps.from ? o.from : undefined;
      const partition = caps.partitions && (o.partition !== 'all' || o.from === 'offset') ? Number(o.partition === 'all' ? 0 : o.partition) : undefined;
      const got = await api.stream<Message[]>('qPeek', { ...base, limit: Number(o.limit), from, partition, offset: o.from === 'offset' ? o.offset : undefined }, c.signal);
      if (c.signal.aborted) return;
      setList(got);
      setFresh(new Set());
      setSel(null);
      setTook(performance.now() - t);
    } catch (e) {
      if (!c.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (ctl.current === c) setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    return () => ctl.current?.abort();
  }, [JSON.stringify(base)]);

  // Live: new messages added at the end, marked new until the next look.
  useEffect(() => {
    if (!live) return;
    const stop = api.subscribe<Message>(
      'qTail',
      base,
      (m) => {
        setList((l) => (l.length >= LIVE_MAX ? [...l.slice(l.length - LIVE_MAX + 1), m] : [...l, m]));
        setFresh((f) => new Set(f).add(m.id));
      },
      (err) => {
        setLive(false);
        if (err) setError(err);
      },
    );
    return stop;
  }, [live, JSON.stringify(base)]);

  // Following the end while live, unless scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (live && el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [list.length, live]);

  const shown = useMemo(() => list.map((m, i) => ({ m, i })).filter(({ m }) => matches(m, filter)), [list, filter]);
  const selected = sel === null ? null : (list[sel] ?? null);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = shown.findIndex((x) => x.i === sel);
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) setSel(next.i);
  };

  const partitionOptions = [...(q.from === 'offset' ? [] : [{ value: 'all', label: 'All partitions' }]), ...partitions.map((n) => ({ value: String(n), label: `Partition ${n}` }))];

  const table = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} tabIndex={0} onKeyDown={onKey} className="min-h-0 flex-1 overflow-auto outline-none">
        <table className="w-full table-fixed border-collapse text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-[var(--node-bg)]">
            <tr className="text-left text-[10.5px] text-[var(--node-muted)]">
              <th className="w-[92px] border-b border-[var(--node-border)] px-2 py-1 font-normal">Time</th>
              <th className="w-[76px] border-b border-[var(--node-border)] px-2 py-1 font-normal">{caps.partitions ? 'Part:Offset' : 'Message'}</th>
              <th className="w-[120px] border-b border-[var(--node-border)] px-2 py-1 font-normal">{caps.engine === 'rabbitmq' ? 'Routing key' : caps.engine === 'sqs' ? 'Group' : 'Key'}</th>
              <th className="border-b border-[var(--node-border)] px-2 py-1 font-normal">Value</th>
              <th className="w-[34px] border-b border-[var(--node-border)] px-1 py-1 text-right font-normal" title="Headers">
                H
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ m, i }) => {
              const nh = Object.keys(m.headers ?? {}).length;
              return (
                <tr
                  key={`${i}:${m.id}`}
                  onClick={() => setSel(i)}
                  onDoubleClick={() => api.copy(m.value, 'the value')}
                  className={cn('h-[22px] cursor-default', sel === i ? 'bg-[color-mix(in_srgb,var(--node-accent)_22%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]', fresh.has(m.id) && sel !== i && 'bg-[color-mix(in_srgb,#3fb950_10%,transparent)]')}
                >
                  <td className="truncate px-2 font-mono text-[var(--node-muted)] tabular-nums" title={fullTime(m.at)}>
                    {clock(m.at)}
                  </td>
                  <td className="truncate px-2 font-mono tabular-nums" title={m.id}>
                    {caps.partitions ? placeOf(m) : i + 1}
                  </td>
                  <td className="truncate px-2 font-mono" title={m.key ?? ''}>
                    {m.key ?? <span className="text-[var(--node-muted)]">—</span>}
                  </td>
                  <td className={cn('truncate px-2 font-mono', m.binary && 'text-[var(--node-muted)]')}>{preview(m) || <span className="text-[var(--node-muted)]">{m.meta?.tombstone ? 'null (tombstone)' : 'empty'}</span>}</td>
                  <td className="px-1 text-right text-[var(--node-muted)] tabular-nums">{nh || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && !busy && (
          <p className="py-8 text-center text-[var(--node-muted)]">
            {list.length ? 'No message matches the filter.' : live ? 'Waiting for new messages…' : `No messages${caps.from && q.from === 'offset' ? ' from that offset' : ''}.`}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        {caps.from && (
          <MiniSelect<From>
            title="Where to look"
            value={q.from}
            options={[
              { value: 'latest', label: 'Newest' },
              { value: 'earliest', label: 'Oldest' },
              { value: 'offset', label: 'From offset' },
            ]}
            onChange={(from) => {
              const next = { ...q, from, partition: from === 'offset' && q.partition === 'all' ? String(partitions[0] ?? 0) : q.partition };
              set(next);
              if (from !== 'offset') void load(next);
            }}
          />
        )}
        {caps.partitions && partitionOptions.length > 0 && <MiniSelect title="Partition" value={q.partition} options={partitionOptions} onChange={(partition) => (set({ partition }), void load({ ...q, partition }))} />}
        {caps.from && q.from === 'offset' && (
          <NodeInput className="h-6 w-[90px] font-mono" value={q.offset} placeholder="offset" aria-label="Offset" onChange={(e) => set({ offset: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void load()} />
        )}
        <MiniSelect title="How many" value={q.limit} options={LIMITS.map((l) => ({ value: l, label: `${l} messages` }))} onChange={(limit) => (set({ limit }), void load({ ...q, limit }))} />
        <NodeButton disabled={busy} onClick={() => void load()}>
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
          Refresh
        </NodeButton>
        {caps.live && (
          <NodeButton
            onClick={() => setLive((x) => !x)}
            title={caps.engine === 'sqs' ? 'Polls every 2 seconds and adds messages it hasn’t seen' : 'Adds messages as they’re published'}
            className={cn(live && 'border-[#3fb950] text-[#3fb950]')}
          >
            <Radio className={cn('size-3.5', live && 'animate-pulse')} />
            Live
          </NodeButton>
        )}
        <NodeInput className="ml-1 h-6 min-w-[120px] flex-1" placeholder="Filter by key, value or header" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </Toolbar>
      {caps.peekNote && <div className="flex-none border-b border-[var(--node-border)] px-3 py-1 text-[10.5px] text-[var(--node-muted)]">{caps.peekNote}</div>}
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      {selected ? <Split id="queue.messages" dir="row" initial={560} min={240} first={table} second={<MessagePane m={selected} caps={caps} api={api} readOnly={p.readOnly} onAgain={() => onAgain(selected)} onClose={() => setSel(null)} />} /> : table}
      <StatusLine>
        <span>{filter ? `${count(shown.length, 'message')} of ${list.length.toLocaleString()}` : count(list.length, 'message')}</span>
        {took !== null && <span>looked in {ms(took)}</span>}
        {live && <span className="text-[#3fb950]">live{fresh.size ? `: ${fresh.size.toLocaleString()} new` : ''}</span>}
      </StatusLine>
    </div>
  );
}
