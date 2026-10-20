/**
 * What an app is, and which build of the shell is running: the digest its
 * records and grants belong to, and the build id an offline install holds
 * against. Re-exported by ./appCache.
 */

import { sha256Hex } from '@softn/bundle-format/crypto';
import type { CachedApp } from './appCacheDb';

// ── Identity ─────────────────────────────────────────────────────────

/** Length of the truncated digest earlier records were keyed by. */
export const SHORT_ORIGIN_LENGTH = 16;
/** What an identity computed without a cryptographic hash is prefixed with. */
const INSECURE_ORIGIN_PREFIX = 'insecure-';

/**
 * Derive an app's identity from its contents.
 *
 * Identity used to be `manifest.name`, a string the bundle chooses for itself.
 * The cache upserted on it, permission grants hung off the record it found, and
 * the runtime used it to namespace the app's database — so a bundle that called
 * itself "Notes" was handed the real Notes' stored data, inherited whatever the
 * user had already granted it, and replaced its cached copy. None of that
 * required a flaw to exploit; it was the intended path, taken by an impostor.
 *
 * A digest cannot be claimed, only earned by being the bytes. The whole
 * SHA-256 is kept: it used to be cut to sixteen hex characters, which is
 * short enough that "same identity" and "same bytes" were no longer the same
 * claim, for a saving of forty-eight characters in a key. Display can
 * abbreviate; identity does not.
 */
export async function computeAppOrigin(bundleData: Uint8Array): Promise<string> {
  // Only where crypto.subtle is. sha256Hex has a script digest of its own for
  // a page without it, but such a page keeps the identity below, as it always
  // has: a new one would orphan the data stored under the old. sha256Hex
  // copies the bytes into a plain buffer, so a view over a larger buffer
  // hashes the bundle and not the whole buffer.
  if (globalThis.crypto?.subtle) return sha256Hex(bundleData);
  // crypto.subtle needs a secure context. Without one this keeps apps isolated
  // from each other, which is the point, but it is NOT collision-resistant —
  // someone able to choose bundle bytes could aim at another app's namespace.
  // The prefix says so to everything that reads it: no grant is persisted
  // under such an identity (see recordPermissionGrant), and it can never
  // collide with a real digest's namespace. Serve the runtime over HTTPS or
  // localhost and this branch never runs.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bundleData.length; i++) {
    h1 = Math.imul(h1 ^ bundleData[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bundleData[i], 0x85ebca6b) >>> 0;
  }
  return INSECURE_ORIGIN_PREFIX + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Whether an identity was computed cryptographically, and so may carry
 * durable trust: a persisted permission grant, in particular.
 */
export function isSecureAppOrigin(origin: string | undefined): boolean {
  return Boolean(origin) && !origin!.startsWith(INSECURE_ORIGIN_PREFIX);
}

/** The first characters of an identity, for a label; never for a lookup. */
export function abbreviateOrigin(origin: string | undefined, length = 12): string {
  if (!origin) return '';
  return origin.startsWith(INSECURE_ORIGIN_PREFIX) ? origin : origin.slice(0, length);
}

// ── Build identity ───────────────────────────────────────────────────
//
// A record's offline state is a claim about hashed files: the chunks the
// service worker holds are the ones the shell that installed them references,
// and a new deployment references new names. So the claim is only good
// against the build that made it, and each record carries that build's id.
//
// Nothing in the build hands the page an id. BUILD-INFO.json is written
// beside the site by scripts/build/build-site.mjs, not into the app's env, and
// vite.config.ts defines no VITE_BUILD_ID — one is honoured if a deployment
// sets it. Otherwise the id is the hash Vite put in the entry chunk's name,
// `assets/index-<hash>.js`, which changes whenever the shell's contents do.
// That name is read from the document's own module script rather than from
// any import, because the entry cannot name itself. A dev server serves
// `/src/main.tsx` unhashed, and everything it serves is one build, `dev`.

/** The hash in an entry script's URL, or null for an unhashed (dev) one. */
export function buildIdFromEntry(src: string | null | undefined): string | null {
  if (!src) return null;
  const hashed = /-([A-Za-z0-9_-]{6,})\.js(?:[?#]|$)/.exec(src);
  return hashed ? hashed[1] : null;
}

let buildId: string | null = null;

/** The identifier of the shell build this page is running; constant for the page's life. */
export function currentBuildId(): string {
  if (buildId !== null) return buildId;
  const env = import.meta.env as { VITE_BUILD_ID?: unknown };
  if (typeof env.VITE_BUILD_ID === 'string' && env.VITE_BUILD_ID) {
    buildId = env.VITE_BUILD_ID;
    return buildId;
  }
  const entry =
    typeof document !== 'undefined'
      ? document.querySelector('script[type="module"][src]')?.getAttribute('src')
      : null;
  buildId = buildIdFromEntry(entry) ?? 'dev';
  return buildId;
}

/**
 * Whether a record's last install still holds: it succeeded, and against
 * this build. A record installed before a deployment is stale — the chunks
 * it fetched are the previous release's — and reads as needing a connection
 * until the app is opened online again.
 */
export function isOfflineReady(app: Pick<CachedApp, 'offline'>, build: string = currentBuildId()): boolean {
  return Boolean(app.offline?.ready) && app.offline?.build === build;
}
