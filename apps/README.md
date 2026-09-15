# The apps

Everything under `apps/` is something a person opens or a server runs. The
engine, the components and the shared contracts live in
[`packages/`](../packages/README.md); the apps put them on a screen or behind
a URL. Each folder is a workspace of its own (`npm run <script> -w <name>`),
except `shared/`, which is one file kept for FormLogic.

| Folder | In one line | Runs where | Ships as |
| --- | --- | --- | --- |
| [`softn-site/`](#softn-site) | softn.com: the landing page, the app directory pages and the publish form | Browser, at `/` | Part of `softn-website-<tag>-zipp-<engine>.zip` |
| [`softn-web/`](#softn-web) | The browser runtime: open a `.softn` app and use it | Browser, at `/web/` | Part of the website archive |
| [`softn-builder/`](#softn-builder) | The visual editor: pages, components, data, source, preview, export | Browser at `/builder/`, and as a desktop app | Part of the website archive; a Tauri build for desktop |
| [`softn-studio/`](#softn-studio) | The AI studio: a brief in plain language becomes an app you can edit and export | Browser, at `/studio/` | Part of the website archive |
| [`softn-single/`](#softn-single) | One app on its own page, unbranded: a spinner, a permission bar, the app | Browser, on your web host, and at `/play/<slug>` on the site | `softn-app-static-<tag>.zip`, and with a backend `softn-app-static-with-backend-linux-x64-<tag>.zip` |
| [`softn-single-private/`](#softn-single-private) | The same single app, but PHP renders the page and the `.softn` file never sits on a URL | PHP web host | `softn-app-private-<tag>.zip`, and with a backend `softn-app-private-with-backend-linux-x64-<tag>.zip` |
| [`softn-api/`](#softn-api) | The directory API behind softn.com: catalogue, publish, play, rate, comment, remix, per-app storage | PHP, at `/api/` beside the site | Part of the website archive |
| [`softn-host-php/`](#softn-host-php) | The on-demand server host: PHP starts a bundled Node process per request to run an app's private `.logic` on the ZIPP engine | Apache/PHP on Linux x64 | The `backend/` folder of the two `…-php-linux-x64-…` archives |
| [`softn-host-rust/`](#softn-host-rust) | `softn-server`: the native private backend with persistent connections and XDB sync | Anywhere Rust builds; behind a reverse proxy | Built from source (`cargo build --release`) |
| [`softn-loader/`](#softn-loader) | The desktop runtime ("SoftN"): opens `.softn` files natively, stores records in SQLite | Windows, macOS, Linux and Android through Tauri | Installers from `npm run tauri build`; not attached to releases |
| [`formlogic-host/`](#formlogic-host) | The trusted shell FormLogic embeds to run an app inside its own product | An opaque-origin iframe inside FormLogic | `hosted-runtime/` in `softn-formlogic-runtime-<tag>.zip`, which FormLogic fetches from the release |
| [`shared/`](#shared) | One re-export file kept at a path FormLogic checks | Build time only | Nothing |

## How they fit together

A `.softn` file is the unit everything agrees on: a zip with a manifest, a
`permission.json`, `.ui` pages, `.logic` scripts, data seeds and assets. You
make one in Studio (from a brief) or Builder (by hand), or FormLogic exports one
for you. You then open it in the web runtime or the desktop runtime, publish it
to the directory so it has a page and a play button, or host it yourself on one
page with the single-app runtime. If the app needs a server (private logic,
SQLite, routes), that server is either the PHP host (no daemon; a process per
request) or the Rust host (a long-running service with sync). The site is the
front door to all of the browser apps: the build script composes `softn-site`,
`softn-web`, `softn-builder`, `softn-studio`, `softn-single` (under `/play/`)
and the docs into one `dist/` that the directory API serves from.

Every app renders through the same `@softn/core` renderer and runs `.logic` in
the same ZIPP WebAssembly sandbox, so an app behaves the same in each of them.
What differs is who owns the page, where the data lives and which
capabilities the host is willing to grant.

## The browser apps

### softn-site

The landing page and the directory's pages: the home page with the learn
section, `/apps`, each `/app/<slug>` page, `/publish` and the footer. It
talks to `softn-api` over relative `/api` URLs and hands a dropped `.softn`
to the publish flow through the shared bundle contract. It deliberately does
not depend on `@softn/core`; the engine is a megabyte it has no use for.

- Run: `npm run dev:site` (port 1421). Test: `npm test -w @softn/site`.
- Ships inside the website archive at the root of the document root.

### softn-web

The runtime people use on softn.com: a launcher that opens a bundle from a
file, a link or the directory, then renders it with a slim bar over the app
(home, fullscreen, menu). It caches bundles, remembers local apps and asks
for capabilities with a permission prompt. `?open=<url>` and `/web/app/<slug>`
are its entry links.

- Run: `npm run dev:web` (port 1420). Test: `npm test -w @softn/web`.
- Ships inside the website archive under `web/`.

### softn-builder

The visual editor. Pages on a canvas with an inspector, a component palette,
a schema editor for collections and relationships, a data view for seed
records, a source view for files the canvas cannot safely rewrite, live
previews at desktop, tablet and phone widths, and an export dialog that
inspects the bundle before it leaves. The same code runs as a desktop app
through Tauri (`src-tauri/`), where it gets native open and save dialogs.

- Run: `npm run dev:builder` (port 1422) or `npm run dev:desktop:builder`.
- Test: `npm test -w @softn/builder`; desktop styles: `npm run test:desktop`.
- Ships inside the website archive under `builder/`; desktop installers come
  from `npm run tauri build -w @softn/builder`.

### softn-studio

The no-code path. You describe an app, review the AI's plan, and Studio
generates the pages, data and actions, which you then edit visually and
export. It uses your own provider key (OpenAI, Anthropic or a custom
endpoint). `PRODUCT_SPEC.md` is the product definition.

- Run: `npm run dev:studio` (port 1423). Test: `npm test -w @softn/studio`.
- Ships inside the website archive under `studio/`.

### softn-single

The smallest way to put one app on a page. No launcher, no branding, no
directory: a spinner, then the app, with a non-blocking permission bar. It
reads `runtime.config.json` beside it (which app, title, theme, optional
permission declaration, optional bundle digest). The site build also places
it under `/play/`, and the directory serves `/play/<slug>` with the app's
configuration written into the page.

- Run: `npm run dev -w @softn/single`. Test: `npm test -w @softn/single`.
- Ships as `softn-app-static-<tag>.zip` (static) and, with the PHP host's
  `backend/` folder added, `softn-app-static-with-backend-linux-x64-<tag>.zip`. Guide:
  [`docs/engineering/SINGLE_APP_RUNTIME.md`](../docs/engineering/SINGLE_APP_RUNTIME.md).

### softn-single-private

The same shell, delivered differently (the PHP is in `php/`; the build copies
it into the webroot): PHP renders the page, the runtime
fetches the app's text in one request and each image, sound or model as its
own request behind a signed viewer cookie, and the `.softn` file stays in a
`private/` folder the web server never serves. It is delivery control, not
copy protection; the guide says exactly what it does and does not hide.

- Run: `npm run dev -w @softn/single-private`; preview with PHP:
  `npm run preview -w @softn/single-private`. Test: `npm test -w @softn/single-private`.
- Ships as `softn-app-private-<tag>.zip` and, with the backend,
  `softn-app-private-with-backend-linux-x64-<tag>.zip`. Guides:
  [`docs/engineering/SINGLE_APP_PRIVATE.md`](../docs/engineering/SINGLE_APP_PRIVATE.md)
  and [`PRIVATE_DEPLOYMENT.md`](softn-single-private/PRIVATE_DEPLOYMENT.md).

## The servers

### softn-api

Plain PHP (8.1+) that turns the static site into an app directory. Apps are
folders under `data/apps/<slug>/` holding `.softn` versions and a generated
`app.json`; publishing, ratings, comments, remixes, categories and each
app's optional server-side storage are files and SQLite under `data/`. No
daemon, no accounts, no MySQL: it runs on shared hosting that takes a zip
upload. `router.php` lets PHP's built-in server stand in for Apache locally.

- Run against a built site: `npm run build:site && php -S 127.0.0.1:5500 -t dist apps/softn-api/router.php`.
- Test: `npm test -w @softn/api` (starts its own `php -S`).
- Ships inside the website archive under `api/`. Guide: [`softn-api/README.md`](softn-api/README.md).

### softn-host-php

The PHP/WASM host for an app's private server logic. `api.php` in the
webroot receives `/api/...`, and for each request PHP starts the bundled
Linux x64 Node from `backend/`, which runs the app's `server/main.logic` on
the ZIPP interpreter with SQLite, crypto and time capabilities, then exits.
There is no listening port and nothing runs while the site is idle. Optional
polling routes and a separately started WebSocket bridge give live updates.
`package.mjs` assembles the two `…-php-linux-x64-…` release archives.

- Test: `npm test -w @softn/host-php` (the fixture-bound suites run only with
  `SOFTN_PHP_TEST_BACKEND` pointing at an extracted backend).
- Guides: [`softn-host-php/README.md`](softn-host-php/README.md) (the contract),
  [`SINGLE_APP_DEPLOYMENT.md`](softn-host-php/SINGLE_APP_DEPLOYMENT.md), [`LIVE_UPDATES.md`](softn-host-php/LIVE_UPDATES.md).

### softn-host-rust

`softn-server`, the native private backend: the same server API v1 as the
PHP host, plus what a long-running process can offer (persistent
connections, XDB synchronisation, a worker pool). It loads a private bundle
directory, keeps its data in an operator-owned directory and sits behind a
same-origin reverse proxy that forwards `/api/*` to it. XDB comes from the
sibling `xdb.org` checkout.

- Build and test: `cargo test --manifest-path apps/softn-host-rust/Cargo.toml`.
- Guide: [`softn-host-rust/PRIVATE_BACKEND.md`](softn-host-rust/PRIVATE_BACKEND.md).

## Desktop and embedded

### softn-loader

The desktop runtime, installed as "SoftN". Open a `.softn` file, drop one on
the window or double-click one (the file association is registered), and the
app runs in a native window with its records in a local SQLite database
through XDB. Wears the product bar with the theme switch. `shell-extension/`
is the Windows Explorer integration; `android:*` scripts build for Android.

- Run: `npm run dev:desktop` (port 1431, in its Tauri window).
  Test: `npm test -w @softn/loader`.
- Installers: `npm run tauri build -w @softn/loader`. Releases do not attach
  them; the tag check keeps `tauri.conf.json` at the release version so a
  build from the tag is stamped correctly. Guide:
  [`docs/engineering/DESKTOP_APPS.md`](../docs/engineering/DESKTOP_APPS.md).

### formlogic-host

The shell FormLogic embeds to run a SoftN app inside its product. It runs in
a sandboxed iframe with an opaque origin: the parent keeps authentication,
sends the bundle, the app id, the theme and the ZIPP engine bytes over a
private channel, and answers the app's `softn.backend.call` actions. A
bundle's `permission.json` cannot grant anything here; the parent decides.
FormLogic's `build-hosted-runtime.mjs` builds this folder from a pinned
checkout of this repository, so keep its file paths and messages stable.

- Guide: [`formlogic-host/README.md`](formlogic-host/README.md) and
  [`docs/engineering/FORMLOGIC_INTEGRATION.md`](../docs/engineering/FORMLOGIC_INTEGRATION.md).

### shared

One file, `hostedEditor.ts`, re-exporting the FormLogic editor channel from
`@softn/editor-shared`. It stays because FormLogic's editor build checks for
this path before building the hosted editors. Do not move it; add nothing
else here.

## Conventions

- Each browser app has `index.html`, `src/`, `test/`, `vite.config.ts` and a
  `vitest.config.ts`; run its tests from its own directory or with
  `npm test -w <name>`, not with vitest's `--root` from the repository root.
- Apps that wear the product bar (`softn-web`, `softn-builder`,
  `softn-studio`, `softn-loader`, `softn-site`) inline the theme pre-paint
  script in `index.html`; a brand test checks that.
- Build output goes to each app's `dist/` (Builder's desktop build to
  `dist-desktop/`); the site build composes them into the root `dist/`.
- The release archives and what each one is for are described in
  [`scripts/release-packages.mjs`](../scripts/release-packages.mjs), which
  generates the `README.md` at the root of every archive.
