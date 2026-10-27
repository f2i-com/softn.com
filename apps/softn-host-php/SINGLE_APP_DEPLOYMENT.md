# Single-app runtime with an optional server backend

The browser runtime and its counter example work immediately. Server support is
optional and unconfigured. No private application, credentials or database is shipped.

## Static-only application

Upload the contents of webroot/ into your public website folder. Replace app.softn
and runtime.config.json with your own public app and configuration. You can omit
api.php and the entire backend/ folder if your app needs no server. No PHP or Node
process is used by the browser-only counter example. For a smaller download use
softn-app-static-vVERSION.zip, the separate static-only distribution.

## Enable a private application backend

Requirements: Linux Intel/AMD x86-64 (glibc 2.28+ only where requests run on the
bundled Node rather than softn-runner), Apache mod_rewrite and PHP 8.1+
with process execution enabled (proc_open, proc_get_status, proc_terminate and
proc_close not in disable_functions). The backend needs no PHP extension beyond a
stock PHP. PHP GD is optional, required only for photo routes (Debian/Ubuntu: the
php-gd package; a stock install does not have it).
The ZIP includes softn-runner, which answers each request with SQLite and the ZIPP
WASM engine and no Node, and Node beside it for operator request hooks and the
WebSocket bridge; no npm install, PHP FFI, separate listening server or systemd
service is required.

1. Put backend/ outside every public document root and Apache Alias. Put webroot/
   contents in your site's document root, including .htaccess: the API is served
   at /api/ from the site's root, not from a subdirectory. Configure Apache
   to honor its rewrite/header/MIME rules (AllowOverride All, or FileInfo, Options,
   Indexes and AuthConfig) and keep your existing HTTPS/PHP setup. Nginx, and an
   Apache with AllowOverride None, read no .htaccess: README-RUNTIME.md has the
   rules to write into the server's own configuration instead.
2. Install your expanded PRIVATE server API v1 bundle at backend/app/, with its
   manifest.json, server logic and SQL migrations. Put its separate PUBLIC client
   at webroot/app.softn and update runtime.config.json. Never publish server source.
3. In api.php, set $backend to the absolute private backend path if it is not a
   sibling of your public folder. No Rust reverse proxy is needed for this host.
4. A page on the same site may call its API with no setting. If the client is
   also served from another origin (www and non-www, another domain), list those
   exact HTTPS origins in manifest.config.server.allowedOrigins. Behind a
   TLS-terminating proxy, list it in trustedProxies (step 6) or list your origin.
5. Make the private backend directory owned by the PHP account. Run setup once
   as that account: `sudo -u www-data php /absolute/path/backend/setup.php`.
   Substitute your actual PHP user. Setup creates private/config.json and data;
   it preserves existing settings. Keep these private and back them up securely.
   It then checks PHP, that the runner requests start runs on this server
   (softn-runner, which needs no Node, where the backend carries it, as a
   release's does; else the bundled Node) and says which, and that the
   app answers /api/meta; any problem is a WARNING line and a non-zero exit,
   with the reason an app does not start beside it. If setup cannot go on (the
   folder is not this account's to write in, the manifest is not JSON, part of
   the upload is missing) it says which in one line. It checks the command-line
   PHP, which is often configured apart from the web server's: step 7 checks
   that one. On softn-runner it also says how much memory a request may take
   ("requestMemoryMb" in private/config.json, 256 MiB unless you set it) and
   what this kernel locks the runner down to: it confines itself, with no
   root, container or service needed (README-RUNTIME.md, softn-runner).
6. Review private/config.json: appId must match the PRIVATE manifest ID; retain
   the generated keyHex and cryptoDomains. Grant only the capabilities the app
   needs. Configure any trusted operator integrations separately. Do not put
   provider credentials in runtime.config.json or the public client bundle.
   Setup says how many of the web server's PHP workers the app may hold at
   once: four requests running, and requests waiting for one of those four
   to finish. Who waits depends on where PHP runs. Under php-fpm nobody
   does (a fifth request at once is told the server is busy) until you
   write "slotWaiters": N here, and you should only for a pm.max_children
   larger than four plus N; Ubuntu's php-fpm package ships 5. Under any other PHP
   (Apache's own, CGI, FastCGI) two wait by default: where the server gives
   PHP six workers or fewer (some shared hosts allow few processes), write
   "slotWaiters": 0, or an overload of the API holds every PHP worker and
   the rest of the site waits behind it. README-RUNTIME.md, Isolation and
   operation, has the measurements.
7. Visit /api/meta. A configured host reports runtime:zipp-wasm-on-demand. If it
   fails, its static diagnostic label identifies the failing startup check without
   exposing secrets (README-RUNTIME.md lists them: backend_public means backend/
   is somewhere the web server serves, private_permissions that setup was run
   as another account than the web server's PHP, open_basedir that PHP may not
   read the backend directory). Uploading the files alone does not initialize
   the backend. A 404 page of the web server's own for /api/meta means the
   rewrite rule is not in effect (mod_rewrite off, or .htaccess not read).
8. Check from outside that nothing private has a URL. Each of these must answer
   403 or 404, never 200:
   `curl -s -o /dev/null -w "%{http_code}\n" https://your.site/backend/private/config.json`
   and the same for /backend/private/data/application.sqlite,
   /backend/app/manifest.json and /.htaccess. On a server that reads no
   .htaccess, a backend/ uploaded into the document root is served to anyone
   who asks: README-RUNTIME.md, Security checklist.

## Compatibility and updates

For live updates, declare read-only GET polling routes with poll:true. Conditional
polls recheck authorization before returning 304. The optional websocket.mjs
bridge provides persistent connections for these same routes when separately
started and reverse-proxied by Apache. See LIVE_UPDATES.md for its protocol and
limits. Nothing starts that service automatically.

README-RUNTIME.md documents the supported server API contract. This host runs
bounded on-demand requests using SQL, crypto, time, trusted client IP, transactions
and optional photos. It does not replace the native Rust host's persistent
connections or XDB synchronization. Existing native databases and encryption keys
require an explicit migration; do not point this host at native state automatically.

To update, preserve backend/private/, backend/app/ (your application) and your
$backend line in api.php (take the new api.php and set the line again),
replace the rest of backend/ together, then run setup again.
README-RUNTIME.md covers backup/restore, upgrade notes, Nginx and a security checklist. Do not replace your
application with the example client. A backend packaged for Linux x64 will not run
on ARM or Windows. The static browser assets remain portable.

## Build from source

`npm run build:single` then `npm run package:single -- --with-backend` builds both
downloads. Without the flag, packaging stays static-only. Backend packaging uses
checksum-pinned official Node binaries and the repository's vendored WASM with
verified provenance, and softn-runner from --runner-dir <dir> where it is given
(apps/softn-runner/build.mjs writes it; a release always gives it). Licenses and checksums accompany each archive.
