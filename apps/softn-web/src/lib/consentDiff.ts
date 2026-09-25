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

import type { CachedApp } from './appCache';

export { diffCapabilities } from '@softn/runtime-shell/consent';
export type { CapabilityChange, PreviousBuild } from '@softn/runtime-shell/consent';

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
