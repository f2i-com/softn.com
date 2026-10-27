/**
 * What an update asks for that the build before it did not.
 *
 * Grants belong to a bundle's digest, so a new build always asks again. That
 * is right, and it is also where a capability can slip past: someone who
 * approved "the internet" for v1 reads the v2 bar, sees "the internet and
 * your files", and presses Allow the way they did last time. The bar says
 * what changed; the diff itself is @softn/runtime-shell's, and finding the
 * build to compare against is this runtime's, because only it keeps a
 * library of builds.
 */

import type { BundleArchive, PermissionConfig } from '@softn/core';
import { extractPermissions, readZip, requestedCapabilities, type BundleManifest } from '@softn/runtime-shell/bundleProcessor';
import { declarationKey, type PreviousBuild } from '@softn/runtime-shell/consent';
import type { CachedApp } from './appCache';

export { diffCapabilities } from '@softn/runtime-shell/consent';
export type { PreviousBuild } from '@softn/runtime-shell/consent';

/**
 * The build of this app the user opened most recently before this one: same
 * name, a different digest. Name is the right key here — this is a
 * presentation decision about what to compare against, and it grants
 * nothing; a mismatch only means the bar shows no comparison.
 */
export function previousBuildFor(apps: readonly CachedApp[], name: string, origin: string): CachedApp | null {
  const others = apps.filter((a) => a.name === name && a.origin && a.origin !== origin);
  if (others.length === 0) return null;
  return [...others].sort((a, b) => b.lastOpened - a.lastOpened)[0];
}

/**
 * What a cached bundle's permission.json declares, read from the bytes:
 * `null` for a bundle that declares nothing, `undefined` for one that could
 * not be read.
 */
function permissionsOf(bundleData: Uint8Array): PermissionConfig | null | undefined {
  let archive: BundleArchive | undefined;
  try {
    const zip = readZip(bundleData);
    archive = zip.archive;
    const manifestText = zip.textFiles.get('manifest.json');
    const manifest = (manifestText ? JSON.parse(manifestText) : {}) as BundleManifest;
    return extractPermissions(zip.textFiles, manifest) ?? null;
  } catch {
    return undefined;
  } finally {
    // A peek at the manifest, not an open: nothing will read an asset from it.
    archive?.release();
  }
}

/**
 * The earlier build as the bar compares it: what it asked for, and whether
 * it declared exactly what this one (`current`) does. The bar may say "the
 * same" only of the same declaration: a v2 that dropped v1's host list asks
 * for "the internet" too, and reaches any host.
 */
export function describePreviousBuild(prev: CachedApp, current: PermissionConfig): PreviousBuild {
  const declared = permissionsOf(prev.bundleData);
  return {
    version: prev.version,
    capabilities: prev.requestedCapabilities ?? (declared ? requestedCapabilities(declared) : []),
    // Read as this build's is: nothing declared is `{ permissions: {} }`.
    sameDeclaration: declared === undefined ? undefined : declarationKey(declared ?? { permissions: {} }) === declarationKey(current),
  };
}
