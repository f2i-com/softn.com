#!/usr/bin/env node
/**
 * Package the documentation alone — `dist/docs/`, as `build:site` wrote it —
 * so a running site can take a docs update without a full release: unpack
 * the archive so that `docs/index.html` lands at `<document root>/docs/index.html`,
 * replacing the folder that is there. Nothing outside `docs/` changes.
 *
 *   node scripts/package-docs.mjs [--out release]
 *
 * The archive is `softn-docs-<version>-<commit>.zip` (the version from
 * package.json, the commit from HEAD) with a `.sha256` beside it, written by
 * the same writer as the release archives: the `.br`/`.gz` twins and the
 * fonts are stored, everything else deflated, and every entry is read back
 * and compared. A short README.md at the archive root says where it goes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive } from './lib/archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'dist', 'docs');
const outDir = path.resolve(root, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'release');
if (!fs.existsSync(path.join(docs, 'index.html'))) throw new Error('Build the site first (npm run build:site); dist/docs/index.html is missing.');

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
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
