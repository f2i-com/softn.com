// Exercise every checked-in demo through the bundle validator. Keeping this
// list discovered rather than hand-maintained means a newly added demo starts
// receiving archive/source/parser checks in the same commit that adds it.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const bundlesDir = path.join(__dirname, '..', 'bundles');
const validator = path.join(__dirname, 'test-bundle.cjs');
const bundles = fs
  .readdirSync(bundlesDir)
  .filter((name) => name.toLowerCase().endsWith('.softn'))
  .sort((left, right) => left.localeCompare(right));

const failed = [];
for (const bundle of bundles) {
  const result = spawnSync(process.execPath, [validator, path.join(bundlesDir, bundle)], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`ERROR: Could not validate ${bundle}: ${result.error.message}`);
    failed.push(bundle);
  } else if (result.status !== 0) {
    failed.push(bundle);
  }
}

if (failed.length > 0) {
  console.error(`Bundle validation failed: ${failed.join(', ')}`);
  process.exit(1);
}

// The launcher shows this metadata directly to users. Keep its advertised
// sizes tied to the served archives so a rebuilt demo cannot leave stale UI
// behind while all source/archive checks still pass.
const servedDir = path.join(__dirname, '..', '..', 'softn-web', 'public', 'demos');
const indexPath = path.join(servedDir, 'index.json');
let demoIndex;
try {
  demoIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
} catch (error) {
  console.error(`ERROR: Could not read demo index: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(demoIndex)) {
  console.error('ERROR: Demo index must contain an array.');
  process.exit(1);
}

const indexedFiles = new Set();
const indexFailures = [];
for (const entry of demoIndex) {
  if (!entry || typeof entry.file !== 'string' || typeof entry.size !== 'number') {
    indexFailures.push('an entry is missing a string file or numeric size');
    continue;
  }
  if (path.basename(entry.file) !== entry.file || !entry.file.toLowerCase().endsWith('.softn')) {
    indexFailures.push(`${entry.file} is not a safe .softn filename`);
    continue;
  }
  if (indexedFiles.has(entry.file)) {
    indexFailures.push(`${entry.file} is listed more than once`);
    continue;
  }
  indexedFiles.add(entry.file);

  const servedPath = path.join(servedDir, entry.file);
  if (!fs.existsSync(servedPath)) {
    indexFailures.push(`${entry.file} is indexed but not served`);
    continue;
  }
  const actualSize = fs.statSync(servedPath).size;
  if (entry.size !== actualSize) {
    indexFailures.push(`${entry.file} advertises ${entry.size} bytes but is ${actualSize}`);
  }
}

for (const servedFile of fs
  .readdirSync(servedDir)
  .filter((name) => name.toLowerCase().endsWith('.softn'))) {
  if (!indexedFiles.has(servedFile)) indexFailures.push(`${servedFile} is served but not indexed`);
}

if (indexFailures.length > 0) {
  for (const failure of indexFailures) console.error(`ERROR: Demo index ${failure}.`);
  process.exit(1);
}

console.log(`All ${bundles.length} demo bundles passed.`);
console.log(`Demo index matches all ${demoIndex.length} served bundles.`);
