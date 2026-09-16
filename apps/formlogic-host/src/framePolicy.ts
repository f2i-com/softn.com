/**
 * The Content-Security-Policy this shell writes over itself, as one pure
 * function of where its assets are and which engines the document serves.
 *
 * The shell is trusted code in an opaque-origin iframe; the policy pins every
 * kind of loading to the trusted runtime directory before any app source is
 * accepted. It is written as a `<meta>` element at the top of `main.tsx`,
 * which means it can only ever be TIGHTENED afterwards — a second meta policy
 * intersects with the first, it never widens it. So the policy has to be
 * decided before anything else happens, from the document alone, and a
 * document that needs a weaker one has to be a different document.
 *
 * That is the whole reason `host.html` exists. The `host-js` engine runs the
 * app author's `.logic` as this document's own JavaScript, which needs
 * `'unsafe-eval'` in `script-src`; `index.html` must not have it, and could
 * not drop it later if it did. So the one token is added here, for the one
 * document that serves that one engine, and `apps/formlogic-host/test/
 * policy.test.mjs` pins both strings.
 */

// A type-only import: this module is the policy and nothing else, and it has
// to be readable — and testable — without loading anything that talks to the
// parent.
import type { EngineId } from './engineInit';

/**
 * The engines that cannot exist without `'unsafe-eval'`, and the only reason
 * any document's policy differs from any other's. Host JavaScript is compiled
 * by the document's own engine; ZIPP compiles inside WebAssembly, which
 * `'wasm-unsafe-eval'` already covers.
 */
const NEEDS_UNSAFE_EVAL: readonly EngineId[] = ['host-js'];

/**
 * The policy for a document serving `served`, with `assets` the trusted
 * runtime directory (an absolute URL ending in `/`).
 *
 * Exactly one token depends on the engines: `'unsafe-eval'`, and only when
 * host JavaScript is among them. Everything else is the same string for every
 * document, which is what makes the two readable side by side.
 */
export function framePolicy(assets: string, served: readonly EngineId[]): string {
  // Nothing else is relaxed: the app still cannot fetch, load or navigate
  // anywhere outside the runtime directory.
  const hostJavaScript = served.some((id) => NEEDS_UNSAFE_EVAL.includes(id)) ? " 'unsafe-eval'" : '';
  return `default-src 'none'; script-src ${assets} 'wasm-unsafe-eval'${hostJavaScript}; connect-src ${assets}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; form-action 'none'; base-uri 'none'; frame-src 'none'`;
}
