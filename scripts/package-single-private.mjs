// release/softn-app-private-vVERSION.zip: the built webroot/ and
// private/ of apps/softn-single-private with the licences, the third-party
// inventory, the deployment guide and the plain-language README.md beside
// them. Written and verified through scripts/lib/archive.mjs like every
// release archive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FRONT_DOOR, startHere } from './release-explainers.mjs';
import { writeArchive } from './lib/archive.mjs';
import { releasePrivateFiles } from '../apps/softn-single-private/scripts/shell.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/softn-single-private/dist');
for (const name of [
  'webroot/index.php',
  'webroot/softn-serve.php',
  'webroot/.htaccess',
  'private/shell.html',
  'private/serve.config.php',
  'private/app.softn',
  'private/.htaccess',
])
  if (!fs.existsSync(path.join(dist, name)))
    throw Error('Build the PHP-served runtime first: missing ' + name);
execFileSync(
  process.execPath,
  [path.join(root, 'scripts/generate-third-party-notices.mjs'), '--out-dir', dist],
  { cwd: root, stdio: 'inherit' }
);
for (const name of ['LICENSE', 'NOTICE'])
  fs.copyFileSync(path.join(root, name), path.join(dist, name));
fs.copyFileSync(path.join(root, 'docs/engineering/SINGLE_APP_PRIVATE.md'), path.join(dist, 'DEPLOYMENT.md'));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// The plain-language explainer, first thing in the archive; DEPLOYMENT.md is the detailed guide it points to.
fs.writeFileSync(path.join(dist, FRONT_DOOR), startHere('private', { tag: 'v' + version }));
const entries = {};
function collect(dir, relative = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = relative + item.name;
    if (item.isDirectory()) collect(path.join(dir, item.name), key + '/');
    else if (item.isFile()) {
      if (key.endsWith('.map')) continue;
      // private/ is written below from the samples, never copied: see releasePrivateFiles.
      if (key.startsWith('private/')) continue;
      entries[key] = fs.readFileSync(path.join(dir, item.name));
    }
  }
}
collect(dist);
for (const [name, bytes] of Object.entries(
  releasePrivateFiles(fs.readFileSync(path.join(dist, 'private/shell.html')))
))
  entries['private/' + name] = Buffer.from(bytes);
const output = path.join(root, 'release', 'softn-app-private-v' + version + '.zip');
const result = writeArchive(entries, output);
console.log(
  output + '\n' + result.size + ' bytes; ' + result.entries.length + ' files; SHA-256 ' + result.sha256
);
