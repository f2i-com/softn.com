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
