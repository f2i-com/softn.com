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

/** JavaScript logic: `.logic`, or `.js` outside `assets/`. */
export function isJavaScriptLogicPath(path: string): boolean {
  return /\.logic$/i.test(path) || (/\.js$/i.test(path) && !ASSETS.test(path));
}

/** Logic in either language the runtime runs. */
export function isLogicPath(path: string): boolean {
  return isJavaScriptLogicPath(path) || /\.py$/i.test(path);
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
