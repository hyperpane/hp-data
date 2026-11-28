// The Database Explorer, as DataGrip's: every saved connection, each one
// opening into what's in it (loaded as it's expanded: expanding a
// connection connects it), with a filter, its status (connected, failed),
// double-click to open (a tap, with a finger), and each item's right-click
// menu (Open, Refresh, Copy Name, and its family's own).

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Database, Ellipsis, LoaderCircle, Plus, Search, TriangleAlert, X } from '@hyperpane/icons';
import { NodeButton, NodeInput, ToolButton, cn, useMenu, useTouch, type MenuEntry } from '@hyperpane/ui';
import { address, kindOf } from '../../shared/kinds.ts';
import { optionsMenu, usePrefs } from './options.ts';
import type { Connection, State, TreeNode } from '../../shared/types.ts';
import type { NewTab } from '../app/tabs.ts';
import { FAMILIES } from '../families/index.ts';
import { connectionMenu, type ConnectionOps } from '../home/menu.ts';
import type { Api } from '../lib/api.ts';
import { NODE_COLORS, NODE_ICONS } from '../ui/icons.tsx';
import { header, row, section, chip } from '../ui/look.ts';
import { Blank, KindTile, rowState } from '../ui/parts.tsx';

interface Loaded {
  loading?: boolean;
  error?: string;
  nodes?: TreeNode[];
}

const keyOf = (conn: string, path: string[]) => [conn, ...path].join('\u0000');

/** A row's start at a depth: 16px a level, from the row's own 4px. */
const INDENT = (depth: number) => 4 + depth * 16;

const chevron =
  'flex size-5 flex-none items-center justify-center rounded-full text-[var(--node-muted)] transition-colors duration-100 hover:bg-[var(--data-fill-hover)] hover:text-[var(--node-fg)]';

export interface ExplorerHandle {
  /** Expands a connection (connecting it). */
  reveal(conn: string): void;
  refresh(conn: string): void;
}

export function Explorer({
  state,
  api,
  project,
  ops,
  open,
  handle,
  activeConn,
}: {
  state: State | null;
  api: Api;
  project: string | null;
  ops: ConnectionOps;
  open(t: NewTab): void;
  handle: React.RefObject<ExplorerHandle | null>;
  activeConn: string | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(() => new Map());
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const menu = useMenu();
  const auto = useRef(new Set<string>());
  const prefs = usePrefs();
  const touch = useTouch();
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
        for (const x of fresh) auto.current.add(x);
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
  const openIds = Object.keys(state?.open ?? {})
    .sort()
    .join();
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
          ...(node.open
            ? [{ label: 'Open', shortcut: '↵', run: () => open({ type: node.open!.tab, conn: c.id, ref: node.open!.ref, title: node.open!.title }) }]
            : []),
          { label: 'Refresh', run: () => refresh(c.id, node.leaf ? path.slice(0, -1) : path) },
          { label: 'Copy Name', run: () => api.copy(node.name.replace(/^index:/, ''), 'the name') },
        ]
      : [
          ...connectionMenu(c, !!state?.open[c.id], ops, kind.family),
          null,
          { label: 'Refresh', run: () => refresh(c.id, []) },
          { label: 'Copy Address', run: () => api.copy(address(kind, c.values), 'the address') },
          { label: 'Copy Name', run: () => api.copy(c.name, 'the name') },
        ];
    const own =
      fam.actions?.({
        node,
        path,
        connection: c,
        kind,
        api,
        project,
        readOnly: c.readOnly,
        open,
        refresh: () => refresh(c.id, node && !node.leaf ? path : path.slice(0, -1)),
      }) ?? [];
    return own.length ? [...items, null, ...own] : items;
  };

  const rows: React.ReactNode[] = [];
  const pushNodes = (c: Connection, path: string[], depth: number) => {
    const k = keyOf(c.id, path);
    const l = loaded.get(k);
    if (l?.error) {
      rows.push(
        <div
          key={`${k}:error`}
          className="mx-1.5 my-0.5 flex items-start gap-2 rounded-control bg-[color-mix(in_srgb,var(--data-error)_8%,transparent)] py-1.5 pe-1.5 text-xs leading-4 text-[var(--node-fg)]"
          style={{ paddingLeft: INDENT(depth) + 22 }}
        >
          <TriangleAlert className="mt-px size-3.5 flex-none text-[var(--data-error)]" />
          <span className="min-w-0 flex-1 py-px break-words select-text">{l.error}</span>
          <button
            type="button"
            className="-my-0.5 h-5 flex-none rounded-full px-2 font-medium text-[var(--node-muted)] hover:bg-[var(--node-hover)] hover:text-[var(--node-fg)]"
            onClick={() => refresh(c.id, path)}
          >
            Retry
          </button>
        </div>,
      );
      return;
    }
    if (l?.loading && !l.nodes) {
      rows.push(
        <div key={`${k}:loading`} className="mx-1.5 flex h-7 items-center gap-2 text-xs text-[var(--node-muted)]" style={{ paddingLeft: INDENT(depth) + 24 }}>
          <LoaderCircle className="size-3.5 animate-spin" />
          {path.length ? 'Loading' : 'Connecting'}
        </div>,
      );
      return;
    }
    const nodes = visible(c.id, path);
    if (l?.nodes && !l.nodes.length)
      rows.push(
        <div key={`${k}:empty`} className="mx-1.5 flex h-7 items-center text-xs text-[var(--node-muted)]" style={{ paddingLeft: INDENT(depth) + 24 }}>
          Empty
        </div>,
      );
    for (const n of nodes) {
      const p = [...path, n.name];
      const nk = keyOf(c.id, p);
      const isOpen = expanded.has(nk);
      const Icon = NODE_ICONS[n.type] ?? NODE_ICONS.info;
      const activate = () => (n.open ? open({ type: n.open.tab, conn: c.id, ref: n.open.ref, title: n.open.title }) : !n.leaf && toggle(c.id, p));
      rows.push(
        <div
          key={nk}
          role="treeitem"
          aria-expanded={n.leaf ? undefined : isOpen}
          tabIndex={-1}
          className={cn(row.compact, 'mx-1.5 gap-1.5 whitespace-nowrap', rowState(selected === nk))}
          style={{ paddingLeft: INDENT(depth) }}
          onClick={() => {
            setSelected(nk);
            if (touch) activate();
          }}
          onDoubleClick={activate}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelected(nk);
            menu.open(e, nodeMenu(c, p, n));
          }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            className={cn(chevron, n.leaf && 'invisible')}
            onClick={(e) => {
              e.stopPropagation();
              toggle(c.id, p);
            }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none', isOpen && 'rotate-90')} />
          </button>
          <Icon className="size-3.5 flex-none" style={{ color: NODE_COLORS[n.type] ?? 'var(--node-muted)' }} />
          <span className="truncate">{n.label ?? n.name}</span>
          {details && n.detail && <span className="min-w-0 truncate text-xs text-[var(--node-muted)] tabular-nums">{n.detail}</span>}
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
    if (groups.length > 1 || group)
      rows.push(
        <div key={`group:${group}`} className={cn(section.header, 'mt-2 px-3.5 first:mt-0')}>
          <span className="truncate">{group || 'Other'}</span>
          <span className={section.count}>{list.length}</span>
        </div>,
      );
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
          className={cn(
            row.base,
            'mx-1.5 gap-1.5',
            rowState(selected === k),
            activeConn === c.id && selected !== k && 'bg-[color-mix(in_srgb,var(--node-fg)_4%,transparent)]',
          )}
          style={{ paddingLeft: INDENT(0) }}
          onClick={() => {
            setSelected(k);
            if (touch) toggle(c.id, []);
          }}
          onDoubleClick={() => toggle(c.id, [])}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelected(k);
            menu.open(e, nodeMenu(c, [], null));
          }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            className={chevron}
            onClick={(e) => {
              e.stopPropagation();
              toggle(c.id, []);
            }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none', isOpen && 'rotate-90')} />
          </button>
          <span className="relative me-0.5 flex-none">
            <KindTile kind={kind} size={20} />
            {(session || (l?.error && !session)) && (
              <span
                className="absolute -right-[3px] -bottom-[3px] size-2.5 rounded-full border-2 border-[var(--data-rail)]"
                style={{ background: session ? 'var(--data-ok)' : 'var(--data-error)' }}
              />
            )}
          </span>
          <span className="truncate font-medium">{c.name}</span>
          {c.color && <span aria-hidden className="size-1.5 flex-none rounded-full" style={{ background: c.color }} />}
          {c.readOnly && (
            <span className={cn(chip.base, chip.neutral, 'h-[18px] px-1 text-[10px]')} title="Read only">
              RO
            </span>
          )}
          {l?.loading && <LoaderCircle className="ms-auto size-3.5 flex-none animate-spin text-[var(--node-muted)]" />}
        </div>,
      );
      if (isOpen) pushNodes(c, [], 1);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-measure="explorer" className={cn(header.base, 'gap-1')}>
        <label className="relative flex min-w-0 flex-1 items-center">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-[var(--node-muted)]" />
          <NodeInput
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
            placeholder={connections.length ? `Filter ${connections.length === 1 ? '1 connection' : `${connections.length} connections`}` : 'Filter'}
            aria-label="Filter"
            className={cn('w-full ps-8 text-[13px]', filter && 'pe-7')}
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear the filter"
              onClick={() => setFilter('')}
              className="absolute right-1 flex size-5 items-center justify-center rounded-full text-[var(--node-muted)] hover:bg-[var(--data-fill-hover)] hover:text-[var(--node-fg)] touch:size-8"
            >
              <X className="size-3" />
            </button>
          )}
        </label>
        <ToolButton label="New connection" icon={Plus} onClick={() => ops.pickKind()} />
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
                connectAll: () => {
                  for (const c of connections) if (!state?.open[c.id]) ops.connect(c);
                },
                disconnectAll: () => {
                  for (const c of connections) if (state?.open[c.id]) ops.disconnect(c);
                },
                refreshOpen: () => {
                  for (const c of connections.filter((c) => expanded.has(keyOf(c.id, [])))) refresh(c.id, []);
                },
                expandOpen: () => {
                  for (const c of connections.filter((c) => state?.open[c.id])) handle.current?.reveal(c.id);
                },
                collapse: () => setExpanded(new Set()),
              }),
            )
          }
        />
      </div>
      <div role="tree" className="group/list flex min-h-0 flex-1 flex-col gap-px overflow-auto py-1.5 text-[13px] select-none">
        {state && !connections.length ? (
          <Blank
            icon={<Database />}
            title="No connections yet"
            actions={
              <NodeButton variant="primary" onClick={() => ops.pickKind()}>
                <Plus />
                New connection
              </NodeButton>
            }
          >
            Connect a database, a store, a queue or a bucket
          </Blank>
        ) : (
          rows
        )}
      </div>
      {menu.element}
    </div>
  );
}
