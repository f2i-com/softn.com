import { composeBundleSource, debug, getXDB, parseXDBFile, seedXDBBundleData, type ComposedBundleSource } from '@softn/core';
import type { BundleManifest } from './bundleFiles';

/**
 * Seed the bundle's XDB files into the app's database; resolves with the
 * number of records written.
 *
 * `isActive` is asked after the database is ready and before every file's
 * seed, so a load that has been replaced while it waited — the desktop
 * loader opens another file, a tab is closed — writes nothing further into a
 * database that is no longer its own. Readiness is asynchronous where the
 * store is native, and a bundle can be replaced during that await.
 */
export async function loadXDBData(
  textFiles: ReadonlyMap<string, string>,
  manifest: Partial<BundleManifest>,
  appId?: string,
  isActive: () => boolean = () => true
): Promise<number> {
  if (!isActive()) return 0;
  const xdb = getXDB(appId);
  const xdbFiles = manifest.files?.xdb ?? [];
  await xdb.isReady;

  let insertedTotal = 0;
  for (const xdbFileName of xdbFiles) {
    if (!isActive()) return insertedTotal;
    const content = textFiles.get(xdbFileName);
    if (!content) continue;

    try {
      const xdbData = parseXDBFile(xdbFileName, content);
      if (!isActive()) return insertedTotal;
      const inserted = seedXDBBundleData(xdb, xdbData);
      insertedTotal += inserted;
      debug(
        `[SoftN] Loaded ${inserted}/${xdbData.records.length} records into ${xdbData.collection}`
      );
    } catch (err) {
      console.error(`[SoftN] Failed to load XDB file ${xdbFileName}:`, err);
    }
  }
  return insertedTotal;
}

/**
 * Process a bundle's main UI file: resolve `<logic src="..."/>` inlining
 * and `<import X from="..."/>` resolution into a single source string.
 * Logic imports stay runtime-resolved, but each fragment's relative paths are
 * canonicalized before the fragments become one parser-visible block.
 */
export function processBundle(
  textFiles: ReadonlyMap<string, string>,
  manifest: Pick<BundleManifest, 'main'> & Partial<BundleManifest>
): ComposedBundleSource {
  // The whole composition, `python` included. This used to be declared as
  // three of its fields, and every host passed on exactly those three — so a
  // Python app reached the renderer with its project dropped and ran as a
  // page with no logic at all.
  const result = composeBundleSource(textFiles, manifest.main, manifest.files?.logic);
  debug('[SoftN] Final source prepared with inlined components');
  return result;
}
