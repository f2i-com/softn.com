/**
 * The same core suite, with the host-JavaScript engine behind the seam.
 *
 *   cd packages/@softn/core && npx vitest run -c vitest.host-js.config.ts
 *
 * Deliberately a config of its own rather than a project of the default run:
 * the default run is the contract for the engine every app actually gets, and
 * its file and test counts stay comparable release to release. This one answers
 * a different question — does `@softn/core/host-js` behave like ZIPP for the
 * bundles the runtime was written against — and is run on demand.
 *
 * `exclude` below is the answer's fine print: every file listed asserts
 * something about ZIPP specifically, and each says which. Nothing here weakens
 * a test; a file is either in the run or named as ZIPP's own.
 */
import { defineWorkspaceTest } from '../../../vitest.base.mjs';

export default defineWorkspaceTest({
  test: {
    name: 'host-js',
    environment: 'jsdom',
    globals: true,
    // setup-wasm first: some of these files drive the ZIPP adapter directly,
    // whatever the seam is configured with.
    setupFiles: ['./test/setup-wasm.ts', './test/setup-host-js.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // The only file excluded, and the only one that fails when it is not.
      // `the default logic engine` asserts what the seam does when NOTHING is
      // configured: that `createLogicEngine()` answers a `VmAdapter` and that
      // `logicEngineThreads()` is `'any'`. This run configures an engine in its
      // setup file, so that premise is false here by construction — the two
      // failures are `is the ZIPP adapter, on any thread, with nothing
      // configured` and `cannot be changed once an engine has been created`,
      // both on the trailing `expect(logicEngineThreads()).toBe('any')`. Both
      // are ZIPP's own contract and both run in the default suite. Nothing in
      // this file is weakened for the host engine's benefit.
      'test/logic-engine-seam.test.ts',
    ],
  },
});
