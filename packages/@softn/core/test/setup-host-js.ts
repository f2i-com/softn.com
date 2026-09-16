/**
 * Run the whole suite on the host-JavaScript engine instead of ZIPP.
 *
 * `vitest.host-js.config.ts` only. The engine seam is module-level state, and
 * vitest gives each test file its own module registry, so configuring it in a
 * setup file configures it for that file — before any test can create an
 * engine, which is what `configureLogicEngine` requires.
 *
 * The point is the contract: `SoftNScriptRuntime` and everything above it were
 * written against ZIPP, and an engine behind the same seam has to behave the
 * same way for the same bundles. A divergence found here is a divergence an
 * app author would meet in the one frame that has no VM around it.
 */
import { configureLogicEngine } from '../src/runtime/vm-adapter';
import { HostJsEngine } from '../src/runtime/host-js';

configureLogicEngine(HostJsEngine);
