import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
  resolve: {
    // Matches the runtime's config for the same reason: without it `react`
    // resolves twice — once nested here, once hoisted for @softn/components —
    // and anything that renders gets a null hook dispatcher as soon as it
    // crosses from one copy into the other.
    dedupe: ['react', 'react-dom'],
  },
});
