# SoftN PHP on-demand WASM runtime (preview)

An application-independent host for SoftN server API v1. Apache/PHP starts one bundled Node process per request. ZIPP's safe-sandbox WebAssembly interpreter evaluates the application's server logic; Node provides explicitly granted host capabilities and SQLite. There is no daemon, listening backend port, PHP FFI, or PHP WASM extension.

## Deployment

Linux x86-64, glibc 2.28+, PHP 8.1+, enabled proc_open/proc_get_status/proc_terminate, executable-file permission, Apache mod_rewrite. PHP GD enables the photo adapter. Put webroot/ contents in the existing DocumentRoot and backend/ outside all public directories. api.php defaults to a sibling backend directory; edit its absolute path if necessary. Allow the supplied .htaccess FileInfo/Options/Indexes/AuthConfig directives (or AllowOverride All) and retain the site's PHP handler. Remove any old /api/ reverse proxy. Run `php backend/setup.php` as the PHP service account, which must own the backend folder. Setup creates private config/data; it does not start a service. It then checks what the first request would otherwise find out: the PHP version and process functions, that the bundled `bin/node` runs on this machine (it will not on ARM, musl or a `noexec` mount), and, with an application installed, that `/api/meta` answers — which applies the app's pending migrations, so run setup as the PHP account, never root, or the database it creates will be root's. Each problem is printed as a `WARNING:` line and setup exits 1. No system Node is needed or used. `api.php` answers `503` with `diagnostic:"php_version"` on PHP older than 8.1 and `diagnostic:"backend_path"` when `$backend` is wrong, instead of a PHP error that would print server paths.

Low-level template archives contain no application. The optional-backend single-app distribution includes the public counter example, but no private server bundle. Install the expanded private bundle at backend/app/, place the public .softn at webroot/app.softn, and supply a matching runtime.config.json before setup. Prefer the packager to generate the client hash and validate separation automatically:

```
node apps/softn-host-php/package.mjs --runtime <compiled-single-runtime> --bundle <expanded-private-bundle> --client <public.softn> --node-dir <node-linux-x64> --wasm-dir <zipp-web-artifacts> --notices <native-notices> --out <hosting.zip>
```

Use `--template` without --bundle/--client to produce a reusable runtime archive. Build tools are needed only on the packaging machine. Hosts receive compiled assets and a bundled executable.

For a site-owner-approved application, pass `--preapprove-permissions` with a current single-app frontend build. This writes `permissionMode:"preapproved"` into the public runtime.config.json and pins the bundle SHA-256. The single-app shell immediately enables only the bundle's declared permissions and hides its consent banner; browser file pickers and camera/microphone permission prompts remain browser-controlled. Default deployments still prompt. This is an operator setting in the deployment config, not a self-approval flag inside an app bundle. Older frontend builds must be replaced before using this setting.

## Supported contract

Optional read-only polling routes and the separately started WebSocket bridge are
documented in [LIVE_UPDATES.md](LIVE_UPDATES.md). The single-app CI distribution
includes both; polling requires no persistent service. The static-only ZIP remains
available without backend files.

- manifest.server.entry selects the private .logic source; manifest.server.routes selects handler functions, with the route schema the Rust host reads (`apps/softn-host-rust/PRIVATE_BACKEND.md`): `method`, `path`, `handler`, optional `transaction` (`read` or `write`; unset or `none` means `read` for a GET and `write` otherwise — on the Rust host `none` means no SQL at all), optional `authorization` (`application` or `anonymous`; unset means `application`), optional `maxBodySize`. A route this host cannot serve — a path outside `/api/` (Apache routes only those to api.php), a method other than GET/POST/PUT/DELETE, or `authorization: "host-token"` (the Rust spelling; `hosttoken` is also read; this host holds no token, so such a route answers 401) — is set aside and listed under `unservedRoutes` by `GET /api/meta`, and the rest of the app runs. No route parameters or wildcards yet.
- Request bodies are JSON objects (`application/json`, nesting depth 64), limited to the smaller of the route's `maxBodySize` and `config.server.maxBodySize`, else 256 KB; a declared value is honoured up to 2 MB (a `photo` upload route up to 5.6 MB). The Rust host bounds a route by the same two fields with a 2 MB default. No body reaches the handler as `{}`. Refusals carry the Rust host's codes: `413 payload_too_large`, `415 unsupported_media_type`, `400 invalid_request`.
- The handler receives `{method, path, query, headers, body}` as on the Rust host: `query` maps each percent-decoded name to its last value, always a string (PHP's own `$_GET` renaming and arrays are not used); `headers` holds every request header, lower-cased, except `Cookie` and `Proxy-Authorization`, with `authorization` and `idempotency-key` always present (empty when not sent). The handler's `body` is sent to the client exactly as the runner serialised it; PHP never decodes and re-encodes it.
- A browser page on the site itself may call its API; any other page's origin must be listed in `config.server.allowedOrigins` (exact `scheme://host[:port]`), or the request is `403 origin_not_allowed`. The site's scheme is the connection's, or a `trustedProxies` peer's `X-Forwarded-Proto`. Requests without `Origin` (non-browser clients) are not checked: authentication is the app's bearer session, never a cookie, so there is no CSRF surface. `OPTIONS` always gets an ok status and never reaches a handler (`204` here, `200` from the Rust host's CORS layer): an allowed Origin gets `Access-Control-Allow-Origin`, a foreign one does not (its browser stops at the preflight), and one with no Origin is not a CORS preflight and learns only the methods.
- Requires server API v1. Implemented capabilities: sql, crypto, time, trusted-client-ip, transaction-scope, photos. Requested capabilities must also be granted in private/config.json. Unsupported capabilities and enabled XDB sync fail closed; apps requiring db/XDB sync, arbitrary HTTP/FS, native modules or persistent callbacks are not compatible with this first adapter.
- The app owns authentication/authorization for `application` routes. Request headers reach it as data; the host itself trusts only what it derives (the client address, the sanitised upload). The client address (the host's per-address rate limit of 120 requests a minute, `429 rate_limited` past it — an IPv6 client shares its /64 — and `req.client_ip` for an app granted trusted-client-ip) is REMOTE_ADDR, and X-Forwarded-For is ignored — so behind a CDN or reverse proxy every visitor shares the proxy's address and one rate-limit bucket. To fix that, list the proxy's addresses or CIDR ranges (IPv4 and IPv6) as `"trustedProxies": ["10.0.0.5", "173.245.48.0/20"]` in private/config.json: X-Forwarded-For is then read only when the connecting peer is listed, and walked from the right past every listed hop to the first address that is not one, so a client cannot choose its identity (the Rust host's `--trusted-proxy=<peers>` rule). List only addresses your proxy connects from; `0.0.0.0/0` would let any client name itself. Apache mod_remoteip, which rewrites REMOTE_ADDR before PHP sees it, remains an alternative.
- `/api/meta` is host-reserved and returns app ID/version, development mode, photo availability and runtime identity. `softn.config` contains manifest.config.app plus operator-controlled development mode. Optional onStart() runs inside each fresh request VM.
- SQL uses the declared private-sqlite migrations, applied in one transaction in sorted path order (as the Rust host), each recorded with its SHA-256. A changed, duplicated, or previously applied but no longer listed migration stops startup (`diagnostic:"database_migrations"`). App tables must not begin with `_` (host-reserved). Lock waits are three seconds; past that the answer is the retryable `503 database_busy`, as when every process slot is taken. The SQL rules are the Rust host's (`runtime/sql.mjs`; its `bridges/sql.rs`), case by case in `tests/sql-parity.json`. Migrations may create and drop the app's tables and indexes, `ALTER TABLE` (add, rename and drop columns, rename tables), use CTEs (also recursive), the date functions and `printf`/`format`; attached DBs, PRAGMA, transaction control, views, triggers, virtual and temp tables, and `_` names (including renames into the namespace and `_` index names) are denied. At request time, query/first run one read-only statement (SELECT, WITH, VALUES) and execute one INSERT, UPDATE, DELETE or REPLACE (optionally behind WITH) that returns no rows, only in a write route. One statement (a `;` in a literal or comment is text); exactly as many parameters as the statement takes, at most 100, each a string, null or number within ±2^53−1 (a whole number binds as an INTEGER, as on the Rust host); 1000 result rows, 2 MiB result bytes, no BLOB values. Functions: count, min, max, sum, avg, total, coalesce, ifnull, nullif, length, lower, upper, trim, ltrim, rtrim, substr, substring, replace, instr, abs, round, like, glob, typeof, unicode, char, hex, quote; the SQLite authorizer refuses every other function and the host's tables. The Rust host currently refuses `ALTER TABLE … DROP COLUMN` and lets a migration rename a table into `_` (the `rust` notes in the fixture); an app for both hosts should not rely on either.
- `crypto` provides sha256, hmac, randomHex, randomInt, equal and seal. Key bytes and unseal are unavailable to the guest. Domains are configured per app in private/config.json. `time` provides now, parseZoned, format and age using IANA zones. Calendar parsing rejects ambiguous/nonexistent local times and supports minute-resolution offsets.
- A route with `upload:"photo"` requests the trusted PHP/GD upload adapter, which accepts a data_url, re-encodes it and supplies req.upload. Require the photos capability for these routes. No other request may inject req.upload.

## Security checklist

- `backend/` outside every public directory and Alias (http.php refuses to run inside the document root; the packaged `backend/.htaccess` denies all as a second guard).
- `private/` and `private/data/` are `0700`, `config.json` `0600`, owned by the PHP account; setup sets these. Never publish or commit them.
- `display_errors` off (http.php sets it; api.php answers configuration errors as JSON).
- `config.server.allowedOrigins` lists only origins other than the site itself that must call the API; `trustedProxies` lists only your own proxy/CDN ranges.
- `capabilities` in private/config.json grant only what the app declares; leave `enableRequestHook`, `enableAfterRequestHook` and `enableHostContext` off unless you installed trusted operator code.
- The webroot `.htaccess` sends `X-Content-Type-Options`, `Referrer-Policy` and framing limits (`frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`); to embed the app on another site, list that origin in `frame-ancestors` and drop `X-Frame-Options`. API responses carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
- Keep PHP, the bundled Node and ZIPP patched: replace the backend runtime files from a new release (below).

## Backup, restore and upgrade

Back up `backend/private/` as a whole: `config.json` (its `keyHex` and `cryptoDomains` decrypt sealed data and verify HMACs; losing it loses them) and `data/application.sqlite` with its `-wal`/`-shm` files. For a consistent copy while serving, use SQLite's backup API (`sqlite3 application.sqlite ".backup /safe/place.sqlite"`) or stop requests first; copying only the main file while WAL holds commits can lose them. Restore by putting both back, owned by the PHP account with the modes above.

To upgrade, keep `backend/private/`, `backend/app/` (unless deploying a new app version) and your edited `api.php`; replace all the other backend files together (http.php and the Node runtime files change as one) and the webroot runtime from the new archive, then run setup again (it preserves settings and re-runs its checks). A new app version may add migrations; never edit or remove one that has been applied. Upgrading to this runtime: migrations now run in sorted order and a deployment that dropped an applied migration from its manifest stops at `database_migrations` until it is listed again; the webroot `.htaccess` now limits framing.

## Nginx

Nginx does not read `.htaccess`. The equivalent, with PHP-FPM (reasoned from the Apache rules, not run in the test suite):

```nginx
root /srv/site/webroot;            # backend/ lives outside it, e.g. /srv/site/backend
location ~ /\. { deny all; }
location = /api.php { return 404; }
location ^~ /api/ {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root/api.php;
    fastcgi_param HTTP_AUTHORIZATION $http_authorization;
    fastcgi_pass unix:/run/php/php-fpm.sock;
}
add_header X-Content-Type-Options nosniff always;
add_header Content-Security-Policy "frame-ancestors 'self'" always;
types { application/wasm wasm; text/javascript mjs; }
```

Stock `fastcgi_params` passes `HTTPS` and `REQUEST_SCHEME`; a custom one must too, or same-site HTTPS pages look like `http://` and are refused as `origin_not_allowed`. Directory listing is off by default in nginx. `php -S` is not a supported server: it neither routes `/api/` nor honours `.htaccess`.

## Isolation and operation

Guest logic has no Node/PHP objects or filesystem/network/environment access. The only synchronous bridge is an exact capability dispatcher. Each VM has 5 million instructions and 512 host calls. The packaged linear-memory maximum is reduced from the upstream 1 GiB to 256 MiB. PHP enforces a 25-second child deadline, bounded pipes, and `config.server.workers` concurrent slots (four when unset, at most sixteen); a request past them is a `503 database_busy` to retry. Node managed heap is capped at 128 MiB separately; these are not total RSS limits. SQLite operations are transactional and a killed process rolls back uncommitted writes. The host rate limit persists across requests; quotas are per installed application. Separate installations/config keys/databases are required for separate tenants.

Optional operator/after-request.mjs runs only when private configuration explicitly sets enableAfterRequestHook:true. This is privileged, operator-installed integration code, not sandboxed application logic. It can perform bounded delivery/retry work after the guest transaction. It is never selected by a request or the manifest. Operator defaults can supply configuration via operator/defaults.json. Do not install untrusted operator modules. Applications without these adapters need none of this folder.

The runner also has an independent 20-second deadline on its supervising Node thread. WASM and synchronous SQLite run in a worker thread; a stuck worker cannot block the supervisor. This bounds execution even if the PHP parent disappears. The outer PHP deadline remains a second safeguard.

No background work runs while a site is idle. Integrations needing guaranteed retries should use an operator cron tick or another supported delivery system. Preserve private/config.json and private/data/ across updates; never publish them. Do not swap app IDs under an existing configuration. Existing native databases/keys require an explicit migration, not an automatic import.

This is a tested preview, not an independent security audit or a claim of compatibility with every native-server feature. Keep PHP, Node and ZIPP patched. The engine and host adapter form the trust boundary; PHP process launching alone is not a sandbox.

## Validation

`npm run test -w @softn/host-php` runs every suite. Some need things a
checkout does not have, and are SKIPPED without them — each skipped test
carries the reason, and each skipped file prints a `WARNING:` line on stderr,
so a run that tested less than it looks says so:

| Suite | Needs | Without it |
| --- | --- | --- |
| `package`, `request-hook` | nothing | always run |
| `client-ip`, `request` | `php` (8.1+) on PATH; the OPTIONS test also `php-cgi` | skipped |
| `sql-parity` (the shared SQL list, tests/sql-parity.json) | Node 24.19+ (node:sqlite) | skipped |
| `route-declarations` (route schema, runner output, migrations, busy database, ALTER TABLE and request SQL end to end) | `npm run fetch:zipp` (packages/@softn/core/wasm-zipp) and Node 24.19+ | skipped |
| `runtime`, `websocket`, `startup-diagnostics` (12 security tests: guest isolation, SQL and migration denial, rollback, WebSocket auth and Origin checks, startup diagnostics) | `SOFTN_PHP_TEST_BACKEND` naming an extracted, initialised Linux backend (`backend/` from a packaged archive, after `php backend/setup.php`) | skipped |

Run the fixture-bound suites on Linux against a fresh extracted package:

```
SOFTN_PHP_TEST_BACKEND=/path/to/extracted/backend npm run test -w @softn/host-php
python3 apps/softn-host-php/tests/apache-smoke.py --archive /path/to/template.zip
```

The integration test targets Debian/Ubuntu Apache module paths and php-cgi (WSL Ubuntu works on Windows), runs an isolated local instance on port 8811, installs a separate counter app, checks bearer forwarding, persistent data, verbatim response bodies, the request shape, same-origin and conditional-poll handling and the security headers, and exercises process-slot/output/deadline limits. It stops its Apache process and leaves its temporary extraction/logs for inspection. It does not change an existing Apache site.

## Trusted request integrations

Private configuration can opt into `enableRequestHook:true`. The host then loads the fixed operator-installed `operator/request.mjs` and calls its async `handleRequest({request,route,invoke,db,crypto,config})` for declared routes after migrations and host rate admission. A missing or failing enabled hook fails closed. `invoke(context)` executes the original request in the normal WASM transaction with a separate trusted `request.context`; any client-supplied context is discarded, including when the hook is disabled. The default context is empty. This supports bounded provider checks outside the guest and outside SQL transactions. The existing 20-second supervisor and 25-second PHP deadlines still apply.

The hook is privileged operator code with database and host access, not a guest capability or manifest-selected extension. Only install trusted integrations. Keep provider credentials in private configuration; pass only necessary validated results into context. Apps without this setting retain the normal route invocation. The after-request hook remains a separate opt-in.

## Startup diagnostics

A `backend_unavailable` response includes a static `diagnostic` label identifying the failed startup stage, such as `configuration_read`, `application_identity`, `database_migrations`, or `wasm_initialization`. It never includes raw exceptions, configuration values, SQL, keys, tokens, or filesystem paths. This label narrows investigation; it does not establish the underlying cause. Preserve private configuration and data while diagnosing an existing deployment.
