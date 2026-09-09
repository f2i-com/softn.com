# Privately served single app with an optional server backend

This archive hosts one `.softn` application from PHP without ever putting the
archive on a URL, and carries the optional PHP/WASM backend beside it. The
application works immediately without the backend. Server support is
optional and unconfigured. No private application, credentials or database
is shipped.

Three folders:

- `webroot/` — `index.php`, `softn-serve.php`, `api.php`, `.htaccess` and the
  runtime's `assets/`. Its **contents** go into the public directory the
  application should live at.
- `private/` — `app.softn`, `serve.config.php`, `shell.html` and a deny-all
  `.htaccess`. The archive and the settings the page is rendered from.
- `backend/` — the PHP/WASM server host with bundled Linux x64 Node, SQLite
  and the ZIPP WASM engine, used only when you enable it.

Put `private/` and `backend/` **beside** the public directory, outside every
document root and Apache alias. If they cannot be siblings, set `$private`
at the top of `index.php` and `$backend` at the top of `api.php` to their
absolute paths.

## The application

Requirements: PHP 8.1 or newer with the `zip` extension, Apache with
`.htaccess` honoured (`AllowOverride All`) or an equivalent server
configuration. Replace `private/app.softn` with your application and edit
`private/serve.config.php`; DEPLOYMENT-SERVE.md documents every setting,
what the browser receives and what this does and does not protect. In
short: the page is rendered by PHP, the runtime fetches the application's
text once and each image, sound or model as its own entry behind a signed
viewer cookie, and the `.softn` file has no URL. A browser must still
receive what it executes, so this is delivery control, not copy protection.

The PHP user needs write access to `private/` once, to generate `secret.key`
and `digest.cache`; otherwise set `secret` in the configuration and copy the
`sha256` pin from `sha256sum app.softn`.

## Enable the backend

Requirements: Linux Intel/AMD x86-64, glibc 2.28+, Apache `mod_rewrite` and
PHP 8.1+ with process execution enabled. PHP GD is optional, required only
for photo routes. No npm install, PHP FFI, separate listening server or
systemd service is required.

1. Install your expanded PRIVATE server API v1 bundle at `backend/app/`, with
   its `manifest.json`, server logic and SQL migrations. Its separate PUBLIC
   client is the `private/app.softn` the page serves. Never publish server
   source; the served client must not contain `server/` entries.
2. Set `manifest.config.server.allowedOrigins` in the private manifest to the
   exact HTTPS origins serving the page. Include www and non-www separately
   if you serve both.
3. Make `backend/` owned by the PHP account and run setup once as that
   account: `sudo -u www-data php /absolute/path/backend/setup.php`. Setup
   creates `backend/private/config.json` and the database; it preserves
   existing settings. Keep these private and back them up securely.
4. Review `backend/private/config.json`: `appId` must match the PRIVATE
   manifest ID; retain the generated `keyHex` and `cryptoDomains`. Grant only
   the capabilities the app needs.
5. Visit `/api/meta`. A configured host reports `runtime:zipp-wasm-on-demand`.
   Until the backend is set up, `/api/…` answers 503 with a diagnostic label
   and the application still runs.

The application reaches its routes through `softn.net.fetch` with the site's
own absolute URL, so its `permission.json` needs `net.enabled` and, when it
lists `allowed_hosts`, the site's host. The viewer cookie is not required by
`/api/…`; route authorization is the backend's, as documented in
README-RUNTIME.md and LIVE_UPDATES.md.

## Updates

To update the runtime, replace `webroot/assets/`, `webroot/index.php`,
`webroot/softn-serve.php`, `webroot/api.php`, `webroot/sw.js` and
`private/shell.html`. Keep `private/app.softn`, `private/serve.config.php`,
`private/secret.key`, `backend/app/`, `backend/private/`, your edited
`index.php`/`api.php` paths, and your own `webroot/pwa-icons/`,
`webroot/apple-touch-icon.png` and `webroot/share.png` if you replaced the
placeholders (see DEPLOYMENT-SERVE.md, "Installable app and link previews"). A backend packaged for Linux x64 will not run on ARM or Windows; the
served application itself needs only PHP.

## Build from source

`npm run build -w @softn/single-php-serve` then
`npm run package:private-single-php`. Backend packaging uses checksum-pinned
official Node binaries and the repository's vendored WASM with verified
provenance. Licences and checksums accompany the archive.
