# SoftN desktop runtime (`apps/softn-loader`)

The desktop and Android runtime for `.softn` apps: a Tauri shell around the
same renderer, ZIPP engine and XDB that the browser runtime uses, with
records kept in a local SQLite database and optional peer sync over the
local network. Open a file, drop one onto the window, or double-click a
`.softn` file once the file association is installed.

- Develop: `npm run dev` (web view only) or `npm run tauri dev` (the desktop
  shell, with the web inspector available as in every debug build).
- Build: `npm run tauri build` from this directory; the Rust side takes XDB
  from this repository (`crates/softn-xdb`, by path).
- Test: `npx vitest run` here; `cargo check --offline` in `src-tauri/`.

## What the page may ask the native side to do

The web view is trusted with the app it shows, not with the disk. Bundle
logic runs inside ZIPP and never sees the page, so the only way for a script
to reach the commands below is a bug in the renderer; the commands are
shaped so that even then nothing beyond the current app is reachable.

Which app's saved data the page may use is decided on the native side
(`src-tauri/src/data_identity.rs`), never by the page: the file the person
chose, the SHA-256 of the bytes the native side read from it, and the native
record `installations.json` in the app's data folder of which bundle digests
the person let use which app's data. A bundle always gets the data kept under
its own digest; another installed app's data only when that record says so or
the person says so in a native dialog ("Open the new version of X with the
data of the version you had?"). The page's own registry
(`softn-loader:installations`, `src/installations.ts`) still runs the upgrade
steps, and was imported into the native record once, at the first start of
the version that has it, before any bundle had been read.

| Command | Rule |
| --- | --- |
| `read_softn_bundle(path)` | Only a file the person opened through this process: on the command line or by file association, in the picker `pick_softn_bundle` opens, or by dropping it onto the window. Any other path is refused. The bytes of the file chosen last are the bundle open now. |
| `pick_softn_bundle()` | Opens the system picker on the native side and records the choice, so the page cannot invent a path. On Android it returns a content URI, which `read_softn_bundle` reads. |
| `read_cached_bundle(name)` | Android intents only: a file name inside the app cache, no separators. Not a choice by the person: it binds no app's data. |
| `set_window_icon(bytes)` | At most 1 MiB and 1024 px on a side; the image header is checked before pixels are allocated. |
| `import_installations(registry)` | Takes the page's registry once, at the first start with a native record, before any bundle was read; refused ever after. |
| `bind_data_identity(bundleId, dataId)` | `bundleId` must be the digest of the bundle open now. Its own data, or data the person let it use, is bound; another installed app's data is asked about in a native dialog. |
| `choose_data_identity(bundleId, candidates)` | The upgrade question, in a native dialog: use the data of the most recently updated installed app of the same name, open as a new app, or cancel. |
| `backup_database(appId)` | The app open now only. Writes a `pre-upgrade-*.sqlite` snapshot beside the database and returns its path; the page never chooses a location. |
| `restore_database(appId, backup)` | The app open now only. Restores only such a snapshot from the database's own directory, local scope. |
| XDB record commands | The data bound for the app open now, and only when the page names that app's id; see `src-tauri/src/scoped_xdb.rs`. |

The raw `get_db_path`, `export_database` and `import_database` commands are
not registered, on the desktop or on Android.

The page is granted no file system or dialog plugin (`src-tauri/capabilities`).
On Android it had `fs:default`, which reads the app's own folders where every
app's database lives, and `fs:allow-read-file`, which reads a `file://` or
`content://` URL with no scope check; the picker and the read are the native
side's there too.

## Content security policy

`src-tauri/tauri.conf.json` allows `connect-src … wss:` to any host on
purpose: server sync (`src/runtimeConfig.ts`) upgrades a user-configured
`https:` sync URL to `wss:`, and core's egress policy is what gates an app's
own traffic. Tightening the CSP to a fixed host would break sync for anyone
who runs their own server.

## Web inspector in shipped builds

Debug builds always have the inspector. Release builds get it only when built
with `cargo tauri build -- --features devtools`; a shipped binary does not
open an inspector over a bundle with Ctrl+Shift+I.
