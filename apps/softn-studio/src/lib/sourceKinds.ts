/**
 * Which of a project's files are pages and which are logic, from their names:
 * the one place Studio says it.
 *
 * A page is `.ui`, or `.html` as a page written the way an HTML page is
 * written is named; logic is JavaScript in a `.logic` or `.js` file, or
 * Python in a `.py` file. A new project is `index.html`, `pages/*.html` and
 * `main.js`; one made before is `ui/*.ui` and `logic/*.logic`, and both run
 * the same, because the runtime finds a page or its logic by what names it
 * (`main`, `<import from>`, `<script src>`), never by its extension.
 *
 * A file under `assets/` is one the app shows or serves, whatever its name,
 * so an `assets/help.html` is not a page and an `assets/chart.js` is not code
 * the app runs.
 */

import { logicImportPaths, pageLogicSources, resolveBundlePath } from '@softn/core';

const ASSETS = /^assets\//i;

/** A page of the app: `.ui`, `.html` or `.htm`, outside `assets/`. */
export function isPagePath(path: string): boolean {
  return /\.(ui|html?)$/i.test(path) && !ASSETS.test(path);
}

/** JavaScript or TypeScript logic: `.logic`, or `.js/.mjs/.ts/.tsx/.mts/.jsx` outside `assets/`. */
export function isJavaScriptLogicPath(path: string): boolean {
  return /\.logic$/i.test(path) || (/\.(?:m?js|tsx?|mts|jsx)$/i.test(path) && !ASSETS.test(path));
}

/** Logic in any language the runtime runs. */
export function isLogicPath(path: string): boolean {
  return isJavaScriptLogicPath(path) || (/\.py$/i.test(path) && !ASSETS.test(path));
}

/**
 * Determine whether `files` is a SoftN v2 Web App Container (`'web'`, run by `@softn/container`)
 * or a legacy v1 SoftN template bundle (`'legacy-ui'`, run by `@softn/core`).
 */
export function projectContainerMode(
  files: ReadonlyMap<string, { content: string | Uint8Array }>,
  brief?: { appFormat?: 'container' | 'ui'; logicLanguage?: string } | null
): 'web' | 'legacy-ui' {
  if (files.size === 0) {
    if (brief?.appFormat === 'container' || brief?.logicLanguage === 'typescript') return 'web';
    return 'legacy-ui';
  }

  let manifestMain: string | null = null;
  const manifestFile = files.get('manifest.json');
  if (manifestFile && typeof manifestFile.content === 'string') {
    try {
      const parsed = JSON.parse(manifestFile.content) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.engine === 2 || parsed.container === true) return 'web';
        if (typeof parsed.main === 'string') manifestMain = parsed.main;
        else if (typeof parsed.entry === 'string') manifestMain = parsed.entry;
      }
    } catch {
      // Fall through to entry inspection
    }
  }

  // TypeScript modules outside assets/ only run in the v2 container engine
  for (const path of files.keys()) {
    if (!/^builder\//i.test(path) && !ASSETS.test(path) && /\.(?:tsx?|mts)$/i.test(path)) {
      return 'web';
    }
  }

  const entryPath =
    (manifestMain && files.has(manifestMain) ? manifestMain : null) ??
    (files.has('index.html') ? 'index.html' : files.has('ui/main.ui') ? 'ui/main.ui' : null);

  if (!entryPath || /\.ui$/i.test(entryPath)) return 'legacy-ui';

  const entryFile = files.get(entryPath);
  const entryText = entryFile && typeof entryFile.content === 'string' ? entryFile.content : '';
  if (!entryText) return brief?.appFormat === 'container' ? 'web' : 'legacy-ui';

  if (/<logic[\s>]|<import\s+[A-Z]\w*\s+from\s*=|<data>\s*<collection\b|^\s*#(?:if|each)\b/m.test(entryText)) {
    return 'legacy-ui';
  }
  if (!/<!doctype\s+html/i.test(entryText) && !/<html[\s>]/i.test(entryText) && /<App[\s>]/.test(entryText)) {
    return 'legacy-ui';
  }
  if (
    /<!doctype\s+html/i.test(entryText) ||
    /<html[\s>]/i.test(entryText) ||
    /<script\b[^>]*\btype\s*=\s*["']?(?:module|text\/python)["']?/i.test(entryText)
  ) {
    return 'web';
  }
  return brief?.appFormat === 'container' ? 'web' : 'legacy-ui';
}

/**
 * The `.js` files that are the app's code: those its pages link with
 * `<script src>` or `<logic src>`, and what those import, followed. A `.js`
 * file nothing links is one the app carries, not code it runs: a library a
 * page loads for itself, a service worker, the runtime's own loader. Read by
 * the composer's rules (core's pageLogicSources and logicImportPaths).
 */
export function linkedScripts(texts: ReadonlyMap<string, string>): Set<string> {
  const linked = new Set<string>();
  const follow = (path: string): void => {
    if (linked.has(path) || !/\.js$/i.test(path)) return;
    const text = texts.get(path);
    if (text === undefined) return;
    linked.add(path);
    for (const imported of logicImportPaths(text, path)) follow(imported);
  };
  for (const [path, text] of texts) {
    if (!isPagePath(path)) continue;
    for (const src of pageLogicSources(text)) {
      try {
        follow(resolveBundlePath(path, src));
      } catch {
        // An unsafe path; the composer refuses it, in its own words.
      }
    }
  }
  return linked;
}
