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
      <NodeInput autoFocus value={pick} onChange={(e) => setPick(e.target.value)} placeholder="PostgreSQL, Redis, S3" />
      {CATEGORIES.map((cat) => {
        const list = kinds.filter((k) => k.category === cat.id);
        if (!list.length) return null;
        return (
          <div key={cat.id} className="flex flex-col gap-1.5">
            <span className="text-[10.5px] font-semibold tracking-wide text-[var(--node-muted)] uppercase">{cat.title}</span>
            <div className="grid grid-cols-2 gap-1.5">
              {list.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => onPick(k)}
                  className="flex items-center gap-2 rounded-[7px] border border-[var(--node-border)] px-2 py-1.5 text-left hover:border-[var(--node-accent)]"
                >
                  <KindTile kind={k} size={22} />
                  <span className="truncate text-[12px]">{k.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
