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
 * The site's ZIPP folder beside the runtime directory: `/zipp/` where the
 * runtime is `/hosted-runtime/`. A host that serves a ZIPP of its own (from
 * v0.0.36) keeps it there, one folder per ZIPP, and names the files in it in
 * `init`; it is static, the host's own install, and nothing an app sends.
 */
export function zippDirectory(assets: string): string {
  return new URL('../zipp/', assets).href;
}

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
  // anywhere outside the runtime directory and the site's ZIPP folder.
  // `connect-src` names `data:` as well, which is no network at all: it lets
  // the app read its own bundled assets, served as data: URLs (media.ts), with
  // fetch, as a model loader or a compute shader does. Pictures, sound and
  // fonts never needed it. The ZIPP folder is in `script-src` for the one file
  // the shell imports from it, the glue of the ZIPP the host sends (checked
  // against the digest the host names first), and in `connect-src` for that
  // check and for the torch package an app that declares torch is given.
  const hostJavaScript = served.some((id) => NEEDS_UNSAFE_EVAL.includes(id)) ? " 'unsafe-eval'" : '';
  const zipp = zippDirectory(assets);
  return `default-src 'none'; script-src ${assets} ${zipp} 'wasm-unsafe-eval'${hostJavaScript}; connect-src ${assets} ${zipp} data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; form-action 'none'; base-uri 'none'; frame-src 'none'`;
}
