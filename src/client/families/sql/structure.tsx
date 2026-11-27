// A table's structure: its columns (type, null, default, key), indexes and
// foreign keys, as tables. The columns' Name takes what's left; Type, Null
// and Default are as wide as they were dragged (kept on this machine).

import { Key } from '@hyperpane/icons';
import { ColumnResizer, cn, useColumnWidths } from '@hyperpane/ui';
import { section } from '../../ui/look.ts';
import type { TableInfo } from '../../../shared/sql.ts';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className={cn(section.header, 'px-2')}>{title}</h3>
      {children}
    </section>
  );
}

const th = 'h-8 border-b border-[var(--data-line-strong)] px-2 text-left text-xs font-medium text-[var(--node-muted)]';
const td = 'h-8 border-b border-[var(--data-line)] px-2';

export function Structure({ info, copy }: { info: TableInfo; copy(text: string, what?: string): void }) {
  const cols = useColumnWidths('data.sql.structure', { type: 200, nullable: 72, fallback: 88 }, { min: 40, max: 600 });
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3 select-text">
      <div className="flex max-w-[900px] flex-col gap-6">
        <Section title={`Columns · ${info.columns.length}${info.rows !== null ? ` · about ${info.rows.toLocaleString()} rows` : ''}`}>
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col />
              <col style={{ width: cols.widths.type }} />
              <col style={{ width: cols.widths.nullable }} />
              <col style={{ width: cols.widths.fallback }} />
            </colgroup>
            <thead>
              <tr>
                <th className={th}>Name</th>
                <th className={`${th} relative`}>
                  Type
                  <ColumnResizer {...cols.resizer('type', 'start')} />
                </th>
                <th className={`${th} relative`}>
                  Null
                  <ColumnResizer {...cols.resizer('nullable', 'start')} />
                </th>
                <th className={`${th} relative`}>
                  Default
                  <ColumnResizer {...cols.resizer('fallback', 'start')} />
                </th>
              </tr>
            </thead>
            <tbody>
              {info.columns.map((c) => (
                <tr key={c.name} className="hover:bg-[var(--node-hover)]" onDoubleClick={() => copy(c.name, 'the name')}>
                  <td className={`${td} font-mono text-xs`}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {c.key && <Key className="size-3.5 flex-none text-[var(--data-key)]" />}
                      <span className="truncate" title={c.name}>
                        {c.name}
                      </span>
                    </span>
                  </td>
                  <td className={`${td} truncate font-mono text-[var(--ansi-4)]`} title={c.type}>
                    {c.type}
                  </td>
                  <td className={`${td} truncate font-mono ${c.nullable === false ? '' : 'text-[var(--node-muted)]'}`}>
                    {c.nullable === false ? 'not null' : 'null'}
                  </td>
                  <td className={`${td} truncate text-[var(--node-muted)]`}>{c.readOnly ? 'generated' : c.hasDefault ? 'yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        {info.indexes.length > 0 && (
          <Section title={`Indexes · ${info.indexes.length}`}>
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {info.indexes.map((i) => (
                  <tr key={i.name}>
                    <td className={`${td} font-mono text-xs`}>{i.name}</td>
                    <td className={`${td} font-mono text-[var(--node-muted)]`}>{i.columns.join(', ')}</td>
                    <td className={td}>{i.primary ? 'primary key' : i.unique ? 'unique' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}
        {info.foreignKeys.length > 0 && (
          <Section title={`Foreign keys · ${info.foreignKeys.length}`}>
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {info.foreignKeys.map((f) => (
                  <tr key={f.name}>
                    <td className={`${td} font-mono text-xs`}>{f.name}</td>
                    <td className={`${td} font-mono text-xs`}>
                      ({f.columns.join(', ')}) → {f.table} ({f.to.join(', ')})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}
      </div>
    </div>
  );
}
