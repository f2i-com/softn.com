#!/usr/bin/env node
/**
 * Build the zipp engine from a zipp.org checkout, for trying an unreleased
 * engine revision. SoftN ships only ZIPP's own release build
 * (`fetch-zipp-release.mjs`, checked against the release's SHA256SUMS), so
 * this writes to the gitignored `.cache/zipp-local/`, never to `wasm-zipp/`:
 *
 *   node scripts/build-zipp-wasm.mjs
 *   ZIPP_REPO=../../../../zipp.org node scripts/build-zipp-wasm.mjs
 *   node scripts/fetch-zipp-release.mjs --install-local .cache/zipp-local
 *
 * The install is stamped build 'local'. Most suites run on it, but the ones
 * that pin release provenance fail by design: scripts/engine-pin.test.mjs
 * (build 'release', the Cargo tag) and test/zipp-languages.test.ts (the
 * commit the module reports). licenses:check, the FormLogic runtime packager
 * and --ensure under CI refuse it, and `npm run fetch:zipp` puts a release back.
 *
 * Requires: rustup with the wasm32-unknown-unknown target, and the wasm-bindgen
 * CLI at the version zipp pins (`cargo install wasm-bindgen-cli --locked
 * --version =0.2.126`).
 *
 * The steps below are zipp's release recipe, not a convenience wrapper around
 * it. That distinction cost something: this used to call `wasm-pack build`,
 * which keeps the name and producers sections wasm-bindgen is told to drop
 * (~329 KB, ~75 KB after brotli, that no browser reads) and skips the
 * target-features strip. So the engine vendored here was not the engine zipp
 * ships, and the difference was invisible — both work.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIPP = resolve(CORE, process.env.ZIPP_REPO ?? '../../../../zipp.org');
const OUT = join(CORE, '.cache/zipp-local');
const variant = process.env.ZIPP_VARIANT ?? 'all';
if (!['all', 'javascript'].includes(variant)) throw new Error('ZIPP_VARIANT must be all or javascript.');

if (!existsSync(join(ZIPP, 'crates/zipp-wasm/Cargo.toml'))) {
  console.error(`No zipp-wasm crate at ${ZIPP}. Set ZIPP_REPO to a zipp.org checkout.`);
  process.exit(1);
}

// A binary without an exact source revision cannot be audited or
// reproduced. Refuse to stamp a dirty checkout as a real commit: the caller can
// commit/stash its zipp work first, then rebuild from that immutable revision.
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: ZIPP,
  encoding: 'utf8',
}).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], {
  cwd: ZIPP,
  encoding: 'utf8',
}).trim();
if (dirty) {
  console.error('The zipp checkout has tracked changes; refusing to create untraceable WASM.');
  process.exit(1);
}

// `--target web` matches how the glue is consumed: tsup inlines the JS into a
// chunk and the glue resolves the binary with `new URL(..., import.meta.url)`,
// which is why tsup.config.ts copies the .wasm next to that chunk.
const WASM = join(ZIPP, 'crates/zipp-wasm');
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

console.log(`Building zipp-wasm from ${ZIPP} ...`);
// RUSTFLAGS overrides .cargo/config.toml rather than adding to it, so both
// linker limits are repeated here. Dropping either one silently produces an
// instance whose ceiling no longer matches what the engine's own accounting
// assumes — check-wasm-memory below is what catches that.
run(
  'cargo',
  ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', ...(variant === 'all' ? ['--features', 'python'] : [])],
  WASM,
);

const PKG = join(WASM, 'pkg');
run(
  'wasm-bindgen',
  [
    '--target', 'web',
    '--out-dir', PKG,
    '--remove-name-section',
    '--remove-producers-section',
    join(WASM, 'target/wasm32-unknown-unknown/release/zipp_wasm.wasm'),
  ],
  WASM,
);
// Binaryen's optimiser over the linked module. rustc emits per-crate; wasm-opt
// sees the whole engine at once and, measured on SoftDOS running DOOM in the
// browser's interpreter-only tier, it is worth 10-15% with identical
// behaviour. Required rather than best-effort: a build without it would be a
// silently slower engine with the same version stamp.
//
// No `--all-features`: binaryen reads the features the module declares in its
// target_features section and stays within them. Given every feature it once
// emitted typed references (an "Unknown heap type" to Node 20's V8), and the
// engine then failed to compile under the Node the CI test job runs — it only
// showed on the runner, because Node 24 on the machine that built it accepted
// them. zipp's own release (crates/zipp-wasm/README.md) ships without wasm-opt
// at all; `fetch-zipp-release.mjs` takes that build as it is, and that is
// what SoftN ships.
run('wasm-opt', ['-O3',
  join(PKG, 'zipp_wasm_bg.wasm'), '-o', join(PKG, 'zipp_wasm_bg.opt.wasm')], WASM);
copyFileSync(join(PKG, 'zipp_wasm_bg.opt.wasm'), join(PKG, 'zipp_wasm_bg.wasm'));
rmSync(join(PKG, 'zipp_wasm_bg.opt.wasm'));
// After wasm-opt, which may write a target-features section of its own.
run('node', ['tests/node/strip-target-features.cjs',
  join(PKG, 'zipp_wasm_bg.wasm'), join(PKG, 'zipp_wasm_bg.stripped.wasm')], WASM);
copyFileSync(join(PKG, 'zipp_wasm_bg.stripped.wasm'), join(PKG, 'zipp_wasm_bg.wasm'));
rmSync(join(PKG, 'zipp_wasm_bg.stripped.wasm'));
// Verifies the post-processed artifact's linear-memory maximum and its host
// import surface. Runs against the file that will actually be installed.
run('node', ['tests/node/check-wasm-memory.cjs', join(PKG, 'zipp_wasm_bg.wasm')], WASM);

mkdirSync(OUT, { recursive: true });
copyFileSync(join(ZIPP, 'LICENSE-APACHE'), join(OUT, 'LICENSE-APACHE'));
writeFileSync(join(OUT, 'THIRD_PARTY_LICENSES.txt'), [
  'ZIPP engine: Apache-2.0. See the source repository for its complete notices.',
  ...(variant === 'all' ? [
    'RustPython parser (MIT):\n' + readFileSync(join(ZIPP, 'crates/rustpython-parser-fork/LICENSE'), 'utf8'),
    'Unicode data:\n' + readFileSync(join(ZIPP, 'LICENSE-UNICODE'), 'utf8'),
  ] : []),
].join('\n\n').trimEnd() + '\n');
for (const f of ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts']) {
  copyFileSync(join(PKG, f), join(OUT, f));
}
const wasmFile = join(OUT, 'zipp_wasm_bg.wasm');
const sha256 = createHash('sha256').update(readFileSync(wasmFile)).digest('hex');
writeFileSync(
  join(OUT, 'SOURCE.json'),
  `${JSON.stringify(
    {
      repository: 'https://github.com/f2i-com/zipp.org',
      revision,
      version: readFileSync(join(WASM, 'Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)[1],
      build: 'local',
      variant,
      languages: variant === 'all' ? ['javascript', 'python'] : ['javascript'],
      rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
      wasmBindgen: execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim().replace(/^wasm-bindgen\s+/, ''),
      license: 'Apache-2.0',
      artifact: 'zipp_wasm_bg.wasm',
      sha256,
    },
    null,
    2
  )}\n`
);
console.log(`Copied engine to ${OUT}`);
console.log(`Source revision: ${revision}`);
console.log('Install it with: node scripts/fetch-zipp-release.mjs --install-local .cache/zipp-local');
