/**
 * The one description of every archive a release ships.
 *
 * A `v*` tag builds five zips (see .github/workflows/release.yml). Each is a
 * different way to put SoftN, or one SoftN app, on a web host, and the
 * difference is easy to get wrong from the file names alone. This module says,
 * for each one, what it is, who should pick it, what is inside, how it is
 * deployed and what the host must provide. `release-explainers.mjs` turns it
 * into the README.md at the root of every archive, the RELEASE-GUIDE.md
 * attached to the release, and the downloads table in the release notes, so
 * the three cannot disagree.
 *
 * Plain words only: the reader is the person about to upload the files, not
 * the person who built them. The detailed engineering guides stay inside the
 * archives; each entry names its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The engine's label for a file name: its release tag when SOURCE.json or
 * BUILD-INFO.json has one that reads as a version, else its version, else the
 * short commit. Never anything else, because it goes into a file name (one
 * release run tried to open `…-zipp-https:/github.com/…/v0.0.14.zip` when
 * the field held the release URL).
 */
export function engineLabel(zipp = {}) {
  const looksLikeVersion = (s) => typeof s === 'string' && /^v?\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/.test(s);
  if (looksLikeVersion(zipp.release)) return zipp.release;
  if (looksLikeVersion(zipp.version)) return `v${zipp.version.replace(/^v/, '')}`;
  if (/^[0-9a-f]{7,40}$/i.test(zipp.revision ?? '')) return zipp.revision.slice(0, 8);
  return 'unknown';
}

/** The engine label of the vendored ZIPP build in this checkout. */
export function vendoredEngineLabel() {
  const source = path.join(root, 'packages/@softn/core/wasm-zipp/SOURCE.json');
  return engineLabel(JSON.parse(fs.readFileSync(source, 'utf8')));
}

const SHA_CHECK = [
  'Every archive comes with a `.sha256` file holding its checksum. To confirm the download is whole and untouched:',
  '- Linux or macOS: run `sha256sum -c <archive>.sha256` (macOS: `shasum -a 256 -c`) in the folder you downloaded to. It prints `OK`.',
  '- Windows PowerShell: run `Get-FileHash <archive> -Algorithm SHA256` and compare the hash with the one in the `.sha256` file.',
];

/**
 * @typedef {object} ReleasePackage
 * @property {string} id            short name used in scripts and tests
 * @property {string} title         what a person calls it
 * @property {(tag: string, engine: string) => string} archive  the file name
 * @property {string} previousName  what the archive was called before v0.0.13, so old links are recognised
 * @property {string} pattern       the file name with placeholders, for tables
 * @property {string} what          one sentence: what this is
 * @property {string[]} chooseIf    reasons to pick this one
 * @property {string[]} notIf       reasons to pick another (naming it)
 * @property {{path: string, what: string}[]} inside   folder by folder
 * @property {string[]} steps       the five-step deploy outline
 * @property {string[]} requirements what the host must provide
 * @property {string} guide         the detailed guide inside the archive
 * @property {string[]} moreGuides  other guides inside the archive
 * @property {string} sizeNote      what makes it big or small
 */

/** @type {ReleasePackage[]} */
export const PACKAGES = [
  {
    id: 'site',
    previousName: 'softn-com-<tag>-zipp-<engine>.zip',
    title: 'The complete softn.com website',
    archive: (tag, engine) => `softn-website-${tag}-zipp-${engine}.zip`,
    pattern: 'softn-website-<tag>-zipp-<engine>.zip',
    what: 'The whole softn.com in one folder: the landing page, the app directory, the web runtime, Builder, Studio, the documentation and the directory API.',
    chooseIf: [
      'You want to run your own SoftN site: a directory people can publish apps to and play them from.',
      'You want Builder, Studio and the web runtime on your own domain.',
    ],
    notIf: [
      'You only want to host one app on a page of your own site. Take `softn-app-static-<tag>.zip` instead; it is far smaller.',
      'You want to keep an app\'s `.softn` file off every URL. Take `softn-app-private-<tag>.zip`.',
    ],
    inside: [
      { path: 'index.html, assets/', what: 'The landing page and the directory pages.' },
      { path: 'web/', what: 'The web runtime: opens and runs a `.softn` app in the browser.' },
      { path: 'builder/', what: 'The visual editor.' },
      { path: 'studio/', what: 'The AI studio (brings its own provider key).' },
      { path: 'play/', what: 'The single-app page the directory uses for `/play/<slug>`.' },
      { path: 'docs/', what: 'The documentation, readable without JavaScript.' },
      { path: 'api/, api/README.md', what: 'The directory API: plain PHP, no database server; its README explains publishing and moderation.' },
      { path: 'data/', what: 'Where the API keeps everything it learns (apps, comments, ratings, its config). Ships empty apart from the rules that keep it private; make it writable.' },
      { path: '.htaccess, nginx.conf.example', what: 'The server rules for Apache (hidden file; upload it) or nginx.' },
      { path: 'README.md', what: 'This file.' },
      { path: 'DEPLOY.md', what: 'The detailed hosting guide.' },
      { path: 'BUILD-INFO.json, LICENSE, NOTICE, THIRD-PARTY-*', what: 'What was built, from which commit, and the licences it carries.' },
    ],
    steps: [
      'Unzip. Upload the **contents** of the folder (not the folder itself) into your web host\'s document root, so `index.html` sits at the top. Include the hidden `.htaccess`.',
      'Make sure `data/` is writable by PHP. Open `/api/health` in a browser: it tells you what the host found and what is missing.',
      'Open the site. On first use the API writes `data/config.json`, which holds your admin key. Keep that file private (the shipped rules already do).',
      'Add apps: drop `.softn` files on any page of the site, or open `/publish`. The admin key lifts the hourly limit for you.',
      'Read `DEPLOY.md` for nginx, upload limits, moderation and backups (copy `data/`).',
    ],
    requirements: [
      'A web host with PHP 8.1 or newer, with the `pdo_sqlite` and `zip` extensions (standard on cPanel-style hosts).',
      'Apache with `.htaccess` honoured, or nginx using the included `nginx.conf.example`.',
      'HTTPS. Upload limits large enough for a bundle (the included `api/.user.ini` asks for 64 MB).',
    ],
    guide: 'DEPLOY.md',
    moreGuides: ['api/README.md'],
    sizeNote: 'The largest download: it carries every app, the docs and the engine.',
  },
  {
    id: 'single',
    previousName: 'softn-single-<tag>.zip',
    title: 'One app on a page (static)',
    archive: (tag) => `softn-app-static-${tag}.zip`,
    pattern: 'softn-app-static-<tag>.zip',
    what: 'The smallest way to host one SoftN app: a plain page with a loading spinner, a permission bar and your app, with no SoftN branding and no server code.',
    chooseIf: [
      'You have a `.softn` app and a web host, and you want the app on a page of your own site.',
      'Your app does not need a server: it keeps its records in the browser.',
      'Your host cannot run PHP, or you would rather not need it.',
    ],
    notIf: [
      'Your app needs a server (private logic, a database, routes). Take `softn-app-static-with-backend-linux-x64-<tag>.zip`.',
      'You do not want the `.softn` file to be downloadable from a URL. Take `softn-app-private-<tag>.zip`.',
      'You want a whole directory of apps. Take the website archive.',
    ],
    inside: [
      { path: 'README.md', what: 'This file.' },
      { path: 'index.html', what: 'The page. It reads `runtime.config.json` next to it.' },
      { path: 'runtime.config.json', what: 'Which app to load, its title, theme and options. Edit this.' },
      { path: 'app.softn', what: 'A small counter example. Replace it with your app.' },
      { path: 'assets/', what: 'The runtime and the ZIPP engine (`.wasm`).' },
      { path: '.htaccess', what: 'Apache rules: the right file types for `.wasm` and `.mjs`, no folder listing (hidden file; upload it).' },
      { path: 'DEPLOYMENT.md', what: 'The detailed guide: every configuration key, permissions, pinning the app\'s digest.' },
      { path: 'LICENSE, NOTICE, THIRD-PARTY-NOTICES.txt', what: 'The licences the runtime carries.' },
    ],
    steps: [
      'Unzip. Upload the **contents** of the folder to an HTTPS web directory, at the root or in a subfolder. Include the hidden `.htaccess`.',
      'Replace `app.softn` with your own app.',
      'Edit `runtime.config.json`: at least `id` (a short name for storage), `title` and `bundle` (`./app.softn`).',
      'Open the page. The app loads; the bar at the bottom asks for any capability the app declares.',
      'Read `DEPLOYMENT.md` for permissions you approve in advance, pinning the app\'s checksum, and serving on nginx or other servers.',
    ],
    requirements: [
      'Any static HTTPS web host. No PHP, no database, no build tools.',
      'The server must send `.wasm` as `application/wasm` and `.mjs` as JavaScript; the included `.htaccess` does that on Apache.',
    ],
    guide: 'DEPLOYMENT.md',
    moreGuides: [],
    sizeNote: 'Small: the runtime and the engine only.',
  },
  {
    id: 'single-backend',
    previousName: 'softn-single-php-linux-x64-<tag>.zip',
    title: 'One app on a page, with an optional PHP server backend',
    archive: (tag) => `softn-app-static-with-backend-linux-x64-${tag}.zip`,
    pattern: 'softn-app-static-with-backend-linux-x64-<tag>.zip',
    what: 'The static single-app page above, plus a `backend/` folder that lets the app run its own private server logic and SQLite database on an Apache/PHP host, with no service to keep running.',
    chooseIf: [
      'Your app has a private server part (`server/` logic, SQL migrations, routes) and your host is Apache with PHP on Linux x86-64.',
      'You want a server without a daemon: PHP starts the bundled Node for each request and it exits when done.',
    ],
    notIf: [
      'Your app needs no server. Take `softn-app-static-<tag>.zip`; it is much smaller.',
      'You need persistent connections or XDB synchronisation between devices. Those need the Rust host (`softn-server`), built from source.',
      'Your host is not Linux x86-64 (ARM, Windows): the bundled Node will not run there. The static part still works anywhere.',
    ],
    inside: [
      { path: 'webroot/', what: 'The page, `runtime.config.json`, the example `app.softn`, the runtime `assets/`, and `api.php`, which answers `/api/...` by starting the backend. Its contents go in your public folder.' },
      { path: 'backend/', what: 'The server host: a bundled Linux x64 Node (`bin/node`), the ZIPP engine (`wasm/`), the runner scripts, `setup.php`, and licences. Goes **outside** every public folder.' },
      { path: 'backend/app/ (you create it)', what: 'Where your private server bundle goes. Nothing private is shipped.' },
      { path: 'README.md', what: 'This file.' },
      { path: 'DEPLOYMENT.md', what: 'The detailed guide: static-only use, enabling the backend step by step, updating.' },
      { path: 'README-RUNTIME.md, LIVE_UPDATES.md', what: 'What the server host supports (the contract), and live updates by polling or WebSocket.' },
      { path: 'BUILD-INFO.json, SHA256SUMS.txt', what: 'What was built and a checksum for every file inside.' },
    ],
    steps: [
      'Unzip. Upload the **contents** of `webroot/` into your public folder (with the hidden `.htaccess`). Put `backend/` beside the public folder, never inside it.',
      'Without a server: replace `webroot/app.softn` and edit `webroot/runtime.config.json`, as for the static archive. You can stop here; the backend stays unused.',
      'With a server: put your expanded private server bundle in `backend/app/`, your public client at `webroot/app.softn`, and set the allowed origins in the private manifest.',
      'Run `php backend/setup.php` once as the PHP user (for example `sudo -u www-data php /path/backend/setup.php`). It creates `backend/private/` with the config and database.',
      'Open `/api/meta`. A working host reports `runtime:zipp-wasm-on-demand`. Read `DEPLOYMENT.md` for `api.php` paths, capabilities and updates.',
    ],
    requirements: [
      'Linux x86-64 with glibc 2.28 or newer (most current distributions).',
      'Apache with `mod_rewrite` and `.htaccess` honoured; PHP 8.1 or newer with `proc_open` allowed. PHP GD only for photo upload routes.',
      'No npm, no PHP extensions beyond the usual, no listening port and no systemd service.',
    ],
    guide: 'DEPLOYMENT.md',
    moreGuides: ['README-RUNTIME.md', 'LIVE_UPDATES.md'],
    sizeNote: 'Larger: it carries a complete Node runtime for Linux x64.',
  },
  {
    id: 'private',
    previousName: 'softn-single-php-serve-<tag>.zip',
    title: 'One app served privately by PHP',
    archive: (tag) => `softn-app-private-${tag}.zip`,
    pattern: 'softn-app-private-<tag>.zip',
    what: 'The single-app page again, but PHP renders it and hands the app\'s files to the browser piece by piece behind a viewer cookie, so the `.softn` file itself is never at a URL.',
    chooseIf: [
      'You do not want visitors (or crawlers) to be able to download your app as one file.',
      'You want the page title, description, icon and link preview rendered on the server.',
      'Your host has PHP.',
    ],
    notIf: [
      'You need copy protection. A browser still receives what it runs; this controls delivery, not copying. `DEPLOYMENT.md` says exactly what is and is not hidden.',
      'You do not have PHP, or a plain page is fine. Take `softn-app-static-<tag>.zip`.',
      'Your app also needs a server backend. Take `softn-app-private-with-backend-linux-x64-<tag>.zip`, which is this archive plus the backend.',
    ],
    inside: [
      { path: 'README.md', what: 'This file.' },
      { path: 'webroot/', what: '`index.php` (renders the page), `softn-serve.php` (serves the app\'s pieces), `.htaccess`, `sw.js`, the runtime `assets/` and the icon placeholders. Its contents go in your public folder.' },
      { path: 'private/', what: '`app.softn` (a sample; replace it), `serve.config.php` (title, theme, what to withhold), `shell.html` (the page template) and a deny-all `.htaccess`. Goes **beside** the public folder, outside it.' },
      { path: 'DEPLOYMENT.md', what: 'The detailed guide: every setting, what the browser receives, the limits of what this hides, updating.' },
      { path: 'LICENSE, NOTICE, THIRD-PARTY-NOTICES.txt', what: 'The licences the runtime carries.' },
    ],
    steps: [
      'Unzip. Upload the **contents** of `webroot/` into your public folder (with the hidden `.htaccess`). Upload `private/` next to the public folder, not inside it.',
      'Replace `private/app.softn` with your app.',
      'Edit `private/serve.config.php`: title, theme, description, and anything to withhold.',
      'Give the PHP user write access to `private/` once, so it can create `secret.key` and `digest.cache` (or set them by hand as the guide shows).',
      'Open the page. If `private/` cannot sit beside the public folder, set `$private` at the top of `index.php` to its absolute path. Read `DEPLOYMENT.md` for the rest.',
    ],
    requirements: [
      'PHP 8.1 or newer with the `zip` extension.',
      'Apache with `.htaccess` honoured (`AllowOverride All`), or an equivalent server configuration.',
      'HTTPS, so the viewer cookie is sent securely.',
    ],
    guide: 'DEPLOYMENT.md',
    moreGuides: [],
    sizeNote: 'Small: the runtime, the engine and two PHP files.',
  },
  {
    id: 'private-backend',
    previousName: 'softn-private-single-php-linux-x64-<tag>.zip',
    title: 'One app served privately by PHP, with an optional server backend',
    archive: (tag) => `softn-app-private-with-backend-linux-x64-${tag}.zip`,
    pattern: 'softn-app-private-with-backend-linux-x64-<tag>.zip',
    what: 'The privately served page above together with the PHP server backend: three folders, `webroot/`, `private/` and `backend/`. The app works at once without the backend; you enable the backend when the app needs it.',
    chooseIf: [
      'You want the `.softn` file kept off every URL **and** the app has a private server part.',
      'Your host is Apache with PHP on Linux x86-64.',
    ],
    notIf: [
      'The app needs no server. Take `softn-app-private-<tag>.zip`, which is this without `backend/`.',
      'You do not need private serving. Take `softn-app-static-with-backend-linux-x64-<tag>.zip`.',
      'Your host is not Linux x86-64: the bundled Node will not run there. The served page itself needs only PHP.',
    ],
    inside: [
      { path: 'webroot/', what: '`index.php`, `softn-serve.php`, `api.php` (answers `/api/...` by starting the backend), a `.htaccess` that also routes `/api`, and the runtime `assets/`. Its contents go in your public folder.' },
      { path: 'private/', what: 'The app (`app.softn`, a sample), `serve.config.php`, `shell.html` and a deny-all `.htaccess`. Beside the public folder.' },
      { path: 'backend/', what: 'The server host: bundled Linux x64 Node, the ZIPP engine, the runner scripts, `setup.php` and licences. Beside the public folder, never inside it.' },
      { path: 'README.md', what: 'This file.' },
      { path: 'DEPLOYMENT.md', what: 'The detailed guide for this archive: placing the three folders, enabling the backend, updating.' },
      { path: 'DEPLOYMENT-SERVE.md', what: 'The private-serving guide: every setting and what is and is not hidden.' },
      { path: 'README-RUNTIME.md, LIVE_UPDATES.md', what: 'What the server host supports, and live updates by polling or WebSocket.' },
      { path: 'BUILD-INFO.json, SHA256SUMS.txt', what: 'What was built and a checksum for every file inside.' },
    ],
    steps: [
      'Unzip. Upload the **contents** of `webroot/` into your public folder (with the hidden `.htaccess`). Put `private/` and `backend/` beside the public folder, outside it.',
      'Replace `private/app.softn` with your public client app and edit `private/serve.config.php`. The page works now; the backend is still off.',
      'To enable the backend: put your expanded private server bundle in `backend/app/` and set the allowed origins in its manifest.',
      'Run `php backend/setup.php` once as the PHP user. It creates `backend/private/` with the config and database.',
      'Open `/api/meta` to confirm `runtime:zipp-wasm-on-demand`. If the folders cannot be siblings, set `$private` in `index.php` and `$backend` in `api.php`. Read `DEPLOYMENT.md`.',
    ],
    requirements: [
      'PHP 8.1 or newer with the `zip` extension; Apache with `mod_rewrite` and `.htaccess` honoured.',
      'For the backend: Linux x86-64 with glibc 2.28 or newer, and `proc_open` allowed in PHP. PHP GD only for photo upload routes.',
      'HTTPS.',
    ],
    guide: 'DEPLOYMENT.md',
    moreGuides: ['DEPLOYMENT-SERVE.md', 'README-RUNTIME.md', 'LIVE_UPDATES.md'],
    sizeNote: 'Larger: it carries a complete Node runtime for Linux x64.',
  },
];

export const DECISIONS = [
  { question: 'Do you want a whole site with a directory of apps, Builder and Studio?', answer: 'site' },
  { question: 'Do you want one app on a page, and it needs no server?', answer: 'single' },
  { question: 'One app, no server, but the `.softn` file must not be downloadable?', answer: 'private' },
  { question: 'One app with a private server part, on Apache/PHP (Linux x86-64)?', answer: 'single-backend' },
  { question: 'One app with a private server part, and the `.softn` file kept off every URL?', answer: 'private-backend' },
];

export const checksumInstructions = SHA_CHECK;

export function packageById(id) {
  const found = PACKAGES.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown release package: ${id}`);
  return found;
}

export function archiveName(id, { tag, engine }) {
  return packageById(id).archive(tag, engine);
}
