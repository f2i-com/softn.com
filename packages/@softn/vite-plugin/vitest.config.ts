import { defineWorkspaceTest } from '../../../vitest.base.mjs';
import { fileURLToPath } from 'node:url';

export default defineWorkspaceTest({
  resolve: {
    // Exercise the parser source directly. Importing the workspace package's
    // dist output makes tests race `tsup --clean` during parallel builds.
    alias: {
      '@softn/core': fileURLToPath(new URL('../core/src/parser/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
