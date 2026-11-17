import { sha256Hex } from '@softn/core';
import { readZip } from '@softn/runtime-shell/bundleProcessor';
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

/**
 * A bundle's files as the desktop loader runs them, or the reason it does not.
 *
 * Which engine runs a bundle is one rule (@softn/bundle-format's engine.ts), read here as
 * the browser runtime reads it: a bundle zipped as its folder is looked inside, and one that
 * says `"engine": 2`, or has a page and no manifest, is a web container. The loader carries
 * no container. It used to run such a bundle's page as a SoftN page, on the engine its
 * author did not write it for, with whatever the bundle declared live once Allow was
 * pressed; and it answered one with no manifest "The bundle has no manifest.json", which is
 * true of a file that opens everywhere else. Now it says what the file is and where it runs.
 */
export function desktopBundleFiles(data: Uint8Array): ReturnType<typeof readZip> {
  const zip = readZip(data);
  const { textFiles, binaryFiles } = unwrapContainerZipEntries(zip.textFiles, zip.binaryFiles);
  const kind = detectWebContainer(textFiles, (path) => binaryFiles.has(path));
  if (kind.isWebContainer) {
    // The archive is not kept open for an app that will not run.
    binaryFiles.release();
    throw new WebContainerNotRunHereError(webContainerName(textFiles, kind.inferredManifest?.name));
  }
  return { ...zip, textFiles, binaryFiles };
}

/** The name on the refusal: the manifest's, or the page's title; never read as anything but text. */
function webContainerName(textFiles: ReadonlyMap<string, string>, inferred: string | undefined): string {
  let name = inferred;
  try {
    const declared = (JSON.parse(textFiles.get('manifest.json') ?? 'null') as { name?: unknown } | null)?.name;
    if (typeof declared === 'string' && declared.trim()) name = declared;
  } catch {
    // No manifest, or one that is not JSON: the page's title.
  }
  return (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

export class WebContainerNotRunHereError extends Error {
  constructor(appName: string) {
    super(
      `${appName ? `“${appName}”` : 'This file'} is a web app: plain HTML, CSS and scripts, which run in SoftN's web container. ` +
        'SoftN for the desktop runs SoftN apps and does not carry the container yet. Open the file in SoftN Web in a browser, where it runs as it is.'
    );
    this.name = 'WebContainerNotRunHereError';
  }
}

/** Whether a path names a .softn file, whatever the case of its extension. */
export function isSoftnPath(value: string): boolean {
  return /\.softn$/i.test(value);
}
