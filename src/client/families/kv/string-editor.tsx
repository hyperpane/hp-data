// A string key's value: its text in an editor, pretty JSON when it parses
// as JSON (saved back as compact as it was), and ⌘S or Save to write it.
// RedisJSON documents use it too, always as JSON.

import { useEffect, useMemo, useState } from 'react';
import { NodeButton, Tabs, Toolbar } from '@hyperpane/ui';
import { CodeEditor } from '../../ui/code.tsx';
import { prettyJson } from './lib.ts';

export interface StringEditorProps {
  value: string;
  /** Shown with `\xNN` escapes. */
  binary?: boolean;
  /** Only the start of it was sent. */
  truncated?: boolean;
  size?: number;
  json?: boolean;
  readOnly: boolean;
  onSave(text: string): Promise<boolean>;
  fail(message: string): void;
}

export function StringEditor(p: StringEditorProps) {
  const pretty = useMemo(() => (p.json ? JSON.stringify(JSON.parse(p.value || 'null'), null, 2) : prettyJson(p.value)), [p.value, p.json]);
  const [asJson, setAsJson] = useState(true);
  const showJson = !!pretty && (asJson || !!p.json);
  const shown = showJson ? pretty! : p.value;
  const [draft, setDraft] = useState(shown);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(shown), [shown]);
  const locked = p.readOnly || !!p.truncated;
  const changed = draft !== shown;

  const save = async () => {
    if (locked || !changed || busy) return;
    let text = draft;
    if (showJson) {
      try {
        const v = JSON.parse(draft);
        // As compact as it was, if it was.
        if (!p.json && !p.value.includes('\n')) text = JSON.stringify(v);
      } catch (e) {
        if (p.json) return p.fail(`That isn’t JSON: ${(e as Error).message}`);
      }
    }
    setBusy(true);
    await p.onSave(text);
    setBusy(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar className="gap-2">
        {pretty && !p.json && (
          <Tabs
            variant="pills"
            label="Show the value as"
            value={asJson ? 'json' : 'text'}
            onValueChange={(v) => setAsJson(v === 'json')}
            items={(['text', 'json'] as const).map((v) => ({
              value: v,
              label: v === 'json' ? 'JSON' : 'Text',
              disabled: changed && (v === 'json') !== asJson,
              title: changed ? 'Save or undo the change first' : undefined,
            }))}
          />
        )}
        <span className="min-w-0 truncate text-2xs text-[var(--node-muted)]">
          {p.size !== undefined && `${p.size.toLocaleString()} bytes`}
          {p.binary && ' · not UTF-8: shown with \\xNN escapes, saved as the bytes they stand for'}
          {p.truncated && ' · only the first megabyte is shown, so it can’t be changed here'}
        </span>
        {!locked && (
          <div className="ms-auto flex flex-none gap-1">
            <NodeButton variant="ghost" disabled={!changed || busy} onClick={() => setDraft(shown)}>
              Undo
            </NodeButton>
            <NodeButton variant={changed ? 'primary' : 'default'} disabled={!changed || busy} onClick={() => void save()}>
              {busy ? 'Saving' : 'Save'}
            </NodeButton>
          </div>
        )}
      </Toolbar>
      <CodeEditor
        className="min-h-0 flex-1"
        value={draft}
        onChange={setDraft}
        language={showJson ? 'json' : 'text'}
        readOnly={locked}
        onSave={() => void save()}
        lineNumbers={showJson}
      />
    </div>
  );
}
