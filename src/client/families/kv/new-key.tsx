// "New key…": its type, its name, what it holds first (a type keeps
// nothing empty), and a TTL; refused when a key of that name is there.

import { useState } from 'react';
import { Tabs, cn } from '@hyperpane/ui';
import { NEW_KEY_TYPES } from '../../../shared/kv.ts';
import type { KeyEntry, KeyType, KeyValue } from '../../../shared/kv.ts';
import type { Api } from '../../lib/api.ts';
import { type Calls, TYPE_NAMES, attempt, parseTtl } from './lib.ts';
import { Dialog, Field, inputClass } from './parts.tsx';

type NewType = (typeof NEW_KEY_TYPES)[number];

export function NewKey({
  calls,
  api,
  stringsOnly,
  prefix,
  onClose,
  onCreated,
}: {
  calls: Calls;
  api: Api;
  stringsOnly: boolean;
  prefix: string;
  onClose(): void;
  onCreated(e: KeyEntry): void;
}) {
  const [type, setType] = useState<NewType>('string');
  const [name, setName] = useState(prefix);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [ttl, setTtl] = useState('');
  const [busy, setBusy] = useState(false);

  const value = (): KeyValue | string => {
    switch (type) {
      case 'string':
        return { type, value: a };
      case 'hash':
        return a ? { type, fields: [{ field: a, value: b }], total: 1 } : 'Give the first field a name';
      case 'list':
        return { type, items: [a], total: 1 };
      case 'set':
        return a ? { type, members: [a], total: 1 } : 'Type the first member';
      case 'zset': {
        const score = Number(b.trim() || '0');
        if (!a) return 'Type the first member';
        return Number.isFinite(score) ? { type, members: [{ member: a, score }], total: 1 } : 'A score is a number';
      }
      case 'stream':
        return a ? { type, entries: [{ id: '*', fields: { [a]: b } }], total: 1 } : 'Give the first entry a field';
    }
  };

  const create = async () => {
    if (!name) return api.fail('Give the key a name');
    const v = value();
    if (typeof v === 'string') return api.fail(v);
    const seconds = ttl.trim() ? parseTtl(ttl) : null;
    if (ttl.trim() && seconds === null) return api.fail(`“${ttl}” isn’t a time: try 90, 15m, 2h or 7d`);
    setBusy(true);
    const ok = await attempt(api, () => calls.call('kvSet', { key: name, value: v, ttl: seconds, create: true }));
    setBusy(false);
    if (ok) onCreated({ key: name, type: type as KeyType, ttl: seconds ?? -1 });
  };

  const labels: Record<NewType, [string, string?]> = {
    string: ['Value'],
    hash: ['First field', 'Its value'],
    list: ['First item'],
    set: ['First member'],
    zset: ['First member', 'Its score'],
    stream: ['First entry’s field', 'Its value'],
  };
  const [la, lb] = labels[type];

  return (
    <Dialog title="New key" ok={busy ? 'Adding' : 'Add'} onOk={() => void create()} onClose={onClose} busy={busy}>
      {!stringsOnly && (
        <Field label="Type">
          <Tabs
            variant="pills"
            label="Type"
            className="self-start"
            value={type}
            onValueChange={setType}
            items={NEW_KEY_TYPES.map((t) => ({ value: t, label: TYPE_NAMES[t] }))}
          />
        </Field>
      )}
      <Field label="Name">
        <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="user:42" />
      </Field>
      <Field label={la}>
        {type === 'string' ? (
          <textarea className={cn(inputClass, 'h-24 resize-y py-1')} value={a} onChange={(e) => setA(e.target.value)} spellCheck={false} />
        ) : (
          <input className={inputClass} value={a} onChange={(e) => setA(e.target.value)} spellCheck={false} />
        )}
      </Field>
      {lb && (
        <Field label={lb}>
          <input className={inputClass} value={b} onChange={(e) => setB(e.target.value)} spellCheck={false} placeholder={type === 'zset' ? '0' : ''} />
        </Field>
      )}
      <Field label="TTL" help="Seconds, or 15m, 2h, 7d. Empty: kept for good.">
        <input className={cn(inputClass, 'w-32')} value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="none" />
      </Field>
    </Dialog>
  );
}
