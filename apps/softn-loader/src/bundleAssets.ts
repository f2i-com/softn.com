import { classifyAsset, type AppAssetResolver } from '@softn/core';

/** Bundle assets keep their original paths so model loaders can find siblings. */
export function createBundleAssetResolver(
  binaryFiles: ReadonlyMap<string, Uint8Array>,
  textFiles: ReadonlyMap<string, string>,
): AppAssetResolver {
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();
  let disposed = false;
  const resolve: AppAssetResolver = (value) => {
    if (disposed || !value) return '';
    const path = value.replace(/\\/g, '/').replace(/^\.\//, '');
    if (path.startsWith('/') || path.split('/').includes('..') || /^[a-z][a-z\d+.-]*:/i.test(path)) return '';
    const cached = urls.get(path);
    if (cached) return cached;
    const binary = binaryFiles.get(path);
    const text = binary ? undefined : textFiles.get(path);
    if (!binary && text === undefined) return '';
    const blob = new Blob([binary ? new Uint8Array(binary) : text!], { type: classifyAsset(path).mime });
    const url = URL.createObjectURL(blob);
    urls.set(path, url);
    paths.set(url, path);
    return url;
  };
  resolve.pathOf = (url) => paths.get(url);
  resolve.dispose = () => {
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    paths.clear();
  };
  return resolve;
}
