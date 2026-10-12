/**
 * The IndexedDB the tests run on (@softn/test-utils) runs read-write
 * transactions one at a time, as every browser does.
 *
 * It ran each request on its own, so two read-write transactions on one
 * store interleaved: both read, then both wrote, and the second write put
 * back what the first had read. No browser does that: a read-write
 * transaction starts only once every earlier transaction on its stores has
 * finished. A save's look at the stored copy and its write share one
 * transaction (persistence.ts, saveProjectRecord) because of exactly that,
 * and a test on the fake could pass where a browser would not, or fail where
 * a browser would pass.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fake-under-test', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('counts');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const committed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error);
  tx.onerror = () => reject(tx.error);
});

/** Read the count and write it back one higher, in one read-write transaction. */
async function increment(db: IDBDatabase): Promise<void> {
  const tx = db.transaction('counts', 'readwrite');
  const store = tx.objectStore('counts');
  const done = committed(tx);
  const count = ((await request(store.get('n'))) as number | undefined) ?? 0;
  store.put(count + 1, 'n');
  await done;
}

async function read(db: IDBDatabase): Promise<number | undefined> {
  const tx = db.transaction('counts', 'readonly');
  return (await request(tx.objectStore('counts').get('n'))) as number | undefined;
}

beforeEach(() => {
  installFakeIndexedDB();
});

describe('the fake IndexedDB', () => {
  it('runs two read-write transactions on one store one after the other', async () => {
    const db = await open();
    await Promise.all([increment(db), increment(db), increment(db)]);
    expect(await read(db)).toBe(3);
  });

  it('starts a transaction made after a read-write one only once that one has finished', async () => {
    const db = await open();
    const writing = increment(db);
    const seen = read(db);
    await writing;
    expect(await seen).toBe(1);
  });

  it('still commits a transaction that is given no request', async () => {
    const db = await open();
    const empty = db.transaction('counts', 'readwrite');
    await committed(empty);
    await increment(db);
    expect(await read(db)).toBe(1);
  });

  it('lets read-only transactions run side by side', async () => {
    const db = await open();
    await increment(db);
    const a = db.transaction('counts', 'readonly');
    const b = db.transaction('counts', 'readonly');
    const order: string[] = [];
    const first = request(a.objectStore('counts').get('n')).then(() => order.push('a'));
    const second = request(b.objectStore('counts').get('n')).then(() => order.push('b'));
    await Promise.all([first, second, committed(a), committed(b)]);
    expect(order.sort()).toEqual(['a', 'b']);
  });
});
