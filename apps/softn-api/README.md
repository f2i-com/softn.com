# The softn.com directory API

PHP with a folder-based JSON catalogue, deployed as `/api/` beside the static site.
It is what turns softn.com from a landing page into an app directory: a
catalogue of `.softn` bundles that anyone can publish to, play from, rate,
comment on and remix, plus a small server-side database for each app that asks
for one. No daemon, no accounts, no MySQL — it runs on shared hosting that
takes a zip upload.

## Requirements

- PHP 8.1 or newer with `zip` and `mbstring`; `pdo_sqlite` is needed only for legacy migration and apps that use server-side storage
- A writable `data/` directory beside `api/` (the build creates it; `GET /api/health` reports whether it is writable)
- Upload limits large enough for a bundle; `api/.user.ini` asks for 64 MB on PHP-FPM and CGI hosts, and `GET /api/health` says whether the host agreed (see "Limits")

## Add an app by copying a folder

Put a valid bundle here (lower-case letters, digits and hyphens in the folder name):

```text
data/
  apps/
    urbanward/
      v1.softn
      app.json           generated on discovery; kept with the app
      icon.svg           extracted from a declared bundle icon, when present
      thumb.png          optional: reference it as app.thumb in app.json
      storage.sqlite     optional app-owned saved data, not directory metadata
  sequences.json         monotonic comment identifier allocation
  categories.json        category definitions
  ratelimits.json        expiring visitor action windows
  cache/bundles.json     disposable bundle inspection cache
  catalog.lock           stable process lock; never delete it while serving
  config.json            private site configuration and keys
```

The next API request discovers new folders and `.softn` files. There is no
SQL registration step or server restart. Prefer `v1.softn`, `v2.softn`, etc.
Other safe `.softn` filenames are accepted and assigned a stable version
number in `app.json`. Upload a bundle with a temporary extension, then rename
it to `.softn` when complete. Removing a bundle removes that version from the
listing; removing the folder removes the app. A folder with no valid bundles
is not listed. Invalid bundles are skipped. A folder whose `app.json` is
malformed or invalid, or that cannot be read or written, is skipped with the
reason in the PHP error log; its files are never touched or replaced with
empty metadata, it keeps its slug so nothing is published over it, and the
rest of the directory is served. Repair the file and the app is listed again
on the next request. A bundle that would repeat a version number already
held by another file in the folder is skipped, not the app.

You can also provide this minimal `app.json` alongside a new bundle:

```json
{
  "schemaVersion": 1,
  "app": {
    "name": "Urbanward",
    "category": "games",
    "description": "Build a city that tells a story.",
    "tags": ["city", "simulation"]
  }
}
```

### Link an app hosted elsewhere

A Softn app that lives on its own site (its own domain, a private
single-app host) can be listed without its bundle. Make a folder with an
`app.json` that names the address and, ideally, a picture, and no `.softn`:

```text
data/apps/outerstead/
  app.json
  thumb.png          the card and link-preview picture (1200 × 630 works well)
```

```json
{
  "schemaVersion": 1,
  "app": {
    "name": "Outerstead",
    "author": "Lance",
    "category": "games",
    "description": "A frontier colony sim. Land, build, keep your people alive.",
    "tags": ["colony", "survival"],
    "thumb": "thumb.png",
    "play_url": "https://outerstead.com/"
  }
}
```

The app appears in the directory with its picture, description, rating,
comments and share page like any other. Its card carries `external`
(`{url, host}`) and `urls.run` is the address itself: Play opens it in a new
tab and counts a launch, which for a linked app is also the run (no runtime
will ever report one). There is nothing to run here, download, read or
remix, so `urls.bundle`, `download`, `studio`, `builder` and `remix` are
null and `/bundle.softn`, `/source`, `/versions` and `/remix` answer 404.
`play_url` (or `playUrl`) must be an `http(s)` address of at most 300
characters; a folder with an invalid one is skipped with the reason in the
error log, like any invalid `app.json`. A folder with neither a bundle nor a
`play_url` is still not listed. If a `.softn` is later added to the folder
the address keeps precedence; remove `play_url` to turn the listing into an
ordinary hosted app.

Missing fields are filled on discovery. A generated file contains `app`
(listing fields, counters and hashed edit key), `versions`, `comments`,
`ratings`, and `runsDaily`. Tags and permissions are JSON arrays/objects,
not embedded JSON strings. `app.runs` counts successful opens;
`app.launches` counts presses of Play. Plays, comments, moderation and ratings
update this file atomically. A folder-added app belongs to the administrator;
published apps retain their edit keys. Keep the entire `data/` folder private:
metadata includes hashed identities and ownership information.

For live edits, use the existing PATCH/admin APIs. If editing JSON manually,
pause API writes or have your editor acquire `data/catalog.lock` before reading
and replacing the file. An ordinary editor or file-copy command does not
participate in the API's locking protocol and can overwrite newer counters.
Back up while requests are stopped or hold that same lock for a consistent
snapshot. Do not replace the whole app.json just to change a category.

## Concurrency and cache

Independent PHP workers acquire an OS `flock` on the stable catalogue lock
before reading the folder snapshot. The lock covers validation, version/slug
allocation, and metadata updates. Read-modify-write operations are therefore
serialized, including ratings, comments, plays and rate limits. A write uses
a unique sibling temporary file, flush/fsync, and rename; it never truncates
the live JSON file. Counter plus history updates for one app are in the same
JSON replacement. The OS releases the lock if a worker exits or is killed.
The lock is released before the response body is sent. Remix counts derive
from folder relationships, so they need no second app-file transaction.

This is a single shared-filesystem design. All writers must use the same
lock and a filesystem supporting `flock` and atomic same-directory rename.
It is not distributed coordination across independent disks. Serializing the
catalogue trades peak request throughput for simple, reliable updates; large
comment histories also increase the size of an app's JSON rewrite. This does
not promise power-loss durability of filesystem directory entries.

Folder entries and app.json are reread for each request. The derived bundle
cache (`cache/bundles.json`) avoids reopening ZIPs: a bundle is inspected
when it is first met and again only when its size, mtime or ctime changes,
which every write the API makes (a temp sibling renamed into place) does.
A bundle that has not changed is never re-read for time alone. The safety
net for a replacement made by hand with its size and timestamps intact is a
periodic sweep: a bundle whose last inspection is older than
`cacheSweepSeconds` (default 600) is read again, at most `cacheSweepBatch`
(default 200) bundles per request, so a large catalogue spreads the sweep
over requests instead of holding the lock for all of it. (Until the
2026-09-11 round-2 repair the cache re-inspected every bundle whose stamp
was five seconds old; under load, where every request waited longer than
that for the lock, that meant every bundle on every request — 20,908
inspections during 200 list requests at 1,000 apps.)
Deleting or corrupting `cache/bundles.json` rebuilds it without losing any
plays, comments, ratings or ownership. Search/filter/sort use PHP over the
current metadata snapshot; search is case-insensitive word matching, with
name matches ranked first, rather than SQLite FTS stemming.

## Limits

`display_errors` must be off wherever the API runs (`api/.user.ini` says so for FPM and
CGI hosts; mod_php reads `php_flag display_errors off` from `.htaccess`; a `php -S`
development server takes `-d display_errors=0`). PHP refuses a POST body past
`post_max_size` before `index.php` runs, and with display_errors on it writes that warning
into the response first, so the headers are already sent when the API answers 413 and the
client sees a 200 with a warning in the body instead.

Every request body is read against a limit chosen from the route alone,
before a byte of it is read, and refused with a `413` that names the limit
(`{"ok": false, "error": …, "limit": <bytes>}`) the moment it is exceeded —
the rest of an oversized body is never read into memory. The limits are in
`data/config.json`; how each route gets one is `Limits` in `lib/http.php`.

| Setting | Default | What it bounds |
|---|---|---|
| `maxJsonBytes` | 256 KB | The body of every route that carries no file: comments, ratings, storage operations, `PATCH`, category suggestions |
| `maxBundleBytes` | 32 MB | A bundle, however it arrives: a multipart file, a raw body, or the decoded `bundleBase64` |
| `maxThumbnailBytes` | 2 MB | An image, the same three ways |
| `maxThumbnailSide` | 8192 | The longest side an image may declare, in pixels |
| `maxThumbnailPixels` | 16,000,000 | The most pixels (width × height) an image may declare |

From those, two envelopes: the JSON body of a route that takes a bundle
(`POST /api/apps`, `/versions`, `/remix`) may be as large as the bundle and
a thumbnail in base64 plus `maxJsonBytes` — 45.6 MB at the defaults — and
the JSON body of `POST …/thumbnail` the image in base64 plus `maxJsonBytes`.
`GET /api/health` reports all of these under `limits`.

How the checks fall:

- A `Content-Length` past the route's limit is refused before anything is
  read. The bytes are counted as they arrive regardless, in 64 KB pieces,
  and the read stops one byte past the limit — so a body with no declared
  length (chunked) is bounded the same way, and a declared length that does
  not match what arrived is a `400`.
- A raw bundle body is spooled to a temporary file piece by piece, never
  held whole in memory. A `bundleBase64` field is refused from its encoded
  length (what it *would* decode to) before it is decoded. A multipart file
  is refused by its size on disk.
- An image is sniffed for its type, then its header is read for the size
  it declares (`getimagesize`, a few bytes) and refused with a `422` past
  the side or pixel budget — before anything would decode it. The API
  decodes no image itself; the budget is for the browsers that will show
  it and for any resizing added later.
- Temporary files the request made for itself are removed when the request
  ends, however it ended; a multipart upload's file PHP removes itself.

**Align the host.** PHP reads a POST body only up to its own
`post_max_size` and a multipart file up to `upload_max_filesize`; a web
server in front (nginx `client_max_body_size`, Apache `LimitRequestBody`)
may cut earlier still. Each must be at least the bundle envelope, or an
upload the API would take arrives empty and fails as "no bundle was sent".
`api/.user.ini` sets 64 MB for PHP-FPM and CGI hosts; a mod_php host reads
`php_value post_max_size 64M` and `php_value upload_max_filesize 64M` from
`.htaccess` instead, and a host that allows neither takes them in `php.ini`.
`GET /api/health` reports `uploadMax`, `postMax`, `memoryLimit` and
`limits.hostAligned`, which is `true` when the PHP values cover the
envelope. When they do not, the API answers a body between the two limits
with a `413` that says which PHP setting to raise, rather than a misleading
`400`. `memory_limit` should stay at the 256 MB `.user.ini` asks for: a
base64 bundle at the limit is decoded from a JSON array that already holds
the encoded text, and the two together are a little over twice
`maxBundleBytes`.

A `data/config.json` written by an earlier version carries the old
`maxJsonBytes` of 48 MB, since the file is written once with every default;
lower it to `262144` by hand. The bundle and thumbnail routes never
depended on it.

## Trusted proxies

The visitor's address keys the rate limits and one-rating-per-person, so
who may assert it matters. `trustedProxies` in `data/config.json` lists the
peers allowed to: addresses or CIDR ranges, IPv4 and IPv6 alike
(`["10.0.0.5", "10.1.0.0/16", "2001:db8::/32"]`). Empty — the default —
trusts nobody, and every request is the address it connected from.

When the connecting peer (`REMOTE_ADDR`) is in the list, `X-Forwarded-For`
is walked from the right: each entry that is itself a trusted proxy is a
hop and is skipped, and the first entry that is not one is the client. A
client behind the edge therefore cannot choose its identity — whatever it
prepends sits to the left of the entry the edge appended, and the walk
stops there — and a client that reaches the host directly cannot either,
since its header is not read. A malformed entry met on the walk, an empty
or missing header, or a chain longer than sixteen trusted hops resolves to
the peer's own address; a chain of nothing but trusted proxies resolves to
its leftmost. An IPv4 address carried inside IPv6 (`::ffff:10.0.0.5`) is
matched as the IPv4 it is; a port after an entry is dropped. A malformed
range in the list is ignored and logged nowhere: it neither opens the
policy nor closes the rest of it.

`trustProxy: true`, the older switch, still works and means "trust the
peer this request came in on, whoever it is" — the rightmost entry is
then the client, as before. It is only safe on a host that nothing but its
own edge can reach, which is a property of the network, not of this file;
it is kept as a compatibility alias and is deprecated in favour of naming
the edge in `trustedProxies`. `GET /api/health` reports how many trusted
ranges are configured and whether the alias is on (`proxy`), and not the
addresses. Nothing logs a forwarded chain or a key.

## Timings, atomic commits and the benchmark

Every metadata file — each app's `app.json`, `categories.json`,
`ratelimits.json`, `sequences.json`, the bundle cache — is committed by
writing a complete temporary sibling in the same directory, flushing and
syncing it, and renaming it over the live file; a bundle is copied the same
way. A reader never opens a partial file: the rename is atomic, and every
reader takes the catalogue lock before reading, so it is held until the
writer that holds it has committed or died. A writer killed mid-commit
leaves its temporary sibling (`.json-…`, `.upload-…`) beside an intact live
file; the catalogue ignores them, and the next request serves what was
committed. `test/catalog-recovery.test.mjs` does exactly that.

The catalogue measures itself. `GET /api/health` carries a `timings` block
for its own request — `lockWaitMs` (time to acquire the catalogue lock),
`lockHoldMs`, `bootMs` (reading every folder), `rebuild` (bundles the cache
had to inspect again: `count` and `ms`, and `swept`, how many of them the
periodic sweep asked for rather than a change), `commit` (metadata files
written, count and ms), `apps` (folders loaded) and `thresholds` (see
"Thresholds" below). With `"debugTimings": true` in
`data/config.json` every response carries the same numbers as a
`Server-Timing` header (`lock;dur=…, hold;dur=…, boot;dur=…,
rebuild;dur=…;desc="N bundles", commit;dur=…;desc="N files", apps;desc="N"`),
which is what the benchmark reads. Leave it off in production: the numbers
are not secret, but they are noise to every other client.

`node scripts/bench/catalog-bench.mjs --sizes 100,1000` builds disposable
catalogues of that many synthetic apps under the system temp directory,
starts several `php -S` workers over each (separate processes, so the lock
is contended for real), runs concurrent list, read, publish, update and
mixed load, and prints p50/p95 latency, lock wait and hold, cache rebuild
time and disk usage as a table and as JSON. `--api <dir>` measures a copy
of another revision, which is how a before/after pair is made without
touching the working tree; `--label` names the run in the JSON. The runs
behind the thresholds below are in `bench/results-2026-09-11.json`
(before and after the round-2 repair, 100 and 1,000 apps, with the machine
they ran on); the numbers depend on the machine. Note what the design
implies before reading them: every request re-reads every `app.json` under
the lock, so per-request cost grows with the catalogue, and a cold cache
inspects every bundle once.

### Thresholds

`timings.thresholds` on `/api/health` names what a request should stay
under, so an operator's probe can compare its own request's numbers with
them. There is no alerting here: the probe decides what to do. The values
come from the 1,000-app "after" run in `bench/results-2026-09-11.json`
(Ryzen 9 9950X3D, Windows 11, PHP 8.4.15, four `php -S` workers, eight
requests in flight):

| Threshold | Default | Where it comes from |
|---|---|---|
| `lockWaitMsP95` | 1000 | Lock wait p95 at 1,000 apps under that load was 564–827 ms in the read phases and 1,160 ms in publish (which also inspects the upload). A probe waiting longer than a second is behind a queue the design cannot drain: every request re-reads every `app.json` under the lock. |
| `lockHoldMsP95` | 350 | Lock hold p95 at 1,000 apps was 193–346 ms, almost all of it the boot (reading every folder, p50 170–250 ms). A hold past this on a warm catalogue means a rebuild, a sweep batch, a slow disk, or more apps than the design is sized for. |
| `warmRebuildCount` | 0 | On a warm catalogue no bundle is inspected: `rebuild.count` is 0 unless a bundle changed or the periodic sweep ran (`rebuild.swept` says which). A probe seeing rebuilds on every request is the round-1 defect back. |

Override any of them in `data/config.json`:

```json
{ "timingThresholds": { "lockWaitMsP95": 2000, "lockHoldMsP95": 600, "warmRebuildCount": 0 } }
```

The scale envelope these runs show: the per-request boot is ~0.2 ms per
app on that machine (17 ms at 100 apps, ~250 ms at 1,000), and because
requests serialise on the lock, throughput at 1,000 apps is about 4–6
requests per second whatever the worker count. Up to a few hundred apps the
catalogue is not the bottleneck; at 1,000 it serves, with latencies of one
to two seconds under eight concurrent clients; beyond that the design's
next cost is the per-request read of every `app.json`, which only a
persisted index would remove. The 10,000-app size was not run in this
round.

## Backup and restore

`backup.php` makes a backup a product operation rather than a file copy:

```bash
php apps/softn-api/backup.php export  /backups/softn-2026-09-11.tar   # or .zip
php apps/softn-api/backup.php verify  /backups/softn-2026-09-11.tar
php apps/softn-api/backup.php restore /backups/softn-2026-09-11.tar --into /srv/site/data
```

The data directory is `SOFTN_DATA_DIR`, else `data/` beside `api/`; `--data`
names another for an export. Export takes the catalogue lock — the same
`flock` every request takes, so requests wait while the snapshot is made
and nothing is half-committed in it — checkpoints each app's
`storage.sqlite` so its WAL is folded into the main file, and writes every
metadata file, bundle, picture and database into the archive. It leaves out
what is not data: `catalog.lock`, `config.lock`, the rebuildable
`cache/`, the temp siblings a killed writer leaves (`.json-…`,
`.upload-…`), retired folders and SQLite's `-shm`. Inside the archive,
`softn-backup.json` lists every file with its size and SHA-256, every app
with its versions' files and digests, and a digest of that list. Export
reads its own archive back and verifies it before reporting success.

`verify` checks an archive against its manifest and refuses it on the first
difference: a file missing or added, a byte out of place, a manifest edited.
`restore` verifies first and writes nothing on failure; then it extracts
into a staging folder beside the destination, hashes what landed, takes the
destination's catalogue lock and moves the files in. The destination must
be absent or empty (`catalog.lock`, `config.lock` and `README.txt` do not
count); `--force` replaces what is there. The restored folder is booted
once, which rebuilds the bundle cache, and the inventory the catalogue then
lists is compared with the one the archive promised — every slug, every
version's file and digest — so "restored" means "serves the same apps".
Exit codes: 0 done, 1 usage or I/O failure, 2 refused (verification, or a
destination that is not empty), 3 restored but the inventory differs.

The archive holds `config.json` — the admin key and the visitor-hash salt
— and every edit-key hash: keep it as private as `data/` itself. A restore
into a running installation needs the API's workers to be on the same
`SOFTN_DATA_DIR`; they pick up the restored catalogue on their next request.

## Existing SQLite installations

On the first catalogue request, an existing `directory.sqlite` is imported
under the catalogue lock into per-app JSON and `categories.json`. Versions,
comments (including hidden ones), ratings, counters and edit-key hashes are
preserved. Existing app.json files take precedence, so an interrupted import
can resume without replacing completed files. A `directory-migrated.json`
marker prevents later imports. The original SQLite file is retained as a
backup and is no longer used after migration. Stop old API workers during the
upgrade: older code writing SQLite does not acquire the new lock. Back up
`data/` before deploying; do not delete the marker while the backup remains.
Transient rate-limit windows restart at migration. Apps' own `storage.sqlite`
files are unchanged.

## Ownership

There are no user accounts. Publishing returns a 40-character **edit key**;
whoever holds it can update the listing, upload a new version, replace the
thumbnail or unpublish. The server stores only a hash of the key. The site
keeps the keys it has been given in the browser's local storage, which is how
"Your apps" on the publish page finds them again.

Moderation uses an **admin key**, generated into `data/config.json` on first
run and sent as `X-Admin-Key`. Seeded demo apps have no edit key, so only the
admin can change them.

Visitors are identified by a salted hash of their address, used for rate
limits and one rating per person per app. Nothing else about a visitor is
kept.

## Routes

`GET /api` returns this list as JSON.

| Route | What it does |
|-------|--------------|
| `GET /api/apps` | Search and browse. `q=`, `category=`, `tag=`, `author=`, `cap=nonet\|none\|storage\|worker`, `sort=trending\|newest\|top\|remixed\|runs\|name`, `page=`, `perPage=` |
| `GET /api/apps/{slug}` | One listing, with its versions |
| `GET /api/apps/{slug}/bundle.softn` | The bundle. `v=` picks a version, `download=1` sends it as an attachment. Carries an `ETag` and answers `If-None-Match` with a 304; `HEAD` gives the headers alone. See "Caching a bundle" |
| `GET /api/apps/{slug}/thumbnail`, `/icon` | Pictures. The URLs the API hands out carry `?v=<updated_at>` because pictures are cached for ten minutes |
| `GET /api/apps/{slug}/source` | The bundle's source files, for the app page's viewer |
| `GET /api/apps/{slug}/comments`, `/rating` | Comments (paged) and the rating summary |
| `GET /api/categories` | Categories with counts. The site-owned ones (Games, Examples, …) are refreshed on every request so renamed core categories reach existing directories |
| `POST /api/apps` | Publish. The bundle goes as a multipart field named `bundle`, as the raw request body, or as `bundleBase64` in JSON; other fields are `name`, `description`, `author`, `category`, `tags`, `notes`, `primary`, `parent`, `thumbnail`. Answers with the listing and its `editKey` |
| `POST /api/apps/{slug}/versions` | A new version of the bundle (`X-Edit-Key`) |
| `PATCH /api/apps/{slug}` | Change the listing's fields (`X-Edit-Key`) |
| `POST /api/apps/{slug}/thumbnail` | Replace the picture (`X-Edit-Key`) |
| `DELETE /api/apps/{slug}` | Unpublish (`X-Edit-Key`) |
| `POST /api/apps/{slug}/remix` | Publish a new app that records this one as its parent. Same fields as publish; the bundle is optional and defaults to the parent's |
| `POST /api/apps/{slug}/comments` | `{name, body}` |
| `POST /api/apps/{slug}/rating` | `{stars}`, one per visitor |
| `POST /api/apps/{slug}/runs` | Counts a play |
| `POST /api/apps/{slug}/storage` | The app's own storage, see below |
| `GET /api/apps/{slug}/storage`, `/storage/{collection}` | What an app has stored: collection names and counts, then a page of one collection |
| `GET /api/README.md` | This file |
| `POST /api/categories` | `{name, description, emoji}` (admin) |
| `GET /api/health` | Folder catalogue/cache backend, ZIP support and whether `data/` is writable |

`/app/{slug}` (no `api`) is a share page: the listing rendered as HTML with
Open Graph tags, for links pasted into chat. `/play/{slug}` is where the app
runs; see "Playing an app" below. Both are also reachable as
`GET /api/page/app/{slug}` and `GET /api/page/play/{slug}`.

## Playing an app

Play on the site goes to `/play/{slug}`. That page is the single-app shell —
the small runtime `apps/softn-single` builds, which the site build places
under `/play/` — served by this API with the app's configuration written into
the document:

```html
<script type="application/json" id="softn-runtime-config">
{"version":1,"id":"snake-game","title":"Snake",
 "bundle":"/api/apps/snake-game/bundle.softn?v=3","sha256":"…",
 "loadingText":"Loading Snake…","theme":"dark","permissionMode":"prompt",
 "directory":{"runs":"/api/apps/snake-game/runs","storage":"/api/apps/snake-game/storage"}}
</script>
```

It is the same shape a standalone deployment's `runtime.config.json` has,
so the shell holds it to the same rules: every location is a path on this
origin, and anything else stops the load. What it buys over the full
runtime at `/web/app/{slug}`: no launcher, catalogue, tab bar or bundle
cache in the download, no round trip for a config file, and a bundle named
by version with its digest pinned — so the browser may keep it for the day
the API allows and the shell still refuses bytes that are not the ones
published. The shell counts the run on the `runs` endpoint once the app is
up, and reaches the app's own database through `storage`, which is named
only when the app declared that capability. The page wears the same slim
bar the runtime draws over every app: the way back to the directory and to
the app's page, the menu, fullscreen, and a fold-away. It carries the app's
name as its title and `<meta name="softn:app">`; an unpublished or unknown
name is a real 404. The bare `/play/` redirects to the directory.

An app runs with every capability it declares withheld until the visitor
allows it on the bar above the app. **Trusting** an app removes that bar:
its play page is served with `"permissionMode": "preapproved"` — the same
setting the [PHP single-app host](../../docs/SINGLE_APP_PHP_SERVE.md) has —
and the shell grants what its `permission.json` declares from the start.
Trust is the operator's alone to give, and it is given on the server, by
hand, in the `app` object of the app's own `app.json`:

```json
{
  "schemaVersion": 1,
  "app": { "slug": "snake-game", "name": "Snake", "trusted": true, … },
  …
}
```

No route sets that key — publishing, patching and remixing never write it —
and the catalogue carries it along when it rewrites the file for a run
count or a comment. Only the JSON `true` counts; `"true"`, `1` or a missing
key read as untrusted, so a typo fails closed. The listing reports the
setting as `trusted`, and the app's page on the site says so under "What it
asks for". Remove the key, or set `false`, to take the trust back. Edit the
file the way the data README says: with the API stopped, or holding
`catalog.lock`. A linked app (`play_url`) has no play page here; `/play/{slug}`
redirects to its address. Keep in mind what the bar was for before trusting
an app whose author you are not: a trusted app with `net` reaches every host
its declaration allows, on every visitor's connection, without asking them.

## Caching a bundle

A bundle response carries `ETag: "<sha256 of the archive>"`. A request with
`If-None-Match` naming that tag (weak `W/` tags and `*` count too, as RFC 9110
§13.1.2 prescribes for this header) is answered with a bodyless `304` that
repeats the `ETag` and `Cache-Control`, so a runtime or a cache that already
holds the bytes never downloads them twice.

That works from another origin too. Every response allows any origin, the
preflight allows `If-None-Match` (which is not CORS-safelisted, so a browser
would otherwise refuse to send it), and `ETag`, `Content-Disposition` and
`Retry-After` are exposed, so a page elsewhere can read the tag, revalidate
with it, name a download, and honour a rate limit.

The two shapes of URL cache differently. `bundle.softn` with no `v=` is the
latest version, which the next publish moves: it is `no-cache, must-revalidate`,
so every use asks the server, and the answer is usually the 304. `bundle.softn?v=N`
names one version whose bytes are settled: it is `public, max-age=86400` — a day,
not immutable, because an unpublish or an admin purge has to reach every cache
within a day, and because the seed can replace a demo's v1 in place.

`HEAD` on either URL returns the status and headers a `GET` would, `Content-Length`
and `ETag` included, with no body. `Range` requests are not implemented: the
response says `Accept-Ranges: none`, a `Range` header is ignored, and the whole
archive is sent with a 200 on every host (Apache would otherwise slice a
script's output into a 206 on its own, which nginx and PHP's built-in server do
not). A runtime opening a bundle needs the whole archive anyway, since its
identity and integrity are the digest of every byte.

## Per-app storage

An app whose `permission.json` declares the `storage` capability gets a
database of its own on the server. A script reaches it as `softn.storage.*`
— `insert`, `get`, `update`, `set`, `remove`, `query`, `count`,
`collections`, `clear`, and `kvGet` / `kvSet` / `kvRemove` for plain keys — and every call
becomes `POST /api/apps/{slug}/storage` with `{op, ...}`. The runtime learns
the endpoint from the address it loaded the bundle from, so an app opened from
a file rather than the directory gets `{error}` back and can say so. Snake's
shared top ten and the Notes board are the worked examples.

The data is **shared**: everyone running the app reaches the same database.
What each of them may do to a collection is its **policy**, declared per
collection in the same `storage` entry and fixed at publication:

```json
{
  "permissions": {
    "storage": {
      "enabled": true,
      "collections": { "scores": "append-only", "posts": "owner-write", "notes": "private", "settings": "publisher", "*": "public" }
    }
  }
}
```

| Policy | Read | Add | Change or remove a record |
|---|---|---|---|
| `public` (the default) | anyone | anyone | anyone |
| `append-only` | anyone | anyone | the edit key only |
| `owner-write` | anyone | anyone with a visitor token | whoever added it, or the edit key |
| `private` | each visitor, their own records only | anyone with a visitor token | whoever added it |
| `publisher` | the edit key only | the edit key only | the edit key only |

`*` sets the policy for every collection not named. Clearing a whole
collection needs the edit key under every policy. The key-value store has no
policies and is always public. Records carry `mine: true` when the visitor
asking added them, which is what an owner-write interface needs to know.

"Whoever added it" is a **visitor token**: a random string the runtime mints
once per browser, keeps in local storage, and sends as `X-Visitor-Token`.
The server keeps only a salted hash of it bound to the app, so the token is
never stored and one app's owners cannot be matched with another's. It is
custody, not an account, in the way the edit key is: clear the browser's
storage and the records stay where their policy leaves them, but nothing can
claim them again. A request without a token is refused by collections that
need one, with a message that says so. Nothing here verifies a game's
outcome: a score in an append-only collection is one nobody can alter, not
one that was earned. A publisher must never embed the edit key in a bundle to
get around a policy — the bundle is downloaded by every visitor.

## Running it locally

```bash
npm run build:site
php -S 127.0.0.1:5500 -t dist apps/softn-api/router.php
```

`router.php` stands in for the deployed `.htaccess`: `/api/` goes to PHP,
`/data/` is refused, `/app/{slug}` renders the share page, `/play/{slug}`
the play page (`dist/play/` must exist: `build:site` puts the shell there), and every static
file is served with the cross-origin isolation headers the runtime's worker
mode depends on. New folders under `data/apps/` are discovered automatically.
The optional demo seeder also refreshes bundles and pictures when its index
changes; keep `seedDemos` enabled to use that workflow. Do not delete the live
app folders or lock files to refresh demos.

## Tests

```bash
npm test -w @softn/api
```

The suite starts its own `php -S` on a temporary root and exercises
publishing, versions, the edit key, comments, ratings, remixes, storage and
the share page. A separate suite starts independent PHP processes to test
concurrent plays/comments/ratings/version uploads, lock-holder termination,
folder/cache changes and SQLite migration. `admission.test.mjs` drives the
body limits (chunked, lying `Content-Length`, base64 and image budgets,
temp-file cleanup, a body larger than `memory_limit`); `proxy.test.mjs`
the trusted-proxy resolver and the rate-limit identity behind it;
`policies.test.mjs` the storage policy matrix under concurrent writers and
the edit key's confinement to the publish reply; `catalog-recovery.test.mjs`
the timings and a writer killed mid-commit; `catalog-warm.test.mjs` that a
warm catalogue inspects no bundle, that a change re-inspects only its own,
that the sweep is bounded, and that listing, cards and details answer
exactly as they did before the round-2 repair (`test/fixtures/catalog`,
whose `make.mjs` regenerates `expected.json` from a known-good revision);
`backup.test.mjs` export, verify and restore, tampered archives and the
`--force` rule. Each starts servers of its own under the system temp
directory, with the ini values `.user.ini` asks for, and removes them.
