import { defineWorkspaceTest } from '../../vitest.base.mjs';
import path from 'node:path';

export default defineWorkspaceTest({
  resolve: {
    alias: {
      '@softn/core': path.resolve(import.meta.dirname, '../../packages/@softn/core/src/index.ts'),
    },
  },
  // The tests live beside the sources.
  test: { include: ['src/**/*.test.ts'] },
});
