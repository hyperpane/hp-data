// Small parts of the kv views: a type's badge, a dialog over the view,
// a labelled field in one, and an empty or loading message.

import { X } from 'lucide-react';
import { NodeButton, ToolButton, cn } from '@hyperpane/ui';
import type { KeyType } from '../../../shared/kv.ts';
import { TYPE_INFO } from './lib.ts';

export function TypeBadge({ type, className }: { type: KeyType; className?: string }) {
  const t = TYPE_INFO[type] ?? TYPE_INFO.other;
  return (
    <span
      className={cn('inline-flex h-4 w-11 flex-none items-center justify-center rounded-[4px] font-mono text-[10px] font-medium', className)}
      style={{ color: t.color, background: `color-mix(in srgb, ${t.color} 16%, transparent)` }}
    >
      {t.label}
    </span>
  );
}

/** A dialog over the view: a title, its fields, OK and Cancel. */
export function Dialog({
  title,
  children,
  ok,
  onOk,
  onClose,
  busy,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  ok: string;
  onOk(): void;
  onClose(): void;
  busy?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-black/40 p-6 pt-[10vh] max-sm:p-3 max-sm:pt-6"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className={cn(
          'rounded-surface flex max-h-full flex-col overflow-hidden border border-[var(--node-border)] bg-[var(--node-bg)]',
          wide ? 'w-[min(620px,100%)]' : 'w-[min(440px,100%)]',
        )}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onOk();
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="flex h-10 flex-none items-center border-b border-[var(--node-border)] ps-3 pe-1.5">
          <span className="truncate text-xs font-semibold">{title}</span>
          <ToolButton label="Close" icon={X} className="ms-auto" onClick={onClose} />
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">{children}</div>
        <div className="flex flex-none justify-end gap-1.5 border-t border-[var(--node-border)] px-3 py-2.5">
          <NodeButton variant="ghost" onClick={onClose}>
            Cancel
          </NodeButton>
          <NodeButton type="submit" variant="primary" disabled={busy}>
            {ok}
          </NodeButton>
        </div>
      </form>
    </div>
  );
}

export function Field({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--node-muted)]">{label}</span>
      {children}
      {help && <span className="text-2xs text-[var(--node-muted)]">{help}</span>}
    </label>
  );
}

export const inputClass =
  'rounded-control h-7 border border-transparent bg-[color-mix(in_srgb,var(--node-fg)_6%,transparent)] px-2 font-mono text-xs text-[var(--node-fg)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--node-muted)] hover:bg-[color-mix(in_srgb,var(--node-fg)_9%,transparent)] focus:border-[var(--node-accent)] focus:bg-transparent focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--node-accent)_22%,transparent)] touch:h-9';

export function Muted({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <div className={cn('px-3 py-3 text-xs', error ? 'text-[var(--ansi-1)] select-text' : 'text-[var(--node-muted)]')}>{children}</div>;
}
