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
      // Python app logic, run on the real web-python engine. The
      // host-JavaScript engine cannot execute Python at all — that is not a
      // gap this run should work around, it is the property the engine exists
      // within, and `test/python-engine-choice.test.ts` asserts it HERE: it is
      // in this run, and under this configuration it takes the refusing branch
      // of every case. So Python is still tested on the host engine; what is
      // excluded is only the part that needs an engine that can run it.
      'test/python-logic.test.tsx',
      // How Python state is read and written, against the raw engine and the
      // Python adapter — including the ZIPP 0.0.19 setattr primitive the
      // design stands on. Same reason again: there is no Python here to write.
      'test/python-state-write.test.ts',
      // Softn's value normalizer against FormLogic's, on the real engine. Same
      // reason: there is no Python here to normalize. The parts of that
      // contract that need no engine — the capability list, the generated
      // sources, the error rewriting — are in `python-contract.test.ts`, which
      // does run here.
      'test/python-formlogic-dialect.test.ts',
      // A Python app training a torch model. Same reason: there is no Python,
      // and so no torch, on the host engine. What a torch declaration means to
      // the composer and the inspector needs no engine and runs here, in
      // `python-packages.test.ts`.
      'test/python-torch.test.tsx',
    ],
  },
});
