// A topic's or a queue's tab: its name and figures at the top, with
// Refresh, Purge and Delete; then Messages (looked at, or live), Publish,
// and Details (partitions, consumer groups and their lag, bindings).

import { useEffect, useMemo, useState } from 'react';
import { Eraser, RefreshCw, Trash2 } from '@hyperpane/icons';
import { Spinner, Tabs, ToolButton, cn, useAsync } from '@hyperpane/ui';
import type { QueueInfo } from '../../../shared/queue.ts';
import type { TabProps } from '../../app/tabs.ts';
import { ErrorBox } from '../../ui/parts.tsx';
import { capsOf } from './caps.ts';
import { DetailsView } from './details.tsx';
import { Messages } from './messages.tsx';
import { type Draft, PublishForm, emptyDraft } from './publish.tsx';

type View = 'messages' | 'publish' | 'details';

export function QueueTab(p: TabProps) {
  const { api, tab, connection, readOnly } = p;
  const caps = useMemo(() => capsOf(p.kind.engine, tab.ref), [p.kind.engine, JSON.stringify(tab.ref)]);
  const base = useMemo(() => ({ id: connection.id, project: p.project, ref: tab.ref }), [connection.id, p.project, JSON.stringify(tab.ref)]);
  const [view, setView] = useState<View>(caps.peek ? 'messages' : 'publish');
  const [seen, setSeen] = useState(p.visible);
  useEffect(() => {
    if (p.visible) setSeen(true);
  }, [p.visible]);
  const info = useAsync(() => (seen ? api.call<QueueInfo>('qDescribe', base) : Promise.resolve(null)), [seen, base]);
  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyDraft(), ...((tab.state?.draft as Partial<Draft>) ?? {}) }));
  const partitions = info.value?.partitions?.map((x) => x.partition) ?? [];

  const purge = async () => {
    if (!(await api.confirm(`Purge ${caps.name}?`, `Every message in the ${caps.noun} is deleted, for every consumer. This can’t be undone.`, 'Purge', true)))
      return;
    try {
      await api.call('qPurge', base);
      api.toast(`Purged ${caps.name}`);
      info.reload();
    } catch (e) {
      api.fail(e);
    }
  };
  const remove = async () => {
    if (!(await api.confirm(`Delete ${caps.name}?`, `The ${caps.noun} and every message in it are deleted. This can’t be undone.`, 'Delete', true))) return;
    try {
      await api.call('qRemove', base);
      api.toast(`Deleted ${caps.name}`);
      p.retitle(`${caps.name} (deleted)`);
    } catch (e) {
      api.fail(e);
    }
  };

  const tabs: { id: View; name: string }[] = [
    ...(caps.peek ? [{ id: 'messages' as const, name: 'Messages' }] : []),
    { id: 'publish', name: 'Publish' },
    { id: 'details', name: 'Details' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs text-[var(--node-fg)]">
      <div className="flex-none ps-3 pe-2.5 pt-1.5 pb-2.5">
        <div className="flex h-7 min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{caps.name || '(default exchange)'}</span>
          <span className="truncate text-2xs text-[var(--node-muted)]">
            {caps.noun}
            {tab.ref.vhost ? ` in ${tab.ref.vhost}` : ''} · {connection.name}
          </span>
          <div className="ms-auto flex flex-none items-center gap-1">
            <ToolButton label="Refresh the figures" icon={RefreshCw} onClick={() => info.reload()} />
            {caps.purge && (
              <ToolButton label={readOnly ? 'Purge (the connection is read only)' : 'Purge'} icon={Eraser} disabled={readOnly} onClick={() => void purge()} />
            )}
            <ToolButton label={readOnly ? 'Delete (the connection is read only)' : 'Delete'} icon={Trash2} disabled={readOnly} onClick={() => void remove()} />
          </div>
        </div>
        <Figures info={info.value ?? null} loading={info.loading} />
      </div>
      {info.error && <ErrorBox error={info.error} />}
      <Tabs label={caps.noun} className="px-1.5" value={view} onValueChange={setView} items={tabs.map((t) => ({ value: t.id, label: t.name }))} />
      {caps.peek && seen && (
        <div className={cn('min-h-0 flex-1 flex-col', view === 'messages' ? 'flex' : 'hidden')}>
          <Messages
            p={p}
            caps={caps}
            base={base}
            partitions={partitions}
            onScreen={p.visible && view === 'messages'}
            onAgain={(m) => {
              setDraft({
                key: m.key ?? '',
                value: m.value,
                headers: Object.entries(m.headers ?? {}).map(([key, value]) => ({ key, value })),
                partition: '',
                routingKey: '',
              });
              setView('publish');
            }}
          />
        </div>
      )}
      {view === 'publish' && (
        <PublishForm
          p={p}
          caps={caps}
          base={base}
          partitions={partitions}
          draft={draft}
          onDraft={(d) => {
            setDraft(d);
            p.setState({ draft: d });
          }}
          onSent={() => info.reload()}
        />
      )}
      {view === 'details' && <DetailsView info={info.value ?? null} caps={caps} loading={info.loading} />}
    </div>
  );
}

function Figures({ info, loading }: { info: QueueInfo | null; loading: boolean }) {
  if (!info)
    return (
      <div className="mt-2 flex h-8 items-center gap-2 text-2xs text-[var(--node-muted)]">
        {loading && (
          <>
            <Spinner size="xs" />
            Loading
          </>
        )}
      </div>
    );
  return (
    <div className={cn('mt-2 flex flex-wrap gap-x-6 gap-y-2', loading && 'opacity-60')}>
      {info.stats.map((s) => (
        <div key={s.label} className="flex min-w-0 flex-col gap-0.5">
          <div className="text-2xs text-[var(--node-muted)]">{s.label}</div>
          <div className="max-w-[320px] truncate font-mono text-xs font-medium tabular-nums" title={s.value}>
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}
