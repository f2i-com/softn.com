import { defineConfig } from 'vitest/config';

/**
 * The benchmark's own runner config. The main config includes only
 * test/**, so `npm test` never runs this; `npm run bench` does.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench/**/*.bench.ts'],
    testTimeout: 600_000,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
});
