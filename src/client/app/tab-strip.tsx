// The strip of open tabs: Home first, always there; each tab with its
// connection's color, its type's icon and its title; middle-click or ×
// closes it.

import { X } from 'lucide-react';
import { cn, useMenu } from '@hyperpane/ui';
import { kindOf } from '../../shared/kinds.ts';
import type { Connection } from '../../shared/types.ts';
import { TAB_ICONS } from '../ui/icons.tsx';
import type { Tab } from './tabs.ts';

export function TabStrip({
  tabs,
  active,
  connection,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseConnection,
  left,
}: {
  tabs: Tab[];
  active: string;
  connection(id: string | null): Connection | undefined;
  onActivate(key: string): void;
  onClose(key: string): void;
  onCloseOthers(key: string): void;
  onCloseConnection(conn: string): void;
  left?: React.ReactNode;
}) {
  const menu = useMenu();
  return (
    <div className="flex h-10 flex-none items-stretch border-b border-[var(--node-border)] touch:h-12">
      {left}
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1 [scrollbar-width:none]">
        {tabs.map((t) => {
          const c = connection(t.conn);
          const k = c ? kindOf(c.kind) : undefined;
          const Icon = TAB_ICONS[t.type];
          const on = t.key === active;
          const home = t.type === 'home';
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={on}
              title={c ? `${t.title} · ${c.name}` : t.title}
              onPointerDown={(e) => e.button === 0 && onActivate(t.key)}
              onAuxClick={(e) => e.button === 1 && !home && onClose(t.key)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (home) return;
                menu.open(e, [
                  { label: 'Close', run: () => onClose(t.key) },
                  { label: 'Close Others', run: () => onCloseOthers(t.key) },
                  ...(c ? [{ label: `Close All of ${c.name}`, run: () => onCloseConnection(c.id) }] : []),
                ]);
              }}
              className={cn(
                'group relative flex max-w-[220px] flex-none cursor-default items-center gap-2 text-xs transition-colors duration-100',
                home ? 'px-2.5' : 'ps-2.5 pe-1.5',
                on ? 'font-medium text-[var(--node-fg)]' : 'text-[var(--node-muted)] hover:text-[var(--node-fg)]',
              )}
            >
              <span aria-hidden className={cn('absolute inset-x-1.5 bottom-0 h-0.5 rounded-full', on ? 'bg-[var(--node-accent)]' : 'bg-transparent')} />
              <Icon className="size-3.5 flex-none" style={{ color: c?.color ?? k?.color ?? undefined }} />
              {!home && <span className="truncate">{t.title}</span>}
              {!home && (
                <button
                  type="button"
                  aria-label="Close tab"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onClose(t.key)}
                  className={cn(
                    'flex size-5 flex-none items-center justify-center rounded-[5px] text-[var(--node-muted)] hover:bg-[var(--node-hover)] hover:text-[var(--node-fg)] touch:size-8',
                    on ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 touch:opacity-100',
                  )}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {menu.element}
    </div>
  );
}
