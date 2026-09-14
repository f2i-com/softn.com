import { defineWorkspaceTest } from '../../../vitest.base.mjs';

/**
 * The benchmark's own runner config. The main config includes only
 * test/**, so `npm test` never runs this; `npm run bench` does.
 */
export default defineWorkspaceTest({
  test: {
    include: ['bench/**/*.bench.ts'],
    testTimeout: 600_000,
  },
});
