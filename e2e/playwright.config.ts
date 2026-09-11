/**
 * The browser smoke gate, against the BUILT deployment.
 *
 * Every spec here drives the site, the runtime, Studio, Builder and the
 * directory API as one origin at their deployed paths, served by
 * scripts/serve-topology.mjs from dist/. Nothing is built by this config:
 * `npm run e2e` expects `SOFTN_WITH_DEMOS=1 npm run build:site` to have run
 * (after `npm run build:packages` on a fresh checkout), and the server
 * script refuses to start on a root that is not that build, naming what is
 * missing. The unit suites test each app on its own; this is the one place
 * a hand-off staged by one app is claimed by another in a real browser, with
 * real IndexedDB, real `rel="noopener"` semantics and the real router.
 *
 * Chromium only, for the gate: it has to be fast and steady on every push.
 * The broader browser and fault matrix in the audit's TEST_PLAN.md is for
 * scheduled or release verification and is not this file.
 *
 * Where a spec fails, the trace, the screenshot and the console log the
 * helpers attach are in test-results/, which the CI job uploads.
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * A fixed port, so the base URL is known before the server is up. Override
 * with SOFTN_E2E_PORT; point SOFTN_E2E_URL at a server started by hand
 * (`node scripts/serve-topology.mjs --port 1425 --keep-data`) to skip
 * starting one here and keep its data directory afterwards.
 */
const port = Number(process.env.SOFTN_E2E_PORT || 1425);
const baseURL = process.env.SOFTN_E2E_URL || `http://127.0.0.1:${port}`;
const externalServer = Boolean(process.env.SOFTN_E2E_URL);
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: path.join(here, 'tests'),
  outputDir: path.join(here, 'test-results'),
  // A journey crosses two apps and a PHP server that, on Windows, answers one
  // request at a time; the runtime alone fetches dozens of chunks and a wasm
  // engine on first load.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // One worker: the specs share one directory (the publish spec creates an
  // app the others could see) and, on the built-in PHP server, parallel
  // pages only queue behind each other.
  workers: 1,
  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(here, 'playwright-report') }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: path.join(here, 'playwright-report') }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Studio, Builder and the runtime are desktop layouts; Builder shows a
    // notice instead of the editor under 900px.
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: externalServer
    ? undefined
    : {
        command: `node scripts/serve-topology.mjs --port ${port}`,
        cwd: repoRoot,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !isCI,
        timeout: 90_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
