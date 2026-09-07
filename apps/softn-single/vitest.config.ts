import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
  resolve: { dedupe: ['react', 'react-dom'] },
});
