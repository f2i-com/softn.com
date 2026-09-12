# Browser gates

Run these browser journeys manually before a release or after changing the
editors, app hand-off or site. They cover the built deployment in Chromium,
Firefox and WebKit, with additional phone and zoom checks.

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

If the development API already uses port 1425, set `SOFTN_E2E_PORT=1430` for the
test run. In PowerShell, use `$env:SOFTN_E2E_PORT='1430'` before
`npm run e2e:matrix`.

The Builder export tests also exercise dragging an ER connection, linking a
record, changing cardinality, exporting and reopening the app, and removing
relationships without deleting their fields or data. Directory checks cover
search sort persistence, removable filters and narrow-screen controls.
