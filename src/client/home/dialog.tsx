// The connection form, over the window: pick a kind (when none is), then
// its fields, laid out as DataGrip's (host and port side by side, More
// options folded), a pasted connection string filling them in, a name, a
// group and a color, read only, and Test before Save. Secrets saved before
// show as saved; typing one replaces it.

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, X, XCircle } from 'lucide-react';
import { Checkbox, NodeButton, NodeInput, Tabs, cn } from '@hyperpane/ui';
import { type Field, type Kind, type Values, kindOf, parseUrl, shown } from '../../shared/kinds.ts';
import type { Connection, ConnectionInput, SessionInfo } from '../../shared/types.ts';
import type { Api } from '../lib/api.ts';
import { KindTile } from '../ui/parts.tsx';
import { FieldInput } from './fields.tsx';
import { KindPicker } from './kind-picker.tsx';

type Section = 'general' | 'ssh' | 'tls' | 'options';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ssh', label: 'SSH' },
  { id: 'tls', label: 'SSL/TLS' },
  { id: 'options', label: 'Options' },
];

const sectionOf = (f: Field): Section => f.section ?? (f.advanced ? 'options' : 'general');

const COLORS = ['#3fb950', '#58a6ff', '#d29922', '#f85149', '#bc8cff', '#f778ba', '#2bc3a6'];

export interface DialogTarget {
  kind: Kind | null;
  connection?: Connection;
}

export function ConnectionDialog({ target, api, project, onClose, onSaved }: { target: DialogTarget; api: Api; project: string | null; onClose(): void; onSaved(c: Connection, connect: boolean): void }) {
  const [kind, setKind] = useState<Kind | null>(target.kind);
  const c = target.connection;
  const [name, setName] = useState(c?.name ?? '');
  const [group, setGroup] = useState(c?.group ?? '');
  const [color, setColor] = useState<string | null>(c?.color ?? null);
  const [readOnly, setReadOnly] = useState(c?.readOnly ?? false);
  const [values, setValues] = useState<Values>(c?.values ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [section, setSection] = useState<Section>('general');
  const [url, setUrl] = useState('');
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'failed'; info?: Omit<SessionInfo, 'at'>; error?: string }>({ state: 'idle' });
  const [saving, setSaving] = useState(false);

  useEffect(() => setTest({ state: 'idle' }), [values, secrets, kind]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const input = (): ConnectionInput | null => (kind ? { id: c?.id, name: name.trim() || kind.name, kind: kind.id, color, group: group.trim(), readOnly, values, secrets } : null);
  const fields = kind?.fields ?? [];
  const all = { ...values, ...secrets };
  const missing = fields.filter((f) => f.required && !f.secret && shown(f, all, kind!) && (values[f.key] === undefined || values[f.key] === '') && f.default === undefined);
  const sections = SECTIONS.filter((x) => x.id === 'general' || fields.some((f) => sectionOf(f) === x.id));

  const doTest = async () => {
    const i = input();
    if (!i) return;
    setTest({ state: 'testing' });
    try {
      const info = await api.call<Omit<SessionInfo, 'at'>>('test', { connection: i, project });
      setTest({ state: 'ok', info });
    } catch (e) {
      setTest({ state: 'failed', error: (e as Error).message });
    }
  };

  const doSave = async (connect: boolean) => {
    const i = input();
    if (!i) return;
    setSaving(true);
    try {
      const saved = await api.call<Connection>('save', { connection: i });
      onSaved(saved, connect);
    } catch (e) {
      api.fail(e);
      setSaving(false);
    }
  };

  const fromUrl = (text: string) => {
    setUrl(text);
    if (!kind) return;
    const v = parseUrl(kind, text);
    if (!v) return;
    const { password, uri, ...rest } = v as Values & { password?: string; uri?: string };
    setValues((old) => ({ ...old, ...rest }));
    if (password) setSecrets((s) => ({ ...s, password: String(password) }));
    if (uri) setSecrets((s) => ({ ...s, uri: String(uri) }));
  };

  const set = (f: Field, v: string | number | boolean) => {
    if (f.secret) setSecrets((s) => ({ ...s, [f.key]: String(v) }));
    else setValues((old) => ({ ...old, [f.key]: v }));
  };

  const rows = useMemo(() => {
    const visible = fields.filter((f) => sectionOf(f) === section && shown(f, { ...values, ...secrets }, kind!));
    const out: Field[][] = [];
    for (let i = 0; i < visible.length; i++) {
      const f = visible[i];
      if (f.half && visible[i + 1]?.half) {
        out.push([f, visible[i + 1]]);
        i++;
      } else out.push([f]);
    }
    return out;
  }, [kind, section, values, secrets]);


  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center overflow-auto bg-black/45 p-4 pt-[6vh]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex w-[min(560px,100%)] flex-col overflow-hidden rounded-[11px] border border-[var(--node-border)] bg-[var(--node-bg)] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-[var(--node-border)] px-4 py-3">
          {kind ? <KindTile kind={kind} size={30} /> : null}
          <div className="flex min-w-0 flex-col">
            <span className="text-[13px] font-semibold">{c ? `Edit ${c.name}` : kind ? `New ${kind.name} connection` : 'New connection'}</span>
            <span className="truncate text-[11px] text-[var(--node-muted)]">{kind ? kind.tagline : 'Pick what you want to connect to'}</span>
          </div>
          {kind && !c && (
            <NodeButton className="ml-auto" onClick={() => setKind(null)}>
              Change
            </NodeButton>
          )}
          <button type="button" aria-label="Close" onClick={onClose} className={cn('flex size-6 items-center justify-center rounded-[5px] text-[var(--node-muted)] hover:text-[var(--node-fg)]', !(kind && !c) && 'ml-auto')}>
            <X className="size-4" />
          </button>
        </div>

        {!kind ? (
          <KindPicker onPick={(k) => (setKind(k), setValues({}), setSecrets({}))} />
        ) : (
          <>
          {sections.length > 1 && (
            <Tabs
              label="Settings"
              className="px-3"
              value={section}
              onValueChange={setSection}
              items={sections.map((x) => {
                const lit = x.id === 'ssh' ? values.sshEnabled === true : x.id === 'tls' ? fields.some((f) => f.section === 'tls' && (values[f.key] || secrets[f.key] || c?.saved.includes(f.key))) : false;
                return { value: x.id, title: x.label, label: lit ? <span className="flex items-center gap-1.5">{x.label}<span className="size-1.5 rounded-full bg-[#3fb950]" /></span> : x.label };
              })}
            />
          )}
          <div className="flex max-h-[62vh] flex-col gap-3 overflow-auto p-4">
            {section === 'general' && (
            <div className="grid grid-cols-[1fr_150px] gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--node-muted)]">Name</span>
                <NodeInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind.name} className="h-7" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--node-muted)]">Group</span>
                <NodeInput value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Local, Production…" className="h-7" />
              </label>
            </div>
            )}
            {section === 'general' && kind.schemes && (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--node-muted)]">Connection string</span>
                <NodeInput value={url} onChange={(e) => fromUrl(e.target.value)} placeholder={`${kind.schemes[0]}://user:password@host:port/…  (paste one to fill the fields)`} className="h-7 font-mono" spellCheck={false} />
              </label>
            )}
            {rows.map((row) => (
              <div key={row.map((f) => f.key).join()} className={cn('grid gap-2', row.length === 2 ? (row[1].key === 'port' ? 'grid-cols-[1fr_96px]' : 'grid-cols-2') : 'grid-cols-1')}>
                {row.map((f) => {
                  const Wrap = f.type === 'boolean' || f.type === 'select' ? 'div' : 'label';
                  return (
                  <Wrap key={f.key} className="flex min-w-0 flex-col gap-1">
                    {f.type !== 'boolean' && (
                      <span className="text-[11px] text-[var(--node-muted)]">
                        {f.label}
                        {f.required && <span className="text-[#f85149]"> *</span>}
                      </span>
                    )}
                    <FieldInput f={f} value={f.secret ? secrets[f.key] : values[f.key]} saved={!!c?.saved.includes(f.key)} onChange={(v) => set(f, v)} />
                    {f.help && <span className="text-[10.5px] text-[var(--node-muted)]">{f.help}</span>}
                  </Wrap>
                  );
                })}
              </div>
            ))}
            {section === 'ssh' && values.sshEnabled === true && values.sshHost && (
              <button
                type="button"
                className="self-start text-[11px] text-[var(--node-muted)] underline hover:text-[var(--node-fg)]"
                onClick={() =>
                  void api.call<{ forgotten: boolean }>('forgetSshHost', { host: values.sshHost, port: values.sshPort ?? 22 }).then(
                    (r) => api.toast(r.forgotten ? `Forgot ${values.sshHost}’s key: the next connection remembers the one it shows.` : `No key was remembered for ${values.sshHost}.`),
                    api.fail,
                  )
                }
              >
                Forget this SSH host’s key (after it was reinstalled)
              </button>
            )}
            {section === 'general' && (
            <div className="flex flex-wrap items-center gap-4 border-t border-[var(--node-border)] pt-3">
              <Checkbox className="text-[12px]" title="No edits from tables, no writes from consoles (as far as can be told)" checked={readOnly} onCheckedChange={setReadOnly} label="Read only" />
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-[var(--node-muted)]">Color</span>
                <button type="button" aria-label="No color" onClick={() => setColor(null)} className={cn('size-4 rounded-full border border-[var(--node-border)]', color === null && 'ring-2 ring-[var(--node-accent)] ring-offset-1 ring-offset-[var(--node-bg)]')} />
                {COLORS.map((x) => (
                  <button key={x} type="button" aria-label={x} onClick={() => setColor(x)} className={cn('size-4 rounded-full', color === x && 'ring-2 ring-[var(--node-fg)] ring-offset-1 ring-offset-[var(--node-bg)]')} style={{ background: x }} />
                ))}
              </div>
            </div>
            )}
            {section === 'general' && kind.note && <p className="text-[11px] text-[var(--node-muted)]">{kind.note}</p>}
          </div>
          </>
        )}

        {kind && (
          <div className="flex flex-col gap-2 border-t border-[var(--node-border)] px-4 py-3">
            {test.state === 'ok' && (
              <div className="flex items-center gap-2 text-[11.5px] text-[#3fb950]">
                <CheckCircle2 className="size-4 flex-none" />
                <span>
                  Connected: {test.info?.version}
                  {test.info?.detail ? <span className="text-[var(--node-muted)]"> · {test.info.detail}</span> : null}
                </span>
              </div>
            )}
            {test.state === 'failed' && (
              <div className="flex items-start gap-2 text-[11.5px] text-[#f85149]">
                <XCircle className="mt-px size-4 flex-none" />
                <span className="break-words whitespace-pre-wrap select-text">{test.error}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <NodeButton disabled={test.state === 'testing' || missing.length > 0} onClick={doTest}>
                {test.state === 'testing' && <LoaderCircle className="size-3.5 animate-spin" />}
                Test Connection
              </NodeButton>
              {missing.length > 0 && <span className="text-[11px] text-[var(--node-muted)]">Fill in {missing.map((f) => f.label).join(', ')}.</span>}
              <div className="ml-auto flex gap-2">
                <NodeButton onClick={onClose}>Cancel</NodeButton>
                {!c && (
                  <NodeButton disabled={saving || missing.length > 0} onClick={() => doSave(false)}>
                    Save
                  </NodeButton>
                )}
                <NodeButton variant="primary" disabled={saving || missing.length > 0} onClick={() => doSave(true)}>
                  {c ? 'Save' : 'Save and Connect'}
                </NodeButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const kindFor = (c: Connection) => kindOf(c.kind);
