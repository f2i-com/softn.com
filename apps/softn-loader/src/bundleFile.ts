import { sha256Hex } from '@softn/core';
import { readZip, type BundleManifest } from '@softn/runtime-shell/bundleProcessor';
import { detectWebContainer, unwrapContainerZipEntries } from '@softn/runtime-shell/containerBundle';

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

export type DesktopBundleRead = ReturnType<typeof readZip> & {
  isWebContainer: boolean;
  inferredManifest?: BundleManifest;
};

/**
 * A bundle's files as the desktop loader runs them.
 *
 * Which engine runs a bundle is one rule (@softn/bundle-format's engine.ts), read here as
 * the browser runtime reads it: a bundle zipped as its folder is looked inside, and one that
 * says `"engine": 2`, `"container": true`, or has an HTML page and no manifest runs inside
 * `@softn/container` (including full-stack bundles with sandboxed PHP/JS/TS/Rust/Python
 * backends and embedded SQLite).
 */
export function desktopBundleFiles(data: Uint8Array): DesktopBundleRead {
  const zip = readZip(data);
  const { textFiles, binaryFiles } = unwrapContainerZipEntries(zip.textFiles, zip.binaryFiles);
  const kind = detectWebContainer(textFiles, (path) => binaryFiles.has(path));
  return {
    ...zip,
    textFiles,
    binaryFiles,
    isWebContainer: kind.isWebContainer,
    inferredManifest: kind.inferredManifest,
  };
}

/** Whether a path names a .softn file, whatever the case of its extension. */
export function isSoftnPath(value: string): boolean {
  return /\.softn$/i.test(value);
}
