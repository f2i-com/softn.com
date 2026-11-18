import { fileURLToPath } from 'node:url';
import { defineWorkspaceTest } from '../../vitest.base.mjs';
import { starterVendorsPlugin } from '../../scripts/build/starter-vendors.mjs';

export default defineWorkspaceTest({
  plugins: [starterVendorsPlugin()],
  test: { css: { include: [/starters[/\\]styles\.css/] } },
  resolve: {
    alias: {
      // The build's plugin provides this module (scripts/build/pwa.mjs); a test that draws
      // PWAPrompt gets a hook it can set (test/helpers/pwaHook.ts).
      'virtual:softn-pwa/react': fileURLToPath(new URL('./test/helpers/pwaHook.ts', import.meta.url)),
    },
  },
});
