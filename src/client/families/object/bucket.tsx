// A bucket's tab: the folder shown as a breadcrumb (click one to go up),
// Back and Up, the list (List.tsx) a page of 1,000 at a time with Load
// more, a filter over what's loaded, Flat (everything under the folder),
// and the selected file's preview beside it (Preview.tsx). Changes
// (upload, new folder, rename, delete) aren't offered on a read-only
// connection.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Database, FolderPlus, ListTree, RefreshCw, Trash2, Upload } from 'lucide-react';
import { NodeButton, NodeInput, ToolButton, cn, useMenu } from '@hyperpane/ui';
import type { ListResult } from '../../../shared/object.ts';
import type { TabProps } from '../../app/tabs.ts';
import { useKept } from '../../lib/hooks.ts';
import { Handle } from '../../ui/parts.tsx';
import { ErrorBox, StatusLine, Toolbar, count } from '../../ui/parts.tsx';
import { formatSize } from '../../ui/cells.ts';
import { List } from './list.tsx';
import { linkMenu, menuFor } from './menu.ts';
import { type Put, type Where, droppedFiles, newFolder, remove, upload } from './ops.ts';
import { type Row, type Sort, crumbs, parentOf, rowsOf, sortRows } from './paths.ts';
import { Preview } from './preview.tsx';

export function BucketView(p: TabProps) {
  const { api, readOnly } = p;
  const bucket = p.tab.ref.bucket ?? '';
  const where: Where = useMemo(() => ({ api, id: p.connection.id, project: p.project, bucket }), [api, p.connection.id, p.project, bucket]);
  const [prefix, setPrefix] = useState<string>(() => (typeof p.tab.state?.prefix === 'string' ? p.tab.state.prefix : (p.tab.ref.prefix ?? '')));
  const back = useRef<string[]>([]);
  const [flat, setFlat] = useState(false);
  const [pages, setPages] = useState<ListResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useKept<Sort>('data.object.sort', { column: 'name', desc: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useKept('data.object.preview', 340);
  const previewStart = useRef(previewWidth);
  const abort = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const menu = useMenu();

  const load = useCallback(
    async (more: boolean) => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setLoading(true);
      setError(null);
      try {
        const token = more ? pages[pages.length - 1]?.next : undefined;
        const page = await api.stream<ListResult>('objList', { id: where.id, project: where.project ?? undefined, bucket, prefix, flat, token }, ac.signal);
        if (ac.signal.aborted) return;
        setPages((old) => (more ? [...old, page] : [page]));
      } catch (e) {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (abort.current === ac) setLoading(false);
      }
    },
    [api, where, bucket, prefix, flat, pages],
  );

  const reload = () => void load(false);
  useEffect(() => {
    setPages([]);
    setSelected(new Set());
    setAnchor(null);
    void load(false);
    return () => abort.current?.abort();
  }, [bucket, prefix, flat, where.id]);

  const go = (to: string, remember = true) => {
    if (to === prefix) return;
    if (remember) back.current.push(prefix);
    setPrefix(to);
    setFilter('');
    p.setState({ prefix: to });
  };
  const goBack = () => {
    const to = back.current.pop();
    if (to !== undefined) go(to, false);
  };

  const all = useMemo(() => rowsOf(pages, prefix, flat), [pages, prefix, flat]);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return sortRows(f ? all.filter((r) => r.name.toLowerCase().includes(f)) : all, sort);
  }, [all, filter, sort]);
  const next = pages[pages.length - 1]?.next ?? null;
  const one = selected.size === 1 ? [...selected][0] : null;
  const previewing = one && !one.endsWith('/') ? one : null;

  const run = async (what: string | null, fn: () => Promise<unknown>, refresh = true) => {
    setBusy(what);
    try {
      await fn();
      if (refresh) reload();
    } catch (e) {
      api.fail(e);
    } finally {
      setBusy(null);
    }
  };

  const put = (puts: Put[]) =>
    puts.length &&
    void run('Uploading…', () =>
      upload(where, prefix, puts, (done, of, name) => setBusy(done < of ? `Uploading ${of > 1 ? `${done + 1} of ${of}: ` : ''}${name}…` : null)).then((n) => api.toast(`Uploaded ${count(n, 'file')} to ${bucket}/${prefix}.`)),
    );

  const open = (row: Row) => (row.folder ? go(row.key) : void run(null, () => api.save('objDownload', { id: where.id, project: where.project ?? undefined, bucket, key: row.key }, row.name.split('/').pop() || row.name), false));

  const ctx = { where, prefix, readOnly, selected: [...selected], reload, go, upload: () => picker.current?.click(), run, setSelected: (k: string) => (setSelected(new Set([k])), setAnchor(k)) };
  const showMenu = (e: React.MouseEvent | { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, row: Row | null) => {
    e.preventDefault();
    menu.open(e, menuFor({ ...ctx, selected: row ? (selected.has(row.key) ? [...selected] : [row.key]) : [] }));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const keys = rows.map((r) => r.key);
    const at = anchor ? keys.indexOf(anchor) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (mod && e.key === 'ArrowUp') return go(parentOf(prefix));
      const i = Math.max(0, Math.min(keys.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      if (!keys[i]) return;
      setSelected(e.shiftKey ? new Set([...selected, keys[i]]) : new Set([keys[i]]));
      setAnchor(keys[i]);
    } else if (e.key === 'Enter' && one) {
      const row = rows.find((r) => r.key === one);
      if (row) open(row);
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(keys));
    } else if (mod && e.key === '[') {
      e.preventDefault();
      goBack();
    } else if ((e.key === 'Delete' || (mod && e.key === 'Backspace')) && selected.size && !readOnly) {
      e.preventDefault();
      void run(null, () => remove(where, [...selected]));
    } else if (e.key === 'Escape') setSelected(new Set());
  };

  const folders = all.filter((r) => r.folder).length;
  const files = all.length - folders;
  const bytes = all.reduce((n, r) => n + (r.size ?? 0), 0);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[12px]">
      <Toolbar>
        <ToolButton label="Back (⌘[)" icon={ArrowLeft} disabled={!back.current.length} onClick={goBack} />
        <ToolButton label="Up (⌘↑)" icon={ArrowUp} disabled={!prefix || flat} onClick={() => go(parentOf(prefix))} />
        <nav className="flex min-w-0 flex-1 items-center overflow-hidden text-[11.5px]" aria-label="Folder">
          <button type="button" className={cn('flex flex-none items-center gap-1 rounded px-1 py-0.5 hover:bg-[color-mix(in_srgb,var(--node-fg)_7%,transparent)]', !prefix && 'font-medium')} onClick={() => go('')}>
            <Database className="size-3 text-[var(--node-muted)]" />
            {bucket}
          </button>
          {crumbs(prefix).map((c, i, list) => (
            <span key={c.prefix} className="flex min-w-0 items-center">
              <span className="px-0.5 text-[var(--node-muted)]">/</span>
              <button type="button" title={c.prefix} className={cn('truncate rounded px-1 py-0.5 hover:bg-[color-mix(in_srgb,var(--node-fg)_7%,transparent)]', i === list.length - 1 && 'font-medium')} onClick={() => go(c.prefix)}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <NodeInput className="w-36" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} aria-label="Filter what’s loaded" />
        <ToolButton label={flat ? 'By folder' : 'Flat: everything under this folder'} icon={ListTree} active={flat} onClick={() => setFlat(!flat)} />
        {!readOnly && (
          <>
            <ToolButton label="Upload Files…" icon={Upload} disabled={!!busy} onClick={() => picker.current?.click()} />
            <ToolButton label="New Folder…" icon={FolderPlus} onClick={() => void run(null, () => newFolder(where, prefix))} />
            <ToolButton label="Delete…" icon={Trash2} disabled={!selected.size || !!busy} onClick={() => void run(null, () => remove(where, [...selected]))} />
          </>
        )}
        <ToolButton label="Refresh" icon={RefreshCw} disabled={loading} onClick={reload} />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = [...(e.target.files ?? [])].map((file) => ({ file, path: file.name }));
            e.target.value = '';
            put(list);
          }}
        />
      </Toolbar>
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      <div className="flex min-h-0 flex-1">
        <List
          rows={rows}
          selected={selected}
          sort={sort}
          onSort={setSort}
          anchor={anchor}
          onSelect={(s, a) => (setSelected(s), setAnchor(a))}
          onOpen={open}
          onMenu={showMenu}
          onKey={onKey}
          onDrop={readOnly ? null : (dt) => void droppedFiles(dt).then(put, api.fail)}
          empty={<p className="pointer-events-none px-3 py-3 text-[var(--node-muted)]">{loading ? 'Loading…' : filter ? 'Nothing loaded matches.' : prefix ? 'This folder is empty.' : 'This bucket is empty.'}{!readOnly && !loading && !filter ? ' Drop files here to upload them.' : ''}</p>}
          footer={
            next && (
              <div className="px-2 py-1.5">
                <NodeButton disabled={loading} onClick={() => void load(true)}>
                  {loading ? 'Loading…' : 'Load more'}
                </NodeButton>
              </div>
            )
          }
        />
        {previewing && (
          <>
            <Handle
              dir="row"
              onDrag={(dx, _dy, done) => {
                const next = Math.max(200, Math.min(900, Math.round(previewStart.current - dx)));
                setPreviewWidth(next);
                if (done) previewStart.current = next;
              }}
              onReset={() => ((previewStart.current = 340), setPreviewWidth(340))}
            />
            <div className="flex min-h-0 flex-none flex-col" style={{ width: previewWidth }}>
              <Preview where={where} objectKey={previewing} onDownload={() => open(rows.find((r) => r.key === previewing) ?? { key: previewing, folder: false, name: previewing, size: null, modified: null })} onLink={(e) => menu.open(e, linkMenu(ctx, previewing))} />
            </div>
          </>
        )}
      </div>
      <StatusLine>
        <span>
          {count(folders, 'folder')}, {count(files, 'file')}
          {next ? ' loaded' : ''}
          {files ? ` · ${formatSize(bytes)}` : ''}
        </span>
        {filter && <span>{count(rows.length, 'match', 'matches')}</span>}
        {selected.size > 0 && <span>{count(selected.size, 'selected', 'selected')}</span>}
        {busy && <span className="truncate text-[var(--node-fg)]">{busy}</span>}
        {readOnly && <span className="ml-auto">Read only</span>}
      </StatusLine>
      {menu.element}
    </div>
  );
}
