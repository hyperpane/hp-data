// The window, laid out as DataGrip's: the Explorer on the left (every
// connection and what's in it), the tabs on the right (Home first, then
// consoles, tables, keys, collections, topics, buckets), and the
// connection form over it all when one is added or edited.

import { useRef, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { NodeMessage, ResizeHandle, ToolButton, useResizable } from '@hyperpane/ui';
import { type Kind, kindOf } from '../../shared/kinds.ts';
import type { Connection } from '../../shared/types.ts';
import { type ExplorerHandle, Explorer } from '../explorer/tree.tsx';
import { FAMILIES } from '../families/index.ts';
import { ConnectionDialog, type DialogTarget } from '../home/dialog.tsx';
import { Home } from '../home/home.tsx';
import type { ConnectionOps } from '../home/menu.ts';
import { useKept, useWidth } from '../lib/hooks.ts';
import { TabStrip } from './tab-strip.tsx';
import type { Tab } from './tabs.ts';
import { useWorkspace } from './workspace.ts';

export function DataView() {
  const w = useWorkspace();
  const { api, project, state, error, tabs, active } = w;
  const [sideOpen, setSideOpen] = useKept('data.sideOpen', true);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const explorer = useRef<ExplorerHandle | null>(null);
  const consoles = useRef(0);
  const [box, width] = useWidth<HTMLDivElement>();
  const side = useResizable({ id: 'data.sidebar', initial: 260, min: 180, max: () => (width ? Math.max(240, width - 320) : Infinity), axis: 'x' });

  const firstTab = (c: Connection) => {
    const kind = kindOf(c.kind);
    if (!kind) return;
    if (kind.family === 'sql') w.open({ key: `${c.id}:console:main`, type: 'console', conn: c.id, ref: c.values.database ? { database: String(c.values.database) } : {}, title: c.name });
    else if (kind.family === 'kv') w.open({ type: 'keys', conn: c.id, ref: { database: String(c.values.db ?? 0) }, title: kind.engine === 'redis' ? `db${c.values.db ?? 0}` : c.name });
    else if (kind.family === 'object' && c.values.bucket) w.open({ type: 'bucket', conn: c.id, ref: { bucket: String(c.values.bucket) }, title: String(c.values.bucket) });
  };

  const ops: ConnectionOps = {
    openConnection(c) {
      if (!sideOpen) setSideOpen(true);
      explorer.current?.reveal(c.id);
      firstTab(c);
    },
    connect(c) {
      explorer.current?.reveal(c.id);
    },
    disconnect(c) {
      void api.call('disconnect', { id: c.id }).catch(api.fail);
    },
    newConsole(c) {
      const kind = kindOf(c.kind);
      if (!kind) return;
      consoles.current++;
      const n = tabs.filter((t) => t.conn === c.id && t.type === 'console').length + 1;
      w.open({ key: `${c.id}:console:${Date.now().toString(36)}${consoles.current}`, type: 'console', conn: c.id, ref: c.values.database ? { database: String(c.values.database) } : {}, title: n > 1 ? `${c.name} (${n})` : c.name });
    },
    edit(c) {
      setDialog({ kind: kindOf(c.kind) ?? null, connection: c });
    },
    duplicate(c) {
      void api.call<Connection>('duplicate', { id: c.id }).then((d) => setDialog({ kind: kindOf(d.kind) ?? null, connection: d }), api.fail);
    },
    async remove(c) {
      if (!(await api.confirm(`Remove ${c.name}?`, 'Its settings and saved password go from this server. Nothing in the database changes.', 'Remove', true))) return;
      w.closeConnection(c.id);
      await api.call('remove', { id: c.id }).catch(api.fail);
    },
    pickKind() {
      setDialog({ kind: null });
    },
  };

  if (error && !state) return <NodeMessage error>{error}</NodeMessage>;

  const narrow = width > 0 && width < 640;
  const showSide = sideOpen && !narrow;

  const body = (t: Tab) => {
    if (t.type === 'home') return <Home state={state} ops={ops} onAdd={(k: Kind) => setDialog({ kind: k })} />;
    const c = w.connection(t.conn);
    const kind = w.kindOf(c);
    if (!c || !kind) return <NodeMessage>{state ? 'This connection was removed.' : 'Loading…'}</NodeMessage>;
    const View = FAMILIES[kind.family].views[t.type];
    if (!View) return <NodeMessage error>{kind.name} has no “{t.type}” tab.</NodeMessage>;
    return (
      <View
        tab={t}
        connection={c}
        kind={kind}
        api={api}
        project={project}
        readOnly={c.readOnly}
        visible={t.key === active.key}
        setState={(patch) => w.setTabState(t.key, patch)}
        open={w.open}
        retitle={(title) => w.retitle(t.key, title)}
      />
    );
  };

  return (
    <div ref={box} className="relative flex h-full min-w-0 text-xs text-[var(--node-fg)]">
      {showSide && (
        <>
          <aside className="flex min-h-0 flex-none flex-col" style={{ width: side.size }}>
            <Explorer state={state} api={api} project={project} ops={ops} open={w.open} handle={explorer} activeConn={active.conn} />
          </aside>
          <ResizeHandle axis="x" dragging={side.dragging} {...side.handleProps} />
        </>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabStrip
          tabs={tabs}
          active={active.key}
          connection={w.connection}
          onActivate={w.activate}
          onClose={w.close}
          onCloseOthers={w.closeOthers}
          onCloseConnection={w.closeConnection}
          left={!narrow && <div className="flex flex-none items-center border-r border-[var(--node-border)] px-1">{<ToolButton label={sideOpen ? 'Hide the Explorer' : 'Show the Explorer'} icon={PanelLeft} active={sideOpen} onClick={() => setSideOpen(!sideOpen)} />}</div>}
        />
        <div className="relative min-h-0 flex-1">
          {tabs.map((t) => (
            <div key={t.key} className="absolute inset-0 flex flex-col" style={{ display: t.key === active.key ? 'flex' : 'none' }}>
              {body(t)}
            </div>
          ))}
        </div>
      </main>
      {dialog && (
        <ConnectionDialog
          target={dialog}
          api={api}
          project={project}
          onClose={() => setDialog(null)}
          onSaved={(c, connect) => {
            setDialog(null);
            if (connect) ops.openConnection(c);
            else if (dialog.connection) explorer.current?.refresh(c.id);
          }}
        />
      )}
    </div>
  );
}
