// The bucket's list, as Finder's: a header of sortable columns, folders
// then files (an icon by extension, name, size, modified, storage class),
// selection by click, ⌘-click and Shift-click, arrows and Enter; files
// dropped from the computer land in the folder shown.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Folder } from 'lucide-react';
import { formatTime } from '@hyperpane/sdk/client';
import { cn, fileIcon } from '@hyperpane/ui';
import { formatSize } from '../../ui/cells.ts';
import type { Row, Sort, SortColumn } from './paths.ts';

export interface ListProps {
  rows: Row[];
  selected: Set<string>;
  sort: Sort;
  onSort(s: Sort): void;
  /** A new selection, and the row it was made from (for Shift-click). */
  onSelect(keys: Set<string>, anchor: string | null): void;
  anchor: string | null;
  onOpen(row: Row): void;
  onMenu(e: React.MouseEvent, row: Row | null): void;
  onKey(e: React.KeyboardEvent): void;
  /** Files dropped on it (null: drops aren't taken). */
  onDrop: ((dt: DataTransfer) => void) | null;
  footer?: React.ReactNode;
  empty: React.ReactNode;
}

const COLUMNS: { id: SortColumn; label: string; className: string }[] = [
  { id: 'name', label: 'Name', className: 'min-w-0 flex-1' },
  { id: 'size', label: 'Size', className: 'w-[72px] justify-end text-right' },
  { id: 'modified', label: 'Modified', className: 'w-[128px]' },
  { id: 'class', label: 'Class', className: 'w-[92px]' },
];

export function List(p: ListProps) {
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  // Keeps the row the keyboard is on in view.
  useEffect(() => {
    if (!p.anchor) return;
    box.current?.querySelector(`[data-key="${CSS.escape(p.anchor)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [p.anchor]);

  const click = (e: React.MouseEvent, row: Row) => {
    const next = new Set(p.selected);
    if (e.shiftKey && p.anchor) {
      const keys = p.rows.map((r) => r.key);
      const [a, b] = [keys.indexOf(p.anchor), keys.indexOf(row.key)].sort((x, y) => x - y);
      if (a >= 0) {
        if (!(e.metaKey || e.ctrlKey)) next.clear();
        for (const k of keys.slice(a, b + 1)) next.add(k);
        return p.onSelect(next, p.anchor);
      }
    }
    if (e.metaKey || e.ctrlKey) {
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return p.onSelect(next, row.key);
    }
    p.onSelect(new Set([row.key]), row.key);
  };

  const drops = p.onDrop
    ? {
        onDragEnter: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          depth.current++;
          setOver(true);
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setOver(false);
        },
        onDragOver: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          if (e.dataTransfer.files.length) p.onDrop!(e.dataTransfer);
        },
      }
    : {};

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" {...drops}>
      <div className="flex h-6 flex-none items-center gap-2 border-b border-[var(--node-border)] px-2 text-[10.5px] text-[var(--node-muted)] select-none">
        <span className="w-4 flex-none" />
        {COLUMNS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={cn('flex h-full items-center gap-0.5 hover:text-[var(--node-fg)]', c.className, p.sort.column === c.id && 'text-[var(--node-fg)]')}
            onClick={() => p.onSort({ column: c.id, desc: p.sort.column === c.id ? !p.sort.desc : c.id === 'modified' || c.id === 'size' })}
          >
            {c.label}
            {p.sort.column === c.id && (p.sort.desc ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />)}
          </button>
        ))}
      </div>
      <div
        ref={box}
        tabIndex={0}
        role="listbox"
        aria-multiselectable
        className="min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={p.onKey}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) p.onMenu(e, null);
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) p.onSelect(new Set(), null);
        }}
      >
        {p.rows.length === 0 && p.empty}
        {p.rows.map((row) => {
          const Icon = row.folder ? Folder : fileIcon(row.name);
          const on = p.selected.has(row.key);
          return (
            <div
              key={row.key}
              data-key={row.key}
              role="option"
              aria-selected={on}
              className={cn(
                'flex h-[22px] cursor-default items-center gap-2 px-2 text-[11.5px] select-none',
                on ? 'bg-[color-mix(in_srgb,var(--node-accent)_22%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]',
              )}
              onMouseDown={(e) => e.button === 0 && click(e, row)}
              onDoubleClick={() => p.onOpen(row)}
              onContextMenu={(e) => {
                if (!on) p.onSelect(new Set([row.key]), row.key);
                p.onMenu(e, row);
              }}
            >
              <Icon className={cn('size-3.5 w-4 flex-none', row.folder ? 'text-[var(--node-accent)]' : 'text-[var(--node-muted)]')} />
              <span className="min-w-0 flex-1 truncate" title={row.key}>
                {row.name}
                {row.folder && <span className="text-[var(--node-muted)]">/</span>}
              </span>
              <span className="w-[72px] flex-none text-right text-[var(--node-muted)] tabular-nums">{row.size === null ? '—' : formatSize(row.size)}</span>
              <span className="w-[128px] flex-none truncate text-[var(--node-muted)] tabular-nums">{row.modified ? formatTime(row.modified) : ''}</span>
              <span className="w-[92px] flex-none truncate text-[10.5px] text-[var(--node-muted)]">{row.storageClass ?? ''}</span>
            </div>
          );
        })}
        {p.footer}
      </div>
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-[var(--node-accent)] bg-[color-mix(in_srgb,var(--node-accent)_10%,transparent)] text-[12px] font-medium">
          Drop to upload here
        </div>
      )}
    </div>
  );
}
