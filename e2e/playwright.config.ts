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
 * Two tiers share this file, told apart by project:
 *
 *   - `chromium` is the per-commit gate (`npm run e2e`): every desktop spec,
 *     one browser, fast and steady on every push.
 *   - The rest are the matrix the audit's TEST_PLAN.md §1 asks for on a
 *     schedule or a release (`npm run e2e:matrix`, .github/workflows/
 *     e2e-matrix.yml): the same desktop specs in Firefox and WebKit, Studio's
 *     phone layout at 390 and 360 px with touch and reduced motion, and the
 *     desktop editors at 200 % zoom. The gate never waits on these — a
 *     WebKit download or a phone-only regression is a scheduled failure,
 *     not a blocked merge.
 *
 * Where a spec fails, the trace, the screenshot and the console log the
 * helpers attach are in test-results/, which the CI jobs upload.
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

/** Studio, Builder and the runtime are desktop layouts; Builder shows a notice instead of the editor under 900px. */
const desktop = { width: 1280, height: 800 };

/**
 * The specs written for a desktop window: the seven journeys of the gate
 * plus the cheap UX checks. Phone and zoom specs are matched by name below
 * and never run in a desktop project.
 */
const desktopSpecs = /\/(studio-handoff|builder-handoff|site-publish-keys|directory-navigation|site-not-found|builder-export-dialog|browser-capabilities)\.spec\.ts$/;

/** The specs that only make sense at a phone width: Studio's mobile editor. */
const mobileSpecs = /\/studio-mobile\.spec\.ts$/;

/**
 * 200 % zoom, as a browser does it: the CSS viewport halves and the device
 * pixel ratio doubles, so a 1920×1080 monitor gives the page 960×540 CSS
 * pixels. 960 keeps the desktop layouts (Studio switches to its phone layout
 * under 768, Builder refuses under 900), which is the point — this is the
 * desktop editor with everything twice the size, not the phone editor.
 */
const zoom200 = { viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 };

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
    viewport: desktop,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // ── The per-commit gate ────────────────────────────────────────────
    {
      name: 'chromium',
      testMatch: desktopSpecs,
      use: { ...devices['Desktop Chrome'], viewport: desktop },
    },

    // ── The scheduled / release matrix ─────────────────────────────────
    // The same desktop journeys in the other two engines. What differs
    // between them is documented in docs/ and the matrix report, not
    // papered over here: Firefox and WebKit have no File System Access API,
    // so a Builder save or a Studio export is a download in both, and WebKit
    // serialises its downloads through a sheet the automation cannot see.
    // The journeys assert what is portable — staging, the ready link, the
    // receiver, the key store — and never a native file handle.
    {
      name: 'firefox',
      testMatch: desktopSpecs,
      use: { ...devices['Desktop Firefox'], viewport: desktop },
    },
    {
      name: 'webkit',
      testMatch: desktopSpecs,
      use: { ...devices['Desktop Safari'], viewport: desktop },
    },
    // Studio's phone layout: a Pixel-class 390×844 viewport with touch, and
    // `prefers-reduced-motion: reduce`, which the audit asks to be covered
    // once. Nothing in the mobile journey depends on an animation finishing,
    // so a layout that skips its transitions under the preference must pass
    // the same assertions.
    {
      name: 'mobile-chromium',
      testMatch: mobileSpecs,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        reducedMotion: 'reduce',
      },
    },
    // The narrowest width the audit names. Same spec, same engine; only the
    // width changes, so a control that fits at 390 and clips at 360 is seen.
    {
      name: 'mobile-chromium-360',
      testMatch: mobileSpecs,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 360, height: 780 },
      },
    },
    // The desktop editors at 200 % zoom: Studio's hand-off journey as-is,
    // plus the reflow spec that checks the primary actions stay visible and
    // clear of the chat composer.
    {
      name: 'zoom-200',
      testMatch: /\/(studio-handoff|studio-zoom)\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], ...zoom200 },
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
