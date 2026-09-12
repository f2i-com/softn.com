/** Compatibility entry for existing loader build commands. */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appDir = path.resolve(__dirname, '..');
const generator = path.resolve(appDir, '../../scripts/generate-native-icons.mjs');
const result = spawnSync(process.execPath, [generator, appDir], {
  cwd: appDir, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
