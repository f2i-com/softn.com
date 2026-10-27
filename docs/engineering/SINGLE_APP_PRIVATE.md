# Single-app PHP host: serving an application without publishing its archive

`apps/softn-single-private` hosts one `.softn` application from a PHP web
server. The archive stays in a private directory the web server never
serves. Visitors receive a page rendered by PHP, then the runtime fetches
what the application needs to run — its UI and logic text in one request,
each image, sound, model or font as its own request when the application
renders it. The application's scripts run in the same ZIPP WebAssembly
sandbox and the same renderer as every other SoftN host. No `.softn` file,
and no request that returns one, exists on the site.

It is the same shell as [the static single-app runtime](SINGLE_APP_RUNTIME.md):
a spinner, a non-blocking permission bar, the application's own UI unbranded.
What differs is delivery.

## What the browser receives

| Request                  | Answer                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.php`              | The page, rendered on the server: title, language, theme colours, description, favicon link, loading text and a small boot configuration. Sets the viewer cookie.              |
| `index.php?source`       | The source pack: the deployment's settings, the manifest reduced to the fields the runtime reads, every text entry (`.ui`, `.logic`, `.json`, `.xdb`, …) and the names of the rest. |
| `index.php?entry=PATH`   | One binary entry with its MIME type, an ETag, a private cache policy and byte ranges, so `<video>` and `<audio>` can seek.                                                     |
| `index.php?icon`         | The manifest icon, for the favicon.                                                                                                                                           |
| `index.php?manifest`     | The web app manifest for installation, built from the deployment settings; no cookie needed.                                                                                  |

Every page and asset the shell serves carries `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: credentialless`, set by
`softn-serve.php` itself and repeated in both `.htaccess` variants, so the
app is as cross-origin isolated here as on softn.com (`SharedArrayBuffer`
for the CPU language-model provider). Nothing to configure on nginx.

The manifest is never sent raw: `config.server`, with any token in it, and
every field the runtime does not read are dropped. Every other entry of the
bundle reaches a visitor's browser: its text in the pack, and the name and
size of every other file, each served when asked for. The server does not
know which entries the application uses, so a file left in the bundle
(`notes/TODO.md`, `data/customers.csv`) is sent unless it is withheld.
Entries listed under `withhold` in the configuration, matched in any case,
are neither packed nor served. A bundle's
`server/` folder is withheld whatever `withhold` says: if the full private
server bundle is deployed as `app.softn`, its server logic and SQL are never
packed or served, because they are the backend's and not the page's. Text-form
models (`.gltf`, `.obj`) are served as entries, not packed, so a large scene
does not sit inside the JSON the application boots from.

The pack and the entries require the cookie `index.php` sets (signed,
HttpOnly, SameSite=Strict, twelve hours by default), refuse browser
navigations and any fetch a browser says came from another origin (a sibling
subdomain included, which SameSite=Strict sends the cookie to) by their
`Sec-Fetch-*` headers, and answer only at the page's own address. Opening
`index.php?entry=…` in a tab, hot linking an entry from another site, or
fetching the pack with a script that never loaded the page all answer 403.

## What this is and is not

This is delivery control: the archive is not on a URL, what you withhold and
the bundle's `server/` folder never leave the server, and a visitor's browser
gets the rest one request at a time under a cookie the page issued. It is
**not copy protection**. A browser must receive the UI and logic text to
execute it, and must receive an image to draw it; a visitor with developer
tools can read the pack, see every other entry's name, and fetch and save
each one. What they cannot do from this site is download the `.softn` file,
reach a withheld entry, or see the manifest's server configuration. Keep
files the application does not need out of the bundle, or list them under
`withhold`. For access control, put the
whole deployment behind server-side authentication as well; for secrets and
proprietary logic, keep them on a server. The
[static runtime's distribution limits](SINGLE_APP_RUNTIME.md#distribution-limits)
apply here in full.

## Build and deploy

Requirements on the server: PHP 8.1 or newer with the `zip` extension, and
any web server that runs PHP. `zip` is the only extension the host needs
beyond a stock PHP, and a stock Debian or Ubuntu PHP does not have it:
install the `php-zip` package and restart the web server or PHP-FPM (until
then every page answers 503 and names the package). Apache with `.htaccess`
is what the included rules target; other servers need the equivalent
(index.php as the directory index, `.wasm` as `application/wasm`, `.mjs` as
JavaScript, and nothing under `private/` reachable), written out under
[A server that reads no `.htaccess`](#a-server-that-reads-no-htaccess)
below.

From the repository, with the CI toolchain (Node 24.19+ with npm 10):

```
npm ci
npm run build:packages
npm run build -w @softn/single-private
npm run package:single-private
```

`release/softn-app-private-vVERSION.zip` holds two folders:

- `webroot/` — `index.php`, `softn-serve.php`, `.htaccess` and the runtime's
  `assets/`. Upload its **contents** to the public directory the application
  should live at, root or subdirectory.
- `private/` — `app.softn`, `serve.config.php`, `shell.html` and a deny-all
  `.htaccess`. Put it **beside** the public directory, outside every document
  root. If it cannot be a sibling, set `$private` at the top of `index.php` to
  its absolute path. The PHP user needs write access to it once, to generate
  `secret.key` and `digest.cache`; otherwise set `secret` in the
  configuration and copy the pin from `sha256sum app.softn`.

Replace `private/app.softn` with your application and edit
`private/serve.config.php`:

```php
<?php
return [
    'id' => 'my-application',
    'title' => 'My application',
    'bundle' => __DIR__ . '/app.softn',
    'theme' => 'dark',
    'loadingText' => 'Loading…',
    'permissionMode' => 'prompt',
    'viewerToken' => true,
    'tokenLifetime' => 43200,
    'secret' => '',
    'withhold' => [],
    'cacheSeconds' => 3600,
];
```

- `id` names the visitor's local XDB records together with the page's path.
  Keep it stable across updates of the same application.
- `theme` is `dark` (the default) or `light`: the colours of the page the
  server renders, and the side the application is drawn in when its project
  declares none. A bundle whose manifest declares `config.theme.mode` `light`
  or `dark` is drawn in that side whatever `theme` says, and a page that sets
  its own `<App theme>` to one of the two is drawn in that; the rule is the
  static runtime's.
- `permissionMode` `prompt` shows the permission bar; `preapproved` enables
  the declared capabilities at once and requires `sha256`, the hex digest of
  the archive, which the host also checks before serving the pack.
- `permissions` may name a JSON permission declaration that replaces the
  bundle's `permission.json`; the precedence is the static runtime's.
- `viewerToken` may be turned off for a deployment that is already behind
  its own authentication, or one that serves the application into another
  site's page. `secret` may be set explicitly when several servers share an
  application or the private directory is read-only.
- `withhold` lists entries never sent: exact paths, directories with a
  trailing slash, or globs, each matched in any case. Every entry not listed
  is sent to any visitor who asks for it. The manifest cannot be withheld.
- `description` and `lang` fill the page's `<meta name="description">` and
  `<html lang>`; without a description the manifest's is used.
- `allowPrivateInWebroot` lifts the refusal to run when the private
  directory is inside the document root, for a host that can only offer one
  folder; its `.htaccess` then has to be honoured.
- `frameAncestors` lists the other sites allowed to show the page in a frame
  (origins such as `https://portal.example.com`). By default only the page's
  own site may frame it (`frame-ancestors 'self'`, `X-Frame-Options:
  SAMEORIGIN`): a page any site can frame can have its permission bar covered
  with a look-alike and its Allow clicked for the visitor.

The sample bundle is generated only when `dist/private/app.softn` is absent,
and the sample configuration only when `dist/private/serve.config.php` is
absent; neither overwrites an operator's file. Runtime bounds: an entry up to
50 MB, a source pack up to 32 MB decoded, an icon up to 256 KiB, sixty
seconds to fetch the pack.

### A server that reads no `.htaccess`

Nginx reads none, and neither does an Apache with `AllowOverride None`. What
the two shipped files say has to be written into the server's own
configuration, and above all the layout has to be right: a `private/` folder
under the document root is then protected by nothing but `index.php`'s
refusal to run. The equivalent for nginx with PHP-FPM, inside the site's
`server { }`, for an application at the site's root (reasoned from the Apache
rules and nginx's documented behaviour, not run in the test suite: check it
as described below):

```nginx
root /srv/site/webroot;            # private/ lives beside it, e.g. /srv/site/private
index index.php;
# Dot files refused; /.well-known/ (a certbot --webroot challenge) served.
location ~ /\.(?!well-known(?:/|$)) { deny all; }
# A second guard, as private/.htaccess is on Apache: nothing of these is
# served even if someone uploads them into the document root.
location ~ ^/(private|backend)(/|$) { return 404; }
location ~ \.(softn|key|cache)$ { return 404; }
# The library is included by index.php; it is not an entry point.
location = /softn-serve.php { return 404; }
# The page, the source pack, the entries and the manifest are all index.php.
# It sends its own headers (nosniff and the two isolation headers): none are
# added here, since a header sent twice is one a browser may ignore.
location = /index.php {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root/index.php;
    fastcgi_pass unix:/run/php/php-fpm.sock;
}
# Everything else is a file: the runtime's assets, the icons, sw.js.
location / {
    add_header X-Content-Type-Options nosniff always;
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
}
# The service worker may control the whole directory and must never be stale.
# add_header in a location replaces the ones above, so they are repeated.
location = /sw.js {
    add_header Service-Worker-Allowed /;
    add_header Cache-Control no-cache;
    add_header X-Content-Type-Options nosniff always;
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
}
# A types block replaces the table inherited from http { }: without the
# include, .html, .css and .js would all be sent as the default type.
include mime.types;
types { application/wasm wasm; text/javascript mjs; }
```

For an application in a subdirectory, each path above gains that prefix
(`location = /app/index.php`, `location = /app/sw.js`, `location /app/` and
so on). With the optional backend,
`/api/...` is handed to `api.php` as well and `api.php` itself is not served;
README-RUNTIME.md in that archive has those two locations.

### Check it

From outside, once the site is up. Each of these must answer 403 or 404,
never 200, whatever the server:

```
for path in private/app.softn private/serve.config.php private/secret.key private/digest.cache app.softn softn-serve.php; do
  curl -s -o /dev/null -w "%{http_code} /$path\n" "https://your.site/$path"
done
```

And the page itself must carry its headers once each:
`curl -sI https://your.site/ | grep -i -E "cross-origin|nosniff"` shows
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy:
credentialless` and `X-Content-Type-Options: nosniff`, one line of each (as
Apache sends them with the shipped `.htaccess`, for the page, an asset and
`sw.js` alike).

What those paths answer was run against Apache 2.4 with the shipped files.
With `private/` beside the document root, the four under `private/` are 404
whether `.htaccess` is read or not, and `softn-serve.php` is 403 where it is
read and 404 (its own answer) where it is not. With `private/` under the
document root they are 403 while `.htaccess` is read; with `AllowOverride
None` the archive, `secret.key`, `digest.cache` and `shell.html` are served
to anyone who asks and `serve.config.php` is run (or, on a server that does
not hand it to PHP, sent as it is, `secret` and all), while `index.php`
answers 503 "The private directory must be outside the public document
root". That refusal is the sign to look for; it does not stop the files
being fetched. Nginx was not run: it reads no `.htaccess`, so without the
rules above it is the `AllowOverride None` column.

## Installable app and link previews

The page is a Progressive Web App out of the box. `index.php` renders a manifest link, the Apple and Android install tags, Open Graph and Twitter card tags, and registers `sw.js`; `index.php?manifest` answers with a web app manifest built from the deployment's `title`, `description`, `lang` and `theme`. The archive holds placeholders carrying the SoftN mark: `webroot/pwa-icons/icon-192.png`, `icon-512.png` and `icon-maskable-512.png` (the installed-app icons), `webroot/apple-touch-icon.png` (iOS home screen) and `webroot/share.png` (the 1200 × 630 picture shown when the link is posted). Replace them with your own artwork under the same names, or point `pwa.icons`, `pwa.appleTouchIcon` and `pwa.shareImage` at other paths.

`serve.config.php` accepts `'pwa' => true` (the default), `false`, or an array: `shortName` (up to 30 characters under the icon), `themeColor` and `backgroundColor` (`#rrggbb`), `display`, `orientation`, `icons` (a list of `src`, `sizes`, `type`, optional `purpose`), `appleTouchIcon`, `shareImage`, `shareImageWidth`, `shareImageHeight`, `siteUrl` (the public address of the page directory, for previews behind a proxy or CDN that hides the host name) and `serviceWorker`. Paths are relative to the page's directory, so a deployment under `/app/` works unchanged; absolute `http(s)` URLs pass through.

The service worker caches only the runtime's hashed `assets/`, the icons and the share image, and answers navigations network-first with the last page as an offline fallback. It never caches `index.php` with a query, so the source pack, entries and the manifest always come from the server and a redeployed application is seen on the next visit. Ubuntu's Apache maps `/icons/` to its own directory-listing images; the placeholders live in `pwa-icons/` so they never collide with it.

## With the optional backend

`npm run package:private-single-php` produces
`release/softn-app-private-with-backend-linux-x64-vVERSION.zip`: the same `webroot/`
and `private/` with `api.php` and a `.htaccess` that also routes `/api/...`,
plus the `backend/` folder of the static variant's backend archive (softn-runner,
bundled Linux x64 Node, SQLite and ZIPP WASM). The application is served privately
with or without the backend; enabling it follows the included DEPLOYMENT.md,
which is [apps/softn-single-private/PRIVATE_DEPLOYMENT.md](https://github.com/f2i-com/softn.com/blob/main/apps/softn-single-private/PRIVATE_DEPLOYMENT.md)
(README.md beside it is the short explainer every release archive carries).
CI verifies that archive with the backend checks and an Apache smoke test
that also loads the served page, the pack and the refusals.

## Local preview

`npm run preview -w @softn/single-private` serves `dist/webroot` with PHP's
built-in server on port 1456 (`PORT` and `PHP` override). `npm run dev`
builds first. Under the built-in server `.htaccess` is not read, so it stands
in for Apache's PHP handling only; the host itself answers 404 for any path
that is not its own, which is why `/app.softn` is not found there either.

## Tests

`npm test -w @softn/single-private` covers the boot configuration, the
asset resolver's same-origin URLs and `pathOf`, the pack parser and loader,
the shell template, and the equality of the PHP extension table with
`@softn/core`'s registry. With `php` on PATH it also starts the built-in
server over a temporary deployment and checks the rendered shell, the cookie,
the pack's contents and what it omits, entry headers, conditional and range
requests, a nine-megabyte streamed entry, the icon, every refusal, the
digest pin, the sidecar and the generated secret. Without `php` that suite
is skipped.
