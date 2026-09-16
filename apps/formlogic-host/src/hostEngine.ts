/**
 * The host entry: the only place in this build that turns the `host-js` engine
 * on.
 *
 * `host-js` compiles the app author's `.logic` with this document's own
 * JavaScript engine. There is no VM around it, so what contains it is the
 * frame: an opaque origin with no FormLogic cookies, storage or DOM, and a
 * Content-Security-Policy that pins every kind of loading to the runtime
 * directory. Both of those belong to the document, not to the adapter, so both
 * are checked HERE — before `configureLogicEngine` — rather than in the
 * adapter's constructor:
 *
 * - The core test suite creates the adapter directly, in a page that is
 *   neither sandboxed nor this document, and must keep working untouched.
 * - A guard in the constructor would be a guard the engine could be asked to
 *   skip. A guard on the entry is one nothing can reach around: the module is
 *   imported only when `index.html`'s twin document said it was the host one,
 *   and it refuses if either half of that is not true.
 *
 * Neither check is a security boundary on its own — the sandbox attribute and
 * the response headers are set by FormLogic, and they are what actually holds.
 * These are the shell refusing to run host JavaScript anywhere it cannot see
 * the containment it was designed for.
 */

import { configureLogicEngine } from '@softn/core';
import { HostJsEngine } from '@softn/core/host-js';
import { HOST_JS_DOCUMENT } from './engineInit';

/**
 * Configure the host-JavaScript engine for this realm, or refuse with one line
 * the parent can show.
 *
 * Called from the `init` handler once the parent has asked for `host-js` and
 * this document has agreed it serves it, and before anything renders:
 * `configureLogicEngine` freezes at the first engine created, and the renderer
 * reads the engine's thread requirement while it mounts.
 */
export function installHostJsEngine(): void {
  if (document.documentElement.getAttribute('data-softn-logic-engine') !== HOST_JS_DOCUMENT) {
    throw new Error('Host JavaScript runs only in the host app runtime document');
  }
  // An opaque origin is what makes the frame safe to run host JavaScript in:
  // without it the app's code would share FormLogic's origin. `'null'` here is
  // the string the browser reports for a sandbox without allow-same-origin.
  if (self.origin !== 'null') {
    throw new Error('Host JavaScript runs only in a sandboxed frame with its own opaque origin');
  }
  configureLogicEngine(HostJsEngine);
}
