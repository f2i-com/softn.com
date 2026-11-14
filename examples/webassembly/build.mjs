// Build WebAssembly.softn from the sources beside this file.
//
//   node examples/webassembly/build.mjs          packs the .wasm files in assets/
//   node examples/webassembly/build.mjs --rust   compiles src/*.rs into assets/ first
//
// --rust needs rustc and its two WebAssembly targets:
//   rustup target add wasm32-unknown-unknown wasm32-wasip1
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const root = new URL('./', import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const stamp = '2026-11-15T09:00:00.000Z';
const optimise = ['-C', 'opt-level=z', '-C', 'lto=fat', '-C', 'codegen-units=1', '-C', 'strip=symbols', '-C', 'panic=abort', '--edition', '2021'];
const programs = [
  { source: 'src/game.rs', target: 'wasm32-unknown-unknown', crateType: 'cdylib', out: 'assets/game.wasm' },
  { source: 'src/stats.rs', target: 'wasm32-unknown-unknown', crateType: 'cdylib', out: 'assets/stats.wasm' },
  { source: 'src/wordfreq.rs', target: 'wasm32-wasip1', crateType: 'bin', out: 'assets/wordfreq.wasm' },
];

if (process.argv.includes('--rust')) {
  await mkdir(path('assets/'), { recursive: true });
  for (const p of programs) {
    execFileSync('rustc', ['--target', p.target, '--crate-type', p.crateType, ...optimise, '-o', path(p.out), path(p.source)], { stdio: 'inherit' });
    console.log(`Compiled ${p.out}`);
  }
}

const assets = programs.map((p) => p.out);
const manifest = {
  id: 'softn-webassembly-example',
  name: 'WebAssembly',
  version: '1.0.0',
  description: 'Three programs compiled from Rust: a game in WasmApp, a library the logic calls, and a WASI command-line tool.',
  main: 'ui/main.ui',
  files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets },
  config: { window: { title: 'WebAssembly', width: 900, height: 900 }, theme: { primary: '#6366f1', mode: 'dark' } },
};
const files = {
  'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  // Nothing to ask for: a module from the app's own files needs no permission.
  'permission.json': strToU8(JSON.stringify({ permissions: {} })),
  'ui/main.ui': strToU8(await readFile(path('ui/main.ui'), 'utf8')),
  'logic/main.logic': strToU8(await readFile(path('logic/main.logic'), 'utf8')),
  'README.md': strToU8(await readFile(path('README.md'), 'utf8')),
};
for (const asset of assets) files[asset] = new Uint8Array(await readFile(path(asset)));
await writeFile(path('WebAssembly.softn'), zipSync(files, { level: 9, mtime: new Date(stamp) }));
console.log('Built examples/webassembly/WebAssembly.softn');
