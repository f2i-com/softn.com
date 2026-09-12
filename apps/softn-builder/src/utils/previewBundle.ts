import { classifyAsset, composeBundleSource, rewriteBundleLogicImports, type AppAssetResolver } from '@softn/core';
import type { AssetFile } from '../types/builder';

/** Use the runtime's helper/component/entry order and its import deduplication. */
export function composePreviewBundle(files: Map<string, string>, main: string, manifest: Record<string, unknown> | null) {
  const groups = manifest?.files as Record<string, unknown> | undefined;
  const declared = Array.isArray(groups?.logic) ? groups.logic.filter((path): path is string => typeof path === 'string') : [];
  const logicPaths = [...new Set([...declared, ...[...files.keys()].filter((path) => path.endsWith('.logic'))])];
  const composition = composeBundleSource(files, main, logicPaths);
  return {
    ...composition,
    importResolver: async (path: string): Promise<string | null> => {
      const canonical = path.replace(/^\.\//, '');
      const source = files.get(canonical);
      return source === undefined ? null : rewriteBundleLogicImports(source, canonical);
    },
  };
}

/** Local preview files get disposable URLs, including assets outside assets/. */
export function createPreviewAssets(files: ReadonlyMap<string, AssetFile>): AppAssetResolver {
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();
  let disposed = false;
  const resolve = ((path: string): string => {
    if (disposed || typeof path !== 'string' || path.startsWith('/') || /(^|[\\/])\.\.([\\/]|$)/.test(path)) return '';
    const canonical = path.replace(/^\.\//, '');
    const cached = urls.get(canonical);
    if (cached) return cached;
    const file = files.get(canonical);
    if (!file) return '';
    const url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: classifyAsset(canonical).mime }));
    urls.set(canonical, url);
    paths.set(url, canonical);
    return url;
  }) as AppAssetResolver;
  resolve.pathOf = (url) => paths.get(url);
  resolve.dispose = () => {
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear(); paths.clear();
  };
  return resolve;
}
