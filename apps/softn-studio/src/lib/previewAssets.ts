import { classifyAsset } from '@softn/core';
import type { VFSFile } from '../types/studio';
import { isPrivatePath, normalizeProjectPath } from './paths';
import { resolveProjectRelativePath } from './projectImport';

/**
 * Files a page names for the composer, not for the browser: `<logic src="../logic/main.logic" />`
 * is how a page says where its logic is, and is read before anything runs; `<link
 * rel="stylesheet" href="styles.css">` places a stylesheet, and `<a href="about.html">` names a page.
 */
const SOURCE_FILE = /\.(ui|html?|logic|js|py|css|xdb|json|sql)$/i;

/**
 * A bundle file named by its bare path in a `src`, with where and what to
 * write instead.
 *
 * `<Image src="assets/logo.png" />` loads nothing when the app is run: a
 * runtime resolves a bundle file through `asset("assets/logo.png")`, and a
 * bare path is asked of whatever site the app is served from. Studio's
 * preview used to swap every quoted "assets/…" that named a file for a data:
 * URL before the page was parsed, so such a picture drew here and was broken
 * everywhere else, and neither the person nor the agent was told. The preview
 * no longer does that; this finds the uses, for the check to report.
 *
 * Only a literal that names a file the project has is reported, on a `src`,
 * `poster` or `href`, written in quotes or as a quoted string in braces. A
 * path that is worked out (`asset("assets/" + id + ".png")`), or handed to
 * `asset()`, is not one. Nor is a quoted `src` or `poster` on an HTML
 * element, `<img src="assets/logo.png">`: the runtime shows that from the
 * bundle, as an HTML page expects. A component's `src` is the component's,
 * and is still reported.
 */
export function bareAssetPaths(path: string, source: string, files: ReadonlyMap<string, unknown>): string[] {
  const out: string[] = [];
  // Other languages blanked, line numbers kept: a path in the logic is the logic's business.
  const template = source.replace(/<(logic|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block) => block.replace(/[^\n]/g, ' '));
  for (const match of template.matchAll(/(^|[\s<])(src|poster|href)=(?:"([^"]+)"|'([^']+)'|\{\s*"([^"]+)"\s*\}|\{\s*'([^']+)'\s*\})/g)) {
    const written = match[3] ?? match[4] ?? match[5] ?? match[6] ?? '';
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(written)) continue;
    const quoted = match[3] !== undefined || match[4] !== undefined;
    const tag = /^<([A-Za-z][\w.:-]*)/.exec(template.slice(template.lastIndexOf('<', match.index + match[1].length)))?.[1] ?? '';
    if (quoted && match[2] !== 'href' && /^[a-z]/.test(tag)) continue;
    const named = normalizeProjectPath(written.replace(/^\.\//, '')) ?? resolveProjectRelativePath(path, written);
    const file = [named, resolveProjectRelativePath(path, written)].find((candidate) => candidate && !isPrivatePath(candidate) && files.has(candidate));
    if (!file || SOURCE_FILE.test(file)) continue;
    const line = template.slice(0, match.index + match[1].length).split('\n').length;
    out.push(`${path} line ${line}: ${match[2]}="${written}" names a file in the bundle by its bare path, which nothing loads when the app runs (it is asked of the site the app is served from). Write ${match[2]}={asset("${file}")}: asset() is what resolves a bundle file.`);
  }
  return out;
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
