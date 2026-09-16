/**
 * `@softn/core/host-js` — the host-JavaScript logic engine, on its own.
 *
 * A separate entry, and the only place this engine is reachable from: the
 * default entry and every other subpath never import it, so a build that does
 * not ask for host JavaScript does not contain it. `scripts/
 * host-js-isolation.test.mjs` holds that: the editors, the web app and the
 * ZIPP entry document must not carry {@link HOST_JS_ENGINE_MARK}.
 *
 *   import { configureLogicEngine } from '@softn/core';
 *   import { HostJsEngine } from '@softn/core/host-js';
 *   configureLogicEngine(HostJsEngine);   // before anything renders
 *
 * Read the adapter's own header before doing that. It runs the app author's
 * code as the page's code; what contains it is the frame around the page, and
 * deciding that frame is good enough is the host's decision, not this module's.
 */

export {
  HOST_JS_BRIDGE_PREAMBLE,
  HOST_JS_ENGINE_MARK,
  HostJsAdapter,
  HostJsEngine,
} from './host-js-adapter';
export type { HostJsEngineFactory, HostJsLocalStorageBridge } from './host-js-adapter';
