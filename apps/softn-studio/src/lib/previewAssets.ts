import { classifyAsset } from '@softn/core';
import type { VFSFile } from '../types/studio';
import { isPrivatePath, normalizeProjectPath } from './paths';
import { resolveProjectRelativePath } from './projectImport';

/**
 * The previewed source with each quoted path to one of the project's assets —
 * `src="assets/logo.png"`, `asset('assets/logo.svg')`, a `url()` in a style
 * block, a path in the logic — replaced by the URL the preview serves that
 * file from.
 *
 * Only a path that is a file is replaced. Every quoted string that began
 * `assets/` used to be, and one that named no file by the empty string: so
 * `asset("assets/avatars/" + id + ".png")` lost its folder and showed nothing,
 * in the preview and nowhere else. What is written in stays inside the quotes
 * it is written between: a text file's URL carries the file's text with its
 * apostrophes as they were, and inside `'…'` the first one ended the string.
 */
export function rewriteAssetReferences(source: string, resolveAsset: (path: string) => string): string {
  return source.replace(
    /(["'])(assets\/[^"']+|\.\.\/assets\/[^"']+|\.\/assets\/[^"']+)(\1)/g,
    (written: string, quote: string, assetPath: string) => {
      const url = resolveAsset(assetPath);
      if (!url) return written;
      return `${quote}${url.replace(/'/g, '%27').replace(/"/g, '%22')}${quote}`;
    }
  );
}

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
