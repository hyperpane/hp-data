// The bucket list's right-click menus: for the files and folders selected
// (download, links for 1 hour, 1 day or 7 days, s3:// URIs, rename or
// move, delete), for the empty space (upload, new folder, refresh), and a
// file's links alone (the preview's Copy Link).

import type { MenuEntry } from '@hyperpane/ui';
import { LINK_TIMES } from '../../../shared/object.ts';
import { count } from '../../ui/parts.tsx';
import { type Where, copyLink, download, newFolder, remove, rename, s3Uri } from './ops.ts';
import { isFolder, nameOf, parentOf } from './paths.ts';

export interface MenuContext {
  where: Where;
  /** The folder shown. */
  prefix: string;
  readOnly: boolean;
  /** What the menu is for: none for the empty space. */
  selected: string[];
  reload(): void;
  go(prefix: string): void;
  upload(): void;
  /** Runs a change, says its error, and reloads after (unless told not to). */
  run(what: string | null, fn: () => Promise<unknown>, refresh?: boolean): Promise<void>;
  setSelected(key: string): void;
}

export const linkMenu = (c: MenuContext, key: string): MenuEntry[] => LINK_TIMES.map((t) => ({ label: `Copy Link for ${t.label}`, run: () => void c.run(null, () => copyLink(c.where, key, t.seconds), false) }));

export function menuFor(c: MenuContext): (MenuEntry | null)[] {
  const { where, selected, readOnly } = c;
  const uri = (keys: string[]) => c.where.api.copy(keys.map((k) => s3Uri(where.bucket, k)).join('\n'), keys.length === 1 ? 'the s3:// URI' : `${keys.length} s3:// URIs`);
  if (!selected.length)
    return [
      ...(readOnly
        ? []
        : [
            { label: 'Upload Files…', run: c.upload },
            { label: 'New Folder…', run: () => void c.run(null, () => newFolder(where, c.prefix)) },
            null,
          ]),
      { label: 'Refresh', run: c.reload },
      { label: 'Copy s3:// URI of This Folder', run: () => uri([c.prefix]) },
    ];
  const files = selected.filter((k) => !isFolder(k));
  const one = selected.length === 1 ? selected[0] : null;
  const entries: (MenuEntry | null)[] = [];
  if (one && isFolder(one)) entries.push({ label: 'Open', run: () => c.go(one) });
  if (files.length) entries.push({ label: files.length === 1 ? 'Download…' : `Download ${count(files.length, 'File')}…`, run: () => void c.run(null, () => download(where, files), false) });
  if (one && !isFolder(one)) entries.push(null, ...linkMenu(c, one));
  if (one && c.prefix !== parentOf(one)) entries.push({ label: 'Show in Folder', run: () => (c.go(parentOf(one)), c.setSelected(one)) });
  entries.push(null, { label: one ? 'Copy s3:// URI' : 'Copy s3:// URIs', run: () => uri(selected) }, { label: one ? 'Copy Key' : 'Copy Keys', run: () => where.api.copy(selected.join('\n'), one ? 'the key' : 'the keys') });
  if (!readOnly) {
    entries.push(null);
    if (one) entries.push({ label: isFolder(one) ? 'Rename Folder…' : 'Rename or Move…', run: () => void c.run(null, () => rename(where, one)) });
    entries.push({ label: one ? `Delete “${nameOf(one)}”…` : `Delete ${count(selected.length, 'Item')}…`, danger: true, run: () => void c.run(null, () => remove(where, selected)) });
  }
  return entries;
}
