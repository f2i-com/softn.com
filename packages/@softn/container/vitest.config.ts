import { defineConfig } from 'vitest/config';
import { starterVendorsPlugin } from '../../../scripts/build/starter-vendors.mjs';

export default defineConfig({
  plugins: [starterVendorsPlugin()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
