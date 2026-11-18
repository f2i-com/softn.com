import { defineWorkspaceTest } from '../../../vitest.base.mjs';
import { starterVendorsPlugin } from '../../../scripts/build/starter-vendors.mjs';

export default defineWorkspaceTest({
  plugins: [starterVendorsPlugin()],
  test: { environment: 'jsdom', css: { include: [/starters[/\\]styles\.css/] } },
});
