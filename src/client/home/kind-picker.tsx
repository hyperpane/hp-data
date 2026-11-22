// Picking what to connect to, when the form opens without a kind: every
// kind by category, with a search.

import { useState } from 'react';
import { NodeInput } from '@hyperpane/ui';
import { CATEGORIES, KINDS, type Kind } from '../../shared/kinds.ts';
import { KindTile } from '../ui/parts.tsx';

export function KindPicker({ onPick }: { onPick(k: Kind): void }) {
  const [pick, setPick] = useState('');
  const kinds = KINDS.filter((k) => !pick || `${k.name} ${k.tagline}`.toLowerCase().includes(pick.toLowerCase()));
  return (
    <div className="flex max-h-[62vh] flex-col gap-3 overflow-auto p-4">
      <NodeInput autoFocus aria-label="Find a kind" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="PostgreSQL, Redis, S3" />
      {CATEGORIES.map((cat) => {
        const list = kinds.filter((k) => k.category === cat.id);
        if (!list.length) return null;
        return (
          <div key={cat.id} className="flex flex-col gap-1">
            <span className="flex h-7 items-center text-xs font-medium text-[var(--node-muted)]">{cat.title}</span>
            <div className="grid grid-cols-2 gap-1 max-sm:grid-cols-1">
              {list.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => onPick(k)}
                  className="rounded-control flex h-9 min-w-0 items-center gap-2 px-2 text-left transition-colors duration-100 outline-none hover:bg-[var(--node-hover)] focus-visible:bg-[var(--node-hover)] touch:h-11"
                >
                  <KindTile kind={k} size={22} />
                  <span className="truncate text-xs">{k.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
