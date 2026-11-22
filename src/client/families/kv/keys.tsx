// A keys tab, as Redis Insight has it: the keys matching a pattern on the
// left, the selected one's value on the right (one at a time when narrow,
// with a way back to the keys). The pattern, the tree or flat choice and
// the selected key are kept with the tab.

import { useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { NodeButton, PaneBar, SplitPane, useSplitCompact } from '@hyperpane/ui';
import type { TabProps } from '../../app/tabs.ts';
import { KeyList } from './key-list.tsx';
import { KeyPanel } from './key-panel.tsx';
import { attempt, callsOf } from './lib.ts';
import { NewKey } from './new-key.tsx';
import { useScan } from './use-scan.ts';

export function KeysView(p: TabProps) {
  const { tab, api, readOnly } = p;
  const st = (tab.state ?? {}) as { pattern?: string; tree?: boolean; selected?: string | null; newKey?: boolean };
  const db = tab.ref.database;
  const calls = useMemo(() => callsOf(p, db), [p.connection.id, p.project, db, api]);
  const [pattern, setPattern] = useState(st.pattern ?? tab.ref.pattern ?? (tab.ref.prefix ? `${tab.ref.prefix}*` : '*'));
  const [tree, setTree] = useState(st.tree ?? true);
  const [selected, setSelected] = useState<string | null>(st.selected ?? null);
  const [adding, setAdding] = useState(!!st.newKey && !readOnly);
  const scan = useScan(calls, pattern, Number(p.connection.values.scanCount ?? 200));
  const stringsOnly = p.kind.engine === 'etcd';

  const select = (key: string | null) => {
    setSelected(key);
    p.setState({ selected: key });
  };

  const remove = async (keys: string[]) => {
    const what = keys.length === 1 ? `“${keys[0]}”` : `${keys.length} keys`;
    if (!(await api.confirm('Delete?', `${what} and ${keys.length === 1 ? 'its value' : 'their values'} will be gone`, 'Delete', true))) return;
    if (await attempt(api, () => calls.call('kvRemove', { keys }))) {
      scan.drop(keys);
      if (selected && keys.includes(selected)) select(null);
    }
  };

  const literalPrefix = /^[^*?[\\]*/.exec(pattern)?.[0] ?? '';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col text-[12px]">
      <SplitPane
        id={`kv.keys.${p.connection.id}`}
        direction="row"
        initial={340}
        min={200}
        minOther={200}
        compactBelow={640}
        show={selected ? 'second' : 'first'}
        first={
          <KeyList
            scan={scan}
            pattern={pattern}
            onPattern={(pt) => {
              setPattern(pt);
              p.setState({ pattern: pt });
            }}
            tree={tree}
            onTree={(t) => {
              setTree(t);
              p.setState({ tree: t });
            }}
            selected={selected}
            onSelect={select}
            onNew={readOnly ? undefined : () => setAdding(true)}
            onRemove={readOnly ? undefined : (ks) => void remove(ks)}
            copy={api.copy}
          />
        }
        second={
          selected ? (
            <>
              <BackToKeys onBack={() => select(null)} />
              <KeyPanel
                key={selected}
                calls={calls}
                api={api}
                keyName={selected}
                readOnly={readOnly}
                stringsOnly={stringsOnly}
                onRemoved={(k) => {
                  scan.drop([k]);
                  select(null);
                }}
                onRenamed={(from, to) => {
                  scan.renamed(from, to);
                  select(to);
                }}
                onTtl={(k, ttl) => scan.patch(k, { ttl })}
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--node-muted)]">
              <KeyRound className="size-6 opacity-50" />
              <span>Pick a key to see its value</span>
              {!readOnly && <NodeButton onClick={() => setAdding(true)}>New key</NodeButton>}
            </div>
          )
        }
      />
      {adding && (
        <NewKey
          calls={calls}
          api={api}
          stringsOnly={stringsOnly}
          prefix={literalPrefix}
          onClose={() => {
            setAdding(false);
            if (st.newKey) p.setState({ newKey: false });
          }}
          onCreated={(e) => {
            setAdding(false);
            if (st.newKey) p.setState({ newKey: false });
            scan.added(e);
            select(e.key);
          }}
        />
      )}
    </div>
  );
}

/** The way back to the keys, over a key shown alone. */
function BackToKeys({ onBack }: { onBack(): void }) {
  return useSplitCompact() ? <PaneBar onBack={onBack} backLabel="Keys" /> : null;
}
