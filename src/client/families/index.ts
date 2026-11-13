// Each family's module: its tabs' views and its tree items' actions.

import type { Family } from '../../shared/kinds.ts';
import type { FamilyModule } from '../app/tabs.ts';
import * as document from './document/index.ts';
import * as kv from './kv/index.ts';
import * as object from './object/index.ts';
import * as queue from './queue/index.ts';
import * as sql from './sql/index.ts';

export const FAMILIES: Record<Family, FamilyModule> = { sql, kv, document, queue, object };
