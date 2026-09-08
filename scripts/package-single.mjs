import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
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
fs.copyFileSync(path.join(root, 'docs/SINGLE_APP_RUNTIME.md'), path.join(dist, 'DEPLOYMENT.md'));
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
const bytes = zipSync(entries, { level: 9 });
const decoded = unzipSync(bytes);
for (const [name, data] of Object.entries(entries))
  if (!Buffer.from(decoded[name]).equals(data)) throw Error('Archive verification failed: ' + name);
const output = path.join(
  root,
  'release',
  'softn-single-v' +
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version +
    '.zip'
);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, bytes);
const sha = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(output + '.sha256', sha + '  ' + path.basename(output) + '\n');
console.log(
  output + '\n' + bytes.length + ' bytes; ' + Object.keys(entries).length + ' files; SHA-256 ' + sha
);
if(process.argv.includes('--with-backend'))execFileSync(process.execPath,[path.join(root,'scripts/package-single-backend.mjs')],{cwd:root,stdio:'inherit'});
