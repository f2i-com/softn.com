// release/softn-app-static-vVERSION.zip: the built apps/softn-single/dist with the
// licences, the third-party inventory, the deployment guide and the
// plain-language README.md beside them. Written and verified through
// scripts/lib/archive.mjs like every release archive. `--with-backend` also
// packages the variant with the PHP/WASM server backend.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FRONT_DOOR, startHere } from './release-explainers.mjs';
import { writeArchive } from './lib/archive.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/softn-single/dist');
for (const name of ['index.html', 'runtime.config.json'])
  if (!fs.existsSync(path.join(dist, name))) throw Error('Build the single-app runtime first.');
execFileSync(
  process.execPath,
  [path.join(root, 'scripts/generate-third-party-notices.mjs'), '--out-dir', dist],
  { cwd: root, stdio: 'inherit' }
);
for (const name of ['LICENSE', 'NOTICE'])
  fs.copyFileSync(path.join(root, name), path.join(dist, name));
fs.copyFileSync(path.join(root, 'docs/engineering/SINGLE_APP_RUNTIME.md'), path.join(dist, 'DEPLOYMENT.md'));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// The plain-language explainer, first thing in the archive; DEPLOYMENT.md is the detailed guide it points to.
fs.writeFileSync(path.join(dist, FRONT_DOOR), startHere('single', { tag: 'v' + version }));
const entries = {};
function collect(dir, relative = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = relative + item.name;
    if (item.isDirectory()) collect(path.join(dir, item.name), key + '/');
    else if (item.isFile()) {
      if (key.endsWith('.map')) continue;
      entries[key] = fs.readFileSync(path.join(dir, item.name));
    }
  }
}
collect(dist);
const output = path.join(root, 'release', 'softn-app-static-v' + version + '.zip');
const result = writeArchive(entries, output);
console.log(
  output + '\n' + result.size + ' bytes; ' + result.entries.length + ' files; SHA-256 ' + result.sha256
);
if(process.argv.includes('--with-backend'))execFileSync(process.execPath,[path.join(root,'scripts/package-single-backend.mjs')],{cwd:root,stdio:'inherit'});
