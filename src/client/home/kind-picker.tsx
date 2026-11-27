// Picking what to connect to, when the form opens without a kind: every
// kind by category, with a search.

import { useState } from 'react';
import { Search } from '@hyperpane/icons';
import { NodeInput, cn } from '@hyperpane/ui';
import { section } from '../ui/look.ts';
import { CATEGORIES, KINDS, type Kind } from '../../shared/kinds.ts';
import { KindTile } from '../ui/parts.tsx';

export function KindPicker({ onPick }: { onPick(k: Kind): void }) {
  const [pick, setPick] = useState('');
  const kinds = KINDS.filter((k) => !pick || `${k.name} ${k.tagline}`.toLowerCase().includes(pick.toLowerCase()));
  return (
    <div className="flex max-h-[62vh] flex-col gap-4 overflow-auto px-5 pt-1 pb-5">
      <label className="relative flex items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-[var(--node-muted)]" />
        <NodeInput autoFocus aria-label="Find a kind" className="w-full ps-8 text-[13px]" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="PostgreSQL, Redis, S3" />
      </label>
      {CATEGORIES.map((cat) => {
        const list = kinds.filter((k) => k.category === cat.id);
        if (!list.length) return null;
        return (
          <div key={cat.id} className="flex flex-col gap-1">
            <span className={cn(section.header, 'h-6 px-0')}>{cat.title}</span>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 max-sm:grid-cols-1">
              {list.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => onPick(k)}
                  className="rounded-control -mx-1.5 flex h-9 min-w-0 items-center gap-2.5 px-1.5 text-left transition-colors duration-100 outline-none hover:bg-[var(--node-hover)] focus-visible:bg-[var(--node-hover)] touch:h-11"
                >
                  <KindTile kind={k} size={24} />
                  <span className="truncate text-[13px]">{k.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
