// Home: Recent connections, My connections (by group), and Add connection
// (every kind, by category), with one search over all of them. With no
// connections yet, it's a welcome and the kinds to pick from.

import { useMemo, useState } from 'react';
import { Database, Plus, Search, SearchX } from 'lucide-react';
import { Empty, NodeButton, NodeInput, useMenu } from '@hyperpane/ui';
import { CATEGORIES, KINDS, type Kind, address, kindOf } from '../../shared/kinds.ts';
import type { Connection, State } from '../../shared/types.ts';
import { ConnectionCard, KindCard } from './cards.tsx';
import { connectionMenu, type ConnectionOps } from './menu.ts';

const RECENT = 6;

function Section({ title, detail, children, action }: { title: string; detail?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {detail && <span className="text-2xs text-[var(--node-muted)]">{detail}</span>}
        <span className="ms-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

const grid = (min: number) => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 8 }) as const;

export function Home({ state, ops, onAdd }: { state: State | null; ops: ConnectionOps; onAdd(kind: Kind): void }) {
  const [query, setQuery] = useState('');
  const menu = useMenu();
  const q = query.trim().toLowerCase();
  const connections = state?.connections ?? [];
  const match = (c: Connection) => {
    const k = kindOf(c.kind);
    return !q || [c.name, c.group, k?.name ?? '', k ? address(k, c.values) : ''].some((s) => s.toLowerCase().includes(q));
  };
  const mine = connections.filter(match);
  const recent = useMemo(
    () =>
      connections
        .filter((c) => c.used)
        .sort((a, b) => (b.used ?? 0) - (a.used ?? 0))
        .slice(0, RECENT),
    [connections],
  ).filter(match);
  const groups = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const c of mine) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [mine]);
  const kinds = KINDS.filter((k) => !q || `${k.name} ${k.tagline} ${k.engine}`.toLowerCase().includes(q));
  const empty = state !== null && connections.length === 0;

  const card = (c: Connection, compact?: boolean) => {
    const kind = kindOf(c.kind);
    if (!kind) return null;
    return (
      <ConnectionCard
        key={c.id}
        c={c}
        kind={kind}
        compact={compact}
        open={state?.open[c.id]}
        onOpen={() => ops.openConnection(c)}
        onMenu={(e) => menu.open(e, connectionMenu(c, !!state?.open[c.id], ops))}
      />
    );
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-8 px-6 py-6 max-sm:gap-6 max-sm:px-4 max-sm:py-4">
        <header className="flex flex-wrap items-center gap-3">
          <span className="rounded-surface flex size-10 flex-none items-center justify-center bg-[#6aa51f] text-white">
            <Database className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h1 className="text-base leading-tight font-semibold">{empty ? 'Welcome to Data' : 'Data'}</h1>
            <span className="text-xs text-[var(--node-muted)]">
              {empty
                ? 'Connect a database, a key-value store, a queue or a bucket to start'
                : `${connections.length} ${connections.length === 1 ? 'connection' : 'connections'}${Object.keys(state?.open ?? {}).length ? ` · ${Object.keys(state!.open).length} connected` : ''}`}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2 max-sm:ml-0 max-sm:w-full">
            <label className="relative max-sm:flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-[var(--node-muted)]" />
              <NodeInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={empty ? 'Find a database' : 'Search connections and databases'}
                aria-label="Search"
                className="w-[260px] pl-7 max-sm:w-full"
              />
            </label>
          </div>
        </header>

        {!empty && recent.length > 0 && !q && (
          <Section title="Recent connections">
            <div style={grid(230)}>{recent.map((c) => card(c, true))}</div>
          </Section>
        )}

        {!empty && (
          <Section
            title="My connections"
            detail={q ? `${mine.length} of ${connections.length}` : undefined}
            action={
              <NodeButton variant="primary" onClick={(e) => ops.pickKind(e.currentTarget)}>
                <Plus />
                New connection
              </NodeButton>
            }
          >
            {mine.length === 0 ? (
              <Empty bordered={false} className="py-6" icon={<SearchX />} title="Nothing matches" description={`No connection matches “${query}”`} />
            ) : (
              <div className="flex flex-col gap-4">
                {groups.map(([group, list]) => (
                  <div key={group} className="flex flex-col gap-2">
                    {(groups.length > 1 || group) && <div className="text-xs font-medium text-[var(--node-muted)]">{group || 'Other'}</div>}
                    <div style={grid(250)}>{list.map((c) => card(c))}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        <Section title="Add connection" detail={empty ? 'Pick what you want to connect to' : undefined}>
          <div className="flex flex-col gap-6">
            {CATEGORIES.map((cat) => {
              const list = kinds.filter((k) => k.category === cat.id);
              if (!list.length) return null;
              return (
                <div key={cat.id} className="flex flex-col gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium">{cat.title}</span>
                    <span className="truncate text-2xs text-[var(--node-muted)]">{cat.description}</span>
                  </div>
                  <div style={grid(190)}>
                    {list.map((k) => (
                      <KindCard key={k.id} kind={k} onClick={() => onAdd(k)} />
                    ))}
                  </div>
                </div>
              );
            })}
            {!kinds.length && (
              <Empty bordered={false} className="py-6" icon={<SearchX />} title="Nothing to add" description={`Data doesn’t connect to “${query}” yet`} />
            )}
          </div>
        </Section>
      </div>
      {menu.element}
    </div>
  );
}
