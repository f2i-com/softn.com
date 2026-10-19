/**
 * Logic written as a JavaScript module, read as the script SoftN runs.
 *
 * A file called `main.js` is written the way a `.js` file usually is, by a
 * person or a model: `export function save()`, `import { total } from
 * "./cart.js"`. An app's logic is one script, not modules: every file's
 * top-level names are the page's, and `import "./cart.js"` places a file's
 * code where it stands. So `export` and the named import said nothing the
 * script could use, and each was a syntax error that kept the app from
 * opening. They are read as what they mean here:
 *
 * - `export` before a declaration is dropped, `export default` before a
 *   named function or class too, and `export { a, b }` or `export default
 *   name` is nothing: the names are the page's already.
 * - `import { a, b } from "./cart.js"`, and `export { a } from "./cart.js"`,
 *   are `import "./cart.js"`: the file's code is placed, and its names are
 *   the ones imported.
 *
 * What would mean something else is left as written, and fails as it did: an
 * import that renames (`{ a as b }`), a default or namespace import, a
 * package (`from "lodash"`), an anonymous `export default`. Line for line,
 * so an error's line is still the author's.
 */
export function moduleSyntaxAsScript(code: string): string {
  if (!/\b(?:export|import)\b/.test(code)) return code;
  return code
    .replace(/^([ \t]*)export[ \t]+default[ \t]+(?=(?:async[ \t]+)?function[ \t]*\*?[ \t]*[A-Za-z_$]|class[ \t]+[A-Za-z_$])/gm, '$1')
    .replace(/^([ \t]*)export[ \t]+(?=(?:async[ \t]+)?function\b|class\b|const\b|let\b|var\b)/gm, '$1')
    .replace(/^([ \t]*)export[ \t]+default[ \t]+[A-Za-z_$][\w$]*[ \t]*;?[ \t]*$/gm, '$1')
    .replace(/^([ \t]*)export[ \t]*\{[^}\n]*\}[ \t]*;?[ \t]*$/gm, '$1')
    .replace(
      /^([ \t]*)(?:import|export)[ \t]*\{([^}\n]*)\}[ \t]*from[ \t]*(["'])((?:\.{1,2})?\/[^"'\n]+)\3[ \t]*;?[ \t]*$/gm,
      (line, indent: string, names: string, quote: string, path: string) =>
        /\bas\b/.test(names) ? line : `${indent}import ${quote}${path}${quote}`
    );
}
