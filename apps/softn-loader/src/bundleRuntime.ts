import {
  composeBundleSource,
  getXDB,
  parseXDBFile,
  seedXDBBundleData,
  type ComposedBundleSource,
} from '@softn/core';

export interface RuntimeBundleManifest {
  main: string;
  files: {
    logic?: string[];
    xdb?: string[];
  };
}

/**
 * A bundle's display name is author-controlled; its bytes are not. Persisted
 * app data therefore belongs to a SHA-256 content identity rather than name.
 */
export async function computeBundleAppId(bundleData: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Secure bundle identity is unavailable in this WebView');
  }

  // Copy the view so an offset Uint8Array never hashes unrelated buffer bytes.
  const digest = await subtle.digest('SHA-256', new Uint8Array(bundleData));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `bundle-${hex}`;
}

/** Shared source composition used by both desktop and browser loaders. */
export function processBundleSource(
  textFiles: ReadonlyMap<string, string>,
  manifest: RuntimeBundleManifest
): ComposedBundleSource {
  return composeBundleSource(textFiles, manifest.main, manifest.files.logic);
}

/**
 * Seed bundle XDB records only while the load that owns them is current.
 *
 * Tauri hydration is asynchronous. A bundle can be replaced during that await,
 * so ownership is checked after readiness and immediately before every
 * synchronous seed batch.
 */
export async function loadBundleXDBData(
  textFiles: ReadonlyMap<string, string>,
  manifest: RuntimeBundleManifest,
  appId: string,
  isActive: () => boolean = () => true
): Promise<number> {
  if (!isActive()) return 0;
  const xdb = getXDB(appId);
  await xdb.isReady;
  if (!isActive()) return 0;

  let insertedTotal = 0;
  for (const xdbFileName of manifest.files.xdb ?? []) {
    if (!isActive()) return insertedTotal;
    const content = textFiles.get(xdbFileName);
    if (content === undefined) continue;

    try {
      const xdbData = parseXDBFile(xdbFileName, content);
      if (!isActive()) return insertedTotal;
      const inserted = seedXDBBundleData(xdb, xdbData);
      insertedTotal += inserted;
      console.log(
        `[SoftN Loader] Loaded ${inserted}/${xdbData.records.length} records into ${xdbData.collection}`
      );
    } catch (error) {
      console.error(`[SoftN Loader] Failed to load XDB file ${xdbFileName}:`, error);
    }
  }
  return insertedTotal;
}
