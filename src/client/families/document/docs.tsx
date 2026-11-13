// A page of documents as a list, as Compass shows them: each one a line
// that opens into its JSON tree, with a menu (Edit, Duplicate, Copy JSON,
// Delete) on a right-click or its ⋯ button.

import { useEffect, useState } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { JsonTree, type MenuEntry, cn, useMenu } from '@hyperpane/ui';
import { oneLine, pretty } from './format.ts';

export interface DocActions {
  edit(i: number): void;
  duplicate(i: number): void;
  copy(i: number): void;
  remove(i: number): void;
}

export function DocList({ docs, mongo, readOnly, actions, offset, expandAll }: { docs: unknown[]; mongo: boolean; readOnly: boolean; actions: DocActions; offset: number; expandAll: number }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const menu = useMenu();
  useEffect(() => setOpen(new Set()), [docs]);
  useEffect(() => {
    if (expandAll > 0) setOpen(new Set(docs.map((_, i) => i)));
    else if (expandAll < 0) setOpen(new Set());
  }, [expandAll]);

  const items = (i: number): (MenuEntry | null)[] => [
    { label: readOnly ? 'View' : 'Edit', run: () => actions.edit(i) },
    readOnly ? null : { label: 'Duplicate', run: () => actions.duplicate(i) },
    { label: 'Copy JSON', run: () => actions.copy(i) },
    ...(readOnly ? [] : [null, { label: 'Delete', danger: true, run: () => actions.remove(i) }]),
  ];

  if (!docs.length) return <div className="p-6 text-center text-[11.5px] text-[var(--node-muted)]">No documents match.</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {docs.map((d, i) => {
        const isOpen = open.has(i);
        return (
          <div key={i} className="border-b border-[var(--node-border)]" onContextMenu={(e) => menu.open(e, items(i))}>
            <div
              className={cn('group flex h-[26px] cursor-default items-center gap-1 pr-1 pl-1 font-mono text-[11.5px] hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]', isOpen && 'bg-[color-mix(in_srgb,var(--node-fg)_3%,transparent)]')}
              onClick={() =>
                setOpen((s) => {
                  const n = new Set(s);
                  if (n.has(i)) n.delete(i);
                  else n.add(i);
                  return n;
                })
              }
              onDoubleClick={() => actions.edit(i)}
            >
              <ChevronRight className={cn('size-3 flex-none text-[var(--node-muted)] transition-transform', isOpen && 'rotate-90')} />
              <span className="w-8 flex-none text-right text-[10.5px] text-[var(--node-muted)] tabular-nums">{offset + i + 1}</span>
              <span className="min-w-0 flex-1 truncate pl-1 text-[var(--node-fg)]">{oneLine(d, mongo)}</span>
              <button
                type="button"
                aria-label="Document menu"
                className="flex size-5 flex-none items-center justify-center rounded text-[var(--node-muted)] opacity-0 group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--node-fg)_10%,transparent)] hover:text-[var(--node-fg)]"
                onClick={(e) => {
                  e.stopPropagation();
                  menu.open(e, items(i));
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </div>
            {isOpen && (
              <div className="py-1 pr-2 pl-6 text-[11px]">
                <JsonTree value={pretty(d, mongo)} depth={2} className="max-h-[520px]" />
              </div>
            )}
          </div>
        );
      })}
      {menu.element}
    </div>
  );
}
