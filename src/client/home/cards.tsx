// The home screen's cards: a saved connection (its kind's tile, name,
// where it points, whether it's connected), and a kind to add.

import { MoreHorizontal, Plug } from 'lucide-react';
import { formatAgo } from '@hyperpane/sdk/client';
import { Badge, cn } from '@hyperpane/ui';
import { type Kind, address } from '../../shared/kinds.ts';
import type { Connection, SessionInfo } from '../../shared/types.ts';
import { KindTile } from '../ui/parts.tsx';

export function ConnectionCard({
  c,
  kind,
  open,
  onOpen,
  onMenu,
  compact,
}: {
  c: Connection;
  kind: Kind;
  open?: SessionInfo;
  onOpen(): void;
  onMenu(e: React.MouseEvent): void;
  compact?: boolean;
}) {
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
        'rounded-surface group relative flex min-w-0 cursor-pointer items-center gap-3 border border-[var(--node-border)] bg-[color-mix(in_srgb,var(--node-fg)_3%,transparent)] px-3 transition-colors duration-100 outline-none hover:bg-[var(--node-hover)] focus-visible:border-[var(--node-accent)]',
        compact ? 'h-14' : 'h-16',
      )}
    >
      {(c.color || open) && <span className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r" style={{ background: c.color ?? 'transparent' }} />}
      <span className="relative">
        <KindTile kind={kind} size={compact ? 28 : 32} />
        {open && (
          <span
            title={`Connected: ${open.version}`}
            className="absolute -right-1 -bottom-1 size-2.5 rounded-full border-2 border-[var(--node-bg)] bg-[var(--ansi-2)]"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium">{c.name}</span>
          {c.readOnly && (
            <Badge size="sm" shape="rounded">
              Read only
            </Badge>
          )}
        </span>
        <span className="truncate font-mono text-2xs text-[var(--node-muted)]">{address(kind, c.values) || kind.name}</span>
        {!compact && c.values.notes ? <span className="truncate text-2xs text-[var(--node-muted)]">{String(c.values.notes).split('\n')[0]}</span> : null}
        {!compact && !c.values.notes && (
          <span className="truncate text-2xs text-[var(--node-muted)]">
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
        className="rounded-control flex size-7 flex-none items-center justify-center text-[var(--node-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--node-hover)] hover:text-[var(--node-fg)] focus-visible:opacity-100 touch:size-9 touch:opacity-100"
      >
        <MoreHorizontal className="size-3.5" />
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
      className="rounded-surface group flex h-14 min-w-0 items-center gap-2.5 border border-[var(--node-border)] px-3 text-left transition-colors duration-100 outline-none hover:bg-[var(--node-hover)] focus-visible:border-[var(--node-accent)]"
    >
      <KindTile kind={kind} size={28} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs font-medium">{kind.name}</span>
        <span className="truncate text-2xs text-[var(--node-muted)]">{kind.tagline}</span>
      </span>
      <Plug className="size-3.5 flex-none text-[var(--node-muted)] opacity-0 group-hover:opacity-100" />
    </button>
  );
}
