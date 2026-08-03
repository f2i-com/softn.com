import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Exercise the parser source directly. Importing the workspace package's
    // dist output makes tests race `tsup --clean` during parallel builds.
    alias: {
      '@softn/core': fileURLToPath(new URL('../core/src/parser/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
