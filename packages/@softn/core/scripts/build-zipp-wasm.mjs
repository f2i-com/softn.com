#!/usr/bin/env node
/**
 * Rebuild the vendored zipp engine in `wasm-zipp/` from a zipp-lang checkout.
 *
 * The engine is a Rust crate that lives in its own repository, so its build
 * output is committed here rather than produced by `npm run build` — a SoftN
 * checkout must be buildable without a Rust toolchain. Run this only when
 * picking up a new engine revision.
 *
 *   node scripts/build-zipp-wasm.mjs
 *   ZIPP_REPO=../../../../zipp-lang node scripts/build-zipp-wasm.mjs
 *
 * Requires: rustup with the wasm32-unknown-unknown target, and wasm-pack.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIPP = resolve(CORE, process.env.ZIPP_REPO ?? '../../../../zipp-lang');
const OUT = join(CORE, 'wasm-zipp');

if (!existsSync(join(ZIPP, 'crates/zipp-wasm/Cargo.toml'))) {
  console.error(`No zipp-wasm crate at ${ZIPP}. Set ZIPP_REPO to a zipp-lang checkout.`);
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
console.log(`Building zipp-wasm from ${ZIPP} ...`);
execFileSync(
  'wasm-pack',
  ['build', 'crates/zipp-wasm', '--target', 'web', '--out-dir', 'pkg', '--release'],
  { cwd: ZIPP, stdio: 'inherit', shell: process.platform === 'win32' }
);

mkdirSync(OUT, { recursive: true });
for (const f of ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts']) {
  copyFileSync(join(ZIPP, 'crates/zipp-wasm/pkg', f), join(OUT, f));
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
