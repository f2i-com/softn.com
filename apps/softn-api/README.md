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
- Upload limits large enough for a bundle; `api/.user.ini` asks for 64 MB on PHP-FPM and CGI hosts

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
cache avoids reopening ZIPs on every request, refreshes when file stats
change, and revalidates at least every five seconds while requests arrive.
A same-size replacement preserving timestamps may take up to five seconds.
Deleting or corrupting `cache/bundles.json` rebuilds it without losing any
plays, comments, ratings or ownership. Search/filter/sort use PHP over the
current metadata snapshot; search is case-insensitive word matching, with
name matches ranked first, rather than SQLite FTS stemming.

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
Open Graph tags, for links pasted into chat.

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
`/data/` is refused, `/app/{slug}` renders the share page, and every static
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
folder/cache changes and SQLite migration.
