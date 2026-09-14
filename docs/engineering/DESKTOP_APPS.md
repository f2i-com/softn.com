# Working with one app across Softn

A `.softn` bundle carries the app's interface, logic, assets, manifest, collection
schemas and starting records. Studio, Builder and the runtime read that same file.

| Tool | Open an existing app | Keep your changes |
| --- | --- | --- |
| Studio | Import its `.softn` file, or open an example | Export a bundle; Run opens the browser runtime |
| Builder | Open its `.softn` file | Save the project or Export a bundle; Preview runs the current files |
| Browser runtime | Open a `.softn` file or use an app's runtime link | Download the original app source; export saved data separately |
| Desktop runtime | Open a file, drop it into the window, or use the file association | Records are stored locally in the app's SQLite database |

For an editor-to-editor transfer, export from the first editor and open that file
in the other. On the desktop, companion links open the website in the system
browser. They do not upload the current project or replace the desktop window.

## Try an editable example

Open Fieldnotes from the homepage in Builder. Its native HTML elements are
editable in the property inspector: select the heading, change **Text Content**,
then open Preview. Add and complete tasks to test its logic. Export the
bundle and open it in Studio or either runtime.

The visual canvas represents editable structure; Preview shows the actual app's
styles and behavior. A file using syntax the visual editor cannot preserve is
still marked **Source-only**, so a canvas edit cannot silently discard source.
Use Code view for those files. Fieldnotes uses markup the visual editor supports.

If an older Fieldnotes project is already open, reopen the newly downloaded
example to get the updated markup. Existing projects are not overwritten when
the website's example is updated.

## Source and saved data

Editor previews use disposable data. Their interactions do not change the seed
records in an exported bundle. Edit starting records in Builder's Data view.
Studio and Builder preserve collection schemas and relationship metadata when
opening and exporting a bundle.

Runtime records belong to that runtime on that device. The browser and native
runtime do not automatically share those records. The native runtime identifies
an app by its bundle content, so a changed bundle gets a separate storage
identity. Keep a data backup before moving between app versions or hosts.

## Run the desktop apps locally

Install Node and the Rust toolchain, including the Windows C++ build tools and
WebView2 on Windows. The native runtime expects the `xdb.org` repository beside
this checkout. Run `npm install` and `npm run build:packages` first.

```sh
# Desktop runtime UI on 1431, in its Tauri window
npm run dev:desktop

# Desktop Builder UI on 1432, in its Tauri window
npm run dev:desktop:builder

# Build both native executables without producing installers
npm run build:desktop
```

The native development ports are separate from the unified website at port
1420. Desktop Builder builds into `apps/softn-builder/dist-desktop`; the browser
Builder builds into `apps/softn-builder/dist`. This prevents a browser build from
overwriting the assets packaged by Tauri.

Desktop Builder uses native Open and Save dialogs, remembers the selected save
path, and checks for unsaved changes before closing. A cancelled dialog leaves
the current project open. The runtime's **Open app** action can reopen a file
after another tool has updated it; **Runtime home** closes its current view.

The runtime's theme switch also updates the running app, preserving its current
screen and unfinished form input. An app with `<App>` or `<App theme="system">`
follows the runtime appearance; `theme="light"` or `theme="dark"` intentionally
keeps a fixed appearance. Use the app's `--color-*` variables for custom styles,
or scope alternate colours under `.softn-theme-dark`, as Fieldnotes does.
Studio and Builder preview controls apply the selected appearance in place.
Previously downloaded bundles keep their authored styles; reopen the updated
Fieldnotes example to use its new dark palette.

The desktop shells retain their explicit `style-src 'self' 'unsafe-inline'`
policy for React, Monaco and app styles created at runtime. Tauri's automatic
nonce rewriting is disabled only for `style-src`; script nonces/hashes and the
remaining CSP directives stay enabled. Adding a nonce alongside `unsafe-inline`
otherwise blocks those dynamic styles. See [Tauri's CSP documentation](https://v2.tauri.app/security/csp/).

Run `npm run generate:native-icons` after changing the shared Softn mark to
regenerate both desktop icon packs. This includes Windows ICO, macOS ICNS and
mobile icons; the generator uses the same geometry as the website.

## Manual checks

```sh
npm run test -w @softn/loader -w @softn/studio -w @softn/builder
npm run test:desktop
node examples/fieldnotes/check.mjs
node examples/fieldnotes/check-theme.mjs
npm run e2e:matrix -- studio-handoff.spec.ts builder-handoff.spec.ts site-workspace.spec.ts
```

The Fieldnotes check uses the development stack and disposable browser storage.
The browser matrix uses a built deployment. Set `SOFTN_E2E_PORT=1430` when the
development stack's PHP server is already using 1425.

Native dialog tests simulate the Tauri bridge; browser tests run the real app
renderer and JavaScript engine. Native executable builds are a separate check.
Windows validation does not establish that macOS, Linux or Android builds work.

The desktop stylesheet tests require both built frontends. They serve those
actual assets with Tauri-equivalent CSP headers and exercise a real `.softn`
app: the previous policy blocks its styles, and the current policy renders them.
