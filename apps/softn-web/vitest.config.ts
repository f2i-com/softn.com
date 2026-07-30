import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
  resolve: {
    // @vitejs/plugin-react sets this for the app build and the tests do not go
    // through it. Without it `react` resolves twice — once nested under this
    // workspace, once hoisted for @softn/components — so a test that mounts a
    // component gets a null hook dispatcher the moment rendering crosses from
    // one copy into the other.
    dedupe: ['react', 'react-dom'],
  },
});
