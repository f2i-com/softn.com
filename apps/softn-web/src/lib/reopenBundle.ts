/** Local imports are not public directory entries, even when names coincide. */
export async function reopenBundle<T extends { directorySlug?: string }>(
  findCached: () => Promise<T | undefined | null>,
  openCached: (cached: T) => Promise<string | null>,
  openRemote: (cached?: T | null) => Promise<string | null>,
): Promise<string | null> {
  let cached: T | undefined | null;
  try { cached = await findCached(); } catch { return openRemote(); }
  return cached && !cached.directorySlug ? openCached(cached) : openRemote(cached);
}
