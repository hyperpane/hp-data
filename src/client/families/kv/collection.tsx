// A hash's fields, a list's items, a set's members, a sorted set's
// members and scores, a stream's entries: a page of them as a table, each
// opened (double-click, or a tap) to read or change it, removed, and new ones added
// in the row at the bottom.

import { useState } from 'react';
import { Trash2 } from '@hyperpane/icons';
import { ColumnResizer, NodeButton, ToolButton, cn, styles, useColumnWidths, useTouch } from '@hyperpane/ui';
import type { KvValue } from '../../../shared/kv.ts';
import type { KvEdit } from '../../../shared/kv.ts';
import { ValueViewer } from '../../ui/parts.tsx';
import { inputClass } from './parts.tsx';

type Coll = Extract<KvValue, { type: 'hash' | 'list' | 'set' | 'zset' | 'stream' }>;

export interface CollectionProps {
  value: Coll;
  offset: number;
  limit: number;
  onPage(offset: number): void;
  readOnly: boolean;
  /** Applies a change; true when it went through (the value's reloaded). */
  edit(op: KvEdit): Promise<boolean>;
  remove(what: string, op: KvEdit): void;
  copy(text: string, what?: string): void;
  fail(message: string): void;
}

interface Row {
  id: string;
  cells: string[];
  /** Opening the last cell may change it. */
  save?(text: string): KvEdit;
  del?: { what: string; op: KvEdit };
}

function rowsOf(v: Coll, offset: number): { head: string[]; rows: Row[] } {
  switch (v.type) {
    case 'hash':
      return {
        head: ['Field', 'Value'],
        rows: v.fields.map((f) => ({
          id: f.field,
          cells: [f.field, f.value],
          save: (t) => ({ op: 'hset', field: f.field, value: t }),
          del: { what: `the field “${f.field}”`, op: { op: 'hdel', field: f.field } },
        })),
      };
    case 'list':
      return {
        head: ['Index', 'Value'],
        rows: v.items.map((it, i) => ({
          id: String(offset + i),
          cells: [String(offset + i), it],
          save: (t) => ({ op: 'lset', index: offset + i, value: t }),
          del: { what: `item ${offset + i}`, op: { op: 'lrem', index: offset + i } },
        })),
      };
    case 'set':
      return { head: ['Member'], rows: v.members.map((m) => ({ id: m, cells: [m], del: { what: `“${m}”`, op: { op: 'srem', member: m } } })) };
    case 'zset':
      return {
        head: ['Score', 'Member'],
        rows: v.members.map((m) => ({
          id: m.member,
          cells: [String(m.score), m.member],
          del: { what: `“${m.member}”`, op: { op: 'zrem', member: m.member } },
        })),
      };
    case 'stream':
      return {
        head: ['ID', 'Fields'],
        rows: v.entries.map((e) => ({ id: e.id, cells: [e.id, JSON.stringify(e.fields)], del: { what: `entry ${e.id}`, op: { op: 'xdel', id: e.id } } })),
      };
  }
}

export function Collection(p: CollectionProps) {
  const { value: v, offset, limit } = p;
  const { head, rows } = rowsOf(v, offset);
  const [open, setOpen] = useState<{ row: Row; col: number } | null>(null);
  const touch = useTouch();
  const last = head.length - 1;
  // The first column (a field, an entry's id, an index) is as wide as it was
  // dragged, for each kind of value (kept on this machine); the value takes
  // what's left.
  const cols = useColumnWidths('data.kv', { field: 200, id: 170, index: 90 }, { min: 40, max: 800 });
  const first = v.type === 'hash' ? 'field' : v.type === 'stream' ? 'id' : 'index';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse font-mono text-xs">
          <colgroup>
            {head.length > 1 && <col style={{ width: cols.widths[first] }} />}
            <col />
            {!p.readOnly && <col style={{ width: 36 }} />}
          </colgroup>
          <thead className={cn(styles.stickyTableHead, 'bg-[var(--node-header)]')}>
            <tr className="h-7 text-left text-2xs text-[var(--node-muted)]">
              {head.map((h, i) => (
                <th key={h} className="relative border-b border-[var(--data-line)] px-2 font-sans font-medium">
                  {h}
                  {i === 0 && head.length > 1 && <ColumnResizer {...cols.resizer(first)} />}
                </th>
              ))}
              {!p.readOnly && <th className="border-b border-[var(--data-line)]" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="group h-7 hover:bg-[var(--node-hover)] touch:h-10">
                {r.cells.map((c, i) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: a finger's tap opens the cell, as a double-click does.
                  <td
                    key={i}
                    className={cn('truncate border-b border-[var(--data-line)] px-2', i === 0 && head.length > 1 && 'text-[var(--node-muted)]')}
                    title={c.length > 500 ? c.slice(0, 500) : c}
                    onClick={() => touch && setOpen({ row: r, col: i })}
                    onDoubleClick={() => setOpen({ row: r, col: i })}
                  >
                    {c}
                  </td>
                ))}
                {!p.readOnly && (
                  <td className="border-b border-[var(--data-line)] text-center">
                    {r.del && (
                      <span className="inline-flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                        <ToolButton label="Remove" icon={Trash2} onClick={() => p.remove(r.del!.what, r.del!.op)} />
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!p.readOnly && <AddRow value={v} edit={p.edit} fail={p.fail} />}
      </div>
      {v.total > limit && (
        <div className="flex h-10 flex-none items-center gap-2 border-t border-[var(--data-line)] px-2.5 text-2xs text-[var(--node-muted)] touch:h-12">
          <span className="tabular-nums">
            {(offset + 1).toLocaleString()}–{Math.min(offset + limit, v.total).toLocaleString()} of {v.total.toLocaleString()}
          </span>
          <div className="ms-auto flex gap-1">
            <NodeButton variant="ghost" disabled={offset === 0} onClick={() => p.onPage(Math.max(0, offset - limit))}>
              Previous
            </NodeButton>
            <NodeButton variant="ghost" disabled={offset + limit >= v.total} onClick={() => p.onPage(offset + limit)}>
              Next
            </NodeButton>
          </div>
        </div>
      )}
      {open && (
        <ValueViewer
          title={`${head[open.col]} ${open.col === 0 ? '' : `of ${open.row.cells[0]}`}`.trim()}
          value={open.row.cells[open.col]}
          onClose={() => setOpen(null)}
          copy={p.copy}
          onSave={
            !p.readOnly && open.col === last && open.row.save
              ? (t) => void p.edit(open.row.save!(t))
              : !p.readOnly && v.type === 'zset' && open.col === 0
                ? (t) => void zscore(p, open.row.cells[1], t)
                : undefined
          }
        />
      )}
    </div>
  );
}

function zscore(p: CollectionProps, member: string, text: string) {
  const score = Number(text.trim());
  if (!Number.isFinite(score)) return p.fail('A score is a number');
  return p.edit({ op: 'zadd', member, score });
}

/** The row that adds: fields as each type needs them. */
function AddRow({ value: v, edit, fail }: { value: Coll; edit(op: KvEdit): Promise<boolean>; fail(m: string): void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const clear = (ok: boolean) => {
    if (!ok) return false;
    setA('');
    setB('');
  };
  const submit = async (side?: 'lpush' | 'rpush') => {
    switch (v.type) {
      case 'hash':
        if (!a) return fail('Give the field a name');
        return clear(await edit({ op: 'hset', field: a, value: b }));
      case 'list':
        return clear(await edit({ op: side ?? 'rpush', value: a }));
      case 'set':
        if (!a) return fail('Type the member');
        return clear(await edit({ op: 'sadd', member: a }));
      case 'zset': {
        const score = Number(b.trim() || '0');
        if (!a) return fail('Type the member');
        if (!Number.isFinite(score)) return fail('A score is a number');
        return clear(await edit({ op: 'zadd', member: a, score }));
      }
      case 'stream': {
        let fields: Record<string, string>;
        try {
          const o = JSON.parse(a) as Record<string, unknown>;
          if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.keys(o).length) throw new Error('an object with a field');
          fields = Object.fromEntries(Object.entries(o).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]));
        } catch (e) {
          return fail(`An entry is a JSON object: {"field": "value"} (${(e as Error).message})`);
        }
        return clear(await edit({ op: 'xadd', fields }));
      }
    }
  };
  const ph: Record<Coll['type'], [string, string?]> = {
    hash: ['New field', 'Value'],
    list: ['New item'],
    set: ['New member'],
    zset: ['New member', 'Score'],
    stream: ['{"field": "value"}'],
  };
  const [pa, pb] = ph[v.type];
  return (
    <form
      className="flex items-center gap-1.5 px-2.5 py-2 max-sm:flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        className={cn(inputClass, 'min-w-0 flex-1 max-sm:basis-full')}
        placeholder={pa}
        value={a}
        onChange={(e) => setA(e.target.value)}
        spellCheck={false}
      />
      {pb && (
        <input
          className={cn(inputClass, 'min-w-0', v.type === 'zset' ? 'w-24' : 'flex-1')}
          placeholder={pb}
          value={b}
          onChange={(e) => setB(e.target.value)}
          spellCheck={false}
        />
      )}
      {v.type === 'list' ? (
        <>
          <NodeButton onClick={() => void submit('lpush')}>Push to the head</NodeButton>
          <NodeButton type="submit">Push to the tail</NodeButton>
        </>
      ) : (
        <NodeButton type="submit">Add</NodeButton>
      )}
    </form>
  );
}
