// The window's hooks: a setting kept in this browser, a list that follows
// its end, and sending results out of the Rows port.

import { useEffect, useRef, useState } from 'react';
import { useHost } from '@hyperpane/sdk/client';
import type { QueryResult } from '../../shared/types.ts';
import { rowsOut } from './rows.ts';

export type Host = ReturnType<typeof useHost>;

/** A per-viewer setting kept in this browser (it may not be kept). */
export function useKept<T>(key: string, initial: T): [T, (v: T | ((old: T) => T)) => void] {
  const [v, setV] = useState<T>(() => read(key, initial));
  const last = useRef(key);
  useEffect(() => {
    if (last.current !== key) {
      last.current = key;
      setV(read(key, initial));
    }
  }, [key]);
  return [
    v,
    (next) => {
      setV((old) => {
        const value = typeof next === 'function' ? (next as (o: T) => T)(old) : next;
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {}
        return value;
      });
    },
  ];
}

export function read<T>(key: string, initial: T): T {
  try {
    const s = localStorage.getItem(key);
    return s === null ? initial : (JSON.parse(s) as T);
  } catch {
    return initial;
  }
}

/** Keeps a list scrolled to its end while it's there; scrolled up, it
 * stays put and says there's more. */
export function useFollow(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [dep, follow]);
  return {
    ref,
    follow,
    onScroll: (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 12);
    },
    toEnd: () => {
      setFollow(true);
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    },
  };
}

/** Sends a tab's new result out of the Rows port, while the tab is shown.
 * Called where a result arrives, so a re-render sends nothing. */
export function useRowsPort(connection: string, visible: boolean) {
  const host = useHost();
  const shown = useRef(visible);
  shown.current = visible;
  return (r: QueryResult | null | undefined, statement?: string) => {
    if (!r || !shown.current) return;
    const out = rowsOut(r, connection, statement ?? r.statement);
    if (out) host.ports.emit('rows', out);
  };
}
