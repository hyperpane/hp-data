// The message selected: where it is and when, its value (a JSON tree when
// it parses, else the text), its headers and what else the queue says
// about it; copied, or put in the Publish form to send again.

import { useState } from 'react';
import { Copy, Forward, X } from 'lucide-react';
import { JsonTree, NodeButton, Tabs, ToolButton } from '@hyperpane/ui';
import type { Message } from '../../../shared/queue.ts';
import type { Api } from '../../lib/api.ts';
import type { Caps } from './caps.ts';
import { fullTime, placeOf, pretty } from './format.ts';

export function MessagePane({ m, caps, api, readOnly, onAgain, onClose }: { m: Message; caps: Caps; api: Api; readOnly: boolean; onAgain(): void; onClose(): void }) {
  const [mode, setMode] = useState<'tree' | 'text'>('tree');
  const v = pretty(m.value);
  const headers = Object.entries(m.headers ?? {});
  const where: [string, string][] = [
    ...(m.partition !== undefined ? ([['Partition', String(m.partition)], ['Offset', m.offset ?? '']] as [string, string][]) : [['Id', m.id] as [string, string]]),
    ['Time', fullTime(m.at) || '—'],
    ...(m.key !== undefined && m.key !== null ? [['Key', m.key] as [string, string]] : []),
    ...Object.entries(m.meta ?? {}).map(([k, x]) => [k, String(x)] as [string, string]),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 flex-none items-center gap-1 border-b border-[var(--node-border)] px-2">
        <span className="truncate font-mono text-[11.5px]">{placeOf(m)}</span>
        {v.json && (
          <Tabs
            variant="pills"
            label="Show the value as"
            className="ml-2 h-6"
            value={mode}
            onValueChange={setMode}
            items={[
              { value: 'tree', label: 'Tree' },
              { value: 'text', label: 'Text' },
            ]}
          />
        )}
        <div className="ml-auto flex flex-none items-center gap-1">
          <NodeButton onClick={() => api.copy(v.json && mode === 'text' ? v.text : m.value, 'the value')}>
            <Copy className="size-3.5" />
            Copy value
          </NodeButton>
          {!readOnly && caps.noun !== 'exchange' && (
            <NodeButton onClick={onAgain} title="Put it in the Publish form">
              <Forward className="size-3.5" />
              Publish again
            </NodeButton>
          )}
          <ToolButton label="Close" icon={X} onClick={onClose} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <section className="border-b border-[var(--node-border)]">
          {m.binary && <p className="px-3 pt-2 text-[10.5px] text-[var(--node-muted)]">Not text: shown as base64.</p>}
          {m.meta?.truncated && <p className="px-3 pt-2 text-[10.5px] text-[var(--node-muted)]">Cut at 1 MB: the rest isn’t shown.</p>}
          {v.json && mode === 'tree' ? (
            <JsonTree value={v.value} depth={3} className="px-1 py-1 text-[11.5px]" />
          ) : (
            <pre className="px-3 py-2 font-mono text-[11.5px] break-all whitespace-pre-wrap select-text">{v.text || <span className="text-[var(--node-muted)]">{m.meta?.tombstone ? 'null (a tombstone)' : 'empty'}</span>}</pre>
          )}
        </section>
        <Pairs title={`Headers${headers.length ? ` (${headers.length})` : ''}`} rows={headers} empty="No headers." api={api} />
        <Pairs title="Message" rows={where} api={api} />
      </div>
    </div>
  );
}

function Pairs({ title, rows, empty, api }: { title: string; rows: [string, string][]; empty?: string; api: Api }) {
  return (
    <section className="border-b border-[var(--node-border)] px-3 py-2">
      <h3 className="mb-1 text-[10px] tracking-wide text-[var(--node-muted)] uppercase">{title}</h3>
      {!rows.length && <p className="text-[11px] text-[var(--node-muted)]">{empty}</p>}
      <table className="w-full table-fixed text-[11.5px]">
        <tbody>
          {rows.map(([k, x]) => (
            <tr key={k} className="group align-top" onDoubleClick={() => api.copy(x, k)}>
              <td className="w-[38%] truncate py-px pr-2 text-[var(--node-muted)]" title={k}>
                {k}
              </td>
              <td className="py-px font-mono break-all select-text">{x}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
