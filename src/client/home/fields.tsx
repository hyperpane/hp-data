// A field of the connection form as its type wants it: a checkbox, a
// list (the kit's Picker), a text area (a key, a certificate, statements),
// or a line (a password that's saved shows as saved).

import { Checkbox, NodeInput, Picker, cn } from '@hyperpane/ui';
import type { Field } from '../../shared/kinds.ts';
import { codeArea, softField } from '../ui/parts.tsx';

export function FieldInput({
  f,
  value,
  saved,
  onChange,
}: {
  f: Field;
  value: string | number | boolean | undefined;
  saved: boolean;
  onChange(v: string | number | boolean): void;
}) {
  const cls = 'h-7 w-full';
  if (f.type === 'boolean') return <Checkbox className="h-7 text-xs" checked={value === true} onCheckedChange={onChange} label={f.label} />;
  if (f.type === 'textarea')
    return (
      <textarea
        value={value === undefined ? '' : String(value)}
        placeholder={f.secret && saved ? '•••••••• (saved)' : f.placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={String(value ?? '').includes('\n') ? 5 : 2}
        className={cn(codeArea, 'block w-full resize-y')}
      />
    );
  if (f.type === 'select')
    return (
      <Picker
        size="sm"
        className={cn('w-full', softField)}
        label={f.label}
        value={String(value ?? f.default ?? '')}
        options={f.options ?? []}
        onValueChange={onChange}
      />
    );
  return (
    <NodeInput
      className={cn(
        cls,
        f.type !== 'password' && (f.key === 'host' || f.key === 'url' || f.key === 'file' || f.key === 'endpoint' || f.key === 'brokers') && 'font-mono',
      )}
      type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
      value={value === undefined ? '' : String(value)}
      placeholder={f.type === 'password' && saved ? '•••••••• (saved)' : (f.placeholder ?? (f.default !== undefined ? String(f.default) : ''))}
      onChange={(e) => onChange(f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
