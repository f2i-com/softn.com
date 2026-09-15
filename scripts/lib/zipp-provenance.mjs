/**
 * The ZIPP engine as the licence inventory records it: the install's
 * SOURCE.json, checked against the files beside it.
 *
 * With `check` (licenses:check, which the release runs) only a verified ZIPP
 * release install passes, and it must record its third-party notices; notices
 * SoftN had to curate because the release ships none are named in a warning.
 * Without it a local build (fetch-zipp-release.mjs --install-local) still gets
 * an inventory, for a local site build.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A file named by SOURCE.json, inside its folder, or an error naming the field. */
function besideSource(dir, name, what) {
  const file = path.resolve(dir, String(name));
  if (!file.startsWith(`${dir}${path.sep}`)) throw new Error(`zipp SOURCE.json names an unsafe ${what}: ${name}`);
  return file;
}

/** @returns {{ artifact: string, sha256: string, notices: string | null }} absolute paths and the engine digest */
export function checkZippProvenance(zipp, dir, { check = false, warn = console.warn } = {}) {
  const root = path.resolve(dir);
  for (const field of ['repository', 'revision', 'license', 'artifact', 'sha256']) {
    if (!zipp[field] || typeof zipp[field] !== 'string') throw new Error(`zipp SOURCE.json is missing ${field}.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(zipp.revision)) throw new Error('zipp SOURCE.json revision is not a full Git commit.');
  if (!/^[0-9a-f]{64}$/i.test(zipp.sha256)) throw new Error('zipp SOURCE.json sha256 is invalid.');
  const artifact = besideSource(root, zipp.artifact, 'artifact');
  if (!fs.existsSync(artifact)) throw new Error(`zipp SOURCE.json names a missing or unsafe artifact: ${zipp.artifact}`);
  const actual = sha256(fs.readFileSync(artifact));
  if (actual !== zipp.sha256.toLowerCase()) throw new Error(`zipp provenance hash is stale: SOURCE.json has ${zipp.sha256}, artifact is ${actual}.`);

  if (check) {
    if (zipp.build !== 'release') throw new Error(`zipp SOURCE.json is a '${zipp.build}' build; a release ships only a verified ZIPP release (npm run fetch:zipp).`);
    if (!zipp.notices || typeof zipp.notices.file !== 'string' || !/^[0-9a-f]{64}$/.test(zipp.notices.sha256 ?? '')) throw new Error('zipp SOURCE.json records no third-party notices.');
    if (zipp.notices.source === 'softn-curated') {
      warn(`warning: ZIPP ${zipp.release} ships no third-party notices; the RustPython and Unicode notices are SoftN's curated copy (packages/@softn/core/zipp-notices/), which cannot prove itself complete.`);
    }
  }
  // Before notices were recorded, the file had this one name.
  const notices = besideSource(root, zipp.notices?.file ?? 'THIRD_PARTY_LICENSES.txt', 'notices file');
  if (zipp.notices) {
    if (!fs.existsSync(notices)) throw new Error(`zipp SOURCE.json names a missing notices file: ${zipp.notices.file}`);
    if (sha256(fs.readFileSync(notices)) !== zipp.notices.sha256) throw new Error(`zipp notices are stale: ${zipp.notices.file} is not the ${zipp.notices.sha256} SOURCE.json records.`);
  }
  return { artifact, sha256: actual, notices: fs.existsSync(notices) ? notices : null };
}
