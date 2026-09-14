import { defineWorkspaceTest } from '../../../vitest.base.mjs';

// Node by default; the tests that render mark themselves `@vitest-environment jsdom`.
export default defineWorkspaceTest();
