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
    <div className="flex h-9 flex-none items-stretch border-b border-[var(--node-border)]">
      {left}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
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
                'group relative flex max-w-[220px] flex-none cursor-default items-center gap-1.5 border-r border-[var(--node-border)] text-[11.5px]',
                home ? 'px-2.5' : 'pr-1 pl-2.5',
                on ? 'bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)] text-[var(--node-fg)]' : 'text-[var(--node-muted)] hover:text-[var(--node-fg)]',
              )}
            >
              {on && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--node-accent)]" />}
              <Icon className="size-3.5 flex-none" style={{ color: c?.color ?? k?.color ?? undefined }} />
              {!home && <span className="truncate">{t.title}</span>}
              {!home && (
                <button
                  type="button"
                  aria-label="Close tab"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onClose(t.key)}
                  className={cn(
                    'flex size-4 flex-none items-center justify-center rounded-[3px] hover:bg-[color-mix(in_srgb,var(--node-fg)_10%,transparent)]',
                    on ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
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
