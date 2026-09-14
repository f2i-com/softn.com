import { classifyAsset } from '@softn/core';
import type { AssetResolver } from '../../softn-web/src/lib/bundleProcessor';

/**
 * The URL the host serves one bundle entry under.
 *
 * Relative to the endpoint, never absolute: the runtime's markup judge treats
 * a URL with no scheme as this origin and asks for no capability, while
 * `https://…` would need the bundle's `net` grant to show its own images.
 * Slashes are left readable in the query; nothing in the path needs
 * percent-encoding for the query string except what encodeURIComponent does.
 */
export function entryUrl(endpoint: string, path: string): string {
  return endpoint + '?entry=' + encodeURIComponent(path).replace(/%2F/g, '/');
}

function isPathAbsolute(endpoint: string): boolean {
  return endpoint.startsWith('/') && !endpoint.startsWith('//') && !endpoint.startsWith('/\\');
}

/**
 * `asset("images/x.png")` for an app whose entries live on the server.
 *
 * The archive resolver in softn-web inflates the entry and mints a blob: URL;
 * this one has no archive and answers with the entry's own URL, so the
 * browser fetches an image when it renders it, the way it does for any page.
 * The contract is the same — synchronous, one URL per path, `pathOf` for the
 * model loaders that resolve a .gltf's siblings against the archive
 * directory — and the refusals are the same: nothing that climbs out of the
 * bundle, and an empty string for a path the bundle lacks.
 *
 * Text entries came down in the source pack rather than as URLs, so an
 * `asset("data/levels.json")` is served from that map as a blob: URL, exactly
 * as the archive resolver serves a text-classified entry.
 */
export function createServedAssetResolver(
  endpoint: string,
  entries: ReadonlySet<string>,
  textFiles: ReadonlyMap<string, string>
): AssetResolver {
  if (!isPathAbsolute(endpoint)) throw Error('Endpoint must be a path on this origin');
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();
  const blobs: string[] = [];
  let disposed = false;

  const resolve = ((assetPath: string): string => {
    if (disposed) return '';
    if (typeof assetPath !== 'string' || !assetPath) return '';
    if (assetPath.includes('..') || assetPath.startsWith('/') || /^[a-zA-Z]:/.test(assetPath))
      return '';
    const path = assetPath.replace(/^\.\//, '');
    const cached = urls.get(path);
    if (cached) return cached;

    let url: string;
    if (entries.has(path)) {
      url = entryUrl(endpoint, path);
    } else {
      const text = textFiles.get(path);
      if (text === undefined) return '';
      try {
        url = URL.createObjectURL(new Blob([text], { type: classifyAsset(path).mime }));
      } catch {
        return '';
      }
      blobs.push(url);
    }
    urls.set(path, url);
    paths.set(url, path);
    return url;
  }) as AssetResolver;

  resolve.pathOf = (url: string) => paths.get(url);

  resolve.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const url of blobs) URL.revokeObjectURL(url);
    blobs.length = 0;
    urls.clear();
    paths.clear();
  };

  return resolve;
}
