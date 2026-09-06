# The softn.com directory API

One PHP script and a SQLite file, deployed as `/api/` beside the static site.
It is what turns softn.com from a landing page into an app directory: a
catalogue of `.softn` bundles that anyone can publish to, play from, rate,
comment on and remix, plus a small server-side database for each app that asks
for one. No daemon, no accounts, no MySQL — it runs on shared hosting that
takes a zip upload.

## Requirements

- PHP 8.1 or newer with `pdo_sqlite` and `zip`
- A writable `data/` directory beside `api/` (the build creates it; `GET /api/health` reports whether it is writable)
- Upload limits large enough for a bundle; `api/.user.ini` asks for 64 MB on PHP-FPM and CGI hosts

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
| `GET /api/apps/{slug}/bundle.softn` | The bundle. `v=` picks a version, `download=1` sends it as an attachment |
| `GET /api/apps/{slug}/thumbnail`, `/icon` | Pictures. The URLs the API hands out carry `?v=<updated_at>` because pictures are cached for ten minutes |
| `GET /api/apps/{slug}/source` | The bundle's source files, for the app page's viewer |
| `GET /api/apps/{slug}/comments`, `/rating` | Comments (paged) and the rating summary |
| `GET /api/categories` | Categories with counts. The site-owned ones (Games, Examples, …) are recreated on every request so renames reach old databases |
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
| `GET /api/health` | SQLite version, full-text search availability, whether `data/` is writable |

`/app/{slug}` (no `api`) is a share page: the listing rendered as HTML with
Open Graph tags, for links pasted into chat.

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
mode depends on. The directory seeds itself from the demo bundles on the first
request, taking each app's picture from
`apps/softn-web/public/demos/thumbs/`. To seed again after the demos change:

```bash
rm -rf dist/data/apps dist/data/directory.sqlite dist/data/seeded dist/data/seed.lock
```

## Tests

```bash
npm test -w @softn/api
```

The suite starts its own `php -S` on a temporary root and exercises
publishing, versions, the edit key, comments, ratings, remixes, storage and
the share page.
