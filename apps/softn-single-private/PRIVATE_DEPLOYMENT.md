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

Requirements: PHP 8.1 or newer with the `zip` extension, and Apache with
`.htaccess` honoured (`AllowOverride All`) or an equivalent server
configuration. `zip` is the one extension the page needs, and a stock Debian
or Ubuntu PHP does not have it: install the `php-zip` package and restart the
web server or PHP-FPM (until then every page answers 503 and says so).
`mbstring` is no longer needed; nor are `ini_set`, `set_time_limit` or the
`ctype` extension, which some hosts disable or leave out. A server that reads
no `.htaccess` (nginx, or Apache with `AllowOverride None`) must be told what
it says: `index.php` as the directory index, `.wasm` served as
`application/wasm` and `.mjs` as JavaScript, `/api/…` handed to `api.php`,
and nothing under `private/` or `backend/` served
(README-RUNTIME.md has the nginx rules for the backend).
Replace `private/app.softn` with your application and edit
`private/serve.config.php`; DEPLOYMENT-SERVE.md documents every setting,
what the browser receives and what this does and does not protect. In
short: the page is rendered by PHP, the runtime fetches the application's
text once and each image, sound or model as its own entry behind a signed
viewer cookie, and the `.softn` file has no URL. A browser must still
receive what it executes, so this is delivery control, not copy protection.

The PHP user needs write access to `private/` once, to generate `secret.key`
and `digest.cache`; otherwise set `secret` in the configuration and copy the
`sha256` pin from `sha256sum app.softn`.

An edit to `serve.config.php` can take a couple of seconds to show: PHP's
opcache keeps the compiled file for `opcache.revalidate_freq` seconds (two by
default), and for as long as PHP runs on a host that sets
`opcache.validate_timestamps=0`, where PHP has to be reloaded.

## Enable the backend

Requirements: Linux Intel/AMD x86-64, glibc 2.28+, Apache `mod_rewrite` and
PHP 8.1+ with process execution enabled (`proc_open`, `proc_get_status`,
`proc_terminate` and `proc_close` not in `disable_functions`). PHP GD is
optional, required only for photo routes (Debian/Ubuntu: the `php-gd`
package). No npm install, PHP FFI, separate listening server or
systemd service is required. The page may live in a subdirectory; the
backend's routes may not: `/api/…` is served from the site's root, so an
application that uses the backend goes in the document root itself.

1. Install your expanded PRIVATE server API v1 bundle at `backend/app/`, with
   its `manifest.json`, server logic and SQL migrations. Its separate PUBLIC
   client is the `private/app.softn` the page serves. Never publish server
   source; the served client must not contain `server/` entries. (As a
   backstop, `softn-serve.php` withholds every `server/` entry from the
   browser whatever `withhold` says, so a server bundle deployed here by
   mistake does not hand out its routes and migrations — but keep them out.)
2. A page on the same site may call its API with no setting. If the page is
   also served from another origin (www and non-www, another domain), list
   those exact HTTPS origins in `manifest.config.server.allowedOrigins` in the
   private manifest. Behind a TLS-terminating proxy, list the proxy in
   `trustedProxies` (step 4) or list your origin.
3. Make `backend/` owned by the PHP account and run setup once as that
   account: `sudo -u www-data php /absolute/path/backend/setup.php`. Setup
   creates `backend/private/config.json` and the database; it preserves
   existing settings. Keep these private and back them up securely. It then
   checks PHP, the bundled Node and that the app answers `/api/meta`; a
   problem is a `WARNING:` line with its reason and a non-zero exit. It
   checks the command-line PHP, which is often configured apart from the web
   server's: step 5 checks that one.
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

## Before going live

- `private/` and `backend/` are outside every document root. Check it from
  outside; each of these must answer 403 or 404, never 200:

  ```
  for path in private/app.softn private/serve.config.php private/secret.key backend/private/config.json backend/private/data/application.sqlite backend/app/manifest.json app.softn softn-serve.php; do
    curl -s -o /dev/null -w "%{http_code} /$path\n" "https://your.site/$path"
  done
  ```

  `index.php` refuses to run (503) when `private/` is inside the document
  root, inside the directory an Alias or a user directory maps to, or in or
  below the page's own directory, unless `allowPrivateInWebroot`; `api.php`
  refuses the same of `backend/` (`backend_public`). That refusal is the
  only guard a server that reads no `.htaccess` has: with both folders under
  the document root, Apache with the shipped `.htaccess` files answers 403
  for all of them, and Apache with `AllowOverride None`, or nginx, hands out
  the `.softn` file, `secret.key`, the backend's database and its key to
  anyone who asks (run against Apache 2.4; nginx reasoned from it).

- Only your own site can show the app in a frame. If another of your sites
  embeds it, list that site in `frameAncestors` in `serve.config.php`.
- The site is served over HTTPS, so the viewer cookie is `Secure`. Behind a
  proxy that terminates TLS, make sure PHP sees `HTTPS=on`.
- `display_errors` is off for PHP. `softn-serve.php`, `api.php` and the
  backend each turn it off for their own requests where the host allows
  `ini_set`; on a host that disables `ini_set` it has to be off in the
  host's own settings.
- Back up `private/serve.config.php`, `private/secret.key` (or your
  `secret`), and `backend/private/` with the database. Treat them as
  credentials; they are not in any release archive, and a release is always
  packaged from the samples, never from a working `dist/private`.

## Build from source

`npm run build -w @softn/single-private` then
`npm run package:private-single-php`. Backend packaging uses checksum-pinned
official Node binaries and the repository's vendored WASM with verified
provenance. Licences and checksums accompany the archive.
