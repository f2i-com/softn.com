import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
    // jsdom cannot fetch the engine binary the way a browser does — see the file.
    setupFiles: ['./test/setup-wasm.ts'],
  },
});
