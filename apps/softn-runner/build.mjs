// Build softn-runner: the guest (ZIPP for WASI) and the runner that embeds it.
//
//   node apps/softn-runner/build.mjs                       for this machine
//   node apps/softn-runner/build.mjs --target <triple>     for a release target
//   node apps/softn-runner/build.mjs --guest               the guest alone
//   node apps/softn-runner/build.mjs --notices             the licences alone
//
// The runner is written to dist/softn-runner-<platform>, the name a release
// carries it under (RUNNER_PLATFORMS): linux-x86_64 (static, musl), the one a
// FormLogic or SoftN server runs, and windows-x86_64.exe. Beside it goes
// RUNNER_NOTICES, the licences of every crate either runner compiles in.
//
// The guest compiles ZIPP's own browser preamble ahead of an app's logic, as
// the Node runner's engine does. That file is taken from the checkout Cargo
// resolved for zipp-vm (crates/zipp-wasm/src/preamble.js beside it), never
// copied by hand, and the checkout must be the commit of the engine SoftN
// installs (packages/@softn/core/wasm-zipp/SOURCE.json), so both runners run
// one engine. The guest pins Rust 1.92.0, ZIPP's release toolchain, and the
// runner its own (each crate's rust-toolchain.toml).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The targets a release builds, and the name each runner is carried under. */
export const RUNNER_PLATFORMS = Object.freeze({
  'x86_64-unknown-linux-musl': 'softn-runner-linux-x86_64',
  'x86_64-pc-windows-msvc': 'softn-runner-windows-x86_64.exe',
});

/** The licences of what is compiled into the runners, written beside them in dist/. */
export const RUNNER_NOTICES = 'SOFTN-RUNNER-THIRD-PARTY-LICENSES.txt';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const guest = join(here, 'guest');
const host = join(here, 'host');
const cargo = (cwd, args) => execFileSync('cargo', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });

function hostTriple() {
  const info = execFileSync('rustc', ['-vV'], { cwd: host, encoding: 'utf8' });
  return /^host: (\S+)$/m.exec(info)?.[1];
}

/**
 * The crates a build compiles in: what the package in `cwd` depends on, as
 * normal dependencies, on these platforms (build scripts' and tests' own
 * dependencies are not shipped; ZIPP's compiler, which precompiles the guest,
 * is one).
 */
function shippedCrates(cwd, platforms) {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', ...platforms.flatMap((p) => ['--filter-platform', p])], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  );
  const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const seen = new Set();
  const queue = [meta.resolve.root];
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
  }
  // The runner's own crates (path dependencies) are SoftN's, under its licence.
  return [...seen].map((id) => packages.get(id)).filter((p) => p.source !== null);
}

/**
 * The third-party licences both runners carry: every crate either half
 * compiles in, on any release platform, with the licence files the crate
 * ships (a text several crates ship the same is written once).
 */
function notices() {
  const crates = new Map();
  for (const p of [...shippedCrates(guest, ['wasm32-wasip1']), ...shippedCrates(host, Object.keys(RUNNER_PLATFORMS))]) crates.set(`${p.name} ${p.version}`, p);
  const licenceFiles = (dir) => readdirSync(dir).filter((f) => /^(licen[cs]e|copying|copyright|notice)/i.test(f) && statSync(join(dir, f)).isFile());
  // Sorted by code point, not by locale, so every machine writes the same file.
  const listed = [...crates]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, p]) => {
      let dir = dirname(p.manifest_path);
      let files = licenceFiles(dir);
      // A crate of a git repository (ZIPP's) may keep its licence at the
      // repository's root, above the crate, within Cargo's checkout.
      for (let up = dir; files.length === 0 && p.source?.startsWith('git+') && dirname(up) !== up && !/[\\/]checkouts$/.test(dirname(up)); ) {
        up = dirname(up);
        files = licenceFiles(up);
        if (files.length) dir = up;
      }
      if (p.license_file && existsSync(resolve(dir, p.license_file))) files.push(p.license_file);
      return { key, p, dir, files: [...new Set(files)].sort() };
    });
  // For each licence named, the first crate that carries its texts.
  const carried = new Map();
  for (const { key, p, files } of listed) if (files.length && p.license && !carried.has(p.license)) carried.set(p.license, key);
  const written = new Map();
  const sections = listed.map(({ key, p, dir, files }) => {
    const from = p.repository ?? (p.source.startsWith('git+') ? p.source.slice(4).replace(/#.*$/, '') : `https://crates.io/crates/${p.name}`);
    const lines = [`${key}`, `  Licence: ${p.license ?? 'its licence file'}`, `  Source: ${from}`];
    if (files.length === 0) {
      const other = carried.get(p.license);
      lines.push(`  The crate carries no licence file: its licence is ${p.license}${other ? `, whose texts ${other} carries` : ''}.`);
    }
    for (const file of files) {
      const text = readFileSync(resolve(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
      const first = written.get(text);
      if (first) {
        lines.push(`  ${file}: the same text as ${first}.`);
      } else {
        written.set(text, `${key}'s ${file}`);
        lines.push(`  ${file}:`, '', text);
      }
    }
    return lines.join('\n');
  });
  const head = [
    'SOFTN-RUNNER THIRD-PARTY LICENCES',
    '',
    'softn-runner (apps/softn-runner in SoftN) is SoftN\'s, under SoftN\'s licence (LICENSE, NOTICE). It compiles in',
    `the ${crates.size} crates below: the ZIPP engine and its dependencies in its WebAssembly guest, and wasmtime,`,
    'rusqlite with SQLite (public domain), chrono and the rest in the runner around it. Each is listed with',
    'the licence its manifest names and the licence files it ships.',
  ];
  return `${head.join('\n')}\n\n${sections.join('\n\n----------------------------------------------------------------\n\n')}\n`;
}

export function build({ target, guestOnly = false } = {}) {
  const engine = JSON.parse(readFileSync(join(root, 'packages/@softn/core/wasm-zipp/SOURCE.json'), 'utf8'));
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], { cwd: guest, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const zipp = metadata.packages.find((p) => p.name === 'zipp-vm');
  if (!zipp) throw new Error('cargo metadata names no zipp-vm');
  const commit = /#([0-9a-f]{40})$/.exec(zipp.source ?? '')?.[1];
  if (commit !== engine.revision) {
    throw new Error(`the guest resolves zipp-vm at ${commit ?? zipp.source}, but SoftN installs ZIPP ${engine.release} at ${engine.revision}`);
  }
  const preamble = readFileSync(resolve(dirname(zipp.manifest_path), '../zipp-wasm/src/preamble.js'));
  const preambleSha256 = createHash('sha256').update(preamble).digest('hex');
  mkdirSync(join(guest, 'generated'), { recursive: true });
  writeFileSync(join(guest, 'generated/zipp-preamble.js'), preamble);
  writeFileSync(
    join(guest, 'generated/zipp-preamble.json'),
    JSON.stringify({ release: engine.release, revision: commit, path: 'crates/zipp-wasm/src/preamble.js', sha256: preambleSha256 }, null, 2) + '\n'
  );
  console.log(`ZIPP ${engine.release} (${commit.slice(0, 12)}): preamble ${preambleSha256.slice(0, 12)}`);

  cargo(guest, ['build', '--release', '--locked']);
  const guestWasm = join(guest, 'target/wasm32-wasip1/release/softn-runner-guest.wasm');
  copyFileSync(guestWasm, join(host, 'softn-runner-guest.wasm'));
  console.log(`guest: ${readFileSync(guestWasm).length} bytes`);
  if (guestOnly) return null;

  const triple = target ?? hostTriple();
  const name = RUNNER_PLATFORMS[triple] ?? `softn-runner-${triple}${triple.includes('windows') ? '.exe' : ''}`;
  cargo(host, ['build', '--release', '--locked', ...(target ? ['--target', target] : [])]);
  const built = join(host, 'target', ...(target ? [target] : []), 'release', `softn-runner${triple.includes('windows') ? '.exe' : ''}`);
  mkdirSync(join(here, 'dist'), { recursive: true });
  const out = join(here, 'dist', name);
  copyFileSync(built, out);
  console.log(`runner: dist/${name}, ${readFileSync(out).length} bytes`);
  writeNotices();
  return out;
}

function writeNotices() {
  const licences = notices();
  mkdirSync(join(here, 'dist'), { recursive: true });
  writeFileSync(join(here, 'dist', RUNNER_NOTICES), licences);
  console.log(`notices: dist/${RUNNER_NOTICES}, ${Buffer.byteLength(licences)} bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--target');
  if (args.includes('--notices')) writeNotices();
  else build({ target: at >= 0 ? args[at + 1] : undefined, guestOnly: args.includes('--guest') });
}
