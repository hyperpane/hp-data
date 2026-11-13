// A table's structure: its columns (type, null, default, key), indexes and
// foreign keys, as tables.

import { Key } from 'lucide-react';
import type { TableInfo } from '../../../shared/sql.ts';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-[var(--node-muted)] uppercase">{title}</h3>
      {children}
    </section>
  );
}

const th = 'border-b border-[var(--node-border)] px-2 py-1 text-left font-medium text-[var(--node-muted)]';
const td = 'border-b border-[color-mix(in_srgb,var(--node-border)_60%,transparent)] px-2 py-1';

export function Structure({ info, copy }: { info: TableInfo; copy(text: string, what?: string): void }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 select-text">
      <div className="flex max-w-[900px] flex-col gap-5">
        <Section title={`Columns · ${info.columns.length}${info.rows !== null ? ` · about ${info.rows.toLocaleString()} rows` : ''}`}>
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Type</th>
                <th className={th}>Null</th>
                <th className={th}>Default</th>
              </tr>
            </thead>
            <tbody>
              {info.columns.map((c) => (
                <tr key={c.name} className="hover:bg-[color-mix(in_srgb,var(--node-fg)_4%,transparent)]" onDoubleClick={() => copy(c.name, 'the name')}>
                  <td className={`${td} font-mono`}>
                    <span className="flex items-center gap-1.5">
                      {c.key && <Key className="size-3 text-[#e3b341]" />}
                      {c.name}
                    </span>
                  </td>
                  <td className={`${td} font-mono text-[#58a6ff]`}>{c.type}</td>
                  <td className={td}>{c.nullable === false ? 'not null' : 'null'}</td>
                  <td className={`${td} text-[var(--node-muted)]`}>{c.readOnly ? 'generated' : c.hasDefault ? 'yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        {info.indexes.length > 0 && (
          <Section title={`Indexes · ${info.indexes.length}`}>
            <table className="w-full border-collapse text-[11.5px]">
              <tbody>
                {info.indexes.map((i) => (
                  <tr key={i.name}>
                    <td className={`${td} font-mono`}>{i.name}</td>
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
            <table className="w-full border-collapse text-[11.5px]">
              <tbody>
                {info.foreignKeys.map((f) => (
                  <tr key={f.name}>
                    <td className={`${td} font-mono`}>{f.name}</td>
                    <td className={`${td} font-mono`}>
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
