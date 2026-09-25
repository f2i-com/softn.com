# Browser gates

Run these browser journeys after changing the editors, app hand-off or site.
They cover the built deployment in Chromium, Firefox and WebKit, with additional
phone and zoom checks. Every release tag runs the Chromium gate
(`.github/workflows/release.yml`) before anything is packaged; the matrix is run
by hand.

```sh
npm run build:packages
SOFTN_WITH_DEMOS=1 npm run build:site
npm run e2e:install          # Chromium, once
npm run e2e                  # the smoke gate: Chromium, ~10 s
npm run e2e:install:matrix   # Firefox and WebKit, once
npm run e2e:matrix           # every engine, mobile widths, 200 % zoom
```

`scripts/serve-topology.mjs` serves the built `dist/` as one origin — site,
runtime, Studio, Builder and the directory API on a disposable data dir —
and the specs run against it. Traces and per-page console output land in
`e2e/test-results/` on failure.

To point the specs at a server that is already running, set `SOFTN_E2E_URL`;
nothing is started then. The quick smoke specs — Python logic in the runtime,
the undeclared-torch refusal, `/docs/` and its 404, Studio's first visit and the
product bar at 390 px — also pass against `npm run dev`:

```sh
SOFTN_E2E_URL=http://localhost:1420 npx playwright test -c e2e/playwright.config.ts --project=chromium   e2e/tests/python-runtime.spec.ts e2e/tests/docs-and-bar.spec.ts e2e/tests/studio-onboarding.spec.ts
```

The other journeys expect the built site's seeded directory. A new spec file
runs only once its name is added to `desktopSpecs` (or a mobile/zoom pattern)
in `playwright.config.ts`.

If the development API already uses port 1425, set `SOFTN_E2E_PORT=1430` for the
test run. In PowerShell, use `$env:SOFTN_E2E_PORT='1430'` before
`npm run e2e:matrix`.

The Builder export tests also exercise dragging an ER connection, linking a
record, changing cardinality, exporting and reopening the app, and removing
relationships without deleting their fields or data. Directory checks cover
search sort persistence, removable filters and narrow-screen controls.
