// The window's tabs: Home, and what's opened from a connection (a console,
// a table, a key browser, a collection, a topic or queue, a bucket). Each
// family's views (families/<family>/index.ts) say which component shows
// which tab type.

import type { Kind } from '../../shared/kinds.ts';
import type { MenuEntry } from '@hyperpane/ui';
import type { Connection, Ref, TabType, TreeNode } from '../../shared/types.ts';
import type { Api } from '../lib/api.ts';

export interface Tab {
  /** Unique: `${conn}:${type}:${JSON.stringify(ref)}`, or a console's own. */
  key: string;
  type: TabType;
  /** The connection's id (null for Home). */
  conn: string | null;
  ref: Ref;
  title: string;
  /** What the tab keeps across reloads (a console's text): small, JSON. */
  state?: Record<string, unknown>;
}

export type NewTab = Omit<Tab, 'key'> & { key?: string };

export interface TabProps {
  tab: Tab;
  connection: Connection;
  kind: Kind;
  api: Api;
  project: string | null;
  /** The connection is marked read only: offer no changes. */
  readOnly: boolean;
  /** Keeps something with the tab, across reloads (merged in). */
  setState(patch: Record<string, unknown>): void;
  /** Opens a tab (or shows it if it's open). */
  open(t: NewTab): void;
  retitle(title: string): void;
  /** True while it's the tab shown (hidden ones stay mounted). */
  visible: boolean;
}

export type Views = Partial<Record<TabType, (p: TabProps) => React.ReactNode>>;

/** What a tree item's right-click menu is given. */
export interface TreeContext {
  /** The item, or null for the connection itself. */
  node: TreeNode | null;
  /** The names from the connection down to the item, the item's last. */
  path: string[];
  connection: Connection;
  kind: Kind;
  api: Api;
  project: string | null;
  readOnly: boolean;
  open(t: NewTab): void;
  /** Reloads the item's children (or the parent's, for a leaf). */
  refresh(): void;
}

/** A family's entries for a tree item's menu, after Open, Refresh and
 * Copy Name, which every item has. */
export type TreeActions = (c: TreeContext) => (MenuEntry | null)[];

/** What families/<family>/index.ts exports. */
export interface FamilyModule {
  views: Views;
  actions?: TreeActions;
}

export const tabKey = (t: NewTab): string => t.key ?? `${t.conn ?? ''}:${t.type}:${JSON.stringify(t.ref)}`;
