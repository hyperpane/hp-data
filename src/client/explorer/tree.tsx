// The Database Explorer, as DataGrip's: every saved connection, each one
// opening into what's in it (loaded as it's expanded: expanding a
// connection connects it), with a filter, its status (connected, failed),
// double-click to open, and each item's right-click menu (Open, Refresh,
// Copy Name, and its family's own).

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, Ellipsis, LoaderCircle, Plus, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { NodeInput, ToolButton, cn, useMenu, type MenuEntry } from '@hyperpane/ui';
import { address, kindOf } from '../../shared/kinds.ts';
import { optionsMenu, usePrefs } from './options.ts';
import type { Connection, State, TreeNode } from '../../shared/types.ts';
import type { NewTab } from '../app/tabs.ts';
import { FAMILIES } from '../families/index.ts';
import { connectionMenu, type ConnectionOps } from '../home/menu.ts';
import type { Api } from '../lib/api.ts';
import { NODE_COLORS, NODE_ICONS } from '../ui/icons.tsx';
import { KindTile } from '../ui/parts.tsx';

interface Loaded {
  loading?: boolean;
  error?: string;
  nodes?: TreeNode[];
}

const keyOf = (conn: string, path: string[]) => [conn, ...path].join('\u0000');

export interface ExplorerHandle {
  /** Expands a connection (connecting it). */
  reveal(conn: string): void;
  refresh(conn: string): void;
}

export function Explorer({ state, api, project, ops, open, handle, activeConn }: { state: State | null; api: Api; project: string | null; ops: ConnectionOps; open(t: NewTab): void; handle: React.RefObject<ExplorerHandle | null>; activeConn: string | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(() => new Map());
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const menu = useMenu();
  const auto = useRef(new Set<string>());
  const prefs = usePrefs();
  const { sort, grouped, details, onlyOpen } = prefs;
  const connections = state?.connections ?? [];

  const load = async (conn: string, path: string[]) => {
    const k = keyOf(conn, path);
    setLoaded((m) => new Map(m).set(k, { ...m.get(k), loading: true, error: undefined }));
    try {
      const nodes = await api.call<TreeNode[]>('children', { id: conn, path, project });
      setLoaded((m) => new Map(m).set(k, { nodes }));
      // Items that say so open on their own, the first time.
      const opens = nodes.filter((n) => n.expand && !n.leaf).map((n) => keyOf(conn, [...path, n.name]));
      const fresh = opens.filter((x) => !auto.current.has(x));
      if (fresh.length) {
        fresh.forEach((x) => auto.current.add(x));
        setExpanded((s) => new Set([...s, ...fresh]));
        for (const n of nodes.filter((n) => n.expand && !n.leaf)) void load(conn, [...path, n.name]);
      }
    } catch (e) {
      setLoaded((m) => new Map(m).set(k, { error: (e as Error).message }));
    }
  };

  const toggle = (conn: string, path: string[]) => {
    const k = keyOf(conn, path);
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else {
        next.add(k);
        if (!loaded.get(k)?.nodes) void load(conn, path);
      }
      return next;
    });
  };

  const refresh = (conn: string, path: string[]) => {
    // Forget what's under it, so it all loads again as it's opened.
    const k = keyOf(conn, path);
    setLoaded((m) => new Map([...m].filter(([x]) => x === k || !x.startsWith(`${k}\u0000`))));
    void load(conn, path);
  };

  handle.current = {
    reveal: (conn) => {
      const k = keyOf(conn, []);
      setSelected(k);
      setExpanded((s) => new Set(s).add(k));
      if (!loaded.get(k)?.nodes) void load(conn, []);
    },
    refresh: (conn) => refresh(conn, []),
  };

  // A session that ended (disconnected, or idle): its items load again
  // when it's opened next.
  const openIds = Object.keys(state?.open ?? {}).sort().join();
  const before = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(Object.keys(state?.open ?? {}));
    const closed = [...before.current].filter((id) => !now.has(id));
    before.current = now;
    if (!closed.length) return;
    const gone = (k: string) => closed.includes(k.split('\u0000')[0]);
    setLoaded((m) => new Map([...m].filter(([k]) => !gone(k))));
    setExpanded((s) => new Set([...s].filter((k) => !gone(k))));
  }, [openIds]);

  const q = filter.trim().toLowerCase();

  /** The items under a path, filtered: those that match, and what's open around them. */
  const visible = (conn: string, path: string[]): TreeNode[] => {
    const nodes = loaded.get(keyOf(conn, path))?.nodes ?? [];
    if (!q) return nodes;
    return nodes.filter((n) => (n.label ?? n.name).toLowerCase().includes(q) || expanded.has(keyOf(conn, [...path, n.name])));
  };

  const nodeMenu = (c: Connection, path: string[], node: TreeNode | null): (MenuEntry | null)[] => {
    const kind = kindOf(c.kind)!;
    const fam = FAMILIES[kind.family];
    const items: (MenuEntry | null)[] = node
      ? [
          ...(node.open ? [{ label: 'Open', shortcut: '↵', run: () => open({ type: node.open!.tab, conn: c.id, ref: node.open!.ref, title: node.open!.title }) }] : []),
          { label: 'Refresh', run: () => refresh(c.id, node.leaf ? path.slice(0, -1) : path) },
          { label: 'Copy Name', run: () => api.copy(node.name.replace(/^index:/, ''), 'the name') },
        ]
      : [...connectionMenu(c, !!state?.open[c.id], ops, kind.family), null, { label: 'Refresh', run: () => refresh(c.id, []) }, { label: 'Copy Address', run: () => api.copy(address(kind, c.values), 'the address') }, { label: 'Copy Name', run: () => api.copy(c.name, 'the name') }];
    const own = fam.actions?.({ node, path, connection: c, kind, api, project, readOnly: c.readOnly, open, refresh: () => refresh(c.id, node && !node.leaf ? path : path.slice(0, -1)) }) ?? [];
    return own.length ? [...items, null, ...own] : items;
  };

  const rows: React.ReactNode[] = [];
  const pushNodes = (c: Connection, path: string[], depth: number) => {
    const k = keyOf(c.id, path);
    const l = loaded.get(k);
    if (l?.error) {
      rows.push(
        <div key={`${k}:error`} className="flex items-start gap-1.5 py-1 pr-2 text-[11px] text-[#f85149]" style={{ paddingLeft: 8 + depth * 14 }}>
          <TriangleAlert className="mt-px size-3.5 flex-none" />
          <span className="min-w-0 flex-1 break-words select-text">{l.error}</span>
          <button type="button" className="flex-none text-[var(--node-muted)] underline hover:text-[var(--node-fg)]" onClick={() => refresh(c.id, path)}>
            Retry
          </button>
        </div>,
      );
      return;
    }
    if (l?.loading && !l.nodes) {
      rows.push(
        <div key={`${k}:loading`} className="flex items-center gap-1.5 py-1 text-[11px] text-[var(--node-muted)]" style={{ paddingLeft: 8 + depth * 14 }}>
          <LoaderCircle className="size-3.5 animate-spin" />
          {path.length ? 'Loading…' : 'Connecting…'}
        </div>,
      );
      return;
    }
    const nodes = visible(c.id, path);
    if (l?.nodes && !l.nodes.length) rows.push(<div key={`${k}:empty`} className="py-1 text-[11px] text-[var(--node-muted)] italic" style={{ paddingLeft: 22 + depth * 14 }}>Empty</div>);
    for (const n of nodes) {
      const p = [...path, n.name];
      const nk = keyOf(c.id, p);
      const isOpen = expanded.has(nk);
      const Icon = NODE_ICONS[n.type] ?? NODE_ICONS.info;
      rows.push(
        <div
          key={nk}
          role="treeitem"
          aria-expanded={n.leaf ? undefined : isOpen}
          tabIndex={-1}
          className={cn('group flex h-[22px] cursor-default items-center gap-1 pr-2 whitespace-nowrap', selected === nk ? 'bg-[color-mix(in_srgb,var(--node-accent)_20%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]')}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => setSelected(nk)}
          onDoubleClick={() => (n.open ? open({ type: n.open.tab, conn: c.id, ref: n.open.ref, title: n.open.title }) : !n.leaf && toggle(c.id, p))}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelected(nk);
            menu.open(e, nodeMenu(c, p, n));
          }}
        >
          <button type="button" tabIndex={-1} aria-label={isOpen ? 'Collapse' : 'Expand'} className={cn('flex size-4 flex-none items-center justify-center text-[var(--node-muted)]', n.leaf && 'invisible')} onClick={(e) => (e.stopPropagation(), toggle(c.id, p))}>
            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <Icon className="size-3.5 flex-none" style={{ color: NODE_COLORS[n.type] ?? 'var(--node-muted)' }} />
          <span className="truncate">{n.label ?? n.name}</span>
          {details && n.detail && <span className="truncate text-[10.5px] text-[var(--node-muted)]">{n.detail}</span>}
        </div>,
      );
      if (isOpen && !n.leaf) pushNodes(c, p, depth + 1);
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, Connection[]>();
    const by: Record<typeof sort, (a: Connection, b: Connection) => number> = {
      added: () => 0,
      name: (a, b) => a.name.localeCompare(b.name),
      used: (a, b) => (b.used ?? 0) - (a.used ?? 0),
      kind: (a, b) => (kindOf(a.kind)?.name ?? '').localeCompare(kindOf(b.kind)?.name ?? '') || a.name.localeCompare(b.name),
    };
    const list = [...connections].filter((c) => !onlyOpen || state?.open[c.id]).sort(by[sort]);
    for (const c of list) {
      const g = grouped ? c.group : '';
      m.set(g, [...(m.get(g) ?? []), c]);
    }
    return [...m].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [connections, sort, grouped, onlyOpen, openIds]);

  for (const [group, list] of groups) {
    if (groups.length > 1 || group) rows.push(<div key={`group:${group}`} className="px-2 pt-2 pb-0.5 text-[10px] font-semibold tracking-wide text-[var(--node-muted)] uppercase">{group || 'Other'}</div>);
    for (const c of list) {
      const kind = kindOf(c.kind);
      if (!kind) continue;
      const k = keyOf(c.id, []);
      const isOpen = expanded.has(k);
      const session = state?.open[c.id];
      const l = loaded.get(k);
      if (q && !c.name.toLowerCase().includes(q) && !isOpen) continue;
      rows.push(
        <div
          key={k}
          role="treeitem"
          aria-expanded={isOpen}
          tabIndex={-1}
          title={session ? `${session.version}${session.detail ? ` · ${session.detail}` : ''}` : kind.name}
          className={cn('group flex h-[26px] cursor-default items-center gap-1.5 pr-2', selected === k ? 'bg-[color-mix(in_srgb,var(--node-accent)_20%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]', activeConn === c.id && selected !== k && 'bg-[color-mix(in_srgb,var(--node-fg)_3%,transparent)]')}
          style={{ paddingLeft: 4 }}
          onClick={() => setSelected(k)}
          onDoubleClick={() => toggle(c.id, [])}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelected(k);
            menu.open(e, nodeMenu(c, [], null));
          }}
        >
          <button type="button" tabIndex={-1} aria-label={isOpen ? 'Collapse' : 'Expand'} className="flex size-4 flex-none items-center justify-center text-[var(--node-muted)]" onClick={(e) => (e.stopPropagation(), toggle(c.id, []))}>
            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <span className="relative flex-none">
            <KindTile kind={kind} size={17} />
            {session && <span className="absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full border border-[var(--node-bg)] bg-[#3fb950]" />}
            {l?.error && !session && <span className="absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full border border-[var(--node-bg)] bg-[#f85149]" />}
          </span>
          {c.color && <span className="h-3 w-[3px] flex-none rounded-full" style={{ background: c.color }} />}
          <span className="truncate font-medium">{c.name}</span>
          {c.readOnly && <span className="flex-none text-[9.5px] text-[var(--node-muted)]">RO</span>}
          {l?.loading && <LoaderCircle className="ml-auto size-3 flex-none animate-spin text-[var(--node-muted)]" />}
        </div>,
      );
      if (isOpen) pushNodes(c, [], 1);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 flex-none items-center gap-1 border-b border-[var(--node-border)] px-2">
        <span className="mr-auto truncate text-[11px] font-semibold tracking-wide text-[var(--node-muted)] uppercase">Explorer</span>
        <ToolButton label="New connection" icon={Plus} onClick={() => ops.pickKind()} />
        <ToolButton label="Refresh everything open" icon={RefreshCw} onClick={() => connections.filter((c) => expanded.has(keyOf(c.id, []))).forEach((c) => refresh(c.id, []))} />
        <ToolButton label="Collapse all" icon={ChevronsDownUp} onClick={() => setExpanded(new Set())} />
        <ToolButton
          label="Explorer options"
          icon={Ellipsis}
          onClick={(e) =>
            menu.open(
              e,
              optionsMenu(prefs, {
                any: connections.length > 0,
                anyOpen: Object.keys(state?.open ?? {}).length > 0,
                newConnection: () => ops.pickKind(),
                connectAll: () => connections.forEach((c) => !state?.open[c.id] && ops.connect(c)),
                disconnectAll: () => connections.forEach((c) => state?.open[c.id] && ops.disconnect(c)),
                expandOpen: () => connections.filter((c) => state?.open[c.id]).forEach((c) => handle.current?.reveal(c.id)),
                collapse: () => setExpanded(new Set()),
              }),
            )
          }
        />
      </div>
      <div className="flex-none border-b border-[var(--node-border)] p-1.5">
        <label className="relative block">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-[var(--node-muted)]" />
          <NodeInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-6 w-full pl-6 text-[11px]" />
        </label>
      </div>
      <div role="tree" className="min-h-0 flex-1 overflow-auto py-1 text-[12px] select-none">
        {state && !connections.length ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[11px] text-[var(--node-muted)]">
            No connections yet.
            <button type="button" className="text-[var(--node-accent)] hover:underline" onClick={() => ops.pickKind()}>
              Add one
            </button>
          </div>
        ) : (
          rows
        )}
      </div>
      {menu.element}
    </div>
  );
}
