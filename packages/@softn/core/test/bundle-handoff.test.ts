/**
 * The hand-off between the editors and the pages that take their bundles.
 *
 * It used to be one shared slot: staging replaced whatever was there and
 * the next page to open took whatever was there, so Run from Studio and
 * Publish from Builder at the same moment delivered one editor's bytes to
 * the other's receiver. Pinned here: every hand-off is addressed by an
 * unguessable id; each receiver gets its own bytes; a record for another
 * page, an expired one, an unknown id and a digest mismatch are all refused
 * without consuming anything else; an aborted transaction is a failed
 * delivery; and the publish address is the site's /publish route.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fake-indexeddb';
import {
  HANDOFF_DB,
  HANDOFF_STORE,
  HANDOFF_TTL_MS,
  describeHandoffFailure,
  handoffIdFrom,
  handoffUrl,
  resetHandoffClaims,
  sameOriginTarget,
  sha256Hex,
  stageBundleHandoff,
  takeBundleHandoff,
} from '../src/bundle/handoff';

let fake: FakeIndexedDB;
const bytesA = new TextEncoder().encode('bundle A');
const bytesB = new TextEncoder().encode('bundle B, quite different');

beforeEach(() => {
  fake = installFakeIndexedDB();
  resetHandoffClaims();
});

describe('handoffUrl', () => {
  it('sends a publish hand-off to the site route that shows the publish form', () => {
    expect(handoffUrl('/', 'publish', 'abc-123')).toBe('/publish?from=handoff&handoff=abc-123');
    expect(handoffUrl('http://localhost:1421', 'publish', 'abc-123')).toBe('http://localhost:1421/publish?from=handoff&handoff=abc-123');
  });

  it('sends a runtime hand-off to the runtime root', () => {
    expect(handoffUrl('/web/', 'runtime', 'abc-123')).toBe('/web/?open=handoff&handoff=abc-123');
    expect(handoffUrl('http://localhost:1420', 'runtime', 'abc-123')).toBe('http://localhost:1420/?open=handoff&handoff=abc-123');
  });

  it('joins a non-root prefix without doubled slashes or a missing segment', () => {
    expect(handoffUrl('/softn/', 'publish', 'id')).toBe('/softn/publish?from=handoff&handoff=id');
    expect(handoffUrl('/softn', 'publish', 'id')).toBe('/softn/publish?from=handoff&handoff=id');
    expect(handoffUrl('/softn/web/', 'runtime', 'id')).toBe('/softn/web/?open=handoff&handoff=id');
  });

  it('round-trips through the receiver-side reader', () => {
    const url = new URL(handoffUrl('/', 'publish', 'f1e2d3c4-0000-4000-8000-000000000000'), 'http://site.test');
    expect(handoffIdFrom(url.search, 'publish')).toEqual({ opened: true, id: 'f1e2d3c4-0000-4000-8000-000000000000' });
    // A publish address is not a runtime hand-off, and vice versa.
    expect(handoffIdFrom(url.search, 'runtime')).toEqual({ opened: false, id: null });
    expect(handoffIdFrom('?from=handoff', 'publish')).toEqual({ opened: true, id: null });
    expect(handoffIdFrom('?from=handoff&handoff=<script>', 'publish')).toEqual({ opened: true, id: null });
  });
});

describe('sameOriginTarget', () => {
  it('knows a separate development port is another origin', () => {
    expect(sameOriginTarget('/web/', 'http://localhost:1421')).toBe(true);
    expect(sameOriginTarget('http://localhost:1421/publish', 'http://localhost:1421')).toBe(true);
    expect(sameOriginTarget('http://localhost:1420/', 'http://localhost:1421')).toBe(false);
  });
});

describe('staging and taking', () => {
  it('delivers each bundle to its own receiver when two are staged at once', async () => {
    const run = await stageBundleHandoff(bytesA, 'from-studio', 'studio', 'runtime');
    const pub = await stageBundleHandoff(bytesB, 'from-builder', 'builder', 'publish');
    expect(run && pub).toBeTruthy();
    expect(run!.id).not.toBe(pub!.id);

    // The receivers open in the other order.
    const gotPub = await takeBundleHandoff(pub!.id, 'publish');
    const gotRun = await takeBundleHandoff(run!.id, 'runtime');
    expect(gotPub.ok && new TextDecoder().decode(gotPub.handoff.bytes)).toBe('bundle B, quite different');
    expect(gotRun.ok && new TextDecoder().decode(gotRun.handoff.bytes)).toBe('bundle A');
    expect(gotRun.ok && gotRun.handoff.from).toBe('studio');
    expect(gotPub.ok && gotPub.handoff.digest).toBe(await sha256Hex(bytesB));
    expect(fake.records(HANDOFF_DB, HANDOFF_STORE).size).toBe(0);
  });

  it('claims once: the same page asking again gets the same answer, a second tab gets nothing', async () => {
    const staged = (await stageBundleHandoff(bytesA, 'a', 'studio', 'runtime'))!;
    const first = takeBundleHandoff(staged.id, 'runtime');
    const again = takeBundleHandoff(staged.id, 'runtime');
    expect(again).toBe(first);
    expect((await first).ok).toBe(true);
    // A duplicate tab is a fresh page with no claim of its own.
    resetHandoffClaims();
    const other = await takeBundleHandoff(staged.id, 'runtime');
    expect(other).toEqual({ ok: false, reason: 'unknown' });
  });

  it('leaves a record for another page where it is', async () => {
    const staged = (await stageBundleHandoff(bytesA, 'a', 'builder', 'publish'))!;
    expect(await takeBundleHandoff(staged.id, 'runtime')).toEqual({ ok: false, reason: 'wrong-destination' });
    expect(fake.records(HANDOFF_DB, HANDOFF_STORE).has(staged.id)).toBe(true);
    resetHandoffClaims();
    expect((await takeBundleHandoff(staged.id, 'publish')).ok).toBe(true);
  });

  it('refuses an unknown id and an empty one without touching what is staged', async () => {
    const staged = (await stageBundleHandoff(bytesA, 'a', 'builder', 'publish'))!;
    expect(await takeBundleHandoff('never-staged-here-0000', 'publish')).toEqual({ ok: false, reason: 'unknown' });
    expect(await takeBundleHandoff(null, 'publish')).toEqual({ ok: false, reason: 'no-id' });
    expect(fake.records(HANDOFF_DB, HANDOFF_STORE).has(staged.id)).toBe(true);
  });

  it('throws an expired record away unread', async () => {
    const stagedAt = 1_000_000;
    const staged = (await stageBundleHandoff(bytesA, 'a', 'studio', 'runtime', stagedAt))!;
    expect(await takeBundleHandoff(staged.id, 'runtime', stagedAt + HANDOFF_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(fake.records(HANDOFF_DB, HANDOFF_STORE).size).toBe(0);
  });

  it('refuses bytes whose digest no longer matches', async () => {
    const staged = (await stageBundleHandoff(bytesA, 'a', 'studio', 'runtime'))!;
    const record = fake.records(HANDOFF_DB, HANDOFF_STORE).get(staged.id) as { bytes: Uint8Array };
    record.bytes[0] ^= 0xff;
    // Write the tampered record back the way a corrupted store would hold it.
    (fake as unknown as { databases: Map<string, { stores: Map<string, { data: Map<string, unknown> }> }> }).databases
      .get(HANDOFF_DB)!.stores.get(HANDOFF_STORE)!.data.set(staged.id, record);
    expect(await takeBundleHandoff(staged.id, 'runtime')).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('reports an aborted transaction as a failed delivery, not a delivered bundle', async () => {
    const staged = (await stageBundleHandoff(bytesA, 'a', 'studio', 'runtime'))!;
    fake.abortNextTransaction = true;
    expect(await takeBundleHandoff(staged.id, 'runtime')).toEqual({ ok: false, reason: 'storage' });
  });

  it('reports storage that cannot be opened as a storage failure, and staging as not done', async () => {
    fake.failOpen = true;
    expect(await stageBundleHandoff(bytesA, 'a', 'studio', 'runtime')).toBeNull();
    expect(await takeBundleHandoff('some-id-0000000000', 'runtime')).toEqual({ ok: false, reason: 'storage' });
  });

  it('clears out records past their TTL and the legacy shared slot when staging', async () => {
    const old = (await stageBundleHandoff(bytesA, 'old', 'studio', 'runtime', 0))!;
    const store = (fake as unknown as { databases: Map<string, { stores: Map<string, { data: Map<string, unknown> }> }> }).databases
      .get(HANDOFF_DB)!.stores.get(HANDOFF_STORE)!.data;
    store.set('pending', { bytes: bytesB, name: 'legacy', from: 'builder', stagedAt: Date.now() });
    const fresh = (await stageBundleHandoff(bytesB, 'new', 'builder', 'publish', HANDOFF_TTL_MS + 5))!;
    const keys = [...fake.records(HANDOFF_DB, HANDOFF_STORE).keys()];
    expect(keys).toEqual([fresh.id]);
    expect(keys).not.toContain(old.id);
  });

  it('stores a copy, so the producer changing its buffer afterwards changes nothing', async () => {
    const buffer = new TextEncoder().encode('original');
    const staged = (await stageBundleHandoff(buffer, 'a', 'studio', 'runtime'))!;
    buffer.fill(0);
    const got = await takeBundleHandoff(staged.id, 'runtime');
    expect(got.ok && new TextDecoder().decode(got.handoff.bytes)).toBe('original');
  });
});

describe('describeHandoffFailure', () => {
  it('always leaves a way forward', () => {
    for (const reason of ['unknown', 'expired', 'wrong-destination', 'corrupt', 'storage', 'no-id'] as const) {
      expect(describeHandoffFailure(reason, 'publish')).toMatch(/choose the (bundle )?file/);
    }
  });
});
