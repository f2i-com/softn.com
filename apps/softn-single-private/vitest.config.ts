import { defineWorkspaceTest } from '../../vitest.base.mjs';

// php-server.test.ts starts PHP's built-in server and waits for it.
export default defineWorkspaceTest({ test: { testTimeout: 30000 } });
