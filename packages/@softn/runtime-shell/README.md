# @softn/runtime-shell

What every host that runs one `.softn` bundle in a browser shares, and
neither the web runtime nor the single-app shell owns:

- `bundleProcessor` — read the archive, compose its source, seed XDB,
  resolve assets and imports, and work out what `permission.json` asked
  for and what is withheld.
- `zipWarmup` and its `zipWorker` — inflate the first screen's entries off
  the main thread, with a main-thread fallback.
- `FrameBar` — the slim bar drawn over an app a directory served.

`apps/softn-web` re-exports these under its old paths
(`src/lib/bundleProcessor`, `src/lib/zipWarmup`, `src/components/FrameBar`),
so nothing that imported them from the app changes. The web app's tests
remain the detailed tests of these modules; this package's own test checks
that the package resolves and its exports are what the shell relies on.
