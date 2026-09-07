# Single-app browser runtime

`apps/softn-single` is a separate entry point that uses the real renderer, component registry, ZIPP sandbox and XDB. It does not import the launcher, catalogue, editor, account bar, bundle cache or download controls. Its loader is a spinner, its document title comes from configuration, and its shell has no product branding. The application's own UI is rendered unchanged.

After loading, the site favicon uses the bundled image at `manifest.icon`, including SVG, PNG and ICO. Icons must be supported bundled images no larger than 256 KiB; missing or unsupported icons leave a blank, unbranded fallback. No external icon URL or root `/favicon.ico` request is needed. The favicon is available before the permission bar is accepted.

## Build and deploy

Use the repository's CI toolchain (Node 20.19+ with npm 10). Run `npm ci`, `npm run build:single`, then `npm run package:single`. Upload the **contents** of `release/softn-single-v0.0.6.zip` to an HTTPS web directory, at the root or in a subdirectory. PHP, the directory API and a service worker are not required. Keep the adjacent `assets` paths intact. Serve `.wasm` as `application/wasm` and `.mjs` as JavaScript; the included Apache file sets those types and disables directory listing. Other servers need equivalent MIME settings. Development: `npm run dev -w @softn/single`; production preview: `npm run preview -w @softn/single`.

Replace the sample `app.softn` in the deployed directory and edit `runtime.config.json`:

```json
{
  "version": 1,
  "id": "my-application",
  "title": "My application",
  "bundle": "./app.softn",
  "loadingText": "Loading…",
  "theme": "dark"
}
```

Optional `permissions` points to a same-origin JSON permission declaration, e.g. `"./permission.json"`. That operator-supplied file is authoritative; without it the runtime uses the bundle's `permission.json`, then its legacy manifest declaration, then no permissions. Invalid declarations stop loading. Optional `sha256` pins the exact bundle bytes. All locations resolve relative to the config file and must be same-origin HTTP(S); redirects, credentials in URLs and URL fragments are refused. The entry always reads its adjacent config. Query parameters, hashes, file drops and messages cannot replace the chosen app.

The sample bundle is generated only when `public/app.softn` is absent, never committed, and never overwrites your supplied file. For custom builds place your bundle there before building, or replace it after deployment. Config is capped at 16 KiB, sidecar permissions at 64 KiB and the compressed bundle at 32 MiB; the shared core ZIP validator also applies its entry/decompression limits. Fetch startup is bounded to 60 seconds.

## Permissions and local records

The app loads immediately with capabilities withheld. A compact, unbranded bar above the app lists requested access, with expandable permission details, Allow and Not now. The bar occupies its own space instead of covering the app; visitors can interact with the app while deciding. Dismissing it leaves access disabled and exposes Review permissions without restarting the app. Allowing access updates the runtime permission configuration; the shared engine may reinitialize scripts so startup features can retry with permission. Browser camera/microphone prompts remain independent. Consent is scoped to the config location, exact bundle digest and full permission declaration; changing the app or host restrictions asks again. Storage failures do not prevent a session-only grant.

Local XDB records use the deployment config path plus its `id`, not the bundle's chosen display name. Keep those stable to preserve records between your trusted app updates. Use a different `id` for a different application. Bundle seeding preserves existing records. The runtime does not register an app in the regular launcher's bundle cache. Manifest-defined server synchronization is not automatically enabled by this standalone host. Local imports, assets, UI/logic, 3D, audio and explicitly permitted model features use the shared runtime. Optional AI/speech files remain separate and are fetched when used; no model weights are included. The runtime shell is smaller than the full website, but an arbitrary 3D/AI app still needs the corresponding engine payloads.

## Distribution limits

There is no download button, launcher export route or source map in the production runtime. This is **not copy protection**: a browser must receive the app's bytes to execute them, and visitors can recover them through network tools, memory or browser storage. File extensions, encryption with a browser-held key, disabling right-click, or hiding branding cannot prevent that. For access-controlled delivery, put the entire deployment behind server-side authentication and authorization; even authenticated viewers can extract what their browser receives. Keep secrets and proprietary server-only logic on a server.

The shell does not inject visible branding, but application text, browser developer tools and required license notices can identify its implementation. Preserve LICENSE, NOTICE, third-party inventory and speech notices. They need not appear as runtime chrome. No private apps or artwork are included in this repository or the default archive.

## Validation

On 2026-09-07, the production build was tested in Chromium on Windows at the site root and at `/nested/`. The sample's click handler executed in the actual ZIPP VM. The app was interactive while the permission bar was visible; Not now and Review permissions preserved its state. Allowing persisted the grant, and changing allowed hosts requested consent again. An intentionally delayed config response displayed the loading spinner. A separate primitive 3D scene rendered without browser warnings or errors. The package script verifies every archive entry against its input bytes.

The new workspace has regression coverage for configuration, bounded loading, permissions, integrity, sample logic composition and the non-blocking permission bar. Browser smoke checks do not establish compatibility with every app, local model, speech device or hosting configuration. No model weights were downloaded during these checks. The full distribution is approximately 41 MiB compressed, including optional engine assets and legal notices; the initial JavaScript entry is approximately 470 KiB gzip, with additional runtime assets loaded separately.
