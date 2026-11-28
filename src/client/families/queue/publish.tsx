// Publishing a message: its key (or message group, or routing key), the
// partition, its value as JSON or text, and headers; sent with Send or
// ⌘Enter, and confirmed in a toast. A read-only connection can't.

import { useEffect, useRef, useState } from 'react';
import { Plus, Send, Trash2 } from '@hyperpane/icons';
import { NodeButton, NodeInput, Picker, Tabs, ToolButton } from '@hyperpane/ui';
import type { TabProps } from '../../app/tabs.ts';
import { CodeEditor } from '../../ui/code.tsx';
import { softField } from '../../ui/parts.tsx';
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

export function PublishForm({
  p,
  caps,
  base,
  partitions,
  draft,
  onDraft,
  onSent,
}: {
  p: TabProps;
  caps: Caps;
  base: Record<string, unknown>;
  partitions: number[];
  draft: Draft;
  onDraft(d: Draft): void;
  onSent(): void;
}) {
  const { api, readOnly } = p;
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState<'json' | 'text'>(() => (draft.value && !pretty(draft.value).json ? 'text' : 'json'));
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });

  const send = async () => {
    if (readOnly || busy) return;
    if (
      language === 'json' &&
      draft.value.trim() &&
      !pretty(draft.value).json &&
      !(await api.confirm('Send it as text?', 'The value isn’t valid JSON', 'Send'))
    )
      return;
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
      api.toast(`Sent to ${caps.name || 'the default exchange'}${where(caps, res?.id)}`);
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
      {readOnly && (
        <div className="flex-none border-b border-[var(--data-line)] bg-[var(--node-header)] px-3 py-2 text-xs text-[var(--node-muted)]">
          This connection is read only: nothing can be published from it
        </div>
      )}
      <div className="flex flex-none flex-wrap items-end gap-3 px-3 pt-3 pb-3">
        {caps.keyLabel && (
          <label className="flex min-w-[200px] flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--node-muted)]">{caps.keyLabel}</span>
            <NodeInput
              className="font-mono"
              value={draft.key}
              placeholder={caps.engine === 'kafka' ? 'none' : caps.engine === 'sqs' ? 'default' : 'none'}
              onChange={(e) => set({ key: e.target.value })}
            />
          </label>
        )}
        {caps.routing && (
          <label className="flex min-w-[200px] flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--node-muted)]">Routing key</span>
            <NodeInput className="font-mono" value={draft.routingKey} placeholder="empty" onChange={(e) => set({ routingKey: e.target.value })} />
          </label>
        )}
        {caps.partitions && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--node-muted)]">Partition</span>
            <Picker
              label="Partition"
              size="sm"
              className={softField}
              value={draft.partition}
              options={[{ value: '', label: 'By key' }, ...partitions.map((n) => ({ value: String(n), label: String(n) }))]}
              onValueChange={(partition) => set({ partition })}
            />
          </div>
        )}
        {caps.engine === 'rabbitmq' && caps.noun === 'queue' && (
          <span className="pb-1.5 text-2xs text-[var(--node-muted)]">Through the default exchange, routing key “{caps.name}”.</span>
        )}
      </div>
      <div className="flex flex-none items-center gap-2 px-3 pb-1.5">
        <span className="text-xs font-medium text-[var(--node-muted)]">Value</span>
        <Tabs
          variant="pills"
          label="The value as"
          value={language}
          onValueChange={setLanguage}
          items={[
            { value: 'json', label: 'JSON' },
            { value: 'text', label: 'Text' },
          ]}
        />
        {language === 'json' && pretty(draft.value).json && (
          <button
            type="button"
            className="rounded-full h-7 px-2 text-xs text-[var(--node-muted)] hover:bg-[var(--node-hover)] hover:text-[var(--node-fg)]"
            onClick={() => set({ value: pretty(draft.value).text })}
          >
            Format
          </button>
        )}
      </div>
      <div className="rounded-control mx-3 flex min-h-[120px] flex-1 flex-col overflow-hidden bg-[color-mix(in_srgb,var(--node-fg)_4%,transparent)] py-1">
        <CodeEditor
          key={language}
          className="min-h-0 flex-1"
          language={language}
          value={draft.value}
          onChange={(value) => set({ value })}
          onRun={() => void sendRef.current()}
          placeholder={language === 'json' ? '{ "id": 1 }' : 'The message'}
          readOnly={readOnly}
          lineNumbers={false}
        />
      </div>
      <div className="flex max-h-[40%] flex-none flex-col gap-1.5 overflow-auto px-3 pt-3">
        <span className="text-xs font-medium text-[var(--node-muted)]">{caps.engine === 'sqs' ? 'Message attributes' : 'Headers'}</span>
        {rows.map((h, i) => {
          const last = i === draft.headers.length;
          return (
            <div key={i} className="group flex items-center gap-1.5">
              <NodeInput
                className="min-w-0 flex-1 font-mono"
                value={h.key}
                placeholder={last ? 'Add a header' : 'Name'}
                onChange={(e) => setHeader(i, { key: e.target.value })}
              />
              <NodeInput
                className="min-w-0 flex-[1.6] font-mono"
                value={h.value}
                placeholder="Value"
                onChange={(e) => setHeader(i, { value: e.target.value })}
              />
              {last ? (
                <span className="w-7 flex-none touch:w-9" />
              ) : (
                <ToolButton
                  label="Remove"
                  icon={Trash2}
                  className="flex-none opacity-60 group-hover:opacity-100 touch:opacity-100"
                  onClick={() => set({ headers: draft.headers.filter((_, j) => j !== i) })}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex h-12 flex-none items-center gap-2 border-t border-[var(--data-line)] px-3">
        <NodeButton variant="primary" disabled={readOnly || busy} onClick={() => void send()}>
          <Send />
          {busy ? 'Sending' : 'Send'}
        </NodeButton>
        <span className="text-2xs text-[var(--node-muted)] touch:hidden">⌘Enter</span>
        <NodeButton variant="ghost" className="ms-auto" onClick={() => onDraft(emptyDraft())}>
          <Plus />
          New message
        </NodeButton>
      </div>
    </div>
  );
}
