// node --test apps/formlogic-host/test/seed.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// An app's bundled records are added to its database before it first draws. The
// frame does the order and the reporting; core's own reader and seeder do the
// rest (parseXDBFile, seedXDBBundleData: once, never over the person's own
// records, a removed seed stays removed — packages/@softn/core/test/
// xdb-data-integrity.test.ts holds those). Here they are stand-ins with the same
// contract, since core's bundle module does not load under plain Node, and the
// last test holds the shell to passing core's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedBundledData } from '../src/seed.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** core's parseXDBFile, as far as this test needs: records, or a warning and none. */
function parse(file, content) {
  try { const data = JSON.parse(content); return { collection: data.collection, records: data.records }; }
  catch (error) { return { collection: file, records: [], warning: `${file}: not valid JSON (${error.message}); its records were not loaded` }; }
}
/** core's seedXDBBundleData, as far as this test needs: adds what is not there yet. */
function seed(db, data) {
  let inserted = 0;
  for (const record of data.records) {
    const collection = db.collections.get(data.collection) ?? new Map();
    db.collections.set(data.collection, collection);
    if (!collection.has(record.id)) { collection.set(record.id, record); inserted++; }
  }
  return inserted;
}
const database = () => ({ isReady: Promise.resolve(), collections: new Map() });
const tasks = JSON.stringify({ collection: 'tasks', records: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` })) });

test('the records an app ships with are added before it draws, and not again', async () => {
  const db = database();
  const files = new Map([['xdb/tasks.xdb', tasks]]);
  const manifest = { files: { xdb: ['xdb/tasks.xdb'] } };
  assert.deepEqual(await seedBundledData(files, manifest, db, parse, seed), { inserted: 40, warnings: [] });
  assert.equal(db.collections.get('tasks').get('t7').title, 'Task 7');
  assert.deepEqual(await seedBundledData(files, manifest, db, parse, seed), { inserted: 0, warnings: [] });
  // A path written the way a manifest may write it, from the bundle's root.
  const rooted = database();
  assert.equal((await seedBundledData(files, { files: { xdb: ['./xdb/tasks.xdb'] } }, rooted, parse, seed)).inserted, 40);
});

test('a file that is missing, unreadable or cannot be stored is said and skipped', async () => {
  const db = database();
  const files = new Map([['xdb/broken.xdb', '{ not json'], ['xdb/tasks.xdb', tasks], ['xdb/full.xdb', tasks.replace('"tasks"', '"full"')]]);
  const manifest = { files: { xdb: ['xdb/missing.xdb', 'xdb/broken.xdb', 'xdb/full.xdb', 'xdb/tasks.xdb', 42] } };
  const refusing = (database, data) => {
    if (data.collection === 'full') throw Object.assign(new Error('App storage limit reached'), { name: 'QuotaExceededError' });
    return seed(database, data);
  };
  const outcome = await seedBundledData(files, manifest, db, parse, refusing);
  assert.equal(outcome.inserted, 40, 'the readable, storable file is added whole');
  assert.equal(outcome.warnings.length, 3);
  assert.match(outcome.warnings[0], /^xdb\/missing\.xdb: listed in manifest\.json but not in the app/);
  assert.match(outcome.warnings[1], /xdb\/broken\.xdb: not valid JSON/);
  assert.match(outcome.warnings[2], /^xdb\/full\.xdb: its records could not all be stored \(App storage limit reached\)/);
});

test('an app with no seed files never waits for its database, and a closed frame writes nothing', async () => {
  let waited = false;
  const db = { collections: new Map(), get isReady() { waited = true; return Promise.resolve(); } };
  assert.deepEqual(await seedBundledData(new Map(), {}, db, parse, seed), { inserted: 0, warnings: [] });
  assert.equal(waited, false);
  const closed = database();
  const outcome = await seedBundledData(new Map([['xdb/tasks.xdb', tasks]]), { files: { xdb: ['xdb/tasks.xdb'] } }, closed, parse, seed, () => false);
  assert.equal(outcome.inserted, 0);
  assert.equal(closed.collections.size, 0);
});

test('the shell seeds with core\'s own reader and seeder, into the database the app opens, before it draws', () => {
  const main = fs.readFileSync(path.join(here, '../src/main.tsx'), 'utf8');
  assert.match(main, /import \{[^}]*\bgetXDB\b[^}]*\bparseXDBFile\b[^}]*\bseedXDBBundleData\b[^}]*\} from '@softn\/core'/);
  const seeding = main.indexOf('seedBundledData(files, manifest, getXDB(event.data.appId), parseXDBFile, seedXDBBundleData');
  assert.ok(seeding > 0, 'seeded into the app id SoftNWithXDB is given');
  assert.ok(main.indexOf('appStorage = installAppStorage(') < seeding, 'after the native app\'s storage is in place');
  assert.ok(seeding < main.indexOf('root.render(<Boundary>'), 'before the app draws');
  assert.match(main, /appId=\{event\.data\.appId\}/);
});
