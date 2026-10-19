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
