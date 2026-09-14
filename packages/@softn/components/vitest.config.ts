import { defineWorkspaceTest } from '../../../vitest.base.mjs';

export default defineWorkspaceTest({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
  esbuild: {
    jsx: 'automatic',
  },
});
