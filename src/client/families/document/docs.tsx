// A page of documents as a list, as Compass shows them: each one a line
// that opens into its JSON tree, with a menu (Edit, Duplicate, Copy JSON,
// Delete) on a right-click or its ⋯ button.

import { useEffect, useState } from 'react';
import { ChevronRight, FileSearch, MoreHorizontal } from '@hyperpane/icons';
import { Empty, JsonTree, type MenuEntry, cn, useMenu } from '@hyperpane/ui';
import { oneLine, pretty } from './format.ts';

export interface DocActions {
  edit(i: number): void;
  duplicate(i: number): void;
  copy(i: number): void;
  remove(i: number): void;
}

export function DocList({
  docs,
  mongo,
  readOnly,
  actions,
  offset,
  expandAll,
}: {
  docs: unknown[];
  mongo: boolean;
  readOnly: boolean;
  actions: DocActions;
  offset: number;
  expandAll: number;
}) {
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

  if (!docs.length)
    return <Empty bordered={false} className="flex-1" icon={<FileSearch />} title="No documents" description="None match the filter on this page" />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {docs.map((d, i) => {
        const isOpen = open.has(i);
        return (
          <div key={i} className="border-b border-[var(--data-line)]" onContextMenu={(e) => menu.open(e, items(i))}>
            <div
              className={cn(
                'group flex h-7 cursor-default items-center gap-1.5 ps-2 pe-1 font-mono text-xs hover:bg-[var(--node-hover)] touch:h-10',
                isOpen && 'bg-[color-mix(in_srgb,var(--node-fg)_4%,transparent)]',
              )}
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
              <span className="w-8 flex-none text-right font-sans text-2xs text-[var(--node-muted)] tabular-nums">{offset + i + 1}</span>
              <span className="min-w-0 flex-1 truncate pl-1 text-[var(--node-fg)]">{oneLine(d, mongo)}</span>
              <button
                type="button"
                aria-label="Document menu"
                className="rounded-control flex size-6 flex-none items-center justify-center text-[var(--node-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--node-hover)] hover:text-[var(--node-fg)] focus-visible:opacity-100 touch:size-9 touch:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  menu.open(e, items(i));
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </div>
            {isOpen && (
              <div className="py-1.5 pe-2 ps-7 font-mono text-xs">
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
