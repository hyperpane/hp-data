// The home screen's cards: a saved connection (its kind's tile, name,
// where it points, whether it's connected), and a kind to add.

import { MoreHorizontal, Plug } from '@hyperpane/icons';
import { formatAgo } from '@hyperpane/sdk/client';
import { cn } from '@hyperpane/ui';
import { card, chip } from '../ui/look.ts';
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
        card,
        'group relative flex min-w-0 cursor-pointer items-center gap-3 px-4 transition-[background-color,box-shadow,scale] duration-150 ease-out outline-none hover:bg-[color-mix(in_srgb,var(--data-raised),var(--node-fg)_4%)] focus-visible:ring-2 focus-visible:ring-[var(--node-accent)] motion-safe:active:scale-[0.995]',
        compact ? 'h-14' : 'h-[72px]',
      )}
    >
      <span className="relative">
        <KindTile kind={kind} size={compact ? 28 : 36} />
        {open && (
          <span
            title={`Connected: ${open.version}`}
            className="absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-[var(--data-raised)] bg-[var(--data-ok)]"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{c.name}</span>
          {c.color && <span aria-hidden className="size-1.5 flex-none rounded-full" style={{ background: c.color }} />}
          {c.readOnly && <span className={cn(chip.base, chip.neutral)}>Read only</span>}
        </span>
        <span className="truncate font-mono text-[11px] leading-4 text-[var(--node-muted)]" title={address(kind, c.values) || kind.name}>
          {address(kind, c.values) || kind.name}
        </span>
        {!compact && c.values.notes ? <span className="truncate text-xs text-[var(--node-muted)]">{String(c.values.notes).split('\n')[0]}</span> : null}
        {!compact && !c.values.notes && (
          <span className="truncate text-xs text-[var(--node-muted)]">
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
        className="rounded-full flex size-7 flex-none items-center justify-center text-[var(--node-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--data-fill-hover)] hover:text-[var(--node-fg)] focus-visible:opacity-100 touch:size-9 touch:opacity-100"
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
      className="rounded-card group flex h-14 min-w-0 items-center gap-3 px-3 text-left bg-[var(--data-rail)] transition-[background-color,box-shadow] duration-150 outline-none hover:bg-[var(--data-fill)] focus-visible:ring-2 focus-visible:ring-[var(--node-accent)]"
    >
      <KindTile kind={kind} size={30} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium">{kind.name}</span>
        <span className="truncate text-xs text-[var(--node-muted)]">{kind.tagline}</span>
      </span>
      <Plug variant="outline" className="size-4 flex-none text-[var(--node-muted)] opacity-0 transition-opacity duration-100 group-hover:opacity-100" />
    </button>
  );
}
