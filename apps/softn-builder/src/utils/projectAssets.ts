/**
 * The assets the project has now.
 *
 * Two stores hold assets. The project store's list is filled when a bundle
 * is opened and not again; the file store's is what the Files panel adds
 * to, renames and deletes from, and what an export writes. The image picker
 * and the canvas read the first, so after `logo.png` was deleted and
 * `hero.png` renamed they went on offering both under their old names,
 * while the export held neither.
 *
 * One answer for all three: the file store's assets, each under the path
 * its node has now, for a project that was opened from a bundle or has any;
 * the project store's list only for a project that has neither.
 */

import { useMemo } from 'react';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import type { AssetFile, ProjectFileNode } from '../types/builder';

export function currentAssets(
  files: { assetFiles: Map<string, AssetFile>; nodes: Map<string, ProjectFileNode> },
  project: { assets: AssetFile[]; source: { manifest: unknown } }
): AssetFile[] {
  if (project.source.manifest === null && files.assetFiles.size === 0) return project.assets;
  return [...files.assetFiles.entries()].map(([id, asset]) => ({ ...asset, bundlePath: files.nodes.get(id)?.path ?? asset.bundlePath }));
}

/** Where an asset is in the project: the path a page names it by. */
export function assetPath(asset: AssetFile): string {
  return asset.bundlePath ?? asset.name;
}

/** The project's assets as they are now, for a component to draw from. */
export function useCurrentAssets(): AssetFile[] {
  const assetFiles = useFilesStore((state) => state.assetFiles);
  const nodes = useFilesStore((state) => state.nodes);
  const assets = useProjectStore((state) => state.assets);
  const source = useProjectStore((state) => state.source);
  return useMemo(() => currentAssets({ assetFiles, nodes }, { assets, source }), [assetFiles, nodes, assets, source]);
}
