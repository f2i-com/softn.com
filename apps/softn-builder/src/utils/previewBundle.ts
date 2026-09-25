import { classifyAsset, composeBundleSource, rewriteBundleLogicImports, type AppAssetResolver } from '@softn/core';
import type { AssetFile } from '../types/builder';

/**
 * Compose the preview the way the runtime composes the exported bundle: with
 * the manifest export would write (see `previewManifest`), its logic list as
 * the helpers, and the manifest itself among the files, where the composer
 * reads the Python packages the app declares.
 *
 * The helpers used to be every `.logic` and `.py` file the preview was given,
 * besides the declared ones, in whatever order the files came — so a helper
 * ran in a different order than in the exported app, and a path the manifest
 * still named after the file was renamed was offered as well.
 */
export function composePreviewBundle(files: Map<string, string>, main: string, manifest: Record<string, unknown>) {
  const groups = manifest.files as Record<string, unknown> | undefined;
  const logicPaths = Array.isArray(groups?.logic) ? groups.logic.filter((path): path is string => typeof path === 'string') : [];
  const textFiles = new Map(files);
  textFiles.set('manifest.json', JSON.stringify(manifest));
  const composition = composeBundleSource(textFiles, main, logicPaths);
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
