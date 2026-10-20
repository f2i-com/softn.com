#!/usr/bin/env node
/**
 * Package the documentation alone — `dist/docs/`, as `build:site` wrote it —
 * so a running site can take a docs update without a full release: unpack
 * the archive so that `docs/index.html` lands at `<document root>/docs/index.html`,
 * replacing the folder that is there. Nothing outside `docs/` changes.
 *
 *   node scripts/release/package-docs.mjs [--out release] [--allow-dirty]
 *
 * The archive is `softn-docs-<version>-<commit>.zip` (the version from
 * package.json, the commit dist/ was built from) with a `.sha256` beside it.
 * It is made only from a dist/ whose BUILD-INFO.json says it was built from
 * HEAD, from a clean tree unless --allow-dirty, with nothing in docs/ that
 * names a path on the build machine; it used to be named for HEAD whatever
 * dist/docs/ had been built from. It is written by the same writer as the
 * release archives: the `.br`/`.gz` twins and the fonts are stored,
 * everything else deflated, and every entry is read back and compared. A
 * short README.md at the archive root says where it goes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readArchive, writeArchive } from '../lib/archive.mjs';
import { buildInfoProblem, headRevision } from '../lib/build-info.mjs';
import { buildMachinePaths } from '../lib/build-paths.mjs';
import { repoRoot as root } from '../lib/paths.mjs';

const dist = path.join(root, 'dist');
const docs = path.join(dist, 'docs');
const outDir = path.resolve(root, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'release');

function fail(message) {
  console.error(`package-docs: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(docs, 'index.html')) || !fs.existsSync(path.join(dist, 'BUILD-INFO.json'))) {
  fail('Build the site first (npm run build:site); dist/docs/index.html or dist/BUILD-INFO.json is missing.');
}
let head;
try {
  head = headRevision(root);
} catch {
  fail('This is not a git checkout, so what dist/ was built from cannot be checked against it.');
}
const info = JSON.parse(fs.readFileSync(path.join(dist, 'BUILD-INFO.json'), 'utf8'));
// The docs carry no source maps either way, so a development build's docs package as they are.
const stale = buildInfoProblem(info, head, { allowDirty: process.argv.includes('--allow-dirty'), development: true });
if (stale) fail(stale);

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const commit = info.softn.revision.slice(0, 10);
const name = `softn-docs-v${version}-${commit}.zip`;

const entries = new Map();
function collect(dir, relative) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = `${relative}/${item.name}`;
    if (item.isDirectory()) collect(path.join(dir, item.name), key);
    else if (item.isFile()) entries.set(key, fs.readFileSync(path.join(dir, item.name)));
  }
}
collect(docs, 'docs');
const machine = buildMachinePaths(dist, [...entries.keys()], root);
if (machine.length > 0) fail(`${machine.slice(0, 10).join('; ')}. Build the site again (npm run build:site).`);
entries.set('README.md', Buffer.from(`# SoftN documentation ${version} (${commit})

The \`/docs/\` section of softn.com on its own, for updating a running site
without a full release.

1. Unpack this archive.
2. Upload the \`docs/\` folder to the site's document root, replacing the
   \`docs/\` folder that is there, so that \`docs/index.html\` is at
   \`<document root>/docs/index.html\`.
3. Keep the \`.br\` and \`.gz\` files beside their originals and the
   \`docs/_assets/\` folder intact: the site's server rules serve the
   compressed twins, and every page loads its stylesheet, script and fonts
   from \`_assets/\`.

Nothing outside \`docs/\` changes. Built from softn.com at commit ${commit}.
`, 'utf8'));

fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, name);
writeArchive(entries, out, { stamp: new Date() });
const check = readArchive(fs.readFileSync(out));
if (check.problems?.length) throw new Error(`The archive did not read back cleanly: ${check.problems.join('; ')}`);
console.log(`${path.relative(root, out)}: ${entries.size} files, ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB (sha256 beside it)`);
