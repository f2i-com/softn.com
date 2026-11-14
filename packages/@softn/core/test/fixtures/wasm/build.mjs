#!/usr/bin/env node
/**
 * Builds the WebAssembly fixtures from src/ with rustc alone (no Cargo):
 *
 *   rustup target add wasm32-wasip1 wasm32-unknown-unknown
 *   node packages/@softn/core/test/fixtures/wasm/build.mjs
 *
 * The .wasm files are committed beside their sources so the tests need no
 * Rust; run this again after changing a source.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const common = ['-C', 'opt-level=z', '-C', 'lto=fat', '-C', 'codegen-units=1', '-C', 'strip=symbols', '-C', 'panic=abort', '--edition', '2021'];
const builds = [
  { source: 'wasi_tool.rs', target: 'wasm32-wasip1', crateType: 'bin', out: 'wasi_tool.wasm' },
  { source: 'calc.rs', target: 'wasm32-unknown-unknown', crateType: 'cdylib', out: 'calc.wasm' },
  { source: 'screen.rs', target: 'wasm32-unknown-unknown', crateType: 'cdylib', out: 'screen.wasm' },
];

for (const { source, target, crateType, out } of builds) {
  execFileSync('rustc', ['--target', target, '--crate-type', crateType, ...common, '-o', join(here, out), join(here, 'src', source)], { stdio: 'inherit' });
  console.log(`built ${out}`);
}
