import { classifyAsset } from '@softn/core';
import type { VFSFile } from '../types/studio';
import { isPrivatePath, normalizeProjectPath } from './paths';
import { resolveProjectRelativePath } from './projectImport';

/** Resolve local bundle assets without depending on an assets/ directory. */
export function createPreviewAssetResolver(files: ReadonlyMap<string, VFSFile>, ownerPath: string) {
  const urls = new Map<string, string>();
  return (assetPath: string): string => {
    if (/^(data:|blob:|https?:\/\/)/i.test(assetPath)) return assetPath;
    const candidates = [
      normalizeProjectPath(assetPath.replace(/^\.\//, '')),
      resolveProjectRelativePath(ownerPath, assetPath),
      normalizeProjectPath(`assets/${assetPath}`),
    ];
    for (const path of candidates) {
      if (!path || isPrivatePath(path)) continue;
      const file = files.get(path);
      if (!file) continue;
      const cached = urls.get(path);
      if (cached) return cached;
      // Use the runtime's MIME table: imported JPEG, WebP, audio and font files
      // must not be served as application/octet-stream in the Studio canvas.
      const { mime } = classifyAsset(path);
      let url: string;
      if (typeof file.content === 'string') {
        url = `data:${mime};charset=utf-8,${encodeURIComponent(file.content)}`;
      } else {
        let binary = '';
        for (const byte of file.content) binary += String.fromCharCode(byte);
        url = `data:${mime};base64,${btoa(binary)}`;
      }
      urls.set(path, url);
      return url;
    }
    return '';
  };
}
