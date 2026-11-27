// The connection form, over the window: pick a kind (when none is), then
// its fields, laid out as DataGrip's (host and port side by side, More
// options folded), a pasted connection string filling them in, a name, a
// group and a color, read only, and Test before Save. Secrets saved before
// show as saved; typing one replaces it.

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, X, XCircle } from '@hyperpane/icons';
import { Checkbox, NodeButton, NodeInput, Spinner, Tabs, ToolButton, cn } from '@hyperpane/ui';
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

export function ConnectionDialog({
  target,
  api,
  project,
  onClose,
  onSaved,
}: {
  target: DialogTarget;
  api: Api;
  project: string | null;
  onClose(): void;
  onSaved(c: Connection, connect: boolean): void;
}) {
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

  const input = (): ConnectionInput | null =>
    kind ? { id: c?.id, name: name.trim() || kind.name, kind: kind.id, color, group: group.trim(), readOnly, values, secrets } : null;
  const fields = kind?.fields ?? [];
  const all = { ...values, ...secrets };
  const missing = fields.filter(
    (f) => f.required && !f.secret && shown(f, all, kind!) && (values[f.key] === undefined || values[f.key] === '') && f.default === undefined,
  );
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
    <div
      className="absolute inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 pt-[6vh] backdrop-blur-[2px] max-sm:items-end max-sm:p-0"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={c ? `Edit ${c.name}` : 'New connection'}
        className="rounded-panel flex w-[min(580px,100%)] flex-col overflow-hidden bg-[var(--node-bg)] shadow-dialog ring-1 ring-[var(--data-line-strong)] max-sm:rounded-b-none"
      >
        <div className="flex items-center gap-3 ps-5 pe-3 pt-4 pb-3">
          {kind ? <KindTile kind={kind} size={36} /> : null}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] leading-5 font-semibold tracking-title">{c ? `Edit ${c.name}` : kind ? `New ${kind.name} connection` : 'New connection'}</span>
            <span className="truncate text-xs text-[var(--node-muted)]">{kind ? kind.tagline : 'Pick what you want to connect to'}</span>
          </div>
          <div className="ms-auto flex flex-none items-center gap-1">
            {kind && !c && (
              <NodeButton variant="ghost" onClick={() => setKind(null)}>
                Change
              </NodeButton>
            )}
            <ToolButton label="Close" icon={X} onClick={onClose} />
          </div>
        </div>

        {!kind ? (
          <KindPicker
            onPick={(k) => {
              setKind(k);
              setValues({});
              setSecrets({});
            }}
          />
        ) : (
          <>
            {sections.length > 1 && (
              <Tabs
                label="Settings"
                variant="pills"
                className="mx-5 mb-1 self-start"
                value={section}
                onValueChange={setSection}
                items={sections.map((x) => {
                  const lit =
                    x.id === 'ssh'
                      ? values.sshEnabled === true
                      : x.id === 'tls'
                        ? fields.some((f) => f.section === 'tls' && (values[f.key] || secrets[f.key] || c?.saved.includes(f.key)))
                        : false;
                  return {
                    value: x.id,
                    title: x.label,
                    label: lit ? (
                      <span className="flex items-center gap-1.5">
                        {x.label}
                        <span className="size-1.5 rounded-full bg-[var(--ansi-2)]" />
                      </span>
                    ) : (
                      x.label
                    ),
                  };
                })}
              />
            )}
            <div className="flex max-h-[62vh] flex-col gap-4 overflow-auto px-5 pt-3 pb-5 max-sm:max-h-none">
              {section === 'general' && (
                <div className="grid grid-cols-[1fr_160px] gap-3 max-sm:grid-cols-1">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[var(--node-muted)]">Name</span>
                    <NodeInput autoFocus className="text-[13px]" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind.name} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[var(--node-muted)]">Group</span>
                    <NodeInput className="text-[13px]" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Local, Production" />
                  </label>
                </div>
              )}
              {section === 'general' && kind.schemes && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[var(--node-muted)]">Connection string</span>
                  <NodeInput
                    value={url}
                    onChange={(e) => fromUrl(e.target.value)}
                    placeholder={`${kind.schemes[0]}://user:password@host:port/name  (paste one to fill the fields)`}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                </label>
              )}
              {rows.map((row) => (
                <div
                  key={row.map((f) => f.key).join()}
                  className={cn(
                    'grid gap-3',
                    row.length === 2 ? (row[1].key === 'port' ? 'grid-cols-[1fr_96px]' : 'grid-cols-2 max-sm:grid-cols-1') : 'grid-cols-1',
                  )}
                >
                  {row.map((f) => {
                    const Wrap = f.type === 'boolean' || f.type === 'select' ? 'div' : 'label';
                    return (
                      <Wrap key={f.key} className="flex min-w-0 flex-col gap-1.5">
                        {f.type !== 'boolean' && (
                          <span className="text-xs font-medium text-[var(--node-muted)]">
                            {f.label}
                            {f.required && <span className="text-[var(--ansi-1)]"> *</span>}
                          </span>
                        )}
                        <FieldInput f={f} value={f.secret ? secrets[f.key] : values[f.key]} saved={!!c?.saved.includes(f.key)} onChange={(v) => set(f, v)} />
                        {f.help && <span className="text-xs leading-4 text-[var(--node-muted)]">{f.help}</span>}
                      </Wrap>
                    );
                  })}
                </div>
              ))}
              {section === 'ssh' && values.sshEnabled === true && values.sshHost && (
                <button
                  type="button"
                  className="self-start text-xs text-[var(--node-muted)] underline underline-offset-2 hover:text-[var(--node-fg)]"
                  onClick={() =>
                    void api
                      .call<{ forgotten: boolean }>('forgetSshHost', { host: values.sshHost, port: values.sshPort ?? 22 })
                      .then(
                        (r) =>
                          api.toast(
                            r.forgotten
                              ? `Forgot ${values.sshHost}’s key: the next connection remembers the one it shows`
                              : `No key was remembered for ${values.sshHost}`,
                          ),
                        api.fail,
                      )
                  }
                >
                  Forget this SSH host’s key (after it was reinstalled)
                </button>
              )}
              {section === 'general' && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-1">
                  <Checkbox
                    className="text-[13px]"
                    title="No edits from tables, no writes from consoles (as far as can be told)"
                    checked={readOnly}
                    onCheckedChange={setReadOnly}
                    label="Read only"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[var(--node-muted)]">Color</span>
                    <button
                      type="button"
                      aria-label="No color"
                      onClick={() => setColor(null)}
                      className={cn(
                        'relative size-5 rounded-full ring-1 ring-[var(--data-line-strong)] ring-inset after:absolute after:inset-1 after:rotate-45 after:border-t after:border-[var(--node-muted)] after:content-[""]',
                        color === null && 'ring-2 ring-[var(--node-fg)] ring-offset-2 ring-offset-[var(--node-bg)]',
                      )}
                    />
                    {COLORS.map((x) => (
                      <button
                        key={x}
                        type="button"
                        aria-label={x}
                        onClick={() => setColor(x)}
                        className={cn('size-5 rounded-full transition-transform duration-100 hover:scale-110', color === x && 'ring-2 ring-[var(--node-fg)] ring-offset-2 ring-offset-[var(--node-bg)]')}
                        style={{ background: x }}
                      />
                    ))}
                  </div>
                </div>
              )}
              {section === 'general' && kind.note && <p className="text-xs leading-relaxed text-[var(--node-muted)]">{kind.note}</p>}
            </div>
          </>
        )}

        {kind && (
          <div className="flex flex-col gap-3 border-t border-[var(--data-line)] bg-[var(--data-rail)] px-5 py-3.5">
            {test.state === 'ok' && (
              <div className="rounded-control flex items-center gap-2 bg-[color-mix(in_srgb,var(--data-ok)_10%,transparent)] px-2.5 py-2 text-[13px] ring-1 ring-[color-mix(in_srgb,var(--data-ok)_20%,transparent)] ring-inset">
                <CheckCircle2 className="size-4 flex-none text-[var(--data-ok)]" />
                <span className="min-w-0 truncate">
                  Connected: {test.info?.version}
                  {test.info?.detail ? <span className="text-[var(--node-muted)]"> · {test.info.detail}</span> : null}
                </span>
              </div>
            )}
            {test.state === 'failed' && (
              <div className="rounded-control flex items-start gap-2 bg-[color-mix(in_srgb,var(--data-error)_9%,transparent)] px-2.5 py-2 text-[13px] ring-1 ring-[color-mix(in_srgb,var(--data-error)_20%,transparent)] ring-inset">
                <XCircle className="mt-0.5 size-4 flex-none text-[var(--data-error)]" />
                <span className="min-w-0 break-words whitespace-pre-wrap select-text">{test.error}</span>
              </div>
            )}
            <div data-measure="dialog-foot" className="flex items-center gap-2 max-sm:flex-wrap">
              <NodeButton disabled={test.state === 'testing' || missing.length > 0} onClick={doTest}>
                {test.state === 'testing' && <Spinner size="xs" />}
                Test Connection
              </NodeButton>
              {missing.length > 0 && <span className="min-w-0 truncate text-xs text-[var(--node-muted)]">Fill in {missing.map((f) => f.label).join(', ')}.</span>}
              <div className="ms-auto flex gap-1.5 max-sm:w-full max-sm:justify-end">
                <NodeButton variant="ghost" onClick={onClose}>
                  Cancel
                </NodeButton>
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
