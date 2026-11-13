// What the bucket tab does to objects, through the server part: upload
// (files picked, or dropped with their folders), download (saved by the
// app, the bytes not passing through this frame), delete (folders counted
// first), rename or move, a new folder, links and URIs to copy.

import { ID } from '../../../shared/types.ts';
import { LINK_TIMES, type RemoveResult } from '../../../shared/object.ts';
import type { Api } from '../../lib/api.ts';
import { count } from '../../ui/parts.tsx';
import { isFolder, nameOf, typeFor } from './paths.ts';

export interface Where {
  api: Api;
  id: string;
  project: string | null;
  bucket: string;
}

const base = (w: Where) => ({ id: w.id, project: w.project ?? undefined, bucket: w.bucket });

/** A file to put, with the path under the folder it goes in. */
export interface Put {
  file: File;
  path: string;
}

/** Puts each file under `prefix`, one at a time; `progress` hears how far. */
export async function upload(w: Where, prefix: string, puts: Put[], progress: (done: number, of: number, name: string) => void, signal?: AbortSignal): Promise<number> {
  let done = 0;
  for (const p of puts) {
    progress(done, puts.length, p.path);
    await w.api.host.stream(ID, { op: 'objUpload', ...base(w), key: prefix + p.path, size: p.file.size, contentType: typeFor(p.file.name, p.file.type), data: p.file }, { signal });
    done++;
  }
  progress(done, puts.length, '');
  return done;
}

/** The files a drop carries, folders walked (as far as the browser lets). */
export async function droppedFiles(dt: DataTransfer): Promise<Put[]> {
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null));
  if (!entries.some((e) => e?.isDirectory)) return [...dt.files].map((file) => ({ file, path: file.name }));
  const out: Put[] = [];
  const walk = async (e: FileSystemEntry, at: string): Promise<void> => {
    if (e.isFile) {
      const file = await new Promise<File>((resolve, reject) => (e as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: at + e.name });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${at}${e.name}/`);
      }
    }
  };
  for (const e of entries) if (e) await walk(e, '');
  return out;
}

export async function download(w: Where, keys: string[]): Promise<void> {
  for (const key of keys.filter((k) => !isFolder(k))) await w.api.save('objDownload', { ...base(w), key }, nameOf(key));
}

/** Asks, then deletes the keys and the folders with all that's in them. */
export async function remove(w: Where, keys: string[]): Promise<boolean> {
  const folders = keys.filter(isFolder);
  const files = keys.filter((k) => !isFolder(k));
  let message = files.length === 1 && !folders.length ? `“${nameOf(files[0])}” will be deleted from ${w.bucket}.` : '';
  if (folders.length) {
    const { count: n } = await w.api.call<RemoveResult>('objRemove', { ...base(w), keys: files, prefixes: folders, dryRun: true });
    const what = [folders.length === 1 ? `the folder “${nameOf(folders[0])}”` : count(folders.length, 'folder'), files.length ? count(files.length, 'file') : null].filter(Boolean).join(' and ');
    message = `${what[0].toUpperCase()}${what.slice(1)} will be deleted: ${count(n, 'object')} in all.`;
  } else if (!message) message = `${count(files.length, 'file')} will be deleted from ${w.bucket}.`;
  const title = keys.length === 1 ? `Delete “${nameOf(keys[0])}”?` : `Delete ${count(keys.length, 'item')}?`;
  if (!(await w.api.confirm(title, `${message} This can’t be undone (unless the bucket keeps versions).`, 'Delete', true))) return false;
  const r = await w.api.call<RemoveResult>('objRemove', { ...base(w), keys: files, prefixes: folders });
  w.api.toast(`Deleted ${count(r.count, 'object')}.`);
  return true;
}

/** Asks for a new key (a path, to move it), then copies and deletes. */
export async function rename(w: Where, key: string): Promise<string | null> {
  const folder = isFolder(key);
  const typed = await w.api.prompt(folder ? 'Rename folder' : 'Rename or move', 'New key (a path moves it)', key.replace(/\/$/, ''), key);
  if (typed === null) return null;
  let to = typed.trim().replace(/^\/+/, '');
  if (!to) return null;
  if (folder) to = to.replace(/\/*$/, '/');
  if (to === key) return null;
  const r = await w.api.call<{ count: number }>('objCopy', { ...base(w), from: key, to, move: true });
  if (folder) w.api.toast(`Moved ${count(r.count, 'object')}.`);
  return to;
}

export async function newFolder(w: Where, prefix: string): Promise<string | null> {
  const name = (await w.api.prompt('New folder', `In ${w.bucket}/${prefix}`, '', 'Name'))?.trim().replace(/^\/+|\/+$/g, '');
  if (!name) return null;
  await w.api.call('objUpload', { ...base(w), key: `${prefix}${name}/` });
  return `${prefix}${name}/`;
}

export async function copyLink(w: Where, key: string, seconds: number): Promise<void> {
  const { url } = await w.api.call<{ url: string }>('objPresign', { ...base(w), key, seconds });
  w.api.copy(url, `a link good for ${LINK_TIMES.find((t) => t.seconds === seconds)?.label ?? `${seconds} seconds`}`);
}

export const s3Uri = (bucket: string, key = '') => `s3://${bucket}/${key}`;
