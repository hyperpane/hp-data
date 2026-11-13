// A field of the connection form as its type wants it: a switch, a list,
// a text area (a key, a certificate, statements), or a line (a password
// that's saved shows as saved).

import { NodeInput, cn } from '@hyperpane/ui';
import type { Field } from '../../shared/kinds.ts';

export function FieldInput({ f, value, saved, onChange }: { f: Field; value: string | number | boolean | undefined; saved: boolean; onChange(v: string | number | boolean): void }) {
  const cls = 'h-7 w-full';
  if (f.type === 'boolean')
    return (
      <label className="flex h-7 items-center gap-2 text-[12px]">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--node-accent)]" />
        {f.label}
      </label>
    );
  if (f.type === 'textarea')
    return (
      <textarea
        value={value === undefined ? '' : String(value)}
        placeholder={f.secret && saved ? '•••••••• (saved)' : f.placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={String(value ?? '').includes('\n') ? 5 : 2}
        className="w-full resize-y rounded-[5px] border border-[var(--node-border)] bg-[var(--node-bg)] px-2 py-1 font-mono text-[11px] text-[var(--node-fg)] outline-none placeholder:text-[var(--node-muted)] focus:border-[var(--node-accent)]"
      />
    );
  if (f.type === 'select')
    return (
      <select value={String(value ?? f.default ?? '')} onChange={(e) => onChange(e.target.value)} className="h-7 w-full rounded-[5px] border border-[var(--node-border)] bg-[var(--node-bg)] px-1.5 text-[12px] text-[var(--node-fg)] outline-none focus:border-[var(--node-accent)]">
        {f.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  return (
    <NodeInput
      className={cn(cls, f.type !== 'password' && (f.key === 'host' || f.key === 'url' || f.key === 'file' || f.key === 'endpoint' || f.key === 'brokers') && 'font-mono')}
      type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
      value={value === undefined ? '' : String(value)}
      placeholder={f.type === 'password' && saved ? '•••••••• (saved)' : (f.placeholder ?? (f.default !== undefined ? String(f.default) : ''))}
      onChange={(e) => onChange(f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
