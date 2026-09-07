# softn-apps

Every SoftN app, downloaded from its release and photographed, in one folder a
SoftN site loads.

```
repos.json      where the apps come from: one GitHub repository per line
fetch.mjs       downloads each release's .softn bundles into the folder
screenshot.mjs  photographs each app in the web runtime into its thumbs/
publish.mjs     publishes the folder into a running site
seed.mjs        a ready-made data/ from the folder, to upload beside api/
build.mjs       fetch, then screenshot
apps/           the default output, ignored by git: index.json, the .softn
                files, thumbs/ — pass --out / --dir for another folder
data/           what seed.mjs writes, ignored by git
```

Node 22, nothing to install beyond the repository's own `npm ci`.

## Build the folder

```
npm run build:site        # the runtime the screenshots are taken in
npm run apps:build        # fetch, then screenshot
```

or the two halves, `npm run apps:fetch` and `npm run apps:screenshot`. Add
`-- --out <folder>` (build, fetch) or `-- --dir <folder>` (screenshot,
publish), or set `SOFTN_APPS_DIR`, to work in another folder — the games
folder beside this checkout, say: `npm run apps:build -- --out ../softn-apps/apps`.

`fetch.mjs` reads `repos.json`, takes each repository's latest release (or the
`tag` named there), checks every bundle against the release's own checksums,
and writes `index.json` — the name, description, version, colour, size, hash
and source of each app, with the category, tags and author the entry gives
it. A private repository is read with the token git already keeps for
github.com, or `GITHUB_TOKEN`. Run it again any time: only changed bundles are
fetched, and a bundle no release lists any more is removed.

`screenshot.mjs` serves the built site with the folder as its `/demos/`,
opens each app in the runtime in headless Edge or Chrome, follows the
photographer's per-app recipe past title screens and permission prompts, and
writes a 1280×800 WebP per app. `--only Name,Name` retakes the ones named.

## Put the folder in a site

Four ways, all the same folder.

**Drop in a ready-made `data/`.**

```
npm run apps:seed
```

runs the directory's own seeder over the folder, offline, and writes
`scripts/softn-apps/data/` (or `-- --out <dir>`): `directory.sqlite` with every
app's rows, `apps/<slug>/v1.softn` and `thumb.*` for each, `config.json` with a
fresh admin key — printed once, keep it — and the rules that keep the folder
unserved. Upload it as `data/` beside `api/` and the directory is populated
before its first visitor. Never put it over a `data/` that already holds
visitors' apps; for a live site, use one of the ways below. It needs PHP 8.1+
with `pdo_sqlite` and `zip` (what the site needs), on PATH or named by
`-- --php <path>`; run it again to bring an output up to date with the folder.

**Upload it.** Copy the folder into a deployed site's document root under
the name `demos/`, beside `api/` — that name is where the directory looks
(`apps/` at the root would shadow the directory's own `/apps` page). The
directory reads it on its next listing: every app it names is published,
with its screenshot; a changed bundle is a new version; one that has left the
folder is retired. Nothing a visitor published is touched.

**Build it in.**

```
npm run build:site -- --demos-dir scripts/softn-apps/apps
```

ships the folder as the site's bundles, so a fresh install starts with them.

**Publish it.** Into a site that is already running, with its admin key from
`data/config.json`:

```
npm run apps:publish -- --site https://example.com --admin-key <key>
```

One publish per app, screenshot attached; apps the site already has are left
alone. The edit key of each new app is printed once. The host's upload limit
must admit the largest bundle (the site's `api/.user.ini` asks for 64 MB).

## Add a game

Add its repository to `repos.json`. Its latest release must carry the `.softn`
(and, ideally, a `SHA256SUMS.txt`); the name and description come from the
bundle's own manifest. Give the entry a `category` and `tags` so the
directory files it well. If the game needs a click to get past its title
screen before a screenshot, add a recipe under its bundle's name in
`scripts/screenshot-demos.mjs`.
