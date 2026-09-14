# SoftN server-side audit (read-only) — 2026-09-15

Scope: `apps/softn-api` (directory API + pages), `apps/softn-php` (PHP front + Node worker
for one app's backend), `apps/softn-rust` (native host, single and multi-tenant), the
deployment configs emitted by `scripts/build-site.mjs`, `scripts/package-*.mjs`,
`scripts/single-backend-inputs.mjs`, and the shipped `.htaccess` files.

Overall: the three hosts are in good shape. Input bounds, path containment, SQLite
authorisers, SSRF blocking, constant-time key comparison, atomic writes and lock discipline
are all present and mostly correct. The real problems are (1) one lock-ordering bug in the
directory API that lets a slow client stall the whole site, (2) divergence between what a
`.softn` may declare for the Rust host and what the PHP host will accept, and (3) operator
defaults (canonical origin, proxies, CORS) that are safe only once configured.

Severity: **H** = fix before next deploy, **M** = fix this cycle, **L** = when touching the
file, **I** = informational / verified fine.

---

## H1. Directory API takes the exclusive catalog lock *before* reading an upload body

- `apps/softn-api/index.php:261-264`: `publish` calls `Db::rateLimit(...)` and only then
  `$req->bundleFile()`.
- `apps/softn-api/lib/db.php:146`: `rateLimit` calls `Catalog::boot()`.
- `apps/softn-api/lib/catalog.php:120`: `boot` takes `flock(LOCK_EX)` on `catalog.lock`
  and holds it until request end (`release()` at :199).
- `apps/softn-api/lib/http.php:518-546`: for the raw-body and `bundleBase64` upload forms
  `bundleFile()` streams `php://input` (`readBounded`) *inside* the request, i.e. while the
  lock is held. Every other request (`Apps::row` → `Catalog::doc` → `boot`) then queues
  behind it. One client trickling a 64 MB body at 1 KB/s stalls the directory for the
  duration; N such clients exhaust PHP workers.
- Multipart uploads are unaffected (PHP buffers them before the script runs).

Fix (backward compatible, no API change): in the `publish`, `versions` and thumbnail cases
call `$req->bundleFile()` / `$req->body()` first, then rate-limit and create. Better: make
`Db::rateLimit` not depend on the catalog lock (own `ratelimits.lock`, `LOCK_EX` for the
few ms of the read-modify-write), so read-only requests never wait on write-side limits.

## H2. `.softn` route declarations accepted by the Rust host are rejected by the PHP host

Same bundle, different outcomes:

| Rule | Rust `apps/softn-rust` | PHP host `apps/softn-php` |
| --- | --- | --- |
| Route path | anything not under `ui/assets/styles/fonts/images/icons` and not `/health`, `/manifest.json`, `/sync*` (`http.rs:353-366`) | must match `^/api/[a-zA-Z0-9/_-]+$` (`request-worker.mjs:42`) |
| `authorization` | `hosttoken` (default), `application`, `anonymous` (`bundle.rs:57`) | only `application`, `anonymous`; **whole worker throws** otherwise |
| `transaction` | `none` (default), `read`, `write` | only `read`, `write`; a route that omits it fails the same check |
| `public` flag | honoured (`http.rs:267`) | ignored |
| Default body limit | 2 MB (`MAX_JSON_PARSE_SIZE`, `http.rs:750`) | 32 KB (`http.php:33`), photo route 5.6 MB |
| Rate limit | ticket endpoint only | 120 req/min/IP in `_request_limits` (`request-worker.mjs`) |
| Methods | GET/POST/PUT/DELETE/PATCH via `add_method_route` | GET/POST/PUT/DELETE |

A bundle written against the Rust defaults (no `transaction`, no `authorization`, a
`/hooks/...` webhook path, a 200 KB JSON POST) loads fine on `softn-server` and returns
`503 runner_unavailable` or `413` on the PHP host, with no hint why. The published docs
(`docs/content/softn-docs.json`, hosting guides) describe one route schema.

Fix: define the route schema once (the `@softn/bundle-format` package recommended in the
structural audit is the right home), have the PHP worker *default* `transaction: read` and
`authorization: application` instead of throwing, accept any `/`-rooted path that is not a
static dir, and raise the default body limit to 256 KB with the manifest value winning.
Keep the strict regex as a *warning* in `softn inspect`, not a load failure. Existing
bundles that already pass the strict check are unaffected.

## M1. `Pages::origin()` builds canonical, `og:url` and share links from the `Host` header

- `apps/softn-api/lib/pages.php` `origin()`: when `siteOrigin` is not in
  `data/config.json`, origin = `X-Forwarded-Proto` + `$_SERVER['HTTP_HOST']`.
- `Config` defaults (`lib/db.php:49`) do not set `siteOrigin`, so a fresh install runs this
  way. A request with a forged `Host` (any Apache vhost that is the default server, or nginx
  `server_name _`) produces cacheable HTML whose canonical/OpenGraph URLs point at the
  attacker's domain; crawlers and link unfurlers cache it.

Fix: `seed.php`/`setup` writes `siteOrigin` from the first request or a CLI argument; when
it is unset, emit **no** canonical/og:url rather than a guessed one, and log a warning in
`/api/health`.

## M2. `/api` answers with `Access-Control-Allow-Origin: *` while accepting keys in the body

- `apps/softn-api/index.php` (CORS block): `*` origin, allowed headers include
  `X-Edit-Key, X-Admin-Key, X-Visitor-Token`.
- `lib/http.php` `credential()`: keys are read from the header **or** the JSON/POST body.
  No cookies are involved, so this is not CSRF, but it means any web page can drive the
  directory with a key a user pastes into it, and error bodies (which include app metadata
  and rate-limit state) are readable cross-origin.

Fix: keep `*` for the read-only routes the runtime and third-party embeds need
(`apps`, `app/:slug`, `bundle`, thumbnails), but for owner/admin routes reflect only
`siteOrigin` (plus the Studio/Builder origins listed in config). Backwards compatible for
every published app, since apps never call owner routes cross-origin.

## M3. Rate limits and visitor identity collapse to one bucket behind a proxy until configured

- `apps/softn-api/lib/http.php:263-290`: `X-Forwarded-For` is honoured only when
  `trustedProxies`/`trustProxy` is set (correct default).
- `lib/db.php:146` and `lib/social.php`: rate limits, ratings ("one per visitor") and
  storage owner tokens all key on `Config::visitorHash($req->ip)`.
- Behind Cloudflare/any reverse proxy with the default config every visitor is the proxy's
  IP: the first `publish` per hour locks everyone out, one rating per site, and the
  `storageWrite` limit is shared by all users of all apps.
- `apps/softn-rust/src/http.rs:900-917`: `--trust-proxy` trusts *any* peer's XFF (takes the
  rightmost entry, which is right), no CIDR list. The PHP side has the better model.

Fix: `/api/health` should report `proxied: true` when `HTTP_X_FORWARDED_FOR` is present
but no proxy is trusted; the deployment guides should make `trustedProxies` a required
step. For Rust, accept `--trust-proxy=<cidr,...>` and keep the bare flag as "any" for
compatibility.

## M4. `Apps::resolveSlug` resolves by app *name* as well as slug

- `apps/softn-api/lib/apps.php` `resolveSlug()`: if no app has the given slug, the first
  app whose `name` matches case-insensitively is returned.
- Names are not unique and are publisher-controlled (`patch` accepts any 64-char name).
  A publisher can name their app "Calculator" and capture `/app/calculator` traffic and
  `parent` remix links until someone publishes an app whose slug is `calculator`. Ordering
  of the name match depends on catalog iteration order (directory listing), so results are
  not even stable.

Fix: keep name resolution only for the `parent` field on publish (that is what it exists
for), and only when the match is unique; `/app/:slug` and `/api/app/:slug` resolve slugs only.
Add `410`/redirect metadata to the catalog if renamed slugs need to keep working.

## M5. Single-app hosts do not ship the isolation headers the site does

- `scripts/build-site.mjs` APACHE_CONFIG/NGINX_CONFIG: `Cross-Origin-Opener-Policy:
  same-origin`, `Cross-Origin-Embedder-Policy: credentialless`.
- `apps/softn-single/public/.htaccess` (only `nosniff` + `no-store`) and
  `apps/softn-single-php-serve/public/.htaccess` (`Service-Worker-Allowed`, `no-cache`):
  no COOP/COEP.
- If any runtime path relies on `crossOriginIsolated` (SharedArrayBuffer-backed ZIPP
  workers, `performance.now()` resolution), an app behaves differently self-hosted than on
  softn.com, and the PWA service worker in `softn-single-php-serve/public/sw.js` will cache
  that state.

Fix: verify whether the runtime needs isolation (grep `crossOriginIsolated`/
`SharedArrayBuffer` in `packages/@softn/core`). If yes, add the same two headers to both
single-app `.htaccess` files and to `DEPLOYMENT.md`; if no, remove them from the site
config too so the three hosts agree (COEP `credentialless` also silently breaks
`<img>`/`<iframe>` embeds of third-party content in published apps).

## M6. PHP host: 4 fixed concurrency slots, and a busy host answers `503` immediately

- `apps/softn-php/runtime/http.php:46-52`: four `slot-N.lock` files, `LOCK_NB`, `503
  database_busy` when all are taken. Each request spawns a Node process (`proc_open`,
  ~150-300 ms cold start) with a 25 s deadline.
- Four concurrent slow handlers (a 20 s poll, a photo upload) make the app read as "down"
  for everyone else; the runtime's poll routes (`poll: true`, `X-SoftN-Poll-Interval`) make
  this likely under modest load.

Fix: make the slot count a `config.server.workers` manifest value (default 4, capped by
the host at, say, 16), and let poll routes short-circuit on `If-None-Match` before taking a
slot (the ETag is computed in PHP at `http.php:116`, so the check could move ahead of the
`proc_open`). Consider a persistent worker later; out of scope for compatibility.

## L1. Edit keys are stored as unsalted SHA-256

- `apps/softn-api/lib/apps.php` `create()`/`requireOwner()`: `sha256(editKey)`, compared
  with `hash_equals`. The key is `random_bytes(20)` (160 bits) so brute force is not a
  concern, and the comparison is constant time. Fine as is; note it in the threat model so
  nobody "upgrades" to a slow hash and makes every request cost 100 ms.

## L2. `Catalog::retire` leaves subdirectories behind

- `apps/softn-api/lib/catalog.php:278-283`: unlinks files in the retired folder, skips
  directories, then `@rmdir`. Any app folder with a subdirectory (future thumbnails dir,
  WAL side files are files so fine today) stays as `.retired-<slug>-<rand>` forever and is
  invisible to `health`. Use a recursive delete or report leftovers in `/api/health`.

## L3. Rust fs bridge rejects any path containing `..`

- `apps/softn-rust/src/bridges/fs.rs:44`: `path.contains("..")`. Rejects legitimate names
  such as `notes..v2.txt`; the canonicalise + `starts_with` check that follows already
  covers traversal. Match components (`Component::ParentDir`) instead. Cosmetic but a
  compat difference from the JS `fs` shim.

## L4. Multi-tenant `/tenants` lists every tenant id unauthenticated

- `apps/softn-rust/src/http.rs:170`: `GET /tenants` on the multi-tenant router. Tenant ids
  are bundle filenames; listing them is fine for a demo box but should be behind the
  host token (or removed) when `serve-multi` is used publicly.

## L5. `storage` `query` `offset` capped at 10 000, `limit` at `maxQueryLimit`

- `apps/softn-api/lib/storage.php:512-527`: `COUNT(*)` plus a `SELECT` per query; both use
  `json_extract` on unindexed JSON. With the per-app quota in place this is bounded, but a
  hostile app author can still burn CPU with `where` on deep paths. Consider an expression
  index on `owner` and `collection` (already keyed) and a statement timeout via
  `PDO::ATTR_TIMEOUT`. No correctness issue: `FIELD` regex (`:47`) and `OPS` (`:49`) are
  sound, values are bound, `orderBy` is validated.

## L6. Directory `.htaccess` blocks `lib/` and `*.md`, nginx config relies on `location` order

- `apps/softn-api/.htaccess` `RewriteRule ^lib/ - [F,L]` and `data/.htaccess` deny-all only
  work with `AllowOverride All`. `scripts/build-site.mjs` NGINX_CONFIG does map `/data` to
  404, but `scripts/package-site.test.mjs` only checks the *page* allowlist agrees; add a
  test that both configs deny `/api/lib/`, `/api/data/`, `/api/backup.php` and `*.md`.

---

## Verified fine (I)

- **Zip inspection** (`lib/bundle.php:62-70, 251-258`): entry count, declared uncompressed
  total, unsafe path regex (`\`, leading `/`, `..` segments), encrypted entries refused,
  `getFromIndex` only after the per-entry `size` check; SVG icons filtered for scripts.
- **Catalog JSON writes** (`lib/catalog.php` `writeJson`): `tempnam` + `fsync` + `rename`
  under the lock; `validate()` (`:176-193`) fails closed with 503 and preserves the file.
- **Slug/path guards**: `validSlug` (`:106`), `path()` refuses symlinks, `setThumbnail`
  unlinks only under a validated slug.
- **Placeholder SVG** (`lib/apps.php:526`): colour validated by `color()` (`:480`),
  initials escaped with `ENT_XML1`.
- **Pages** escape with `htmlspecialchars`; play config JSON uses `JSON_HEX_TAG|AMP`.
- **Visitor tokens**: regex `^[A-Za-z0-9_-]{16,128}$`, hashed with salt and slug
  (`lib/storage.php:239`); policies `public|owner-write|private|publisher` enforced in
  `allowRead/allowAdd/allowChange`; `clear` requires the edit key (`:571`).
- **PHP host**: Origin allowlist from the manifest with `Vary: Origin` and preflight
  requiring an Origin (`runtime/http.php:16-25`); backend must sit outside the docroot
  (`:45`); JSON-only bodies with per-route limits; `proc_open` with
  `--disable-proto=throw`, fixed env, 25 s deadline, output caps, kill on timeout;
  worker `resourceLimits` 128 MB; SQLite `trusted_schema=OFF`, `max_page_count`, authorizer
  allowlist and single-statement check (`wasm-host.mjs`); WebSocket bridge upstream is
  loopback/https only with origin allowlist and 8 KB frames; `setup.php` CLI-only with
  `umask 0077`; `package.mjs` refuses to archive live state; `photos.php` re-encodes via GD.
- **Rust host**: `DefaultBodyLimit` from the manifest; bearer token compared as SHA-256
  digests with `ct_eq`; token stripped from `/manifest.json` (`bundle.rs:391`); ticket flow
  single-use, TTL, table cap, background eviction and an IP limiter; CORS closed in
  production unless `allowedOrigins` is set, open only in `--dev`; SQL bridge with
  `SQLITE_LIMIT_*`, `ATTACH` disabled, semantic authorizer, one statement per call;
  HTTP bridge with private/link-local/loopback blocking on the *resolved* address,
  `max_redirects(0)`, 20 s global timeout under the 25 s VM wall time; fs bridge
  canonicalises and rejects symlinks per component; WS frames capped at 4 MB;
  writer mutex poison recovery.
- **Packaging** (`scripts/single-backend-inputs.mjs`): Node 24.20.0 and `ws` pinned by
  SHA-256, vendored ZIPP WASM checked against `SOURCE.json`, licences copied beside it.

## Consistency matrix (what an app author gets on each host)

| Concern | softn.com (`softn-api`) | Static single | PHP-served single + backend | Rust `softn-server` |
| --- | --- | --- | --- | --- |
| Backend routes | none (storage API instead) | none | strict `/api/*` schema (H2) | permissive schema (H2) |
| Body limit | 64 M upload, JSON per route | n/a | 32 KB default | 2 MB default |
| Per-IP rate limit | yes, JSON file (M3) | n/a | 120/min in worker | ticket endpoint only |
| CORS | `*` (M2) | n/a | manifest allowlist, Origin required for preflight | manifest allowlist, closed by default |
| COOP/COEP | yes | no (M5) | no (M5) | not set by the binary |
| Proxy trust | `trustedProxies` list | n/a | none (uses `REMOTE_ADDR`) | `--trust-proxy` any (M3) |

## Suggested order

1. H1 (ten-line change in `index.php`, plus a dedicated rate-limit lock).
2. H2 in the PHP worker (defaults instead of throws) and a shared route schema; add a
   test that runs the same fixture manifest through both hosts' validators.
3. M1 + M3 as "first-run" checks surfaced by `/api/health` and the hosting guide.
4. M2, M4, M5 (after the `crossOriginIsolated` check), M6.
5. L-items when the files are next touched.
