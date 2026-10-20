# @softn/runtime-shell

What every host that runs one `.softn` bundle in a browser shares, and
neither the web runtime nor the single-app shell owns:

- `bundleProcessor` — read the archive, compose its source, seed XDB,
  resolve assets and imports, and work out what `permission.json` asked
  for and what is withheld.
- `zipWarmup` and its `zipWorker` — inflate the first screen's entries off
  the main thread, with a main-thread fallback.
- `FrameBar` — the slim bar drawn over an app a directory served.
- `consent` — the rule every host applies to what a bundle declares: the
  app runs at once with all of it withheld (`withheldPermissions`) until the
  person allows it; `requestedCapabilities`, the grant store keyed by app
  identity and declaration (`grantKey`, `hasSavedGrant`, `saveGrant`), and
  what an update newly asks for (`diffCapabilities`).
- `PermissionBar` and `PermissionPrompt` — the bar that asks and the dialog
  behind "What this means". Host-specific words (a browser's own camera
  prompt, storage "on this site") come in through `wording`;
  `DESKTOP_WORDING` is the loader's. Given `appRootRef`, the bar puts focus
  back into the app after Allow.

The web runtime, the desktop loader (`apps/softn-loader`) and the
single-app shell (`@softn/single-shell`) all ask through these, so a bundle
is asked in the same words wherever it is opened. The web runtime keeps its
grants on its cached-app records (by content origin, under its adoption and
secure-context rules) and checks them with `grantCovers`; the loader and the
single-app shell keep theirs in localStorage under their own prefixes.

Also here:

- `net` — whether a remote `import` may be fetched (core's egress rule, the
  one `softn.net.fetch` is held to, local network included), a response body
  read within a bound, and the manifest's sync server as one WebSocket
  address (`resolveServerConfig`).
- `failure` — what a host says when an app will not open.

The hosts import these modules directly; the detailed tests of each are in
this package's `test/`.
