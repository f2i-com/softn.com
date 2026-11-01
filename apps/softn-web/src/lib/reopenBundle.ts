/**
 * Local imports are not public directory entries, even when names coincide.
 * `directoryFirst`: the address names the directory's app, and a local import
 * of that name is left for the caller's fallback if the directory has none.
 */
export async function reopenBundle<T extends { directorySlug?: string }>(
  findCached: () => Promise<T | undefined | null>,
  openCached: (cached: T) => Promise<string | null>,
  openRemote: (cached?: T | null) => Promise<string | null>,
  directoryFirst = false,
): Promise<string | null> {
  let cached: T | undefined | null;
  try { cached = await findCached(); } catch { return openRemote(); }
  return cached && !cached.directorySlug && !directoryFirst ? openCached(cached) : openRemote(cached);
}
