import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
  resolve: {
    // The tests do not go through @vitejs/plugin-react, which sets this for
    // the app build. Without it `react` can resolve twice — once nested under
    // this workspace, once hoisted for @softn/brand — and a component rendered
    // across the two copies gets a null hook dispatcher.
    dedupe: ['react', 'react-dom'],
  },
});
