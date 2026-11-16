// Small parts of the kv views: a type's badge, a dialog over the view,
// a labelled field in one, and an empty or loading message.

import { X } from 'lucide-react';
import { NodeButton, cn } from '@hyperpane/ui';
import type { KeyType } from '../../../shared/kv.ts';
import { TYPE_INFO } from './lib.ts';

export function TypeBadge({ type, className }: { type: KeyType; className?: string }) {
  const t = TYPE_INFO[type] ?? TYPE_INFO.other;
  return (
    <span
      className={cn(
        'inline-flex h-[15px] w-[42px] flex-none items-center justify-center rounded-[3px] font-mono text-[9px] font-semibold tracking-wide',
        className,
      )}
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
      className="absolute inset-0 z-40 flex items-start justify-center bg-black/40 p-6 pt-[10vh]"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className={cn(
          'flex max-h-full flex-col overflow-hidden rounded-lg border border-[var(--node-border)] bg-[var(--node-bg)] shadow-2xl',
          wide ? 'w-[min(620px,100%)]' : 'w-[min(440px,100%)]',
        )}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onOk();
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="flex h-9 flex-none items-center border-b border-[var(--node-border)] px-3">
          <span className="font-medium">{title}</span>
          <button type="button" aria-label="Close" className="ml-auto text-[var(--node-muted)] hover:text-[var(--node-fg)]" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">{children}</div>
        <div className="flex flex-none justify-end gap-1 border-t border-[var(--node-border)] px-3 py-2">
          <NodeButton onClick={onClose}>Cancel</NodeButton>
          <NodeButton type="submit" disabled={busy} className="border-[var(--node-accent)] text-[var(--node-accent)]">
            {ok}
          </NodeButton>
        </div>
      </form>
    </div>
  );
}

export function Field({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-[var(--node-muted)]">{label}</span>
      {children}
      {help && <span className="text-[10.5px] text-[var(--node-muted)]">{help}</span>}
    </label>
  );
}

export const inputClass =
  'h-7 rounded-[5px] border border-[var(--node-border)] bg-transparent px-2 font-mono text-[12px] text-[var(--node-fg)] outline-none focus:border-[var(--node-accent)]';

export function Muted({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <div className={cn('px-3 py-3 text-[11.5px]', error ? 'text-[#f85149]' : 'text-[var(--node-muted)]')}>{children}</div>;
}
