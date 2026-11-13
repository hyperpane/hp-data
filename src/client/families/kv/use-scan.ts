// The keys of a keys tab: SCAN a page at a time for a pattern, more on
// request, and changes made here (a key removed, renamed, added) kept in
// the list without scanning again.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyEntry, ScanResult } from '../../../shared/kv.ts';
import type { Calls } from './lib.ts';

export const PAGE = 200;

export interface Scan {
  keys: KeyEntry[];
  total: number | undefined;
  /** More to load. */
  more: boolean;
  loading: boolean;
  error: string | null;
  loadMore(): void;
  reload(): void;
  drop(keys: string[]): void;
  renamed(from: string, to: string): void;
  added(e: KeyEntry): void;
  patch(key: string, e: Partial<KeyEntry>): void;
}

export function useScan(calls: Calls, pattern: string, count = PAGE): Scan {
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [cursor, setCursor] = useState('0');
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const run = useRef(0);
  const callsRef = useRef(calls);
  callsRef.current = calls;

  const load = useCallback(
    async (from: string, fresh: boolean) => {
      const me = ++run.current;
      setLoading(true);
      setError(null);
      try {
        const r = await callsRef.current.call<ScanResult>('kvScan', { pattern: pattern || '*', cursor: from, count: Math.max(10, Math.min(10_000, count || PAGE)) });
        if (me !== run.current) return;
        setKeys((old) => {
          if (fresh) return r.keys;
          const seen = new Set(old.map((k) => k.key));
          return [...old, ...r.keys.filter((k) => !seen.has(k.key))];
        });
        setCursor(r.cursor);
        setDone(r.cursor === '0');
        setTotal(r.total);
      } catch (e) {
        if (me === run.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (me === run.current) setLoading(false);
      }
    },
    [pattern],
  );

  useEffect(() => {
    setKeys([]);
    setDone(false);
    void load('0', true);
  }, [load, calls.db]);

  return {
    keys,
    total,
    more: !done,
    loading,
    error,
    loadMore: () => !done && !loading && void load(cursor, false),
    reload: () => void load('0', true),
    drop: (ks) => {
      const gone = new Set(ks);
      setKeys((old) => old.filter((k) => !gone.has(k.key)));
      setTotal((t) => (t === undefined ? t : Math.max(0, t - ks.length)));
    },
    renamed: (from, to) => setKeys((old) => old.map((k) => (k.key === from ? { ...k, key: to } : k))),
    added: (e) => {
      setKeys((old) => [e, ...old.filter((k) => k.key !== e.key)]);
      setTotal((t) => (t === undefined ? t : t + 1));
    },
    patch: (key, e) => setKeys((old) => old.map((k) => (k.key === key ? { ...k, ...e } : k))),
  };
}
