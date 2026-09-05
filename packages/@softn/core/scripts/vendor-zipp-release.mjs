#!/usr/bin/env node
/**
 * Vendor the zipp engine from a published zipp.org release into `wasm-zipp/`.
 *
 *   node scripts/vendor-zipp-release.mjs v0.0.14
 *
 * This is the engine zipp's own CI built, tested and signed off, taken as it
 * is: the release archive is checked against the release's SHA256SUMS, the
 * files inside it against the archive's own SHA256SUMS, and SOURCE.json then
 * records the tag, the commit and the hash of the module that is really here.
 * `build-zipp-wasm.mjs` is the other way in — a local build from a checkout —
 * for engine revisions that have not been released yet.
 *
 * No dependencies beyond fflate, which core already ships for bundles.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const REPO = 'https://github.com/f2i-com/zipp.org';
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.ZIPP_OUT ? resolve(process.env.ZIPP_OUT) : join(CORE, 'wasm-zipp');
const FILES = ['zipp_wasm.js', 'zipp_wasm.d.ts', 'zipp_wasm_bg.wasm', 'zipp_wasm_bg.wasm.d.ts'];

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  console.error('Usage: node scripts/vendor-zipp-release.mjs vMAJOR.MINOR.PATCH');
  process.exit(1);
}
const version = tag.slice(1);
const bundleName = `zipp-wasm-${version}-web`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchBytes(name) {
  const url = `${REPO}/releases/download/${tag}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** SHA256SUMS lines are `<hex>  <name>`. */
function parseSums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

console.log(`Fetching ${bundleName}.zip from the ${tag} release ...`);
const [zip, releaseSums] = await Promise.all([fetchBytes(`${bundleName}.zip`), fetchBytes('SHA256SUMS')]);
const expectedZip = parseSums(Buffer.from(releaseSums).toString('utf8')).get(`${bundleName}.zip`);
const zipHash = sha256(zip);
if (!expectedZip) throw new Error(`the release's SHA256SUMS does not list ${bundleName}.zip`);
if (zipHash !== expectedZip) throw new Error(`archive hash ${zipHash} does not match the release's ${expectedZip}`);

const entries = unzipSync(zip);
const inner = entries[`${bundleName}/SHA256SUMS`];
if (!inner) throw new Error('the archive carries no SHA256SUMS');
const innerSums = parseSums(Buffer.from(inner).toString('utf8'));
for (const file of FILES) {
  const bytes = entries[`${bundleName}/${file}`];
  if (!bytes) throw new Error(`the archive has no ${file}`);
  const expected = innerSums.get(file);
  if (!expected || sha256(bytes) !== expected) throw new Error(`${file} does not match the archive's SHA256SUMS`);
}
const buildInfo = Object.fromEntries(
  Buffer.from(entries[`${bundleName}/BUILD-INFO.txt`] ?? new Uint8Array())
    .toString('utf8')
    .split('\n')
    .map((l) => l.split('='))
    .filter((kv) => kv.length === 2)
    .map(([k, v]) => [k.trim(), v.trim()])
);
if (!/^[0-9a-f]{40}$/.test(buildInfo.commit ?? '')) throw new Error('BUILD-INFO.txt names no full commit');
if (buildInfo.version !== version) throw new Error(`BUILD-INFO.txt says version ${buildInfo.version}, not ${version}`);

mkdirSync(OUT, { recursive: true });
for (const file of FILES) writeFileSync(join(OUT, file), entries[`${bundleName}/${file}`]);
const wasmHash = sha256(entries[`${bundleName}/zipp_wasm_bg.wasm`]);
writeFileSync(
  join(OUT, 'SOURCE.json'),
  `${JSON.stringify(
    {
      repository: REPO,
      revision: buildInfo.commit,
      version,
      // The tag, not a URL: package-site.mjs puts this in the archive's name.
      release: tag,
      releaseUrl: `${REPO}/releases/tag/${tag}`,
      bundle: `${bundleName}.zip`,
      bundleSha256: zipHash,
      rustc: buildInfo.rustc,
      wasmBindgen: (buildInfo['wasm-bindgen'] ?? '').replace(/^wasm-bindgen\s+/, ''),
      license: 'Apache-2.0',
      artifact: 'zipp_wasm_bg.wasm',
      sha256: wasmHash,
    },
    null,
    2
  )}\n`
);
console.log(`Vendored zipp ${tag} (${buildInfo.commit.slice(0, 8)}) into ${OUT}`);
console.log(`Engine sha256: ${wasmHash}`);
