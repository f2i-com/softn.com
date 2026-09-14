# SoftN desktop runtime (`apps/softn-loader`)

The desktop and Android runtime for `.softn` apps: a Tauri shell around the
same renderer, ZIPP engine and XDB that the browser runtime uses, with
records kept in a local SQLite database and optional peer sync over the
local network. Open a file, drop one onto the window, or double-click a
`.softn` file once the file association is installed.

- Develop: `npm run dev` (web view only) or `npm run tauri dev` (the desktop
  shell, with the web inspector available as in every debug build).
- Build: `npm run tauri build` from this directory; the Rust side needs the
  XDB checkout the repository pins (`.github/scripts/checkout-xdb.sh`).
- Test: `npx vitest run` here; `cargo check --offline` in `src-tauri/`.

## What the page may ask the native side to do

The web view is trusted with the app it shows, not with the disk. Bundle
logic runs inside ZIPP and never sees the page, so the only way for a script
to reach the commands below is a bug in the renderer; the commands are
shaped so that even then nothing beyond the current app is reachable.

| Command | Rule |
| --- | --- |
| `read_softn_bundle(path)` | Only a file the person opened through this process: on the command line or by file association, in the picker `pick_softn_bundle` opens, or by dropping it onto the window. Any other path is refused. |
| `pick_softn_bundle()` | Opens the system picker on the native side and records the choice, so the page cannot invent a path. |
| `read_cached_bundle(name)` | Android intents only: a file name inside the app cache, no separators. |
| `set_window_icon(bytes)` | At most 1 MiB and 1024 px on a side; the image header is checked before pixels are allocated. |
| `backup_database(appId)` | Writes a `pre-upgrade-*.sqlite` snapshot beside the database and returns its path; the page never chooses a location. |
| `restore_database(appId, backup)` | Restores only such a snapshot from the database's own directory, local scope. |
| XDB record commands | The app's own collections; see `xdb.org`'s Tauri module. |

The raw `get_db_path`, `export_database` and `import_database` commands are
not registered on the desktop.

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
