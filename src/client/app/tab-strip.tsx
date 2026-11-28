// The strip of open tabs: Home first, always there; each tab with its
// connection's color, its type's icon and its title; middle-click or ×
// closes it.

import { X } from '@hyperpane/icons';
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
    <div data-measure="tabs" className="flex h-11 flex-none items-center border-b border-[var(--data-line)] touch:h-12">
      {left}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto ps-1 pe-2 [scrollbar-width:none]">
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
              aria-label={home ? 'Home' : undefined}
              className={cn(
                'group rounded-full relative flex h-7 max-w-[220px] flex-none cursor-default items-center gap-1.5 text-[13px] transition-colors duration-100 touch:h-9',
                home ? 'w-7 justify-center touch:w-9' : on ? 'ps-2 pe-1' : 'ps-2 pe-2.5 hover:pe-1 focus-within:pe-1 touch:pe-1',
                on
                  ? 'bg-[var(--data-fill-hover)] text-[var(--node-fg)]'
                  : 'text-[var(--node-muted)] hover:bg-[var(--node-hover)] hover:text-[var(--node-fg)]',
              )}
            >
              <Icon className="size-4 flex-none" style={{ color: home ? undefined : (c?.color ?? k?.color ?? undefined) }} />
              {!home && <span className="truncate">{t.title}</span>}
              {!home && (
                <button
                  type="button"
                  aria-label="Close tab"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onClose(t.key)}
                  className={cn(
                    'flex size-5 flex-none items-center justify-center rounded-full text-[var(--node-muted)] hover:bg-[var(--data-fill-active)] hover:text-[var(--node-fg)] touch:size-7',
                    on ? 'flex' : 'hidden group-hover:flex focus-visible:flex touch:flex',
                  )}
                >
                  <X className="size-3.5" />
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
