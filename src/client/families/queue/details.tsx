// A topic's or a queue's details: its partitions (leader, watermarks,
// replicas and those in sync), who reads it (consumer groups and their
// lag, or a queue's consumers), and its bindings.

import { cn } from '@hyperpane/ui';
import type { QueueInfo } from '../../../shared/queue.ts';
import type { Caps } from './caps.ts';

export function DetailsView({ info, caps, loading }: { info: QueueInfo | null; caps: Caps; loading: boolean }) {
  if (!info) return <p className="py-8 text-center text-[var(--node-muted)]">{loading ? 'Loading…' : 'Nothing to show.'}</p>;
  const parts = info.partitions ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
      {caps.partitions && (
        <Section title={`Partitions (${parts.length})`}>
          <Table
            head={['Partition', 'Leader', 'Low', 'High', 'Messages', 'Replicas', 'In sync']}
            right={[0, 1, 2, 3, 4]}
            rows={parts.map((x) => [String(x.partition), x.leader === null ? 'none' : String(x.leader), x.low, x.high, (BigInt(x.high) - BigInt(x.low)).toLocaleString(), x.replicas.join(', '), x.isr.join(', ')])}
            warn={parts.map((x) => x.leader === null || x.isr.length < x.replicas.length)}
          />
        </Section>
      )}
      {info.consumers && (
        <Section title={caps.engine === 'kafka' ? `Consumer groups (${info.consumers.length})` : `Consumers (${info.consumers.length})`}>
          {info.consumers.length ? (
            <Table head={caps.engine === 'kafka' ? ['Group', 'State', 'Lag'] : ['Consumer', 'Detail']} right={caps.engine === 'kafka' ? [2] : []} rows={info.consumers.map((c) => (caps.engine === 'kafka' ? [c.name, c.detail, c.lag ?? ''] : [c.name, c.detail]))} />
          ) : (
            <p className="text-[11px] text-[var(--node-muted)]">{caps.engine === 'kafka' ? 'No group has committed offsets in this topic.' : 'Nobody is consuming.'}</p>
          )}
        </Section>
      )}
      {info.bindings && (
        <Section title={`Bindings (${info.bindings.length})`}>
          {info.bindings.length ? <Table head={['From', 'To', 'Routing key']} rows={info.bindings.map((b) => [b.source, b.destination, b.routingKey || '—'])} /> : <p className="text-[11px] text-[var(--node-muted)]">No bindings.</p>}
        </Section>
      )}
      <Section title="Figures">
        <Table head={['', '']} rows={info.stats.map((s) => [s.label, s.value])} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1 text-[10px] tracking-wide text-[var(--node-muted)] uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Table({ head, rows, right = [], warn }: { head: string[]; rows: string[][]; right?: number[]; warn?: boolean[] }) {
  return (
    <table className="w-full border-collapse text-[11.5px]">
      {head.some(Boolean) && (
        <thead>
          <tr className="text-[10.5px] text-[var(--node-muted)]">
            {head.map((h, i) => (
              <th key={i} className={cn('border-b border-[var(--node-border)] px-2 py-1 font-normal', right.includes(i) ? 'text-right' : 'text-left')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={cn('hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]', warn?.[i] && 'text-[#d29922]')}>
            {r.map((c, j) => (
              <td key={j} className={cn('border-b border-[color-mix(in_srgb,var(--node-border)_50%,transparent)] px-2 py-[3px] font-mono tabular-nums select-text', right.includes(j) && 'text-right', j === 0 && !right.includes(0) && 'font-sans')}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
