/**
 * IndexedDB in a web container (src/guest-indexeddb.ts).
 *
 * The engine has none; this one is written for the app's side and kept through the Worker,
 * in the embedding page's storage, under the quota everything the app keeps is held to.
 * Here: what a store and an index answer, a transaction that commits by itself and one that
 * is undone, an upgrade, what is still there when the app is opened again, and what the
 * quota refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { GUEST_INDEXEDDB_SOURCE } from '../src/guest-indexeddb';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

/** The helpers every page here uses: a request and a transaction as promises, and a place to report. */
const PRELUDE = `var out = {};
  var done = function () { document.getElementById('out').textContent = JSON.stringify(out); };
  var req = function (r) { return new Promise(function (resolve, reject) { r.onsuccess = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; }); };
  var over = function (tx) { return new Promise(function (resolve, reject) { tx.oncomplete = function () { resolve(); }; tx.onabort = function () { reject(tx.error || new Error('aborted')); }; }); };
  var fail = function (e) { out.failed = String(e && e.name) + ': ' + String(e && e.message); done(); };
  // How far the page has got, for a test that waits on it in vain to say where it stopped.
  setInterval(function () { document.getElementById('out').setAttribute('data-so-far', Object.keys(out).join(',')); }, 200);`;

const page = (script: string) => `<!doctype html><html><body><p id="out">…</p><script>${PRELUDE}\n${script}</script></body></html>`;

async function open(script: string, extra: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    appId: 'indexeddb-test',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source: { 'index.html': page(script) },
    ...extra,
  });
  const result = async (): Promise<Record<string, unknown>> => {
    const reported = () => handle.shadowRoot.querySelector('#out')?.textContent;
    await expect
      .poll(reported, { timeout: 20_000, interval: 20 })
      .not.toBe('…')
      .catch(() => {
        throw new Error(`the page reported nothing; it got as far as: ${handle.shadowRoot.querySelector('#out')?.getAttribute('data-so-far')}; it said: ${said.join(' | ')}`);
      });
    return JSON.parse(reported() ?? '{}') as Record<string, unknown>;
  };
  return { handle, said, result };
}

describe('IndexedDB in a web container', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('keeps no piece of a part under a name that is not one of its databases’ (pieces under any name were kept without a limit)', async () => {
    const { handle, result } = await open(`
      var refused = function (name) { try { host.callSync('idb.write', name, 'x'.repeat(1000), '0', '2'); return 'kept'; } catch (e) { return 'refused'; } };
      out.other = refused('not a part 1');
      out.long = refused('p' + JSON.stringify(['d', 's', 'x'.repeat(2000)]));
      out.part = refused('p' + JSON.stringify(['d', 's', 1]));
      done();`);
    expect(await result()).toEqual({ other: 'refused', long: 'refused', part: 'kept' });
    handle.dispose();
  });

  it('holds a commit’s parts to its room, names and all (removes under long names, never ended, held the Worker’s memory)', async () => {
    const { handle, result } = await open(`
      var tried = function (work) { try { work(); return 'kept'; } catch (e) { return 'refused'; } };
      host.callSync('idb.begin');
      out.longRemove = tried(function () { host.callSync('idb.remove', 'm[' + 'x'.repeat(3000000)); });
      out.shortRemove = tried(function () { host.callSync('idb.remove', 'm["d"]'); });
      host.callSync('idb.end', 'cancel');
      done();`);
    expect(await result()).toEqual({ longRemove: 'refused', shortRemove: 'kept' });
    handle.dispose();
  });

  it('updates a thousand records through an index cursor, and puts ten thousand in one transaction, without stopping the app', async () => {
    // Each write made every index again from all the records, and sorted it; and every request
    // a transaction was asked was answered in one turn. Both took more than a turn has.
    const { handle, said, result } = await open(
      `
      var opening = indexedDB.open('many', 1);
      opening.onupgradeneeded = function () {
        var store = opening.result.createObjectStore('items', { keyPath: 'id' });
        store.createIndex('byGroup', 'group');
        opening.result.createObjectStore('bulk', { autoIncrement: true });
      };
      req(opening).then(async function (db) {
        var fill = db.transaction('items', 'readwrite');
        for (var i = 0; i < 1000; i++) fill.objectStore('items').put({ id: i, group: i % 7, seen: false });
        await over(fill);
        var walk = db.transaction('items', 'readwrite');
        var updated = 0;
        walk.objectStore('items').index('byGroup').openCursor().onsuccess = function (e) {
          var cursor = e.target.result;
          if (!cursor) return;
          var value = cursor.value;
          value.seen = true;
          cursor.update(value);
          updated++;
          cursor.continue();
        };
        await over(walk);
        out.updated = updated;
        out.seen = (await req(db.transaction('items').objectStore('items').index('byGroup').getAll())).filter(function (v) { return v.seen; }).length;
        var bulk = db.transaction('bulk', 'readwrite');
        for (var j = 0; j < 10000; j++) bulk.objectStore('bulk').put({ n: j });
        await over(bulk);
        out.bulk = await req(db.transaction('bulk').objectStore('bulk').count());
        done();
      }).catch(fail);`,
      // A turn's budget of a twelfth of the usual: what one turn takes is what is measured.
      { persistStorage: false, limits: { storageQuotaBytes: 64 * 1024 * 1024, instructionsPerTurn: 8_000_000 } }
    );
    expect(await result()).toEqual({ updated: 1000, seen: 1000, bulk: 10000 });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  }, 60_000);

  it('keeps nothing of a commit the quota refuses, in any store, and nothing of an upgrade undone', async () => {
    // What a refused commit had written was written back a part at a time, and the first part
    // refused again stopped that: a store that was cleared lost all its records, and another
    // kept the write that was undone. And an upgrade that made a store again under its old
    // name, then was undone, deleted the old store's records.
    const { handle, result } = await open(
      `
      var opening = indexedDB.open('kept', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('a'); opening.result.createObjectStore('b'); };
      req(opening).then(async function (db) {
        var fill = db.transaction('a', 'readwrite');
        for (var i = 0; i < 10; i++) fill.objectStore('a').put('record ' + i, i);
        await over(fill);
        var tx = db.transaction(['a', 'b'], 'readwrite');
        tx.objectStore('a').clear();
        tx.objectStore('b').put(new Array(40000).join('x'), 'large');
        out.refused = await new Promise(function (resolve) { tx.onabort = function () { resolve(tx.error && tx.error.name); }; tx.oncomplete = function () { resolve('kept'); }; });
        db.close();
        // Read again from what is kept: nothing of the refused commit is there.
        __softnIdbChanged('s' + JSON.stringify(['kept', 'a']));
        __softnIdbChanged('s' + JSON.stringify(['kept', 'b']));
        var again = await req(indexedDB.open('kept', 1));
        out.a = await req(again.transaction('a').objectStore('a').count());
        out.b = await req(again.transaction('b').objectStore('b').count());
        again.close();
        // An upgrade that deletes a store and makes it again, then is undone.
        var upgrading = indexedDB.open('kept', 2);
        upgrading.onupgradeneeded = function () {
          var up = upgrading.result;
          up.deleteObjectStore('a');
          up.createObjectStore('a').put('new', 'only');
          upgrading.transaction.abort();
        };
        out.upgrade = await new Promise(function (resolve) { upgrading.onerror = function () { resolve(upgrading.error && upgrading.error.name); }; upgrading.onsuccess = function () { resolve('upgraded'); }; });
        __softnIdbChanged('s' + JSON.stringify(['kept', 'a']));
        var last = await req(indexedDB.open('kept'));
        out.version = last.version;
        out.after = await req(last.transaction('a').objectStore('a').count());
        done();
      }).catch(fail);`,
      { limits: { storageQuotaBytes: 40_000 } }
    );
    expect(await result()).toEqual({ refused: 'QuotaExceededError', a: 10, b: 0, upgrade: 'AbortError', version: 1, after: 10 });
    handle.dispose();
  });

  it('is complete only once the page has kept it: refused by the page, it is undone, and says so', async () => {
    // The transaction said it was complete before the page had written it; a write the page's
    // storage then refused (full, or closed to the page) was lost, and the app never knew.
    const { handle, said, result } = await open(`
      var db;
      var opening = indexedDB.open('refused', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
      req(opening).then(async function (opened) {
        db = opened;
        var first = db.transaction('s', 'readwrite');
        first.objectStore('s').put('kept', 'a');
        await over(first);
        out.ready = true;
        done();
      }).catch(fail);
      document.addEventListener('click', async function () {
        var tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put('lost', 'a');
        out.write = await new Promise(function (resolve) { tx.oncomplete = function () { resolve('complete'); }; tx.onabort = function () { resolve(tx.error && tx.error.name); }; });
        // A transaction that writes nothing is complete, whatever became of another's write.
        var reading = db.transaction('s');
        var got = reading.objectStore('s').get('a');
        out.read = await new Promise(function (resolve) { reading.oncomplete = function () { resolve('complete ' + got.result); }; reading.onabort = function () { resolve(reading.error && reading.error.name); }; });
        out.after = await req(db.transaction('s').objectStore('s').get('a'));
        done();
      });`);
    expect(await result()).toEqual({ ready: true });
    // The page's storage is full from here on.
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key.includes('idb:')) throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
    try {
      handle.shadowRoot.querySelector('#out')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      await expect.poll(() => handle.shadowRoot.querySelector('#out')?.textContent ?? '').toContain('"after"');
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(JSON.parse(handle.shadowRoot.querySelector('#out')!.textContent!)).toMatchObject({ write: 'QuotaExceededError', read: 'complete kept', after: 'kept' });
    expect(said.some((line) => line.includes('could not be kept'))).toBe(true);
    handle.dispose();
  });

  it('keeps an object store larger than the bridge carries at once, and reads it back', async () => {
    // A store is kept as one text, and the bridge carries 4 million characters from the app
    // at once (and 16 MB of JSON to it): a store of more than a few megabytes was never kept.
    const { handle, said, result } = await open(
      `
      var opening = indexedDB.open('big', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('rows'); };
      req(opening).then(async function (db) {
        var long = new Array(7000001).join('z');
        var tx = db.transaction('rows', 'readwrite');
        tx.objectStore('rows').put(long, 'long');
        tx.objectStore('rows').put('short', 'short');
        out.kept = await new Promise(function (resolve) { tx.onabort = function () { resolve(tx.error && tx.error.name); }; tx.oncomplete = function () { resolve('kept'); }; });
        // Read again from what is kept, as another tab's write has it read.
        __softnIdbChanged('s' + JSON.stringify(['big', 'rows']));
        var back = await req(db.transaction('rows').objectStore('rows').get('long'));
        out.length = back.length;
        out.same = back === long;
        out.short = await req(db.transaction('rows').objectStore('rows').get('short'));
        done();
      }).catch(fail);`,
      { persistStorage: false, limits: { storageQuotaBytes: 64 * 1024 * 1024 } }
    );
    expect(await result()).toEqual({ kept: 'kept', length: 7_000_000, same: true, short: 'short' });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('keeps records in stores and finds them by key, by range, by index and with a cursor, in transactions that commit by themselves or are undone', async () => {
    const { handle, said, result } = await open(`
      var opening = indexedDB.open('notes', 1);
      opening.onupgradeneeded = function (e) {
        out.upgrade = e.oldVersion + '>' + e.newVersion + ':' + (e instanceof IDBVersionChangeEvent) + ':' + (opening.transaction.mode);
        var db = opening.result;
        var store = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
        store.createIndex('byTag', 'tags', { multiEntry: true });
        store.createIndex('byTitle', 'title', { unique: true });
        db.createObjectStore('kv');
      };
      req(opening).then(async function (db) {
        out.stores = Array.from(db.objectStoreNames).join(',') + ':' + db.version + ':' + db.objectStoreNames.contains('kv') + ':' + (db instanceof IDBDatabase);
        var tx = db.transaction(['notes', 'kv'], 'readwrite');
        var notes = tx.objectStore('notes');
        out.same = notes === tx.objectStore('notes') && notes instanceof IDBObjectStore && notes.keyPath === 'id' && notes.autoIncrement;
        var live = { title: 'one', tags: ['x', 'y'], when: new Date(5), nested: { n: [1, 2, undefined] } };
        var first = notes.add(live);
        // What is kept is the value as it was when it was put.
        live.title = 'changed after';
        var a = await req(first);
        var b = await req(notes.add({ title: 'two', tags: ['y'] }));
        var c = await req(notes.put({ id: 10, title: 'ten', tags: [] }));
        var d = await req(notes.add({ title: 'after ten', tags: ['z'] }));
        out.keys = [a, b, c, d].join(',');
        await req(tx.objectStore('kv').put(new Map([['k', new Set([1])]]), 'map'));
        await req(tx.objectStore('kv').put(new Uint8Array([1, 2, 3]).buffer, [1, 'a']));
        await over(tx);

        var read = db.transaction('notes');
        var store = read.objectStore('notes');
        var one = await req(store.get(1));
        out.one = [one.title, one.id, one.when instanceof Date && one.when.getTime(), JSON.stringify(one.nested), 2 in one.nested.n].join('|');
        out.missing = String(await req(store.get(99)));
        out.count = await req(store.count());
        out.all = (await req(store.getAll(IDBKeyRange.bound(2, 10)))).map(function (n) { return n.title; }).join(',');
        out.limited = (await req(store.getAll(null, 2))).length;
        out.keysIn = (await req(store.getAllKeys(IDBKeyRange.lowerBound(2, true)))).join(',');
        var byTag = store.index('byTag');
        out.index = [byTag instanceof IDBIndex, byTag.multiEntry, byTag.unique, byTag.keyPath, Array.from(store.indexNames).join('+')].join('|');
        out.byTag = (await req(byTag.getAll('y'))).map(function (n) { return n.title; }).join(',');
        out.tagCount = await req(byTag.count());
        out.byTitle = (await req(store.index('byTitle').get('ten'))).id;
        out.titleKey = await req(store.index('byTitle').getKey('two'));
        var seen = [];
        await new Promise(function (resolve) {
          var r = store.openCursor(null, 'prev');
          r.onsuccess = function () { var cursor = r.result; if (!cursor) return resolve(); seen.push(cursor.key + ':' + cursor.value.title + ':' + (cursor instanceof IDBCursorWithValue)); cursor.continue(); };
        });
        out.prev = seen.join(',');
        var tagged = [];
        await new Promise(function (resolve) {
          var r = byTag.openKeyCursor(IDBKeyRange.only('y'));
          r.onsuccess = function () { var cursor = r.result; if (!cursor) return resolve(); tagged.push(cursor.key + '>' + cursor.primaryKey + ':' + ('value' in cursor)); cursor.continue(); };
        });
        out.tagCursor = tagged.join(',');
        var skipped = [];
        await new Promise(function (resolve) {
          var r = store.openCursor();
          var moves = 0;
          // Two places on, then to a key named, then on to the end. A key that is not further on is refused.
          r.onsuccess = function () {
            var cursor = r.result;
            if (!cursor) return resolve();
            skipped.push(cursor.key);
            moves++;
            if (moves === 1) cursor.advance(2);
            else if (moves === 2) cursor.continue(11);
            else { try { cursor.continue(11); } catch (e) { skipped.push(e.name); } cursor.continue(); }
          };
        });
        out.skipped = skipped.join(',');
        out.readOnly = (function () { try { store.put({ title: 'x' }); return 'put'; } catch (e) { return e.name; } })();
        await over(read);
        out.finished = (function () { try { read.objectStore('notes'); return 'ok'; } catch (e) { return e.name; } })();

        // A title twice in an index that takes each once: the request fails, and the
        // transaction goes on when the app says it may.
        var tx2 = db.transaction('notes', 'readwrite');
        var twice = tx2.objectStore('notes').add({ title: 'one', tags: [] });
        out.twice = await new Promise(function (resolve) { twice.onerror = function (e) { e.preventDefault(); resolve(twice.error.name); }; });
        await req(tx2.objectStore('notes').delete(2));
        await over(tx2);

        // Undone: nothing of it is there afterwards.
        var tx3 = db.transaction('notes', 'readwrite');
        tx3.objectStore('notes').clear();
        tx3.objectStore('notes').add({ title: 'gone', tags: [] });
        var undone = new Promise(function (resolve) { tx3.onabort = function () { resolve('aborted:' + (tx3.error === null)); }; });
        tx3.abort();
        out.abort = await undone;
        // And undone by a request that fails with nobody to say otherwise.
        var tx4 = db.transaction('notes', 'readwrite');
        tx4.objectStore('notes').add({ title: 'kept until the next one fails', tags: [] });
        tx4.objectStore('notes').add({ title: 'ten', tags: [] });
        out.failedTx = await new Promise(function (resolve) { tx4.onabort = function () { resolve(tx4.error && tx4.error.name); }; tx4.oncomplete = function () { resolve('completed'); }; });
        out.after = (await req(db.transaction('notes').objectStore('notes').getAllKeys())).join(',');

        var kv = db.transaction('kv').objectStore('kv');
        var map = await req(kv.get('map'));
        var buffer = await req(kv.get([1, 'a']));
        out.kv = [map instanceof Map, map.get('k') instanceof Set, map.get('k').has(1), buffer instanceof ArrayBuffer, new Uint8Array(buffer).join('')].join('|');
        out.noKey = (function () { try { db.transaction('kv', 'readwrite').objectStore('kv').put('no key given'); return 'put'; } catch (e) { return e.name; } })();
        out.badKey = (function () { try { IDBKeyRange.only({}); return 'made'; } catch (e) { return e.name; } })();
        out.cmp = [indexedDB.cmp(1, 'a'), indexedDB.cmp([1], [1, 0]), indexedDB.cmp(new Date(1), 5), indexedDB.cmp('b', 'a'), indexedDB.cmp(2, 2)].join(',');
        done();
      }).catch(fail);`);
    expect(await result()).toEqual({
      upgrade: '0>1:true:versionchange',
      stores: 'kv,notes:1:true:true',
      same: true,
      keys: '1,2,10,11',
      one: 'one|1|5|{"n":[1,2,null]}|true',
      missing: 'undefined',
      count: 4,
      all: 'two,ten',
      limited: 2,
      keysIn: '10,11',
      index: 'true|true|false|tags|byTag+byTitle',
      byTag: 'one,two',
      tagCount: 4,
      byTitle: 10,
      titleKey: 2,
      prev: '11:after ten:true,10:ten:true,2:two:true,1:one:true',
      tagCursor: 'y>1:false,y>2:false',
      skipped: '1,10,11,DataError',
      readOnly: 'ReadOnlyError',
      finished: 'InvalidStateError',
      twice: 'ConstraintError',
      abort: 'aborted:true',
      failedTx: 'ConstraintError',
      after: '1,10,11',
      kv: 'true|true|true|true|123',
      noKey: 'DataError',
      badKey: 'DataError',
      cmp: '-1,-1,1,1,0',
    });
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('is there when the app is opened again, and is upgraded with what it holds', async () => {
    const first = await open(`
      var opening = indexedDB.open('library', 2);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('books', { keyPath: 'isbn' }); };
      req(opening).then(async function (db) {
        var tx = db.transaction('books', 'readwrite');
        tx.objectStore('books').put({ isbn: 'b', title: 'Second', year: 1999 });
        tx.objectStore('books').put({ isbn: 'a', title: 'First', year: 2005, cover: new Blob(['png'], { type: 'image/png' }) });
        await over(tx);
        out.kept = (await req(db.transaction('books').objectStore('books').getAllKeys())).join(',');
        done();
      }).catch(fail);`);
    expect(await first.result()).toEqual({ kept: 'a,b' });
    first.handle.dispose();

    // Opened again: the same app, a new page and a new Worker. A newer version adds an index
    // over the records already there.
    const second = await open(`
      indexedDB.databases().then(function (list) { out.listed = list.map(function (d) { return d.name + ':' + d.version; }).join(','); });
      var lower = indexedDB.open('library', 1);
      lower.onerror = function (e) {
        e.preventDefault();
        out.lower = lower.error.name;
        var opening = indexedDB.open('library', 3);
        opening.onupgradeneeded = function (e) {
          out.upgrade = e.oldVersion + '>' + e.newVersion;
          var books = opening.transaction.objectStore('books');
          books.createIndex('byYear', 'year');
          opening.result.createObjectStore('shelves', { autoIncrement: true });
        };
        req(opening).then(async function (db) {
          var books = db.transaction('books').objectStore('books');
          out.byYear = (await req(books.index('byYear').getAll())).map(function (b) { return b.year + ' ' + b.title; }).join(', ');
          var first = await req(books.get('a'));
          out.cover = [first.cover instanceof Blob, first.cover.type, await first.cover.text()].join('|');
          out.stores = Array.from(db.objectStoreNames).join(',');
          // The name with no version opens what is there.
          db.close();
          var again = await req(indexedDB.open('library'));
          out.again = again.version;
          again.close();
          await req(indexedDB.deleteDatabase('library'));
          out.deleted = (await indexedDB.databases()).length;
          done();
        }).catch(fail);
      };`);
    expect(await second.result()).toEqual({
      listed: 'library:2',
      lower: 'VersionError',
      upgrade: '2>3',
      byYear: '1999 Second, 2005 First',
      cover: 'true|image/png|png',
      stores: 'books,shelves',
      again: 3,
      deleted: 0,
    });
    second.handle.dispose();
    // Deleted: nothing of it is left in the page's storage either.
    expect(Object.keys(localStorage).filter((key) => key.includes('idb:'))).toEqual([]);
  });

  it('is held to the quota with everything else the app keeps: a transaction past it is undone, and says so', async () => {
    const SCRIPT = `
      var opening = indexedDB.open('big', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('rows'); };
      req(opening).then(async function (db) {
        var small = db.transaction('rows', 'readwrite');
        small.objectStore('rows').put('fits', 'small');
        await over(small);
        var tx = db.transaction('rows', 'readwrite');
        tx.objectStore('rows').put(new Array(40000).join('x'), 'large');
        out.large = await new Promise(function (resolve) { tx.onabort = function () { resolve(tx.error && tx.error.name); }; tx.oncomplete = function () { resolve('kept'); }; });
        out.after = (await req(db.transaction('rows').objectStore('rows').getAllKeys())).join(',');
        // What the app keeps another way shares the quota.
        try { localStorage.setItem('more', new Array(40000).join('y')); out.local = 'kept'; } catch (e) { out.local = 'refused'; }
        done();
      }).catch(fail);`;
    const { handle, result } = await open(SCRIPT, { limits: { storageQuotaBytes: 40_000 } });
    expect(await result()).toEqual({ large: 'QuotaExceededError', after: 'small', local: 'refused' });
    handle.dispose();
    // What the page kept is what the app was told it kept.
    // Its description, its store's list of pages, and the store's one page.
    const kept = Object.keys(localStorage).filter((key) => key.includes('idb:'));
    expect(kept.length).toBe(3);
    expect(kept.map((key) => localStorage.getItem(key) ?? '').join('').length).toBeLessThan(1000);
  });
});

describe('IndexedDB transactions, as a browser runs them', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('runs two that write a store one after the other, so that one undone takes back only its own', async () => {
    // Side by side, the second's write was taken back by the first's undoing, though the
    // second had said it was complete; the other way about, the first's undone write was kept.
    const { handle, said, result } = await open(`
      var opening = indexedDB.open('turns', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); opening.result.createObjectStore('t'); };
      req(opening).then(async function (db) {
        var order = [];
        var a = db.transaction('s', 'readwrite');
        var b = db.transaction('s', 'readwrite');
        var r = db.transaction('s');
        // A store no other writes: not held up by them.
        var other = db.transaction('t', 'readwrite');
        a.objectStore('s').put('A1', 'a').onsuccess = function () {
          order.push('a wrote');
          Promise.resolve().then(function () { a.objectStore('s').put('A2', 'a2').onsuccess = function () { order.push('a undoes'); a.abort(); }; });
        };
        b.objectStore('s').put('B1', 'b').onsuccess = function () { order.push('b wrote'); };
        r.objectStore('s').getAllKeys().onsuccess = function (e) { order.push('r read ' + e.target.result.join('+')); };
        other.objectStore('t').put('T1', 't').onsuccess = function () { order.push('t wrote'); };
        await Promise.all([
          new Promise(function (resolve) { a.onabort = function () { order.push('a undone'); resolve(); }; }),
          new Promise(function (resolve) { b.oncomplete = function () { order.push('b complete'); resolve(); }; }),
          new Promise(function (resolve) { r.oncomplete = resolve; }),
          new Promise(function (resolve) { other.oncomplete = resolve; }),
        ]);
        out.order = order.filter(function (step) { return step !== 't wrote'; }).join(', ');
        // The other store's transaction ran beside a, not after it.
        out.otherBeside = order.indexOf('t wrote') >= 0 && order.indexOf('t wrote') < order.indexOf('a undone');
        out.after = (await req(db.transaction('s').objectStore('s').getAllKeys())).join(',');
        // Undone by abort(): the event comes in a task of its own, so a handler set after the call is heard.
        var tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put('gone', 'gone');
        tx.abort();
        out.abortHeard = await new Promise(function (resolve) { tx.onabort = function () { resolve('heard'); }; setTimeout(function () { resolve('not heard'); }, 1000); });
        done();
      }).catch(fail);`);
    const reported = await result();
    expect(reported).toEqual({
      order: 'a wrote, a undoes, a undone, b wrote, b complete, r read b',
      otherBeside: true,
      after: 'b',
      abortHeard: 'heard',
    });
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
    // What is kept for the next visit is what the app was told: b's record, and not a's.
    const kept = Object.entries(localStorage).filter(([key]) => key.endsWith('idb:p["turns","s",1]'));
    expect(kept.length).toBe(1);
    expect(kept[0][1]).toContain('B1');
    expect(kept[0][1]).not.toContain('A1');
  });

  it('answers from an index made again under the same name by its new rule', async () => {
    // Dexie does this when an index's flags change. The keys each record has in an index were
    // kept under the index's name, and the new index answered from the old one's.
    const { handle, result } = await open(`
      var first = indexedDB.open('again', 1);
      first.onupgradeneeded = function () { first.result.createObjectStore('s', { keyPath: 'id' }).createIndex('tags', 'tags'); };
      req(first).then(async function (db) {
        await req(db.transaction('s', 'readwrite').objectStore('s').put({ id: 1, tags: ['x', 'y'] }));
        out.whole = (await req(db.transaction('s').objectStore('s').index('tags').getAll(['x', 'y']))).length;
        db.close();
        var second = indexedDB.open('again', 2);
        second.onupgradeneeded = function () {
          var s = second.transaction.objectStore('s');
          s.deleteIndex('tags');
          s.createIndex('tags', 'tags', { multiEntry: true });
        };
        var db2 = await req(second);
        out.each = (await req(db2.transaction('s').objectStore('s').index('tags').getAll('x'))).map(function (r) { return r.id; }).join(',');
        done();
      }).catch(fail);`);
    expect(await result()).toEqual({ whole: 1, each: '1' });
    handle.dispose();
  });

  it('finishes a save made just before the app is hidden, while it is hidden', async () => {
    // Its turns were the app's own timers, which wait while the app is not shown: the save
    // waited too, and was lost if the app was closed before it was shown again.
    const { handle, result } = await open(
      `var db;
      var opening = indexedDB.open('hidden', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
      req(opening).then(function (opened) { db = opened; out.ready = true; done(); });
      document.addEventListener('click', function () {
        db.transaction('s', 'readwrite').objectStore('s').put('kept while hidden', 'note');
        setTimeout(function () { document.body.setAttribute('data-timer', 'ran'); }, 0);
      });`
    );
    expect(await result()).toEqual({ ready: true });
    handle.shadowRoot.querySelector('#out')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    handle.setActive(false);
    const kept = () => Object.entries(localStorage).some(([key, value]) => key.endsWith('idb:p["hidden","s",1]') && value.includes('kept while hidden'));
    await expect.poll(kept, { timeout: 5_000 }).toBe(true);
    // The app's own timer still waits for it to be shown.
    expect(handle.shadowRoot.querySelector('[data-timer]')).toBeNull();
    handle.setActive(true);
    await expect.poll(() => handle.shadowRoot.querySelector('[data-timer]')?.getAttribute('data-timer')).toBe('ran');
    handle.dispose();
  });

  it('leaves nothing of a database the quota refused to make', async () => {
    // The upgrade's first store was kept, its second refused: the first stayed kept for good,
    // out of the database's description, and was not taken away when the database was deleted.
    const { handle, result } = await open(
      `var opening = indexedDB.open('toobig', 1);
      opening.onupgradeneeded = function () {
        opening.result.createObjectStore('a').put(new Array(12000).join('x'), 1);
        opening.result.createObjectStore('b').put(new Array(12000).join('y'), 1);
      };
      opening.onsuccess = function () { out.open = 'opened'; done(); };
      opening.onerror = function (e) {
        e.preventDefault();
        out.open = opening.error.name;
        indexedDB.databases().then(function (list) { out.listed = list.length; done(); });
      };`,
      { limits: { storageQuotaBytes: 40_000 } }
    );
    expect(await result()).toEqual({ open: 'AbortError', listed: 0 });
    handle.dispose();
    expect(Object.keys(localStorage).filter((key) => key.includes('idb:'))).toEqual([]);
  });
});

describe('what an app keeps, held to its quota whatever it names it', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('counts a key named __proto__ when the app is opened again', async () => {
    // Read back into a plain object, a key named __proto__ was not the object's own: it was
    // not counted, and the app could keep as much again under other names.
    const limits = { limits: { storageQuotaBytes: 40_000 } };
    const first = await open(`localStorage.setItem('__proto__', new Array(15000).join('p')); out.first = localStorage.getItem('__proto__').length; done();`, limits);
    expect(await first.result()).toEqual({ first: 14999 });
    first.handle.dispose();
    const second = await open(
      `out.proto = String(localStorage.getItem('__proto__')).length;
      try { localStorage.setItem('other', new Array(15000).join('o')); out.other = 'kept'; } catch (e) { out.other = 'refused'; }
      done();`,
      limits
    );
    expect(await second.result()).toEqual({ proto: 14999, other: 'refused' });
    second.handle.dispose();
  });

  it('keeps only the names IndexedDB writes when the app writes through the bridge itself', async () => {
    const { handle, result } = await open(`
      try { host.callSync('idb.write', '__proto__', 'x'); out.odd = 'kept'; } catch (e) { out.odd = 'refused'; }
      try { host.callSync('idb.write', 'ls:theirs', 'x'); out.other = 'kept'; } catch (e) { out.other = 'refused'; }
      done();`);
    expect(await result()).toEqual({ odd: 'refused', other: 'refused' });
    handle.dispose();
    expect(Object.keys(localStorage).filter((key) => key.includes('idb:'))).toEqual([]);
  });
});

describe('the same app open in another tab', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('reads what the other tab kept before it writes over it', async () => {
    // Each tab kept the stores it read when it started: what one wrote, the other wrote away.
    const { handle, result } = await open(`
      var db;
      var opening = indexedDB.open('shared', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
      req(opening).then(async function (opened) {
        db = opened;
        await req(db.transaction('s', 'readwrite').objectStore('s').put('A', 'a'));
        out.ready = true;
        done();
      }).catch(fail);
      document.addEventListener('click', async function () {
        out.seen = (await req(db.transaction('s').objectStore('s').getAllKeys())).join(',');
        await req(db.transaction('s', 'readwrite').objectStore('s').put('C', 'c'));
        out.after = (await req(db.transaction('s').objectStore('s').getAllKeys())).join(',');
        done();
      });`);
    expect(await result()).toEqual({ ready: true });
    // The other tab: it read what this one kept, added a record, and kept the store again.
    const key = Object.keys(localStorage).find((name) => name.endsWith('idb:p["shared","s",1]'))!;
    const before = localStorage.getItem(key)!;
    const kept = JSON.parse(before) as Array<[unknown, string]>;
    kept.push(['b', JSON.stringify('B')]);
    const written = JSON.stringify(kept);
    localStorage.setItem(key, written);
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: before, newValue: written, storageArea: localStorage }));
    handle.shadowRoot.querySelector('#out')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    await expect.poll(() => handle.shadowRoot.querySelector('#out')?.textContent ?? '').toContain('"after"');
    expect(JSON.parse(handle.shadowRoot.querySelector('#out')!.textContent!)).toMatchObject({ seen: 'a,b', after: 'a,b,c' });
    expect(JSON.parse(localStorage.getItem(key)!).map((row: [unknown, string]) => row[0])).toEqual(['a', 'b', 'c']);
    handle.dispose();
  });

  it('keeps what the other tab wrote while a transaction here was using the store, with the transaction’s own over it', async () => {
    // The IndexedDB layer by itself, with a host that keeps its parts in a map: the other
    // tab's write is made at an exact moment, inside a transaction.
    const kept = new Map<string, string>();
    const host = {
      callSync(kind: string, ...args: string[]) {
        if (kind === 'idb.keys') return [...kept.keys()];
        if (kind === 'idb.read') return kept.get(args[0]) ?? null;
        if (kind === 'idb.write') return kept.set(args[0], args[1]) && true;
        if (kind === 'idb.remove') return kept.delete(args[0]);
        if (kind === 'idb.begin' || kind === 'idb.end') return true;
        throw new Error(kind);
      },
      call(_kind: string, _args: unknown[], answer: (value: unknown) => void) {
        setTimeout(() => answer({ ok: true }), 0);
      },
    };
    const scope = vm.createContext({ host, setTimeout, clearTimeout, console });
    vm.runInContext(GUEST_INDEXEDDB_SOURCE, scope);
    const outcome = await vm.runInContext(
      `new Promise(function (resolve, reject) {
        var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
        var opening = indexedDB.open('tabs', 1);
        opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
        req(opening).then(async function (db) {
          var first = db.transaction('s', 'readwrite');
          first.objectStore('s').put('mine', 'gone');
          first.objectStore('s').put('mine', 'kept');
          await new Promise(function (ok) { first.oncomplete = ok; });
          var tx = db.transaction('s', 'readwrite');
          var store = tx.objectStore('s');
          store.delete('gone');
          store.put('x', 'x').onsuccess = function () {
            // The other tab, now: it adds a record and keeps the store.
            var name = 'p' + JSON.stringify(['tabs', 's', 1]);
            var theirs = JSON.parse(host.callSync('idb.read', name));
            theirs.push(['theirs', JSON.stringify('t')]);
            theirs.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
            host.callSync('idb.write', name, JSON.stringify(theirs));
            __softnIdbChanged(name);
            store.put('y', 'y');
          };
          await new Promise(function (ok) { tx.oncomplete = ok; });
          resolve((await req(db.transaction('s').objectStore('s').getAllKeys())).join(','));
        }).catch(reject);
      })`,
      scope
    );
    expect(outcome).toBe('kept,theirs,x,y');
    expect(JSON.parse(kept.get('p' + JSON.stringify(['tabs', 's', 1]))!).map((row: [string]) => row[0])).toEqual(['kept', 'theirs', 'x', 'y']);
  });

  /** The IndexedDB layer by itself, in a context of its own, with a host that keeps its parts in `kept`. */
  /** The IndexedDB layer by itself, in a context of its own, with a host that keeps its parts in `kept` (and answers its calls by `onCall`, when given). */
  function layer(kept: Map<string, string>, onCall?: (kind: string, args: unknown[], answer: (value: unknown) => void, scope: vm.Context) => void) {
    const host = {
      callSync(kind: string, ...args: string[]) {
        if (kind === 'idb.keys') return [...kept.keys()];
        if (kind === 'idb.read') return kept.get(args[0]) ?? null;
        if (kind === 'idb.write') return kept.set(args[0], args[1]) && true;
        if (kind === 'idb.remove') return kept.delete(args[0]);
        if (kind === 'idb.begin' || kind === 'idb.end') return true;
        throw new Error(kind);
      },
      call(kind: string, args: unknown[], answer: (value: unknown) => void) {
        if (onCall) onCall(kind, args, answer, scope);
        else setTimeout(() => answer({ ok: true }), 0);
      },
    };
    const scope = vm.createContext({ host, setTimeout, clearTimeout, console });
    vm.runInContext(GUEST_INDEXEDDB_SOURCE, scope);
    return (script: string) => vm.runInContext(script, scope) as Promise<unknown>;
  }

  it('keeps a store as pages: what is read back is what was written, through splits and pages left empty, and a commit writes only what it changed', async () => {
    // Kept as one text, every commit wrote all of a store: a record put into a store of forty
    // thousand took a fifth of a second. Kept as pages, a commit writes the pages it changed.
    const kept = new Map<string, string>();
    const commits: string[][] = [];
    let writing: string[] | null = null;
    const host = {
      callSync(kind: string, ...args: string[]) {
        if (kind === 'idb.keys') return [...kept.keys()];
        if (kind === 'idb.read') return kept.get(args[0]) ?? null;
        if (kind === 'idb.write') { writing?.push(args[0]); return kept.set(args[0], args[1]) && true; }
        if (kind === 'idb.remove') { writing?.push(`-${args[0]}`); return kept.delete(args[0]); }
        if (kind === 'idb.begin') { writing = []; return true; }
        if (kind === 'idb.end') { if (writing) commits.push(writing); writing = null; return true; }
        throw new Error(kind);
      },
      call(_kind: string, _args: unknown[], answer: (value: unknown) => void) {
        setTimeout(() => answer({ ok: true }), 0);
      },
    };
    const scope = vm.createContext({ host, setTimeout, clearTimeout, console });
    vm.runInContext(GUEST_INDEXEDDB_SOURCE, scope);
    const outcome = await vm.runInContext(
      `new Promise(async function (resolve, reject) {
        try {
          var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
          var over = function (tx) { return new Promise(function (ok, no) { tx.oncomplete = ok; tx.onabort = function () { no(tx.error); }; }); };
          var opening = indexedDB.open('fuzz', 1);
          opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
          var db = await req(opening);
          var model = new Map();
          var seed = 7;
          var rnd = function (n) { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
          var list = 's' + JSON.stringify(['fuzz', 's']);
          for (var round = 0; round < 40; round++) {
            var tx = db.transaction('s', 'readwrite');
            var s = tx.objectStore('s');
            var op = rnd(10);
            if (op < 5) {
              var count = 1 + rnd(round < 6 ? 900 : 80);
              for (var i = 0; i < count; i++) { var k = rnd(6000); var v = 'v' + round + '-' + i; s.put(v, k); model.set(k, v); }
            } else if (op < 8) {
              var lo = rnd(6000); var hi = lo + rnd(600);
              s.delete(IDBKeyRange.bound(lo, hi));
              Array.from(model.keys()).forEach(function (key) { if (key >= lo && key <= hi) model.delete(key); });
            } else if (op === 8) {
              var one = rnd(6000); s.delete(one); model.delete(one);
            } else if (rnd(3) === 0) { s.clear(); model.clear(); }
            await over(tx);
            // Read again from what is kept, now and then, as another tab's write has it read.
            if (round % 7 === 6) __softnIdbChanged(list);
          }
          __softnIdbChanged(list);
          var keys = await req(db.transaction('s').objectStore('s').getAllKeys());
          var values = await req(db.transaction('s').objectStore('s').getAll());
          var want = Array.from(model.keys()).sort(function (a, b) { return a - b; });
          var same = keys.length === want.length && keys.every(function (k, i) { return k === want[i] && values[i] === model.get(k); });
          // A store of some thousands, and one record put into it.
          var fill = db.transaction('s', 'readwrite');
          for (var f = 0; f < 3000; f++) fill.objectStore('s').put('fill', 10000 + f);
          await over(fill);
          var single = db.transaction('s', 'readwrite');
          single.objectStore('s').put('one more', 11500);
          await over(single);
          resolve({ same: same, count: keys.length, listed: JSON.parse(host.callSync('idb.read', list)).p.map(function (page) { return page[0]; }) });
        } catch (e) { reject(e); }
      })`,
      scope
    );
    const { same, count, listed } = outcome as { same: boolean; count: number; listed: number[] };
    expect(same).toBe(true);
    expect(count).toBeGreaterThan(0);
    // Every page listed is kept, and none is kept that is not listed.
    const pages = [...kept.keys()].filter((name) => name.startsWith('p')).map((name) => JSON.parse(name.slice(1))[2] as number).sort((a, b) => a - b);
    expect(pages).toEqual([...listed].sort((a, b) => a - b));
    expect(listed.length).toBeGreaterThan(10);
    // The last commit wrote one page and the list.
    expect(commits[commits.length - 1].length).toBe(2);
  });

  it('keeps every record after a refused commit that emptied a page, and a commit after it', async () => {
    // A refused commit had laid its store out again (a page emptied and let go of); undone, its
    // records were back in memory under the new layout, and the next commit wrote that layout
    // over what was kept: the records the refused commit had deleted were gone for good.
    const kept = new Map<string, string>();
    let staged: Map<string, string | null> | null = null;
    const host = {
      callSync(kind: string, ...args: string[]) {
        if (kind === 'idb.keys') return [...kept.keys()];
        if (kind === 'idb.read') return kept.get(args[0]) ?? null;
        if (kind === 'idb.write') { if (staged) staged.set(args[0], args[1]); else kept.set(args[0], args[1]); return true; }
        if (kind === 'idb.remove') { if (staged) staged.set(args[0], null); else kept.delete(args[0]); return true; }
        if (kind === 'idb.begin') { staged = new Map(); return true; }
        if (kind === 'idb.end') {
          const batch = staged;
          staged = null;
          if (!batch || args[0] === 'cancel') return true;
          // The quota: no part of more than 100,000 characters.
          for (const value of batch.values()) if (value !== null && value.length > 100_000) throw new Error('QuotaExceededError');
          for (const [name, value] of batch) { if (value === null) kept.delete(name); else kept.set(name, value); }
          return true;
        }
        throw new Error(kind);
      },
      call(_kind: string, _args: unknown[], answer: (value: unknown) => void) {
        setTimeout(() => answer({ ok: true }), 0);
      },
    };
    const scope = vm.createContext({ host, setTimeout, clearTimeout, console });
    vm.runInContext(GUEST_INDEXEDDB_SOURCE, scope);
    const outcome = await vm.runInContext(
      `new Promise(async function (resolve, reject) {
        try {
          var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
          var over = function (tx) { return new Promise(function (ok) { tx.oncomplete = function () { ok('complete'); }; tx.onabort = function () { ok(tx.error && tx.error.name); }; }); };
          var opening = indexedDB.open('layout', 1);
          opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); opening.result.createObjectStore('big'); };
          var db = await req(opening);
          var fill = db.transaction('s', 'readwrite');
          for (var i = 1; i <= 1000; i++) fill.objectStore('s').put('v' + i, i);
          await over(fill);
          var refused = db.transaction(['s', 'big'], 'readwrite');
          refused.objectStore('s').delete(IDBKeyRange.bound(251, 500));
          refused.objectStore('big').put(new Array(200001).join('x'), 1);
          var said = await over(refused);
          var later = db.transaction('s', 'readwrite');
          later.objectStore('s').put('changed', 900);
          await over(later);
          // Read again from what is kept, as another tab would.
          __softnIdbChanged('s' + JSON.stringify(['layout', 's']));
          var count = await req(db.transaction('s').objectStore('s').count());
          var middle = await req(db.transaction('s').objectStore('s').get(300));
          resolve([said, count, middle].join('|'));
        } catch (e) { reject(e); }
      })`,
      scope
    );
    expect(outcome).toBe('QuotaExceededError|1000|v300');
  });

  it('deletes a database once the transactions of a closed connection are done, and keeps nothing of it after', async () => {
    // The deletion went on while a transaction of a connection closed just before was still
    // writing: it wrote after the deletion, and its parts stayed kept, described by nothing.
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var said = [];
      var opening = indexedDB.open('d', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
      opening.onsuccess = function () {
        var db = opening.result;
        var tx = db.transaction('s', 'readwrite');
        for (var i = 0; i < 800; i++) tx.objectStore('s').put('v' + i, i);
        tx.oncomplete = function () { said.push('tx complete'); };
        db.close();
        var deleting = indexedDB.deleteDatabase('d');
        deleting.onsuccess = function () { said.push('deleted'); setTimeout(function () { resolve(said.join(',') + '|' + host.callSync('idb.keys').length); }, 50); };
        deleting.onerror = function () { reject(deleting.error); };
      };
    })`);
    expect(outcome).toBe('tx complete,deleted|0');
  });

  it('writes no more from a connection left at a version another tab moved the database on from', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
      var opening = indexedDB.open('v', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
      req(opening).then(async function (db) {
        // The other tab: version 2, without the store s.
        var meta = 'm' + JSON.stringify(['v']);
        host.callSync('idb.write', meta, JSON.stringify({ version: 2, stores: [] }));
        __softnIdbChanged(meta);
        var tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put('late', 1);
        var said = await new Promise(function (ok) { tx.oncomplete = function () { ok('kept'); }; tx.onabort = function () { ok(tx.error && tx.error.name); }; });
        resolve(said + '|' + host.callSync('idb.keys').filter(function (name) { return name.charAt(0) !== 'm'; }).length);
      }).catch(reject);
    })`);
    expect(outcome).toBe('AbortError|2');
  });

  it('goes on with an upgrade once the handler of blocked closes the other connection', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var said = [];
      var first = indexedDB.open('b', 1);
      first.onsuccess = function () {
        var db1 = first.result;
        var second = indexedDB.open('b', 2);
        second.onblocked = function () { said.push('blocked'); db1.close(); };
        second.onupgradeneeded = function () { said.push('upgradeneeded'); };
        second.onsuccess = function () { said.push('success ' + second.result.version); resolve(said.join(',')); };
        second.onerror = function () { reject(second.error); };
      };
    })`);
    expect(outcome).toBe('blocked,upgradeneeded,success 2');
  });

  it('opens at the version another tab moved on to, without upgrading again over its stores, while a connection at the old one is open here', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
      var said = [];
      var first = indexedDB.open('moved', 1);
      first.onupgradeneeded = function () { first.result.createObjectStore('s'); };
      req(first).then(async function (c1) {
        // The other tab: version 2, with a store x of its own holding five records.
        var meta = 'm' + JSON.stringify(['moved']);
        var description = JSON.parse(host.callSync('idb.read', meta));
        description.version = 2;
        description.stores.push({ name: 'x', keyPath: null, autoIncrement: false, indexes: [] });
        host.callSync('idb.write', meta, JSON.stringify(description));
        host.callSync('idb.write', 'p' + JSON.stringify(['moved', 'x', 1]), JSON.stringify([[1, '"a"'], [2, '"b"'], [3, '"c"'], [4, '"d"'], [5, '"e"']]));
        host.callSync('idb.write', 's' + JSON.stringify(['moved', 'x']), JSON.stringify({ n: 1, np: 2, p: [[1]] }));
        __softnIdbChanged(meta);
        var second = indexedDB.open('moved', 2);
        second.onblocked = function () { said.push('blocked'); setTimeout(function () { c1.close(); }, 0); };
        second.onupgradeneeded = function () { said.push('upgradeneeded'); second.result.createObjectStore('x'); };
        var c2 = await req(second);
        said.push('open ' + c2.version);
        said.push('x ' + await req(c2.transaction('x').objectStore('x').count()));
        // The old connection, still open, writes no more.
        var tx = c1.transaction('s', 'readwrite');
        tx.objectStore('s').put('late', 1);
        said.push(await new Promise(function (ok) { tx.oncomplete = function () { ok('kept'); }; tx.onabort = function () { ok(tx.error && tx.error.name); }; }));
        resolve(said.join('|'));
      }).catch(reject);
    })`);
    expect(outcome).toBe('open 2|x 5|AbortError');
  });

  it('refuses a generated key a value cannot take, and a cursor sent back by its record key, as a browser does', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function (e) { e.preventDefault(); no(r.error); }; }); };
      var opening = indexedDB.open('rules', 1);
      opening.onupgradeneeded = function () {
        opening.result.createObjectStore('deep', { keyPath: 'a.b', autoIncrement: true });
        opening.result.createObjectStore('rows').createIndex('group', 'g');
      };
      req(opening).then(async function (db) {
        var said = [];
        var tx = db.transaction(['deep', 'rows'], 'readwrite');
        try { tx.objectStore('deep').put({ a: 5 }); said.push('took a number'); } catch (e) { said.push(e.name); }
        var made = await req(tx.objectStore('deep').put({}));
        var kept = await req(tx.objectStore('deep').get(made));
        said.push(made + ':' + JSON.stringify(kept));
        for (var i = 0; i < 4; i++) tx.objectStore('rows').put({ g: i < 2 ? 'x' : 'y' }, i);
        var cursor = await req(tx.objectStore('rows').index('group').openCursor());
        try { cursor.continuePrimaryKey('x', 0); said.push('went back'); } catch (e) { said.push(e.name); }
        try { cursor.continuePrimaryKey('w', 9); said.push('went back'); } catch (e) { said.push(e.name); }
        cursor.continuePrimaryKey('x', 1);
        await new Promise(function (ok) { cursor.request.onsuccess = ok; });
        said.push(cursor.primaryKey);
        resolve(said.join('|'));
      }).catch(reject);
    })`);
    expect(outcome).toBe('DataError|1:{"a":{"b":1}}|DataError|DataError|1');
  });

  it('tells an open connection when another tab deletes its database, and writes to it no more', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
      var opening = indexedDB.open('gone', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s').put('one', 1); };
      req(opening).then(async function (db) {
        var told = await new Promise(function (ok) {
          db.onversionchange = function (e) { ok(e.oldVersion + '>' + e.newVersion); };
          // The other tab deletes it: its description and its store are no longer kept.
          var meta = 'm' + JSON.stringify(['gone']);
          host.callSync('idb.remove', meta);
          host.callSync('idb.remove', 's' + JSON.stringify(['gone', 's']));
          host.callSync('idb.remove', 'p' + JSON.stringify(['gone', 's', 1]));
          __softnIdbChanged(meta);
        });
        var tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put('two', 2);
        var after = await new Promise(function (ok) { tx.oncomplete = function () { ok('kept'); }; tx.onabort = function () { ok(tx.error && tx.error.name); }; });
        resolve(told + '|' + after + '|' + host.callSync('idb.keys').length);
      }).catch(reject);
    })`);
    expect(outcome).toBe('1>null|AbortError|0');
  });

  it('opens a database asked for during an upgrade once the upgrade is over, from what it left', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var said = [];
      var first = indexedDB.open('up', 1);
      var second;
      first.onupgradeneeded = function () {
        first.result.createObjectStore('s');
        second = indexedDB.open('up', 1);
        second.onupgradeneeded = function () { said.push('second upgrades'); second.result.createObjectStore('t'); };
        second.onsuccess = function () { said.push('second open: ' + Array.from(second.result.objectStoreNames).join(',')); resolve(said.join('|')); };
        second.onerror = function () { reject(second.error); };
        // Undone: the second opening finds no database, and makes its own.
        first.transaction.abort();
      };
      first.onerror = function () { said.push('first ' + (first.error && first.error.name)); };
      first.onsuccess = function () { said.push('first opened'); };
    })`);
    expect(outcome).toBe('first AbortError|second upgrades|second open: t');
  });

  it('takes stores, indexes and keys named like an object’s own, and an invalid Date, as it takes any other', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
      var opening = indexedDB.open('names', 1);
      opening.onupgradeneeded = function () {
        opening.result.createObjectStore('constructor').createIndex('toString', 'a');
        opening.result.createObjectStore('__proto__');
      };
      req(opening).then(async function (db) {
        var tx = db.transaction(['constructor', '__proto__'], 'readwrite');
        tx.objectStore('constructor').put({ a: 1 }, 'x');
        tx.objectStore('__proto__').put(JSON.parse('{"__proto__": {"inner": 1}, "b": 2}'), 'y');
        tx.objectStore('__proto__').put(new Date(NaN), 'when');
        await new Promise(function (ok, no) { tx.oncomplete = ok; tx.onabort = function () { no(tx.error); }; });
        var read = db.transaction(['constructor', '__proto__']);
        var byIndex = await req(read.objectStore('constructor').index('toString').get(1));
        var withProto = await req(read.objectStore('__proto__').get('y'));
        var when = await req(read.objectStore('__proto__').get('when'));
        var listed = await indexedDB.databases();
        resolve([byIndex.a, Object.keys(withProto).join(','), withProto.__proto__ && withProto.__proto__.inner, isNaN(when.getTime()), listed.map(function (d) { return d.name; }).join(',')].join('|'));
      }).catch(reject);
    })`);
    expect(outcome).toBe('1|__proto__,b|1|true|names');
  });

  it('writes only while this tab holds the database, from what the other tabs kept by the time it is given it', async () => {
    // Two tabs that wrote at once each wrote from what they had read: records one made with
    // keys it generated were written away by the other's, made with the same keys.
    const kept = new Map<string, string>();
    const asked: string[] = [];
    let otherTab: ((scope: vm.Context) => void) | null = null;
    const run = layer(kept, (kind, args, answer, scope) => {
      if (kind === 'idb.hold' || kind === 'idb.release') asked.push(`${kind} ${String(args[0])}`);
      setTimeout(() => {
        // What another tab kept while this one waited for the hold: taken in before it is given.
        if (kind === 'idb.hold' && otherTab) {
          otherTab(scope);
          otherTab = null;
        }
        answer({ ok: true });
      }, kind === 'idb.hold' ? 5 : 0);
    });
    const opened = await run(`new Promise(function (resolve, reject) {
      var opening = indexedDB.open('held', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s', { autoIncrement: true }); };
      opening.onsuccess = function () { globalThis.heldDb = opening.result; resolve('open'); };
      opening.onerror = function () { reject(opening.error); };
    })`);
    expect(opened).toBe('open');
    // Opened (and upgraded) while held, and let go of after.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toEqual(['idb.hold held', 'idb.release held']);
    asked.length = 0;
    otherTab = (scope) => {
      // Kept as the other tab keeps it: the store's one page, and its list with the generator at 4.
      const list = `s${JSON.stringify(['held', 's'])}`;
      const page = `p${JSON.stringify(['held', 's', 1])}`;
      kept.set(page, JSON.stringify([[1, '"b1"'], [2, '"b2"'], [3, '"b3"']]));
      kept.set(list, JSON.stringify({ ...JSON.parse(kept.get(list) ?? '{"p":[[1]]}'), n: 4 }));
      for (const name of [page, list]) vm.runInContext(`__softnIdbChanged(${JSON.stringify(name)})`, scope);
    };
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
      var tx = heldDb.transaction('s', 'readwrite');
      var adding = tx.objectStore('s').add('mine');
      tx.oncomplete = function () {
        // Reading asks for no hold.
        req(heldDb.transaction('s').objectStore('s').getAllKeys()).then(function (keys) { resolve(adding.result + '|' + keys.join(',')); }, reject);
      };
      tx.onerror = function () { reject(tx.error); };
    })`);
    expect(outcome).toBe('4|1,2,3,4');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toEqual(['idb.hold held', 'idb.release held']);
    // The other tab's records are kept with this tab's.
    expect(JSON.parse(kept.get(`p${JSON.stringify(['held', 's', 1])}`) ?? '[]').map((row: unknown[]) => row[0])).toEqual([1, 2, 3, 4]);
  });

  it('tells this tab’s open connection when another tab gives the database a new version, and opens it at that version again', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
      var opening = indexedDB.open('versions', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s'); };
      req(opening).then(async function (db) {
        var told = await new Promise(function (ok) {
          db.onversionchange = function (e) { ok(e.oldVersion + '>' + e.newVersion); db.close(); };
          // The other tab: version 2, with another store.
          var name = 'm' + JSON.stringify(['versions']);
          var meta = JSON.parse(host.callSync('idb.read', name));
          meta.version = 2;
          meta.stores.push({ name: 't', keyPath: null, autoIncrement: false, indexes: [] });
          host.callSync('idb.write', name, JSON.stringify(meta));
          __softnIdbChanged(name);
        });
        var again = await req(indexedDB.open('versions'));
        resolve(told + '|' + again.version + '|' + Array.from(again.objectStoreNames).join(','));
      }).catch(reject);
    })`);
    expect(outcome).toBe('1>2|2|s,t');
  });

  it('generates keys after the other tab’s once it has heard of its write', async () => {
    const kept = new Map<string, string>();
    const run = layer(kept);
    const outcome = await run(`new Promise(function (resolve, reject) {
      var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
      var opening = indexedDB.open('keys', 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('s', { autoIncrement: true }); };
      req(opening).then(async function (db) {
        var tx = db.transaction('s', 'readwrite');
        var store = tx.objectStore('s');
        var generated = [];
        store.add('mine').onsuccess = function (e) {
          generated.push(e.target.result);
          // The other tab: three records of its own, its generator at 4.
          var name = 's' + JSON.stringify(['keys', 's']);
          host.callSync('idb.write', name, JSON.stringify({ n: 4, r: [[1, '"b1"'], [2, '"b2"'], [3, '"b3"']] }));
          __softnIdbChanged(name);
          store.add('mine too').onsuccess = function (e2) { generated.push(e2.target.result); };
        };
        await new Promise(function (ok) { tx.oncomplete = ok; });
        resolve(generated.join(',') + '|' + (await req(db.transaction('s').objectStore('s').getAllKeys())).join(','));
      }).catch(reject);
    })`);
    // Its first key was made before it heard (and is the other tab's first too); its second comes after theirs.
    expect(outcome).toBe('1,4|1,2,3,4');
  });
});