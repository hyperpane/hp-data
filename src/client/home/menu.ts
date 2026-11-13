// What can be done to a saved connection, from its card or its row in the
// tree: the menu, and the operations behind it (the window's).

import type { MenuEntry } from '@hyperpane/ui';
import type { Connection } from '../../shared/types.ts';

export interface ConnectionOps {
  /** Connects (if it isn't), shows it in the tree, and opens what it opens
   * first (a console, its keys, its one bucket). */
  openConnection(c: Connection): void;
  connect(c: Connection): void;
  disconnect(c: Connection): void;
  newConsole(c: Connection): void;
  edit(c: Connection): void;
  duplicate(c: Connection): void;
  remove(c: Connection): void;
  /** The form, with no kind picked yet. */
  pickKind(at?: HTMLElement): void;
}

export function connectionMenu(c: Connection, open: boolean, ops: ConnectionOps, family?: string): (MenuEntry | null)[] {
  return [
    { label: 'Open', run: () => ops.openConnection(c) },
    open ? { label: 'Disconnect', run: () => ops.disconnect(c) } : { label: 'Connect', run: () => ops.connect(c) },
    ...(family === undefined || family === 'sql' || family === 'kv' || family === 'document' ? [{ label: 'New Console', run: () => ops.newConsole(c) }] : []),
    null,
    { label: 'Edit Connection…', run: () => ops.edit(c) },
    { label: 'Duplicate', run: () => ops.duplicate(c) },
    null,
    { label: 'Remove…', danger: true, run: () => ops.remove(c) },
  ];
}
