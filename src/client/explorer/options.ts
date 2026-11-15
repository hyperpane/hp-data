// The Explorer's options: how connections are sorted and grouped, whether
// items show their details, whether only connected ones show (kept in this
// browser), and the ⋯ menu that changes them and acts on every connection.

import type { MenuEntry } from '@hyperpane/ui';
import { useKept } from '../lib/hooks.ts';

export type Sort = 'added' | 'name' | 'used' | 'kind';

export function usePrefs() {
  const [sort, setSort] = useKept<Sort>('data.explorer.sort', 'added');
  const [grouped, setGrouped] = useKept('data.explorer.grouped', true);
  const [details, setDetails] = useKept('data.explorer.details', true);
  const [onlyOpen, setOnlyOpen] = useKept('data.explorer.onlyOpen', false);
  return { sort, setSort, grouped, setGrouped, details, setDetails, onlyOpen, setOnlyOpen };
}

export type Prefs = ReturnType<typeof usePrefs>;

export interface OptionsActions {
  any: boolean;
  anyOpen: boolean;
  newConnection(): void;
  connectAll(): void;
  disconnectAll(): void;
  expandOpen(): void;
  collapse(): void;
}

const tick = (on: boolean, label: string) => `${on ? '✓ ' : '\u2003 '}${label}`;

export function optionsMenu(p: Prefs, a: OptionsActions): (MenuEntry | null)[] {
  return [
    { label: 'New Connection', run: a.newConnection },
    { label: 'Connect All', disabled: !a.any, run: a.connectAll },
    { label: 'Disconnect All', disabled: !a.anyOpen, run: a.disconnectAll },
    null,
    { label: tick(p.sort === 'added', 'Sort as Added'), run: () => p.setSort('added') },
    { label: tick(p.sort === 'name', 'Sort by Name'), run: () => p.setSort('name') },
    { label: tick(p.sort === 'used', 'Sort by Last Used'), run: () => p.setSort('used') },
    { label: tick(p.sort === 'kind', 'Sort by Kind'), run: () => p.setSort('kind') },
    null,
    { label: tick(p.grouped, 'Group by Group'), run: () => p.setGrouped(!p.grouped) },
    { label: tick(p.details, 'Show Details (counts, types, sizes)'), run: () => p.setDetails(!p.details) },
    { label: tick(p.onlyOpen, 'Only Connected'), run: () => p.setOnlyOpen(!p.onlyOpen) },
    null,
    { label: 'Expand Connected', run: a.expandOpen },
    { label: 'Collapse All', run: a.collapse },
  ];
}
