/**
 * Rewrite `src/utils/componentRegistry.drift.json` with the registry's
 * current disagreements against the component manifest. Run it after fixing
 * a registry entry so the baseline says only what is still wrong; the test
 * `componentRegistry.manifest.test.ts` refuses a stale baseline either way.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', 'src/utils/componentRegistry.manifest.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SOFTN_WRITE_DRIFT_BASELINE: '1' },
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
