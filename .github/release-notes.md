## SoftN RELEASE_TAG

### What's new in 0.0.9

- Privately served single app: `softn-single-php-serve` hosts one `.softn` from PHP without ever putting the archive on a URL. The page is rendered on the server, the runtime fetches the app's text once and each asset on demand behind a signed viewer cookie, and browser navigations, cross-site fetches and withheld entries are refused. Delivery control, not copy protection: a browser still receives what it executes.
- `softn-private-single-php-linux-x64`: that host together with the optional Apache/PHP backend (bundled Linux x64 Node, SQLite and ZIPP WASM) in one archive, with a merged `.htaccess` that routes `/api/…`.
- A whole-project review, with fixes across the engine, components, browser hosts, the app directory and the scripts: CSS-escape and `background`/Markdown/SmartCards egress bypasses closed, `softn.qr.decode` held to the `net` gate, scripts can no longer overwrite host globals, deletes inside VM functions no longer resurrect on offline peers, a parser hang and prototype-chain identifier lookups fixed, unclosed tags diagnosed, server sync keeps offline writes, AI downloads bounded and judged, the COI service worker no longer breaks redirected navigations, an open redirect in `?back=` closed, and an oversized manifest can no longer take the whole directory down.
- The app directory skips a broken app folder and serves the rest, keeping the folder's files and slug untouched; the demo fetch retries a transient GitHub error patiently.
- `softn.sandbox.run` executes a script in a fresh, bridge-less ZIPP guest inside a worker with source, instruction and time bounds; `files.readZipText` reads a small text-only ZIP a user chose; TileMap gains a viewport-clipped mode that allocates pixels only for the visible window.
- The native Rust host remains available under `apps/softn-rust`; its executable is still `softn-server`.

The backend download targets Linux x86-64 with Apache/PHP and process execution enabled. It is a generic, unconfigured distribution: install your own public and private app bundles and preserve existing configuration, keys and databases when upgrading. Native XDB synchronization remains a Rust-host feature.

### Downloads

| File | What it is |
|------|------------|
| `softn-com-RELEASE_TAG-zipp-*.zip` | The complete static softn.com: the directory, the web runtime, Studio and Builder. Upload its contents to a web host's document root; `DEPLOY.md` inside explains the rest. The `.sha256` beside it is its checksum. |
| `softn-single-RELEASE_TAG.zip` | Lightweight, unbranded single-app runtime with a loading spinner, non-blocking permission bar and bundled-app favicon. Upload its contents, replace `app.softn` and edit `runtime.config.json`; `DEPLOYMENT.md` explains configuration and permissions. A `.sha256` checksum is included. |
| `softn-single-php-linux-x64-RELEASE_TAG.zip` | Single-app browser runtime plus an optional Apache/PHP server backend, bundled Linux x64 Node/SQLite, ZIPP WASM, polling and an optional WebSocket bridge. The backend is unconfigured until you install a private server bundle and run setup. `START-HERE.md` explains both static-only and server-backed deployment. |
| `softn-single-php-serve-RELEASE_TAG.zip` | Single-app runtime served by PHP from a private archive: the page is rendered on the server, the runtime fetches the app's text once and each asset on demand behind a viewer cookie, and no `.softn` file is ever on a URL. Upload `webroot/` contents, keep `private/` beside it; `DEPLOYMENT.md` explains the settings and the limits of what this hides. |
| `softn-private-single-php-linux-x64-RELEASE_TAG.zip` | The PHP-served single app together with the optional Apache/PHP server backend above: `webroot/`, `private/` and `backend/`. The app is served privately with or without the backend; `START-HERE.md` explains enabling it. |

The complete website archive's name carries the tag of the zipp engine inside it. It ships no
example apps: the directory starts empty, and `.softn` files dropped on any
page of the site publish into it — one, or a folder at once, with the admin
key from `data/config.json` lifting the hourly limit for the site owner. The
example apps are published as `.softn` downloads with every
[softn-Examples release](https://github.com/f2i-com/softn-Examples/releases).
The desktop loader and builder are not attached to releases; they build from
this tag's manifests with `npm run tauri build` in their apps.

The single-app archive includes a small counter example; replace it with your own bundle. It has no app download controls, but browser-delivered app bytes remain extractable. Required license notices are included in all archives.
