## SoftN RELEASE_TAG

### What's new in 0.0.8

- Optional Apache/PHP backend for single-app deployments: on-demand ZIPP WASM execution, SQLite transactions, private configuration, trusted integration hooks and optional photo uploads.
- Authenticated conditional polling and an optional WebSocket bridge. Polling needs no separate service; WebSockets require a running Node process and an Apache reverse proxy.
- Faster browser startup through lazy component loading, demand-read bundles and per-app offline installation.
- Correct CSS declaration and media-query boundaries in rendered apps, valid deployment identifiers and operator-configured permission preapproval for single-app hosting.
- The native Rust host remains available under `apps/softn-rust`; its executable is still `softn-server`.

The backend download targets Linux x86-64 with Apache/PHP and process execution enabled. It is a generic, unconfigured distribution: install your own public and private app bundles and preserve existing configuration, keys and databases when upgrading. Native XDB synchronization remains a Rust-host feature.

### Downloads

| File | What it is |
|------|------------|
| `softn-com-RELEASE_TAG-zipp-*.zip` | The complete static softn.com: the directory, the web runtime, Studio and Builder. Upload its contents to a web host's document root; `DEPLOY.md` inside explains the rest. The `.sha256` beside it is its checksum. |
| `softn-single-RELEASE_TAG.zip` | Lightweight, unbranded single-app runtime with a loading spinner, non-blocking permission bar and bundled-app favicon. Upload its contents, replace `app.softn` and edit `runtime.config.json`; `DEPLOYMENT.md` explains configuration and permissions. A `.sha256` checksum is included. |
| `softn-single-php-linux-x64-RELEASE_TAG.zip` | Single-app browser runtime plus an optional Apache/PHP server backend, bundled Linux x64 Node/SQLite, ZIPP WASM, polling and an optional WebSocket bridge. The backend is unconfigured until you install a private server bundle and run setup. `START-HERE.md` explains both static-only and server-backed deployment. |

The complete website archive's name carries the tag of the zipp engine inside it. It ships no
example apps: the directory starts empty, and `.softn` files dropped on any
page of the site publish into it — one, or a folder at once, with the admin
key from `data/config.json` lifting the hourly limit for the site owner. The
example apps are published as `.softn` downloads with every
[softn-Examples release](https://github.com/f2i-com/softn-Examples/releases).
The desktop loader and builder are not attached to releases; they build from
this tag's manifests with `npm run tauri build` in their apps.

The single-app archive includes a small counter example; replace it with your own bundle. It has no app download controls, but browser-delivered app bytes remain extractable. Required license notices are included in all archives.
