#!/usr/bin/env node
/**
 * A ready-made data/ from the folder: the directory populated before its
 * first visitor, to upload beside api/.
 *
 *   npm run apps:seed [-- --dir <folder>] [--out <data dir>] [--php <php executable>]
 *
 * Runs the API's own seeder (apps/softn-api/seed-folder.php) over the folder,
 * so the output is exactly what a site's first request would have written:
 * directory.sqlite, apps/<slug>/ with each bundle and picture, config.json
 * with a fresh admin key, and the rules that keep the folder unserved. The
 * default output is scripts/softn-apps/data/ (ignored by git). Run it again
 * to bring an output up to date with the folder.
 *
 * Needs PHP 8.1+ with pdo_sqlite and zip — what the site itself needs — on
 * PATH, or named by --php or SOFTN_PHP.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dirArg = flag('--dir', process.env.SOFTN_APPS_DIR || '');
const appsDir = dirArg ? path.resolve(process.cwd(), dirArg) : path.join(here, 'apps');
const outArg = flag('--out', '');
const outDir = outArg ? path.resolve(process.cwd(), outArg) : path.join(here, 'data');
const php = flag('--php', process.env.SOFTN_PHP || 'php');

if (!fs.existsSync(path.join(appsDir, 'index.json'))) {
  console.error(`${appsDir} has no index.json. Run npm run apps:build first.`);
  process.exit(1);
}
const probe = spawnSync(php, ['-r', 'echo PHP_VERSION, " ", extension_loaded("pdo_sqlite") ? "pdo_sqlite" : "no-pdo_sqlite", " ", extension_loaded("zip") ? "zip" : "no-zip";'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error(`No PHP at "${php}". The seeder is the site's own PHP; install PHP 8.1+ with pdo_sqlite and zip, or pass --php <path to php>.`);
  process.exit(1);
}
if (/no-pdo_sqlite|no-zip/.test(probe.stdout)) {
  console.error(`${php} (${probe.stdout.trim()}) lacks an extension the directory needs: enable pdo_sqlite and zip in its php.ini.`);
  process.exit(1);
}

const r = spawnSync(php, [path.join(root, 'apps', 'softn-api', 'seed-folder.php'), '--from', appsDir, '--out', outDir], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`\nReady: ${outDir}\n  directory.sqlite, apps/<slug>/, config.json (the admin key is in it — keep it), .htaccess`);
