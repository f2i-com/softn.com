import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@softn/core': path.resolve(import.meta.dirname, '../../packages/@softn/core/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
