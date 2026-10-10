/**
 * The `pages` list of a manifest, kept true to the project's files.
 *
 * Studio writes into each manifest the pages an app was planned with:
 * `pages: [{ id, name, path, route }]`, where `path` is the page's UI file.
 * The Builder does not model the list. It carries the manifest it opened
 * through to the export with every field it does not edit as it was, which
 * is right for a field that describes nothing the Builder changes, and was
 * wrong for this one: a page renamed here left with the list still naming
 * the old file, and Studio, finding a page whose file is not there, threw
 * the whole list away.
 *
 * What a list that names files needs is for the names to follow the files:
 *
 *  - a page that is renamed or moved, alone or with its folder, is the same
 *    entry at its new path;
 *  - a page that is deleted leaves the list;
 *  - a UI file made here is not added. The list is the app's routes, as its
 *    shell shows them: a new file has no route until the shell is given
 *    one, and no name but its file's;
 *  - a manifest that has no list is not given one.
 *
 * Files are told apart by their ids, so a rename is not mistaken for a
 * delete and a new file of an old name is not mistaken for the page.
 */

interface Located {
  path: string;
}

const plain = (path: string): string => (path.startsWith('/') ? path.slice(1) : path);

/**
 * `manifest` with its pages following the UI files from `before` to
 * `after` (each by file id). The same object when nothing in it moves, and
 * for a manifest with no list.
 */
export function pagesFollowing<M extends Record<string, unknown> | null>(
  manifest: M,
  before: ReadonlyMap<string, Located>,
  after: ReadonlyMap<string, Located>
): M {
  if (!manifest || !Array.isArray(manifest.pages) || before === after) return manifest;
  const moved = new Map<string, string>();
  const gone = new Set<string>();
  for (const [id, file] of before) {
    const now = after.get(id);
    if (!now) gone.add(plain(file.path));
    else if (now.path !== file.path) moved.set(plain(file.path), plain(now.path));
  }
  if (moved.size === 0 && gone.size === 0) return manifest;
  // A path a file has just been given is that file's, whatever left it a moment ago.
  for (const file of after.values()) gone.delete(plain(file.path));

  let changed = false;
  const pages: unknown[] = [];
  for (const entry of manifest.pages as unknown[]) {
    const path = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).path : undefined;
    if (typeof path !== 'string') {
      pages.push(entry);
      continue;
    }
    const to = moved.get(plain(path));
    if (to !== undefined) {
      pages.push({ ...(entry as Record<string, unknown>), path: to });
      changed = true;
    } else if (gone.has(plain(path))) {
      changed = true;
    } else {
      pages.push(entry);
    }
  }
  return changed ? ({ ...manifest, pages } as M) : manifest;
}
