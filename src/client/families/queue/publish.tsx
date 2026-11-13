// Publishing a message: its key (or message group, or routing key), the
// partition, its value as JSON or text, and headers; sent with Send or
// ⌘Enter, and confirmed in a toast. A read-only connection can't.

import { useEffect, useRef, useState } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { NodeButton, NodeInput, ToolButton, cn } from '@hyperpane/ui';
import type { TabProps } from '../../app/tabs.ts';
import { CodeEditor } from '../../ui/code.tsx';
import { MiniSelect } from '../../ui/parts.tsx';
import type { Caps } from './caps.ts';
import { pretty } from './format.ts';

export interface Draft {
  key: string;
  value: string;
  headers: { key: string; value: string }[];
  /** '' for any. */
  partition: string;
  routingKey: string;
}

export const emptyDraft = (): Draft => ({ key: '', value: '', headers: [], partition: '', routingKey: '' });

/** What the server said it published, as a sentence's end. */
function where(caps: Caps, id: string | undefined): string {
  if (!id) return '';
  if (caps.partitions) {
    const [partition, offset] = id.split(':');
    return ` (partition ${partition}, offset ${offset})`;
  }
  return ` (${id})`;
}

export function PublishForm({ p, caps, base, partitions, draft, onDraft, onSent }: { p: TabProps; caps: Caps; base: Record<string, unknown>; partitions: number[]; draft: Draft; onDraft(d: Draft): void; onSent(): void }) {
  const { api, readOnly } = p;
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState<'json' | 'text'>(() => (draft.value && !pretty(draft.value).json ? 'text' : 'json'));
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });

  const send = async () => {
    if (readOnly || busy) return;
    if (language === 'json' && draft.value.trim() && !pretty(draft.value).json && !(await api.confirm('Send it as text?', 'The value isn’t valid JSON.', 'Send'))) return;
    setBusy(true);
    try {
      const headers = Object.fromEntries(draft.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value]));
      const res = await api.call<{ id?: string }>('qPublish', {
        ...base,
        key: caps.keyLabel && draft.key ? draft.key : undefined,
        value: draft.value,
        headers,
        partition: caps.partitions && draft.partition !== '' ? Number(draft.partition) : undefined,
        routingKey: caps.routing ? draft.routingKey : undefined,
      });
      api.toast(`Sent to ${caps.name || 'the default exchange'}${where(caps, res?.id)}.`);
      onSent();
    } catch (e) {
      api.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // ⌘Enter anywhere in the form (the editor has its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && p.visible && !e.defaultPrevented) {
        e.preventDefault();
        void sendRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.visible]);

  const rows = [...draft.headers, { key: '', value: '' }];
  const setHeader = (i: number, h: Partial<{ key: string; value: string }>) => {
    const next = i === draft.headers.length ? [...draft.headers, { key: '', value: '', ...h }] : draft.headers.map((x, j) => (j === i ? { ...x, ...h } : x));
    set({ headers: next });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {readOnly && <div className="flex-none border-b border-[var(--node-border)] px-3 py-1.5 text-[11px] text-[var(--node-muted)]">This connection is read only: nothing can be published from it.</div>}
      <div className="flex flex-none flex-wrap items-end gap-3 px-3 pt-2.5 pb-2">
        {caps.keyLabel && (
          <label className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className="text-[10.5px] text-[var(--node-muted)]">{caps.keyLabel}</span>
            <NodeInput className="h-6 font-mono" value={draft.key} placeholder={caps.engine === 'kafka' ? 'none' : caps.engine === 'sqs' ? 'default' : 'none'} onChange={(e) => set({ key: e.target.value })} />
          </label>
        )}
        {caps.routing && (
          <label className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className="text-[10.5px] text-[var(--node-muted)]">Routing key</span>
            <NodeInput className="h-6 font-mono" value={draft.routingKey} placeholder="empty" onChange={(e) => set({ routingKey: e.target.value })} />
          </label>
        )}
        {caps.partitions && (
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-[var(--node-muted)]">Partition</span>
            <MiniSelect value={draft.partition} options={[{ value: '', label: 'By key' }, ...partitions.map((n) => ({ value: String(n), label: String(n) }))]} onChange={(partition) => set({ partition })} />
          </label>
        )}
        {caps.engine === 'rabbitmq' && caps.noun === 'queue' && <span className="pb-1 text-[10.5px] text-[var(--node-muted)]">Through the default exchange, routing key “{caps.name}”.</span>}
      </div>
      <div className="flex flex-none items-center gap-2 px-3 pb-1">
        <span className="text-[10.5px] text-[var(--node-muted)]">Value</span>
        <div className="flex flex-none rounded-md border border-[var(--node-border)] p-px">
          {(['json', 'text'] as const).map((l) => (
            <button key={l} type="button" onClick={() => setLanguage(l)} className={cn('rounded px-1.5 py-px text-[10.5px]', language === l ? 'bg-[color-mix(in_srgb,var(--node-fg)_10%,transparent)] text-[var(--node-fg)]' : 'text-[var(--node-muted)] hover:text-[var(--node-fg)]')}>
              {l === 'json' ? 'JSON' : 'Text'}
            </button>
          ))}
        </div>
        {language === 'json' && pretty(draft.value).json && (
          <button type="button" className="text-[10.5px] text-[var(--node-muted)] hover:text-[var(--node-fg)]" onClick={() => set({ value: pretty(draft.value).text })}>
            Format
          </button>
        )}
      </div>
      <div className="mx-3 flex min-h-[120px] flex-1 flex-col overflow-hidden rounded-md border border-[var(--node-border)]">
        <CodeEditor key={language} className="min-h-0 flex-1" language={language} value={draft.value} onChange={(value) => set({ value })} onRun={() => void sendRef.current()} placeholder={language === 'json' ? '{ "id": 1 }' : 'The message'} readOnly={readOnly} lineNumbers={false} />
      </div>
      <div className="flex max-h-[40%] flex-none flex-col gap-1 overflow-auto px-3 pt-2">
        <span className="text-[10.5px] text-[var(--node-muted)]">{caps.engine === 'sqs' ? 'Message attributes' : 'Headers'}</span>
        {rows.map((h, i) => {
          const last = i === draft.headers.length;
          return (
            <div key={i} className="group flex items-center gap-1.5">
              <NodeInput className="h-6 flex-1 font-mono" value={h.key} placeholder={last ? 'Add a header' : 'Name'} onChange={(e) => setHeader(i, { key: e.target.value })} />
              <NodeInput className="h-6 flex-[1.6] font-mono" value={h.value} placeholder="Value" onChange={(e) => setHeader(i, { value: e.target.value })} />
              {last ? <span className="w-6 flex-none" /> : <ToolButton label="Remove" icon={Trash2} className="flex-none opacity-60 group-hover:opacity-100" onClick={() => set({ headers: draft.headers.filter((_, j) => j !== i) })} />}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-none items-center gap-2 border-t border-[var(--node-border)] px-3 py-2">
        <NodeButton disabled={readOnly || busy} onClick={() => void send()} className="border-[var(--node-accent)]">
          <Send className="size-3.5" />
          {busy ? 'Sending…' : 'Send'}
        </NodeButton>
        <span className="text-[10.5px] text-[var(--node-muted)]">⌘Enter</span>
        <button type="button" className="ml-auto flex items-center gap-1 text-[10.5px] text-[var(--node-muted)] hover:text-[var(--node-fg)]" onClick={() => onDraft(emptyDraft())}>
          <Plus className="size-3" />
          New message
        </button>
      </div>
    </div>
  );
}
