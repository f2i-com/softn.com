# Browser gates

These run locally, not in CI: the shared Verify workflow stays the one gate
(install, audit, build, typecheck, lint, unit suites), and the browser
journeys are run by hand before a release or after a change to the editors,
the hand-off or the site.

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
