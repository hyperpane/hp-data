// The left side of a keys tab: a glob to match, the keys found (flat, or
// as a tree by `:`), each with its type and TTL, and "Load more" while
// SCAN has more. ↑ and ↓ move through them.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderTree, List, Plus, RefreshCw, Search } from 'lucide-react';
import { NodeButton, StatusBar, ToolButton, cn, useMenu } from '@hyperpane/ui';
import type { KeyEntry } from '../../../shared/kv.ts';
import { type KeyNode, keyTree, ttlText } from './lib.ts';
import { Muted, TypeBadge } from './parts.tsx';
import type { Scan } from './use-scan.ts';

type Row = { kind: 'folder'; prefix: string; name: string; count: number; depth: number; open: boolean } | { kind: 'key'; name: string; entry: KeyEntry; depth: number };

function rowsOf(nodes: KeyNode[], open: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const n of nodes) {
    if (n.kind === 'key') out.push({ kind: 'key', name: n.name, entry: n.entry, depth });
    else {
      const isOpen = open.has(n.prefix);
      out.push({ kind: 'folder', prefix: n.prefix, name: n.name, count: n.count, depth, open: isOpen });
      if (isOpen) rowsOf(n.children, open, depth + 1, out);
    }
  }
  return out;
}

export interface KeyListProps {
  scan: Scan;
  pattern: string;
  onPattern(p: string): void;
  tree: boolean;
  onTree(t: boolean): void;
  selected: string | null;
  onSelect(key: string): void;
  onNew?(): void;
  onRemove?(keys: string[]): void;
  copy(text: string, what?: string): void;
}

export function KeyList(p: KeyListProps) {
  const { scan } = p;
  const [typed, setTyped] = useState(p.pattern);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const menu = useMenu();
  const rows = useMemo<Row[]>(
    () => (p.tree ? rowsOf(keyTree(scan.keys), open) : scan.keys.map((entry) => ({ kind: 'key' as const, name: entry.key, entry, depth: 0 }))),
    [scan.keys, p.tree, open],
  );
  const toggle = (prefix: string) =>
    setOpen((old) => {
      const s = new Set(old);
      if (s.has(prefix)) s.delete(prefix);
      else s.add(prefix);
      return s;
    });

  const move = (by: number) => {
    const keys = rows.filter((r) => r.kind === 'key');
    if (!keys.length) return;
    const i = keys.findIndex((r) => r.entry.key === p.selected);
    const next = keys[Math.max(0, Math.min(keys.length - 1, i < 0 ? 0 : i + by))];
    p.onSelect(next.entry.key);
    document.querySelector(`[data-kv-key="${CSS.escape(next.entry.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex h-9 flex-none items-center gap-1 border-b border-[var(--node-border)] px-2"
        onSubmit={(e) => {
          e.preventDefault();
          p.onPattern(typed.trim() || '*');
        }}
      >
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-1.5 size-3 text-[var(--node-muted)]" />
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="*"
            spellCheck={false}
            aria-label="Pattern"
            title="A glob: * any, ? one character, [abc] one of. Enter to search."
            className="h-6 w-full min-w-0 rounded-[5px] border border-[var(--node-border)] bg-transparent pr-2 pl-6 font-mono text-[11.5px] text-[var(--node-fg)] outline-none focus:border-[var(--node-accent)]"
          />
        </div>
        <ToolButton label={p.tree ? 'Show the keys flat' : 'Group the keys by “:”'} icon={p.tree ? List : FolderTree} onClick={() => p.onTree(!p.tree)} />
        <ToolButton label="Scan again" icon={RefreshCw} onClick={scan.reload} />
        {p.onNew && <ToolButton label="New key" icon={Plus} onClick={p.onNew} />}
      </form>
      <div
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto py-0.5 outline-none"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            move(e.key === 'ArrowDown' ? 1 : -1);
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && p.selected && p.onRemove) p.onRemove([p.selected]);
        }}
      >
        {scan.error && <Muted error>{scan.error}</Muted>}
        {!scan.error && !scan.loading && !rows.length && <Muted>{p.pattern === '*' ? 'No keys in this database' : `No keys match ${p.pattern}`}</Muted>}
        {rows.map((r) =>
          r.kind === 'folder' ? (
            <div
              key={`f:${r.prefix}`}
              className="flex h-[22px] cursor-default items-center gap-1 pr-2 hover:bg-[var(--node-hover)]"
              style={{ paddingLeft: 6 + r.depth * 12 }}
              onClick={() => toggle(r.prefix)}
              onContextMenu={(e) =>
                menu.open(e, [
                  { label: `Show only ${r.prefix}*`, run: () => (setTyped(`${r.prefix}*`), p.onPattern(`${r.prefix}*`)) },
                  { label: 'Copy the prefix', run: () => p.copy(r.prefix, 'the prefix') },
                ])
              }
            >
              {r.open ? <ChevronDown className="size-3 flex-none text-[var(--node-muted)]" /> : <ChevronRight className="size-3 flex-none text-[var(--node-muted)]" />}
              <Folder className="size-3.5 flex-none text-[var(--node-muted)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{r.name}</span>
              <span className="flex-none text-[10.5px] text-[var(--node-muted)] tabular-nums">{r.count}</span>
            </div>
          ) : (
            <div
              key={`k:${r.entry.key}`}
              data-kv-key={r.entry.key}
              title={r.entry.key}
              className={cn('flex h-[22px] cursor-default items-center gap-1.5 pr-2', r.entry.key === p.selected ? 'bg-[color-mix(in_srgb,var(--node-accent)_22%,transparent)]' : 'hover:bg-[var(--node-hover)]')}
              style={{ paddingLeft: 6 + r.depth * 12 + (p.tree ? 16 : 0) }}
              onClick={() => p.onSelect(r.entry.key)}
              onContextMenu={(e) =>
                menu.open(e, [
                  { label: 'Copy the name', run: () => p.copy(r.entry.key, 'the key’s name') },
                  ...(p.onRemove ? [null, { label: 'Delete', danger: true, run: () => p.onRemove!([r.entry.key]) }] : []),
                ])
              }
            >
              <TypeBadge type={r.entry.type} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{r.name}</span>
              {r.entry.ttl >= 0 && <span className="flex-none text-[10.5px] text-[var(--node-muted)] tabular-nums">{ttlText(r.entry.ttl)}</span>}
            </div>
          ),
        )}
        {scan.more && rows.length > 0 && (
          <div className="flex justify-center py-2">
            <NodeButton disabled={scan.loading} onClick={scan.loadMore}>
              {scan.loading ? 'Scanning' : 'Load more'}
            </NodeButton>
          </div>
        )}
      </div>
      <StatusBar>
        <span>
          {scan.loading && !scan.keys.length ? 'Scanning' : `${scan.keys.length.toLocaleString()} ${scan.keys.length === 1 ? 'key' : 'keys'}${scan.more ? ' so far' : ''}`}
          {scan.total !== undefined && ` · ${scan.total.toLocaleString()} in the database`}
        </span>
      </StatusBar>
      {menu.element}
    </div>
  );
}
