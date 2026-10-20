/**
 * Bundles dropped anywhere on the site, on their way to the publish page.
 *
 * The home page and the directory have no form for a file to land in, so a
 * drop there stashes the bundles here — in memory, for this page load only —
 * while the router moves to /publish, which takes them exactly as if they had
 * been dropped on its own zone. Nothing here touches storage: a bundle is
 * the visitor's until they publish it.
 */

const BUNDLE_NAME = /\.(softn|zip)$/i;
const ZIP_TYPE = /zip/i;

let pending: File[] = [];
const listeners = new Set<() => void>();

/** A `.softn` (or a `.zip`, which is what a bundle is) by name, or a zip by type when the name says nothing. */
export function isBundleFile(file: File): boolean {
  return BUNDLE_NAME.test(file.name) || (!/\.[a-z0-9]+$/i.test(file.name) && ZIP_TYPE.test(file.type));
}

/** The bundles among a drop's files, in the order they were dropped. */
export function bundleFiles(list: ArrayLike<File>): File[] {
  return Array.from(list).filter(isBundleFile);
}

/** Keep a drop's bundles for the publish page; answers how many there are, and tells whoever is listening. */
export function stashDroppedBundles(list: ArrayLike<File>): number {
  pending = bundleFiles(list);
  if (pending.length > 0) for (const listener of listeners) listener();
  return pending.length;
}

/** Hear about a stash while mounted — the publish page, when the drop lands on it. Returns the unsubscribe. */
export function onDroppedBundles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stashed bundles, once: a second call answers none. */
export function takeDroppedBundles(): File[] {
  const out = pending;
  pending = [];
  return out;
}

/** True when a drag carries files at all — the only kind of drag the site takes. */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

/** How many entries of a dropped folder are looked at, at most, files and folders together. */
export const MAX_WALKED_ENTRIES = 5000;
/** How many folders deep a dropped folder is opened. */
export const MAX_WALK_DEPTH = 8;

/** Folders a walk does not open: hidden ones and installed packages, which hold no bundles of anyone's and can hold thousands of files. */
const SKIPPED_FOLDER = /^(?:\.|node_modules$)/;

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Every file under the given entries, folders opened, in name order within
 * each folder. A file whose name has an extension other than a bundle's is
 * passed over without being opened. The walk stops after MAX_WALKED_ENTRIES
 * entries and MAX_WALK_DEPTH folders down; an entry that cannot be read is
 * left out.
 */
async function walkEntries(roots: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];
  let budget = MAX_WALKED_ENTRIES;
  const visit = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    if (budget <= 0) return;
    budget -= 1;
    if (entry.isFile) {
      if (/\.[a-z0-9]+$/i.test(entry.name) && !BUNDLE_NAME.test(entry.name)) return;
      try {
        out.push(await fileOf(entry as FileSystemFileEntry));
      } catch {
        /* gone, or refused: left out */
      }
      return;
    }
    if (!entry.isDirectory || depth >= MAX_WALK_DEPTH || (depth > 0 && SKIPPED_FOLDER.test(entry.name))) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // readEntries answers in batches, and an empty one means the end.
    try {
      for (let batch = await readBatch(reader); batch.length > 0 && children.length < budget; batch = await readBatch(reader)) children.push(...batch);
    } catch {
      /* a folder that cannot be listed: what was listed is kept */
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) await visit(child, depth + 1);
  };
  for (const root of roots) await visit(root, 0);
  return out;
}

/**
 * The files a drop carries, with any folder in it opened. The browser lists a
 * dropped folder in `dataTransfer.files` as one item that is not a file, so
 * a folder of bundles was taken as "none of those is a bundle". Called from
 * the drop handler itself: the drag's items can be read only while the drop
 * event is being handled, so the entries are taken now and only the reading
 * of them waits. A drop with no folder in it is `dataTransfer.files`, as
 * before; a browser without entries gets the same.
 */
export function droppedFiles(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return Promise.resolve([]);
  const files = Array.from(dt.files ?? []);
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items.map((item) => (item.kind === 'file' && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  if (!entries.some((entry) => entry?.isDirectory)) return Promise.resolve(files);
  return walkEntries(entries.filter((entry): entry is FileSystemEntry => entry !== null));
}
