#!/usr/bin/env node
/**
 * Rebuild the vendored zipp engine in `wasm-zipp/` from a zipp.org checkout.
 *
 * The engine is a Rust crate that lives in its own repository, so its build
 * output is committed here rather than produced by `npm run build` — a SoftN
 * checkout must be buildable without a Rust toolchain. Run this only when
 * picking up a new engine revision.
 *
 *   node scripts/build-zipp-wasm.mjs
 *   ZIPP_REPO=../../../../zipp.org node scripts/build-zipp-wasm.mjs
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
const OUT = join(CORE, 'wasm-zipp');

if (!existsSync(join(ZIPP, 'crates/zipp-wasm/Cargo.toml'))) {
  console.error(`No zipp-wasm crate at ${ZIPP}. Set ZIPP_REPO to a zipp.org checkout.`);
  process.exit(1);
}

// A vendored binary without an exact source revision cannot be audited or
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
  ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown'],
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
run('node', ['tests/node/strip-target-features.cjs',
  join(PKG, 'zipp_wasm_bg.wasm'), join(PKG, 'zipp_wasm_bg.stripped.wasm')], WASM);
copyFileSync(join(PKG, 'zipp_wasm_bg.stripped.wasm'), join(PKG, 'zipp_wasm_bg.wasm'));
rmSync(join(PKG, 'zipp_wasm_bg.stripped.wasm'));
// Verifies the post-processed artifact's linear-memory maximum and its host
// import surface. Runs against the file that will actually be vendored.
run('node', ['tests/node/check-wasm-memory.cjs', join(PKG, 'zipp_wasm_bg.wasm')], WASM);

mkdirSync(OUT, { recursive: true });
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
