# Single-app PHP host: serving an application without publishing its archive

`apps/softn-single-php-serve` hosts one `.softn` application from a PHP web
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

The manifest is never sent raw: `config.server`, with any token in it, and
every field the runtime does not read are dropped. Entries listed under
`withhold` in the configuration are neither packed nor served. Text-form
models (`.gltf`, `.obj`) are served as entries, not packed, so a large scene
does not sit inside the JSON the application boots from.

The pack and the entries require the cookie `index.php` sets (signed,
HttpOnly, SameSite=Strict, twelve hours by default), refuse browser
navigations and cross-site fetches by their `Sec-Fetch-*` headers, and answer
only at the page's own address. Opening `index.php?entry=…` in a tab, hot
linking an entry from another site, or fetching the pack with a script that
never loaded the page all answer 403.

## What this is and is not

This is delivery control: the archive is not on a URL, nothing the
application does not use leaves the server, and a visitor's browser gets the
pieces one request at a time under a cookie the page issued. It is **not copy
protection**. A browser must receive the UI and logic text to execute it, and
must receive an image to draw it; a visitor with developer tools can read the
pack and save entries as they arrive. What they cannot do from this site is
download the `.softn` file, reach entries the application never asked for,
or see the manifest's server configuration. For access control, put the
whole deployment behind server-side authentication as well; for secrets and
proprietary logic, keep them on a server. The
[static runtime's distribution limits](SINGLE_APP_RUNTIME.md#distribution-limits)
apply here in full.

## Build and deploy

Requirements on the server: PHP 8.1 or newer with the `zip` extension, and
any web server that runs PHP. Apache with `.htaccess` is what the included
rules target; other servers need the equivalent (index.php as the directory
index, `.wasm` as `application/wasm`, `.mjs` as JavaScript, and nothing under
`private/` reachable).

From the repository, with the CI toolchain (Node 20.19+ with npm 10):

```
npm ci
npm run build:packages
npm run build -w @softn/single-php-serve
npm run package:single-php-serve
```

`release/softn-single-php-serve-vVERSION.zip` holds two folders:

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
  trailing slash, or globs. The manifest cannot be withheld.
- `description` and `lang` fill the page's `<meta name="description">` and
  `<html lang>`; without a description the manifest's is used.
- `allowPrivateInWebroot` lifts the refusal to run when the private
  directory is inside the document root, for a host that can only offer one
  folder; its `.htaccess` then has to be honoured.

The sample bundle is generated only when `dist/private/app.softn` is absent,
and the sample configuration only when `dist/private/serve.config.php` is
absent; neither overwrites an operator's file. Runtime bounds: an entry up to
50 MB, a source pack up to 32 MB decoded, an icon up to 256 KiB, sixty
seconds to fetch the pack.

## Local preview

`npm run preview -w @softn/single-php-serve` serves `dist/webroot` with PHP's
built-in server on port 1456 (`PORT` and `PHP` override). `npm run dev`
builds first. Under the built-in server `.htaccess` is not read, so it stands
in for Apache's PHP handling only; the host itself answers 404 for any path
that is not its own, which is why `/app.softn` is not found there either.

## Tests

`npm test -w @softn/single-php-serve` covers the boot configuration, the
asset resolver's same-origin URLs and `pathOf`, the pack parser and loader,
the shell template, and the equality of the PHP extension table with
`@softn/core`'s registry. With `php` on PATH it also starts the built-in
server over a temporary deployment and checks the rendered shell, the cookie,
the pack's contents and what it omits, entry headers, conditional and range
requests, a nine-megabyte streamed entry, the icon, every refusal, the
digest pin, the sidecar and the generated secret. Without `php` that suite
is skipped.
