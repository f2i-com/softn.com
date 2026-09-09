import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'], testTimeout: 30000 },
  resolve: { dedupe: ['react', 'react-dom'] },
});
