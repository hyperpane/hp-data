// An icon for each kind of tree item and tab.

import { Archive, Braces, Columns3, Database, Eye, Folder, House, Inbox, Info, KeyRound, KeySquare, Layers, ListOrdered, ListTree, Radio, Shuffle, SquareFunction, SquareTerminal, Table2, Users, Zap, type LucideIcon } from 'lucide-react';
import type { NodeType, TabType } from '../../shared/types.ts';

export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  database: Database,
  schema: Layers,
  folder: Folder,
  table: Table2,
  view: Eye,
  column: Columns3,
  index: ListTree,
  key: KeyRound,
  function: SquareFunction,
  sequence: ListOrdered,
  trigger: Zap,
  keyspace: KeySquare,
  collection: Braces,
  topic: Radio,
  queue: Inbox,
  exchange: Shuffle,
  group: Users,
  bucket: Archive,
  info: Info,
};

export const NODE_COLORS: Partial<Record<NodeType, string>> = {
  database: '#58a6ff',
  schema: '#a371f7',
  table: '#3fb950',
  view: '#2bc3a6',
  key: '#e3b341',
  index: '#9aa3b6',
  function: '#f0883e',
  keyspace: '#f85149',
  collection: '#3fb950',
  topic: '#f0883e',
  queue: '#f0883e',
  exchange: '#bc8cff',
  bucket: '#e3a33b',
};

export const TAB_ICONS: Record<TabType, LucideIcon> = {
  home: House,
  console: SquareTerminal,
  table: Table2,
  keys: KeySquare,
  collection: Braces,
  topic: Radio,
  queue: Inbox,
  bucket: Archive,
};
