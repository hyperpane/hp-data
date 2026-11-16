// The right side of a keys tab: the selected key's name, type, size and
// TTL (changed, or removed to keep it for good), renamed, deleted, and
// its value in the editor its type needs.

import { useCallback, useEffect, useState } from 'react';
import { Clock, Copy, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { ToolButton, Toolbar } from '@hyperpane/ui';
import type { KvValue } from '../../../shared/kv.ts';
import type { KvEdit } from '../../../shared/kv.ts';
import type { Api } from '../../lib/api.ts';
import { Collection } from './collection.tsx';
import { type Calls, TYPE_NAMES, attempt, parseTtl, ttlText } from './lib.ts';
import { Muted, TypeBadge } from './parts.tsx';
import { StringEditor } from './string-editor.tsx';

const LIMIT = 200;

export interface KeyPanelProps {
  calls: Calls;
  api: Api;
  keyName: string;
  readOnly: boolean;
  onRemoved(key: string): void;
  onRenamed(from: string, to: string): void;
  onTtl(key: string, ttl: number): void;
  /** The connection keeps strings only (etcd). */
  stringsOnly: boolean;
}

export function KeyPanel(p: KeyPanelProps) {
  const { calls, api, keyName: key } = p;
  const [value, setValue] = useState<KvValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (at = offset) => {
      setLoading(true);
      try {
        const v = await calls.call<KvValue>('kvGet', { key, offset: at, limit: LIMIT });
        setValue(v);
        setError(null);
        p.onTtl(key, v.ttl);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [calls, key, offset],
  );

  useEffect(() => {
    setValue(null);
    setOffset(0);
    void load(0);
  }, [key, calls.db]);

  const edit = async (op: KvEdit) => {
    const ok = await attempt(api, () => calls.call('kvEdit', { key, op }));
    if (ok) await load();
    return ok;
  };

  const ttl = async () => {
    const now = value && value.ttl >= 0 ? String(value.ttl) : '';
    const typed = await api.prompt('Time to live', 'Seconds, or 15m, 2h, 7d. Empty: kept for good.', now, 'kept for good');
    if (typed === null) return;
    const n = typed.trim() ? parseTtl(typed) : null;
    if (typed.trim() && n === null) return api.fail(`“${typed}” isn’t a time: try 90, 15m, 2h or 7d`);
    if (await attempt(api, () => calls.call('kvExpire', { key, ttl: n }))) await load();
  };

  const rename = async () => {
    const to = await api.prompt('Rename the key', 'New name', key);
    if (!to || to === key) return;
    if (await attempt(api, () => calls.call('kvRename', { key, to }))) p.onRenamed(key, to);
  };

  const remove = async () => {
    if (!(await api.confirm('Delete the key?', `“${key}” and its value will be gone`, 'Delete', true))) return;
    if (await attempt(api, () => calls.call('kvRemove', { keys: [key] }))) p.onRemoved(key);
  };

  const removePart = async (what: string, op: KvEdit) => {
    if (await api.confirm(`Remove ${what}?`, `From “${key}”`, 'Remove', true)) await edit(op);
  };

  const length = value && 'total' in value ? value.total : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Toolbar className="gap-2">
        {value && <TypeBadge type={value.type} />}
        <span className="min-w-0 truncate font-mono text-[12px] select-text" title={key}>
          {key}
        </span>
        <ToolButton label="Copy the name" icon={Copy} onClick={() => api.copy(key, 'the key’s name')} />
        <span className="flex-none text-[10.5px] text-[var(--node-muted)]">
          {value && TYPE_NAMES[value.type]}
          {length !== null &&
            ` · ${length.toLocaleString()} ${value?.type === 'hash' ? 'fields' : value?.type === 'stream' ? 'entries' : value?.type === 'list' ? 'items' : 'members'}`}
        </span>
        <div className="ml-auto flex flex-none items-center gap-0.5">
          {value && (
            <button
              type="button"
              disabled={p.readOnly}
              onClick={() => void ttl()}
              title={p.readOnly ? undefined : 'Change the TTL'}
              className="mr-1 inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11px] text-[var(--node-muted)] enabled:hover:bg-[var(--node-hover)] enabled:hover:text-[var(--node-fg)]"
            >
              <Clock className="size-3" />
              {value.ttl >= 0 ? `TTL ${ttlText(value.ttl)}` : 'No TTL'}
            </button>
          )}
          <ToolButton label="Read it again" icon={RefreshCw} onClick={() => void load()} />
          {!p.readOnly && <ToolButton label="Rename" icon={Pencil} onClick={() => void rename()} />}
          {!p.readOnly && <ToolButton label="Delete" icon={Trash2} onClick={() => void remove()} />}
        </div>
      </Toolbar>
      {value?.meta && (
        <div className="flex flex-none flex-wrap gap-x-3 border-b border-[var(--node-border)] px-2 py-1 text-[10.5px] text-[var(--node-muted)]">
          {Object.entries(value.meta).map(([k, v]) => (
            <span key={k}>
              {k} <span className="text-[var(--node-fg)]">{v}</span>
            </span>
          ))}
        </div>
      )}
      {error ? (
        <Muted error>{error}</Muted>
      ) : !value ? (
        <Muted>{loading ? 'Reading' : ''}</Muted>
      ) : value.type === 'string' || value.type === 'json' ? (
        <StringEditor
          key={`${key}:${value.type}`}
          value={value.type === 'string' ? value.value : JSON.stringify(value.value)}
          json={value.type === 'json'}
          binary={value.type === 'string' && value.binary}
          truncated={value.truncated}
          size={value.size}
          readOnly={p.readOnly}
          fail={(m) => api.fail(m)}
          onSave={async (text) => {
            const v = value.type === 'json' ? { type: 'json', value: JSON.parse(text) } : { type: 'string', value: text, binary: value.binary };
            const ok = await attempt(api, () => calls.call('kvSet', { key, value: v }), 'Saved.');
            if (ok) await load();
            return ok;
          }}
        />
      ) : value.type === 'other' ? (
        <Muted>{value.value}</Muted>
      ) : (
        <Collection
          value={value}
          offset={offset}
          limit={LIMIT}
          onPage={(o) => {
            setOffset(o);
            void load(o);
          }}
          readOnly={p.readOnly || p.stringsOnly}
          edit={edit}
          remove={(what, op) => void removePart(what, op)}
          copy={api.copy}
          fail={(m) => api.fail(m)}
        />
      )}
    </div>
  );
}
