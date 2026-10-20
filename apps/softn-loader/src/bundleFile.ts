import { sha256Hex } from '@softn/core';

/**
 * What the desktop loader knows about a .softn file before it opens it: that
 * it is one, by its name, and which app it is, by its bytes. Reading,
 * composing, seeding and resolving the bundle are @softn/runtime-shell's, as
 * they are in the browser hosts.
 */

/**
 * A bundle's display name is author-controlled; its bytes are not. Persisted
 * app data therefore belongs to a SHA-256 content identity rather than name.
 * Refused, not approximated, where the WebView has no Web Crypto: the loader
 * keys native data by it, and a weaker digest could be aimed at another app.
 */
export async function computeBundleAppId(bundleData: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure bundle identity is unavailable in this WebView');
  }
  return `bundle-${await sha256Hex(bundleData)}`;
}

/** Whether a path names a .softn file, whatever the case of its extension. */
export function isSoftnPath(value: string): boolean {
  return /\.softn$/i.test(value);
}
