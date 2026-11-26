// release/softn-app-static-vVERSION.zip: the built apps/softn-single/dist with the
// licences, the third-party inventory, the deployment guide and the
// plain-language README.md beside them. Written and verified through
// scripts/lib/archive.mjs like every release archive. `--with-backend` also
// packages the variant with the PHP/WASM server backend.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FRONT_DOOR, startHere } from './release-explainers.mjs';
import { writeArchive } from '../lib/archive.mjs';
import { requireStandaloneBuild } from './single-backend-inputs.mjs';
import { repoRoot as root } from '../lib/paths.mjs';

const dist = path.join(root, 'apps/softn-single/dist');
for (const name of ['index.html', 'runtime.config.json'])
  if (!fs.existsSync(path.join(dist, name))) throw Error('Build the single-app runtime first.');
// Before anything is written: the site build leaves a /play/ build here.
requireStandaloneBuild(dist);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// Generate third-party notices in a temporary folder so apps/softn-single/dist/ is not mutated
// in place with static-only DEPLOYMENT.md / README.md / inventory files that other packagers read.
const noticesTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-single-notices-'));
const entries = {};
function collect(dir, relative = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === '.vite') continue;
    const key = relative + item.name;
    if (item.isDirectory()) collect(path.join(dir, item.name), key + '/');
    else if (item.isFile()) {
      if (key.endsWith('.map')) continue;
      entries[key] = fs.readFileSync(path.join(dir, item.name));
    }
  }
}
try {
  execFileSync(
    process.execPath,
    [path.join(root, 'scripts/licenses/generate-third-party-notices.mjs'), '--out-dir', noticesTmp],
    { cwd: root, stdio: 'inherit' }
  );
  collect(dist);
  for (const name of ['LICENSE', 'NOTICE']) {
    entries[name] = fs.readFileSync(path.join(root, name));
  }
  for (const name of fs.readdirSync(noticesTmp)) {
    const full = path.join(noticesTmp, name);
    if (fs.statSync(full).isFile()) entries[name] = fs.readFileSync(full);
  }
  entries['DEPLOYMENT.md'] = fs.readFileSync(path.join(root, 'docs/engineering/SINGLE_APP_RUNTIME.md'));
  // The plain-language explainer, first thing in the archive; DEPLOYMENT.md is the detailed guide it points to.
  entries[FRONT_DOOR] = Buffer.from(startHere('single', { tag: 'v' + version }), 'utf8');
} finally {
  fs.rmSync(noticesTmp, { recursive: true, force: true });
}
const output = path.join(root, 'release', 'softn-app-static-v' + version + '.zip');
const result = writeArchive(entries, output);
console.log(
  output + '\n' + result.size + ' bytes; ' + result.entries.length + ' files; SHA-256 ' + result.sha256
);
// --runner-dir goes on to it: the backend carries softn-runner from there (single-backend-inputs.mjs runnerDirOption).
const runnerAt=process.argv.indexOf('--runner-dir');
if(process.argv.includes('--with-backend'))execFileSync(process.execPath,[path.join(root,'scripts/release/package-single-backend.mjs'),...(runnerAt<0?[]:process.argv.slice(runnerAt,runnerAt+2))],{cwd:root,stdio:'inherit'});
