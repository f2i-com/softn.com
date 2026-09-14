import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
  resolve: {
    // Without it `react` can resolve twice — once nested here, once hoisted
    // for an app — and a hook rendered across the two copies gets a null
    // dispatcher.
    dedupe: ['react', 'react-dom'],
  },
});
