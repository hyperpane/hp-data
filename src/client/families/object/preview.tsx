// The pane beside the list: the selected file's metadata (size, type,
// ETag, modified, storage class, user metadata) and its content: text and
// JSON (the first 1 MB), images (as a Blob URL), else "No preview".

import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Link } from 'lucide-react';
import { formatTime } from '@hyperpane/sdk/client';
import { JsonTree, NodeMessage, ToolButton, cn, fileIcon } from '@hyperpane/ui';
import { PREVIEW_BYTES, type ObjectDetails } from '../../../shared/object.ts';
import { formatSize } from '../../ui/cells.ts';
import { looksLikeText, nameOf, shownAs } from './paths.ts';
import type { Where } from './ops.ts';

const IMAGE_MAX = 10 * 1024 * 1024;

interface Read {
  bytes: Uint8Array;
  size: number;
  contentType: string | null;
  truncated: boolean;
}

type Content = { kind: 'image'; url: string } | { kind: 'json'; value: unknown; text: string } | { kind: 'text'; text: string; truncated: boolean } | { kind: 'none'; why: string };

export function Preview({ where, objectKey, onDownload, onLink, className }: { where: Where; objectKey: string; onDownload(): void; onLink(e: React.MouseEvent): void; className?: string }) {
  const [head, setHead] = useState<ObjectDetails | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { api } = where;

  useEffect(() => {
    let live = true;
    let blobUrl: string | null = null;
    setHead(null);
    setContent(null);
    setError(null);
    const base = { id: where.id, project: where.project ?? undefined, bucket: where.bucket, key: objectKey };
    void (async () => {
      const h = await api.call<ObjectDetails>('objHead', base);
      if (!live) return;
      setHead(h);
      const shown = shownAs(objectKey, h.contentType);
      if (h.size === 0) return setContent({ kind: 'none', why: 'Empty.' });
      if (shown === 'image' && h.size > IMAGE_MAX) return setContent({ kind: 'none', why: `Too big to preview (${formatSize(h.size)}).` });
      const r = await api.call<Read>('objRead', { ...base, limit: shown === 'image' ? IMAGE_MAX : PREVIEW_BYTES });
      if (!live) return;
      if (shown === 'image') {
        blobUrl = URL.createObjectURL(new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: h.contentType?.startsWith('image/') ? h.contentType : objectKey.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '' }));
        return setContent({ kind: 'image', url: blobUrl });
      }
      if (shown === 'unknown' && !looksLikeText(r.bytes)) return setContent({ kind: 'none', why: 'No preview.' });
      const text = new TextDecoder().decode(r.bytes);
      if (shown === 'json' && !r.truncated) {
        try {
          return setContent({ kind: 'json', value: JSON.parse(text), text });
        } catch {}
      }
      setContent({ kind: 'text', text, truncated: r.truncated });
    })().catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [where.id, where.bucket, objectKey]);

  const Icon = fileIcon(nameOf(objectKey));
  const meta = useMemo(() => (head ? rowsOf(head) : []), [head]);

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <div className="flex h-8 flex-none items-center gap-1.5 border-b border-[var(--node-border)] px-2">
        <Icon className="size-3.5 flex-none text-[var(--node-muted)]" />
        <span className="min-w-0 flex-1 truncate font-medium" title={objectKey}>
          {nameOf(objectKey)}
        </span>
        {content && 'text' in content && <ToolButton label="Copy the text" icon={Copy} onClick={() => api.copy(content.text, 'the text')} />}
        <ToolButton label="Copy Link…" icon={Link} onClick={onLink} />
        <ToolButton label="Download" icon={Download} onClick={onDownload} />
      </div>
      {error ? (
        <NodeMessage error>{error}</NodeMessage>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <table className="w-full flex-none border-b border-[var(--node-border)] text-[11px]">
            <tbody>
              {meta.map(([label, value]) => (
                <tr key={label} className="align-top">
                  <td className="w-[96px] py-0.5 pr-2 pl-2 whitespace-nowrap text-[var(--node-muted)]">{label}</td>
                  <td className="py-0.5 pr-2 font-mono break-all select-text">{value}</td>
                </tr>
              ))}
              {!head && (
                <tr>
                  <td className="px-2 py-1 text-[var(--node-muted)]">Loading…</td>
                </tr>
              )}
            </tbody>
          </table>
          <Body content={content} />
        </div>
      )}
    </div>
  );
}

function Body({ content }: { content: Content | null }) {
  if (!content) return null;
  switch (content.kind) {
    case 'image':
      return (
        <div className="flex min-h-[120px] flex-1 items-center justify-center bg-[repeating-conic-gradient(color-mix(in_srgb,var(--node-fg)_6%,transparent)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
          <img src={content.url} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      );
    case 'json':
      return <JsonTree value={content.value} depth={2} className="min-h-0 flex-1 p-2" />;
    case 'text':
      return (
        <pre className="min-h-0 flex-1 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words select-text">
          {content.text}
          {content.truncated && <span className="block pt-1 text-[var(--node-muted)] italic">… the first {formatSize(PREVIEW_BYTES)}</span>}
        </pre>
      );
    default:
      return <p className="px-2 py-3 text-[var(--node-muted)]">{content.why}</p>;
  }
}

function rowsOf(h: ObjectDetails): [string, string][] {
  const rows: [string, string][] = [
    ['Size', `${formatSize(h.size)}${h.size >= 1024 ? ` (${h.size.toLocaleString('en-US')} bytes)` : ''}`],
    ['Type', h.contentType ?? '—'],
    ['Modified', h.modified ? formatTime(h.modified) : '—'],
    ['ETag', h.etag ?? '—'],
  ];
  if (h.storageClass) rows.push(['Storage class', h.storageClass]);
  for (const [k, v] of Object.entries(h.system ?? {})) rows.push([k, v]);
  for (const [k, v] of Object.entries(h.metadata)) rows.push([`meta: ${k}`, v]);
  rows.push(['Key', h.key]);
  return rows;
}
