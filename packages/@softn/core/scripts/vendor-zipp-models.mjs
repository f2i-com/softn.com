#!/usr/bin/env node
/**
 * ZIPP's local-model stack, vendored into vendor/zipp-models/.
 *
 *   node scripts/vendor-zipp-models.mjs --zipp <checkout> [--ref vX.Y.Z]
 *       copy the files below out of that ZIPP checkout at that git ref, byte
 *       for byte, and record each one's sha256 in vendor/zipp-models/SOURCE.json;
 *       the ref is the repository's declared ZIPP release unless one is named
 *   node scripts/vendor-zipp-models.mjs --check
 *       check the vendored files against SOURCE.json (no checkout needed)
 *
 * Three pieces, all ZIPP's own and all source a person can read:
 *
 *   gpu-lab/       the compute runtime: Graph v2 on WebGPU, WebGL2, compiled
 *                  WebAssembly kernels or plain JavaScript. A release carries it
 *                  in its embed kit; when the ref is a release and that kit is in
 *                  .zipp-release/, every file here is checked against the kit's.
 *   model-plugins/ the model loader: GGUF and Safetensors sources, the weight
 *                  store, the decode planner and the Python architecture
 *                  plugins. It is in no release yet, so it comes from the tag.
 *   model-plugins/wasm/gguf/
 *                  gguf-wasm's browser build, which ZIPP pins and commits
 *                  (gguf-wasm.lock.json records where it came from).
 *
 * Nothing is fetched from the network, and nothing is rewritten: a plugin's
 * Python is hashed by its own plugin.json, so a changed byte would refuse to
 * install. .gitattributes keeps the folder out of line-ending conversion for
 * the same reason.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = path.join(ROOT, 'vendor', 'zipp-models');
const REPO_ROOT = path.resolve(ROOT, '..', '..', '..');
const CRATE = 'crates/zipp-wasm';

/** What is vendored, as paths under crates/zipp-wasm/. A trailing slash is a folder, taken whole. */
export const VENDORED = [
  'gpu-lab/LICENSE',
  'gpu-lab/NOTICE',
  'gpu-lab/src/',
  'gpu-lab/wasm/kernels.wasm',
  'model-plugins/LICENSE',
  'model-plugins/src/',
  'model-plugins/plugins/qwen3/',
  'model-plugins/wasm/VERSION',
  'model-plugins/wasm/gguf-wasm.lock.json',
  'model-plugins/wasm/gguf/LICENSE-APACHE',
  'model-plugins/wasm/gguf/LICENSE-MIT',
  'model-plugins/wasm/gguf/gguf_wasm.js',
  'model-plugins/wasm/gguf/gguf_wasm_bg.wasm',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args, encoding = 'utf8') => execFileSync('git', ['-C', cwd, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 });

function listAt(zipp, ref) {
  const files = [];
  for (const entry of VENDORED) {
    if (!entry.endsWith('/')) { files.push(entry); continue; }
    const listed = git(zipp, ['ls-tree', '-r', '--name-only', ref, `${CRATE}/${entry}`]).split('\n').filter(Boolean);
    if (!listed.length) throw new Error(`${entry} is empty at ${ref}`);
    // Bytecode caches and the like never belong; only what a checkout tracks is listed.
    files.push(...listed.map((p) => p.slice(CRATE.length + 1)));
  }
  return files.sort();
}

/** The release kit's copy of each gpu-lab file, when that kit is cached. */
async function kitFiles(ref) {
  const version = ref.replace(/^v/, '');
  const kit = path.join(REPO_ROOT, '.zipp-release', ref, `zipp-${version}-wasm-embed-kit.zip`);
  if (!/^v\d+\.\d+\.\d+$/.test(ref) || !fs.existsSync(kit)) return null;
  const { unzipSync } = await import('fflate');
  const prefix = `zipp-${version}-wasm-embed-kit/`;
  const out = new Map();
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(fs.readFileSync(kit))))) {
    if (name.startsWith(`${prefix}gpu-lab/`)) out.set(name.slice(prefix.length), Buffer.from(bytes));
  }
  return out;
}

async function vendor(zipp, ref) {
  const commit = git(zipp, ['rev-list', '-n', '1', ref]).trim();
  const files = listAt(zipp, ref);
  const kit = await kitFiles(ref);
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  const record = {};
  for (const file of files) {
    const bytes = git(zipp, ['show', `${commit}:${CRATE}/${file}`], 'buffer');
    if (kit && file.startsWith('gpu-lab/')) {
      const shipped = kit.get(file);
      if (!shipped) throw new Error(`${file} is not in the ${ref} embed kit`);
      if (!shipped.equals(bytes)) throw new Error(`${file} differs from the ${ref} embed kit's copy`);
    }
    const target = path.join(VENDOR_DIR, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    record[file] = sha256(bytes);
  }
  // gguf-wasm's files as ZIPP pinned them: its lock records each one's digest.
  const lock = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'model-plugins/wasm/gguf-wasm.lock.json'), 'utf8'));
  for (const [file, digest] of Object.entries(record)) {
    const pinned = file.startsWith('model-plugins/wasm/gguf/') ? lock.files?.[file.slice('model-plugins/wasm/'.length)] : undefined;
    if (pinned !== undefined && pinned !== digest) throw new Error(`${file} is not the gguf-wasm ${lock.tag} file ZIPP pinned`);
  }
  const source = {
    repository: 'https://github.com/f2i-com/zipp.org',
    ref,
    commit,
    path: CRATE,
    checkedAgainstKit: Boolean(kit),
    ggufWasm: { repository: lock.repository, tag: lock.tag, commit: lock.commit },
    license: 'Apache-2.0 (gpu-lab, model-plugins); Apache-2.0 OR MIT (gguf-wasm)',
    files: record,
  };
  fs.writeFileSync(path.join(VENDOR_DIR, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
  console.log(`Vendored ${files.length} files of ZIPP ${ref} (${commit.slice(0, 8)})${kit ? ', gpu-lab checked against the embed kit' : ''}.`);
}

/** Problems with the vendored tree, as sentences; none when it matches SOURCE.json. */
export function checkVendored(dir = VENDOR_DIR) {
  const problems = [];
  const sourcePath = path.join(dir, 'SOURCE.json');
  if (!fs.existsSync(sourcePath)) return [`${sourcePath} is missing`];
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const recorded = new Set(Object.keys(source.files ?? {}));
  for (const [file, digest] of Object.entries(source.files ?? {})) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) { problems.push(`${file} is missing`); continue; }
    if (sha256(fs.readFileSync(full)) !== digest) problems.push(`${file} is not the vendored ${digest.slice(0, 12)}`);
  }
  const walk = (at) => fs.readdirSync(at, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(at, e.name)) : [path.join(at, e.name)]);
  for (const full of walk(dir)) {
    const rel = path.relative(dir, full).split(path.sep).join('/');
    if (rel !== 'SOURCE.json' && !recorded.has(rel)) problems.push(`${rel} is not a vendored file`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  if (args.includes('--check')) {
    const problems = checkVendored();
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('vendor/zipp-models matches SOURCE.json');
  } else {
    const zipp = value('--zipp');
    if (!zipp) { console.error('Usage: vendor-zipp-models.mjs --zipp <ZIPP checkout> [--ref vX.Y.Z] | --check'); process.exit(2); }
    // The installer reads the declared release; it is loaded only here, so --check and checkVendored's callers never load it.
    const ref = value('--ref') ?? (await import('./fetch-zipp-release.mjs')).declaredRelease();
    await vendor(path.resolve(zipp), ref);
  }
}
