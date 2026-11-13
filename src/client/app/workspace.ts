// The window's state: the saved connections and their sessions (watched
// from the server part), the open tabs and which one is shown. The tabs
// are the window's data (in the project, so the window opens as it was
// left); what a tab keeps (a console's text) stays in this browser, as a
// draft would.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useHost, useProject, useWindow } from '@hyperpane/sdk/client';
import type { Kind } from '../../shared/kinds.ts';
import { kindOf } from '../../shared/kinds.ts';
import type { Connection, State } from '../../shared/types.ts';
import { type Api, makeApi } from '../lib/api.ts';
import { read } from '../lib/hooks.ts';
import { type NewTab, type Tab, tabKey } from './tabs.ts';

export const HOME: Tab = { key: 'home', type: 'home', conn: null, ref: {}, title: 'Home' };

const MAX_TABS = 40;

function parseTabs(s: string | undefined): Tab[] {
  try {
    const list = JSON.parse(s ?? '[]') as Tab[];
    return Array.isArray(list) ? list.filter((t) => t && typeof t.key === 'string' && t.type !== 'home').slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

export interface Workspace {
  api: Api;
  project: string | null;
  state: State | null;
  error: string | null;
  tabs: Tab[];
  active: Tab;
  activate(key: string): void;
  open(t: NewTab): void;
  close(key: string): void;
  closeOthers(key: string): void;
  closeConnection(conn: string): void;
  setTabState(key: string, patch: Record<string, unknown>): void;
  retitle(key: string, title: string): void;
  connection(id: string | null): Connection | undefined;
  kindOf(c: Connection | undefined): Kind | undefined;
}

export function useWorkspace(): Workspace {
  const host = useHost();
  const api = useMemo(() => makeApi(host), [host]);
  const project = useProject()?.id ?? null;
  const win = useWindow() as { id?: number } | null;
  const data = useData();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>(() => parseTabs(data.tabs));
  const [activeKey, setActiveKey] = useState<string>(() => data.active ?? 'home');
  const storeKey = `data.tabs.${win?.id ?? 'window'}`;
  const [tabState, setTabStateMap] = useState<Record<string, Record<string, unknown>>>(() => read(storeKey, {}));
  const written = useRef(data.tabs ?? '[]');

  useEffect(
    () =>
      api.subscribe<State>(
        'watch',
        {},
        (s) => {
          setState(s);
          setError(null);
        },
        (e) => e && setError(e),
      ),
    [api],
  );

  // The tabs as the window's data, when they change (not their state).
  useEffect(() => {
    const json = JSON.stringify(tabs.map(({ state: _s, ...t }) => t));
    if (json !== written.current) {
      written.current = json;
      host.win.setData('tabs', json === '[]' ? null : json);
    }
  }, [tabs]);
  useEffect(() => {
    host.win.setData('active', activeKey === 'home' ? null : activeKey);
  }, [activeKey]);
  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(tabState));
    } catch {}
  }, [tabState]);

  // A tab whose connection was removed goes with it.
  useEffect(() => {
    if (!state) return;
    const ids = new Set(state.connections.map((c) => c.id));
    setTabs((ts) => (ts.some((t) => t.conn && !ids.has(t.conn)) ? ts.filter((t) => !t.conn || ids.has(t.conn)) : ts));
  }, [state]);

  const all = [HOME, ...tabs.map((t) => ({ ...t, state: tabState[t.key] }))];
  const active = all.find((t) => t.key === activeKey) ?? HOME;

  const close = (key: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.key === key);
      if (i < 0) return ts;
      const next = ts.filter((t) => t.key !== key);
      if (key === activeKey) setActiveKey(next[Math.min(i, next.length - 1)]?.key ?? 'home');
      return next;
    });
    setTabStateMap(({ [key]: _gone, ...rest }) => rest);
  };

  return {
    api,
    project,
    state,
    error,
    tabs: all,
    active,
    activate: setActiveKey,
    open(t) {
      const key = tabKey(t);
      setTabs((ts) => {
        if (ts.some((x) => x.key === key)) return ts;
        const next = [...ts, { ...t, key, state: undefined }];
        return next.length > MAX_TABS ? next.slice(-MAX_TABS) : next;
      });
      if (t.state) setTabStateMap((m) => ({ ...m, [key]: { ...m[key], ...t.state } }));
      setActiveKey(key);
    },
    close,
    closeOthers(key) {
      setTabs((ts) => ts.filter((t) => t.key === key));
      setActiveKey(key);
    },
    closeConnection(conn) {
      setTabs((ts) => ts.filter((t) => t.conn !== conn));
      if (active.conn === conn) setActiveKey('home');
    },
    setTabState(key, patch) {
      setTabStateMap((m) => ({ ...m, [key]: { ...m[key], ...patch } }));
    },
    retitle(key, title) {
      setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, title } : t)));
    },
    connection: (id) => (id ? state?.connections.find((c) => c.id === id) : undefined),
    kindOf: (c) => (c ? kindOf(c.kind) : undefined),
  };
}
