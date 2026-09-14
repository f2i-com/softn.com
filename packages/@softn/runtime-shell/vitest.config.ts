import { defineWorkspaceTest } from '../../../vitest.base.mjs';

// Node by default; a test that renders marks itself `@vitest-environment jsdom`.
export default defineWorkspaceTest();
