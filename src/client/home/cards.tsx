// The home screen's cards: a saved connection (its kind's tile, name,
// where it points, whether it's connected), and a kind to add.

import { MoreHorizontal, Plug } from 'lucide-react';
import { formatAgo } from '@hyperpane/sdk/client';
import { cn } from '@hyperpane/ui';
import { type Kind, address } from '../../shared/kinds.ts';
import type { Connection, SessionInfo } from '../../shared/types.ts';
import { KindTile } from '../ui/parts.tsx';

export function ConnectionCard({ c, kind, open, onOpen, onMenu, compact }: { c: Connection; kind: Kind; open?: SessionInfo; onOpen(): void; onMenu(e: React.MouseEvent): void; compact?: boolean }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      title={c.values.notes ? String(c.values.notes) : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
      className={cn(
        'group relative flex min-w-0 cursor-pointer items-center gap-3 rounded-[9px] border border-[var(--node-border)] bg-[color-mix(in_srgb,var(--node-fg)_2.5%,transparent)] px-3 transition-colors outline-none hover:border-[color-mix(in_srgb,var(--node-accent)_55%,var(--node-border))] hover:bg-[color-mix(in_srgb,var(--node-accent)_6%,transparent)] focus-visible:border-[var(--node-accent)]',
        compact ? 'h-[52px]' : 'h-[62px]',
      )}
    >
      {(c.color || open) && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r" style={{ background: c.color ?? 'transparent' }} />}
      <span className="relative">
        <KindTile kind={kind} size={compact ? 28 : 34} />
        {open && <span title={`Connected: ${open.version}`} className="absolute -right-1 -bottom-1 size-2.5 rounded-full border-2 border-[var(--node-bg)] bg-[#3fb950]" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium">{c.name}</span>
          {c.readOnly && <span className="flex-none rounded-[3px] border border-[var(--node-border)] px-1 text-[9.5px] text-[var(--node-muted)]">read only</span>}
        </span>
        <span className="truncate font-mono text-[10.5px] text-[var(--node-muted)]">{address(kind, c.values) || kind.name}</span>
        {!compact && c.values.notes ? (
          <span className="truncate text-[10.5px] text-[var(--node-muted)] italic opacity-80">{String(c.values.notes).split('\n')[0]}</span>
        ) : null}
        {!compact && !c.values.notes && (
          <span className="truncate text-[10.5px] text-[var(--node-muted)] opacity-80">
            {kind.name}
            {open ? ` · ${open.version}` : c.used ? ` · ${formatAgo(c.used)}` : ''}
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label="More"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e);
        }}
        className="flex size-6 flex-none items-center justify-center rounded-[5px] text-[var(--node-muted)] opacity-0 group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--node-fg)_8%,transparent)] hover:text-[var(--node-fg)] focus-visible:opacity-100"
      >
        <MoreHorizontal className="size-4" />
      </button>
    </div>
  );
}

export function KindCard({ kind, onClick }: { kind: Kind; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`New ${kind.name} connection`}
      className="group flex h-[54px] min-w-0 items-center gap-2.5 rounded-[9px] border border-[var(--node-border)] px-2.5 text-left transition-colors outline-none hover:border-[color-mix(in_srgb,var(--node-accent)_55%,var(--node-border))] hover:bg-[color-mix(in_srgb,var(--node-accent)_6%,transparent)] focus-visible:border-[var(--node-accent)]"
    >
      <KindTile kind={kind} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] font-medium">{kind.name}</span>
        <span className="truncate text-[10.5px] text-[var(--node-muted)]">{kind.tagline}</span>
      </span>
      <Plug className="size-3.5 flex-none text-[var(--node-muted)] opacity-0 group-hover:opacity-100" />
    </button>
  );
}
