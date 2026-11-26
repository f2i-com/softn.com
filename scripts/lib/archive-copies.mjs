/**
 * Files an archive stores once although it installs them in several places.
 *
 * FormLogic's runtime archive (scripts/release/package-formlogic-runtime.mjs)
 * lays its trees out the way FormLogic installs them, and several trees carry
 * the same bytes: the engine in zipp/ and native-runtime/wasm/, the container
 * engines in hosted-runtime/ and native-runtime/wasm/container/, the torch
 * package four times, and the chunks Builder and Studio share. Written out
 * each time, those copies were a quarter of the archive.
 *
 * So the packager writes each such file once and names every other place it
 * goes in softn-release.json `copies` ({ "<where it goes>": "<the entry that
 * has its bytes>" }), at `formatVersion` 2. `files` still lists every file of
 * every tree with its digest, copies included, so a reader that fills the
 * copies in first (materializeCopies) sees exactly the archive it always saw
 * and checks it the same way. FormLogic's scripts/fetch-softn-release.mjs does
 * the same before it reads anything else.
 *
 * What is never stored as a copy: a file under COPY_MIN_BYTES (the saving is
 * a few bytes, and an archive a person opens keeps its small files where they
 * belong), the files at the archive's root, and zipp-tools/, which FormLogic
 * unpacks by itself without the rest (scripts/site-zipp.mjs).
 */
import { createHash } from 'node:crypto';

/** The softn-release.json format whose readers fill `copies` in. */
export const COPIES_FORMAT = 2;

/** Smaller files are written out each time. */
export const COPY_MIN_BYTES = 4096;

/**
 * Which copy of a file is the one stored: the first of these trees that has
 * it, then the first by name. The ZIPP trees first, because they are where a
 * reader proves the engine and the torch package against ZIPP's own sums.
 */
const STORED_FIRST = ['zipp/', 'zipp-web/', 'zipp-torch/', 'hosted-runtime/', 'app-editors/', 'native-runtime/'];

const bytesOf = (value) => (Buffer.isBuffer(value) ? value : value.data);
const modeOf = (value) => (Buffer.isBuffer(value) ? 0o100644 : (value.mode ?? 0o100644));
const rank = (name) => {
  const i = STORED_FIRST.findIndex((prefix) => name.startsWith(prefix));
  return i === -1 ? STORED_FIRST.length : i;
};
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A name that may be stored as a copy of another entry. */
function mayBeCopy(name, size, minBytes) {
  return size >= minBytes && name.includes('/') && !name.startsWith('zipp-tools/') && !name.endsWith('/');
}

/**
 * The copies an archive of `entries` can leave out: for every content (and
 * mode) more than one entry has, every entry but the one stored.
 *
 * @param {Map<string, Buffer | {data: Buffer, mode?: number}>} entries
 * @param {{minBytes?: number}} [options]
 * @returns {Record<string, string>} where each copy goes -> the entry stored, sorted by where it goes
 */
export function planCopies(entries, { minBytes = COPY_MIN_BYTES } = {}) {
  const firstOf = new Map();
  const copies = [];
  const names = [...entries.keys()].sort((a, b) => rank(a) - rank(b) || byCodePoint(a, b));
  for (const name of names) {
    const value = entries.get(name);
    const data = bytesOf(value);
    if (!mayBeCopy(name, data.length, minBytes)) continue;
    const key = `${modeOf(value).toString(8)}:${createHash('sha256').update(data).digest('hex')}`;
    const stored = firstOf.get(key);
    if (stored === undefined) firstOf.set(key, name);
    else copies.push([name, stored]);
  }
  return Object.fromEntries(copies.sort(([a], [b]) => byCodePoint(a, b)));
}

/**
 * The archive's entries with its copies filled in, as `readArchive` returned
 * them otherwise: each copy is its stored entry's bytes and mode under the
 * copy's name. Throws on an archive whose copies are not sound: `copies` in a
 * format that has none, a copy the archive also stores, a copy of a file it
 * does not store (or of another copy), or a copy softn-release.json does not
 * list. The digests are the caller's to check, against `files`, as for every
 * other entry.
 *
 * @param {Map<string, {data: Buffer, mode: number}>} entries  what readArchive read
 * @param {{formatVersion?: number, copies?: unknown, files?: Record<string, string>}} release  softn-release.json
 */
export function materializeCopies(entries, release) {
  const copies = release?.copies;
  if (release?.formatVersion !== COPIES_FORMAT) {
    if (copies !== undefined) throw new Error(`softn-release.json names copies at formatVersion ${release?.formatVersion}; only formatVersion ${COPIES_FORMAT} has them.`);
    return entries;
  }
  if (!copies || typeof copies !== 'object' || Array.isArray(copies)) throw new Error('softn-release.json formatVersion 2 has no copies object.');
  const filled = new Map(entries);
  for (const [name, from] of Object.entries(copies)) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((s) => s === '..' || s === '' || s === '.')) throw new Error(`softn-release.json names a copy at ${JSON.stringify(name)}, not a name an archive entry can have.`);
    if (typeof from !== 'string' || !from) throw new Error(`softn-release.json copies ${name} from no entry.`);
    if (entries.has(name)) throw new Error(`${name} is stored in the archive and named as a copy of ${from}.`);
    if (!Object.hasOwn(release.files ?? {}, name)) throw new Error(`${name} is named as a copy but softn-release.json does not list it.`);
    if (Object.hasOwn(copies, from)) throw new Error(`${name} is named as a copy of ${from}, which is itself a copy.`);
    const stored = entries.get(from);
    if (!stored || from.endsWith('/')) throw new Error(`${name} is named as a copy of ${from}, which the archive does not store.`);
    filled.set(name, { ...stored });
  }
  return filled;
}
