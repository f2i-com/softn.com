/**
 * Files on their way in and out of the browser, for the Files panel: what a
 * drop or a paste carries, read into the shape lib/fileOps.ts adds, and a
 * file or a folder handed to the person as a download.
 */

import { zipSync } from 'fflate';
import { classifyAsset } from '@softn/core';
import type { IncomingFile } from './fileOps';
import { MAX_APP_FILES, nameOf, pastedName } from './fileRules';
import type { VFSFile } from '../types/studio';

/** As much of the browser's file-system entry as is read here (the standard types do not carry it). */
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(done: (file: File) => void, failed: (err: unknown) => void): void;
  createReader?(): { readEntries(done: (entries: Entry[]) => void, failed: (err: unknown) => void): void };
}

/** Every file under a dropped folder, each with the folders it is in. A folder that cannot be read gives what could be. */
async function filesIn(entry: Entry, within: string, out: IncomingFile[]): Promise<void> {
  if (out.length > MAX_APP_FILES) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => entry.file!(resolve, () => resolve(null)));
    if (file) out.push({ file, within });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  const inside = within ? `${within}/${entry.name}` : entry.name;
  // A reader hands a folder over some entries at a time, and nothing once it has given them all.
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (batch.length === 0) return;
    for (const child of batch) await filesIn(child, inside, out);
  }
}

/**
 * What a drop carries: its files, and for a folder that was dropped every file
 * in it with the folders it came in. The entries are taken before anything is
 * awaited: the browser empties the drop as soon as its handler returns.
 */
export function incomingFromDrop(transfer: DataTransfer): Promise<IncomingFile[]> {
  const entries: Entry[] = [];
  const loose: File[] = [];
  const items = transfer.items ? Array.from(transfer.items) : [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  if (entries.length === 0 && loose.length === 0) loose.push(...Array.from(transfer.files ?? []));
  return (async () => {
    const out: IncomingFile[] = loose.map((file) => ({ file }));
    for (const entry of entries) await filesIn(entry, '', out);
    return out;
  })();
}

/** What a paste carries as files: a screenshot or a copied picture, or files copied in the computer's file manager. */
export function incomingFromPaste(data: { files?: ArrayLike<File> | null } | null | undefined): IncomingFile[] {
  return Array.from(data?.files ?? []).map((file) => ({ file, name: pastedName(file) }));
}

/** Hand bytes to the person as a file of this name. */
export function saveAs(name: string, content: Uint8Array | string, mime: string): void {
  const blob = new Blob([content as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The files of a folder as a zip that unpacks to the folder: `icons/home.svg`, not `assets/icons/home.svg`. */
export function zipFolder(files: ReadonlyMap<string, VFSFile>, folder: string): Uint8Array {
  const inside = `${folder}/`;
  const start = folder.length - nameOf(folder).length;
  const encoder = new TextEncoder();
  // Every entry's name starts with the folder's, so none is the `__proto__` the export has to refuse.
  const entries: Record<string, Uint8Array> = {};
  for (const [path, file] of files) {
    if (!path.startsWith(inside)) continue;
    entries[path.slice(start)] = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
  }
  return zipSync(entries, { level: 6 });
}

/** Download the file at `path`, or the folder there as a zip. Answers why it could not be, or null. */
export function downloadEntry(files: ReadonlyMap<string, VFSFile>, path: string, isDir: boolean): string | null {
  if (!isDir) {
    const file = files.get(path);
    if (!file) return `${path} is no longer in the project.`;
    saveAs(nameOf(path), file.content, classifyAsset(path).mime);
    return null;
  }
  const zip = zipFolder(files, path);
  if (zip.byteLength <= 22) return `${nameOf(path)} has no files in it to download.`;
  saveAs(`${nameOf(path)}.zip`, zip, 'application/zip');
  return null;
}
