import { defineWorkspaceTest } from '../../vitest.base.mjs';
import { starterVendorsPlugin } from '../../scripts/build/starter-vendors.mjs';
import path from 'node:path';

export default defineWorkspaceTest({
  plugins: [starterVendorsPlugin()],
  resolve: {
    alias: {
      '@softn/core/authoring': path.resolve(import.meta.dirname, '../../packages/@softn/core/src/authoring.ts'),
      '@softn/core/web-host': path.resolve(import.meta.dirname, '../../packages/@softn/core/src/web-host.ts'),
      '@softn/core/renderer': path.resolve(import.meta.dirname, '../../packages/@softn/core/src/renderer/index.ts'),
      '@softn/core': path.resolve(import.meta.dirname, '../../packages/@softn/core/src/index.ts'),
    },
  },
  // The tests live beside the sources.
  test: { include: ['src/**/*.test.ts'] },
});
