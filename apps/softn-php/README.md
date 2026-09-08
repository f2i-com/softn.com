# SoftN PHP on-demand WASM runtime (preview)

An application-independent host for SoftN server API v1. Apache/PHP starts one bundled Node process per request. ZIPP's safe-sandbox WebAssembly interpreter evaluates the application's server logic; Node provides explicitly granted host capabilities and SQLite. There is no daemon, listening backend port, PHP FFI, or PHP WASM extension.

## Deployment

Linux x86-64, glibc 2.28+, PHP 8.1+, enabled proc_open/proc_get_status/proc_terminate, executable-file permission, Apache mod_rewrite. PHP GD enables the photo adapter. Put webroot/ contents in the existing DocumentRoot and backend/ outside all public directories. api.php defaults to a sibling backend directory; edit its absolute path if necessary. Allow the supplied .htaccess FileInfo/Options/Indexes/AuthConfig directives (or AllowOverride All) and retain the site's PHP handler. Remove any old /api/ reverse proxy. Run `php backend/setup.php` as the PHP service account, which must own the backend folder. Setup creates private config/data; it does not start a service.

Template archives contain no application. Install the expanded private bundle at backend/app/, place the public .softn at webroot/app.softn, and supply a matching runtime.config.json before setup. Prefer the packager to generate the client hash and validate separation automatically:

```
node apps/softn-php/package.mjs --runtime <compiled-single-runtime> --bundle <expanded-private-bundle> --client <public.softn> --node-dir <node-linux-x64> --wasm-dir <zipp-web-artifacts> --notices <native-notices> --out <hosting.zip>
```

Use `--template` without --bundle/--client to produce a reusable runtime archive. Build tools are needed only on the packaging machine. Hosts receive compiled assets and a bundled executable.

For a site-owner-approved application, pass `--preapprove-permissions` with a current single-app frontend build. This writes `permissionMode:"preapproved"` into the public runtime.config.json and pins the bundle SHA-256. The single-app shell immediately enables only the bundle's declared permissions and hides its consent banner; browser file pickers and camera/microphone permission prompts remain browser-controlled. Default deployments still prompt. This is an operator setting in the deployment config, not a self-approval flag inside an app bundle. Older frontend builds must be replaced before using this setting.

## Supported contract

- manifest.server.entry selects the private .logic source; manifest.server.routes selects handler functions. Request paths must be exact `/api/` paths (no route parameters/wildcards yet), with GET/POST/PUT/DELETE, authorization `application` or `anonymous`, and transaction `read` or `write`.
- Requires server API v1. Implemented capabilities: sql, crypto, time, trusted-client-ip, transaction-scope, photos. Requested capabilities must also be granted in private/config.json. Unsupported capabilities and enabled XDB sync fail closed; apps requiring db/XDB sync, arbitrary HTTP/FS, native modules or persistent callbacks are not compatible with this first adapter.
- The app owns authentication/authorization for `application` routes. PHP only forwards trusted HTTP metadata; client-controlled forwarded-IP headers are ignored. Configure Apache mod_remoteip for an actual trusted upstream proxy if needed.
- `/api/meta` is host-reserved and returns app ID/version, development mode, photo availability and runtime identity. `softn.config` contains manifest.config.app plus operator-controlled development mode. Optional onStart() runs inside each fresh request VM.
- SQL uses the declared private-sqlite migrations. App tables must not begin with `_` (host-reserved). Migrations support ordinary tables/indexes; attached DBs, PRAGMA, transaction control, views, triggers and virtual tables are denied. Query/first accept SELECT; execute accepts INSERT/UPDATE/DELETE. One statement, up to 100 scalar parameters, 1000 result rows and 2 MiB result bytes. SQLite authorizer prevents private-table access and arbitrary SQL functions.
- `crypto` provides sha256, hmac, randomHex, randomInt, equal and seal. Key bytes and unseal are unavailable to the guest. Domains are configured per app in private/config.json. `time` provides now, parseZoned, format and age using IANA zones. Calendar parsing rejects ambiguous/nonexistent local times and supports minute-resolution offsets.
- A route with `upload:"photo"` requests the trusted PHP/GD upload adapter, which accepts a data_url, re-encodes it and supplies req.upload. Require the photos capability for these routes. No other request may inject req.upload.

## Isolation and operation

Guest logic has no Node/PHP objects or filesystem/network/environment access. The only synchronous bridge is an exact capability dispatcher. Each VM has 5 million instructions and 512 host calls. The packaged linear-memory maximum is reduced from the upstream 1 GiB to 256 MiB. PHP enforces a 25-second child deadline, bounded pipes, and four concurrent slots. Node managed heap is capped at 128 MiB separately; these are not total RSS limits. SQLite operations are transactional and a killed process rolls back uncommitted writes. The host rate limit persists across requests; quotas are per installed application. Separate installations/config keys/databases are required for separate tenants.

Optional operator/after-request.mjs runs only when private configuration explicitly sets enableAfterRequestHook:true. This is privileged, operator-installed integration code, not sandboxed application logic. It can perform bounded delivery/retry work after the guest transaction. It is never selected by a request or the manifest. Operator defaults can supply configuration via operator/defaults.json. Do not install untrusted operator modules. Applications without these adapters need none of this folder.

The runner also has an independent 20-second deadline on its supervising Node thread. WASM and synchronous SQLite run in a worker thread; a stuck worker cannot block the supervisor. This bounds execution even if the PHP parent disappears. The outer PHP deadline remains a second safeguard.

No background work runs while a site is idle. Integrations needing guaranteed retries should use an operator cron tick or another supported delivery system. Preserve private/config.json and private/data/ across updates; never publish them. Do not swap app IDs under an existing configuration. Existing native databases/keys require an explicit migration, not an automatic import.

This is a tested preview, not an independent security audit or a claim of compatibility with every native-server feature. Keep PHP, Node and ZIPP patched. The engine and host adapter form the trust boundary; PHP process launching alone is not a sandbox.

## Validation

Use a fresh extracted package's backend for the WASM/SQLite unit tests:

```
SOFTN_PHP_TEST_BACKEND=/path/to/extracted/backend node --test apps/softn-php/tests/runtime.test.mjs
python3 apps/softn-php/tests/apache-smoke.py --archive /path/to/template.zip
```

The integration test targets Debian/Ubuntu Apache module paths and php-cgi, runs an isolated local instance on port 8811, installs a separate counter app, checks bearer forwarding and persistent data, and exercises process-slot/output/deadline limits. It stops its Apache process and leaves its temporary extraction/logs for inspection. It does not change an existing Apache site.

## Trusted request integrations

Private configuration can opt into `enableRequestHook:true`. The host then loads the fixed operator-installed `operator/request.mjs` and calls its async `handleRequest({request,route,invoke,db,crypto,config})` for declared routes after migrations and host rate admission. A missing or failing enabled hook fails closed. `invoke(context)` executes the original request in the normal WASM transaction with a separate trusted `request.context`; any client-supplied context is discarded, including when the hook is disabled. The default context is empty. This supports bounded provider checks outside the guest and outside SQL transactions. The existing 20-second supervisor and 25-second PHP deadlines still apply.

The hook is privileged operator code with database and host access, not a guest capability or manifest-selected extension. Only install trusted integrations. Keep provider credentials in private configuration; pass only necessary validated results into context. Apps without this setting retain the normal route invocation. The after-request hook remains a separate opt-in.
