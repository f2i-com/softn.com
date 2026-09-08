# Single-app runtime with an optional server backend

The browser runtime and its counter example work immediately. Server support is
optional and unconfigured. No private application, credentials or database is shipped.

## Static-only application

Upload the contents of webroot/ into your public website folder. Replace app.softn
and runtime.config.json with your own public app and configuration. You can omit
api.php and the entire backend/ folder if your app needs no server. No PHP or Node
process is used by the browser-only counter example. For a smaller download use
softn-single-vVERSION.zip, the separate static-only distribution.

## Enable a private application backend

Requirements: Linux Intel/AMD x86-64, glibc 2.28+, Apache mod_rewrite and PHP 8.1+
with process execution enabled. PHP GD is optional, required only for photo routes.
The ZIP includes Node with SQLite and the ZIPP WASM engine; no npm install, PHP FFI,
separate listening server or systemd service is required.

1. Put backend/ outside every public document root and Apache Alias. Put webroot/
   contents in your site's document root, including .htaccess. Configure Apache
   to honor its rewrite/header/MIME rules and keep your existing HTTPS/PHP setup.
2. Install your expanded PRIVATE server API v1 bundle at backend/app/, with its
   manifest.json, server logic and SQL migrations. Put its separate PUBLIC client
   at webroot/app.softn and update runtime.config.json. Never publish server source.
3. In api.php, set $backend to the absolute private backend path if it is not a
   sibling of your public folder. No Rust reverse proxy is needed for this host.
4. Set manifest.config.server.allowedOrigins to the exact HTTPS origins serving
   your client. Include www and non-www separately if you serve both.
5. Make the private backend directory owned by the PHP account. Run setup once
   as that account: `sudo -u www-data php /absolute/path/backend/setup.php`.
   Substitute your actual PHP user. Setup creates private/config.json and data;
   it preserves existing settings. Keep these private and back them up securely.
6. Review private/config.json: appId must match the PRIVATE manifest ID; retain
   the generated keyHex and cryptoDomains. Grant only the capabilities the app
   needs. Configure any trusted operator integrations separately. Do not put
   provider credentials in runtime.config.json or the public client bundle.
7. Visit /api/meta. A configured host reports runtime:zipp-wasm-on-demand. If it
   fails, its static diagnostic label identifies the failing startup check without
   exposing secrets. Uploading the files alone does not initialize the backend.

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

To update, preserve backend/private/ and your edited api.php. Do not replace your
application with the example client. A backend packaged for Linux x64 will not run
on ARM or Windows. The static browser assets remain portable.

## Build from source

`npm run build:single` then `npm run package:single -- --with-backend` builds both
downloads. Without the flag, packaging stays static-only. Backend packaging uses
checksum-pinned official Node binaries and the repository's vendored WASM with
verified provenance. Licenses and checksums accompany each archive.
