import { defineWorkspaceTest } from '../../../vitest.base.mjs';

export default defineWorkspaceTest({
  test: {
    environment: 'jsdom',
    globals: true,
    // jsdom cannot fetch the engine binary the way a browser does — see the file.
    setupFiles: ['./test/setup-wasm.ts'],
  },
});
