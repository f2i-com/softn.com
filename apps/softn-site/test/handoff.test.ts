/**
 * The publish page's side of the hand-off, and its agreement with the
 * editors' side.
 *
 * The site carries its own copy of the protocol rather than depending on
 * the engine, so this test imports the core implementation by path — test
 * only — and checks the two read and write the same records and the same
 * addresses: a bundle staged by core's `stageBundleHandoff` is claimed by
 * the site's `takeBundleHandoff`, and the address core's `handoffUrl`
 * produces is the route the site's router shows the publish form at.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB, type FakeIndexedDB } from '../../../packages/@softn/core/test/helpers/fake-indexeddb';
import { handoffUrl, stageBundleHandoff, HANDOFF_DB as CORE_DB, HANDOFF_STORE as CORE_STORE, HANDOFF_PARAM as CORE_PARAM, HANDOFF_TTL_MS as CORE_TTL } from '../../../packages/@softn/core/src/bundle/handoff';
import { HANDOFF_DB, HANDOFF_PARAM, HANDOFF_STORE, HANDOFF_TTL_MS, handoffIdFrom, openedForHandoff, resetHandoffClaims, takeBundleHandoff } from '../src/lib/handoff';
import { isOwnedPath } from '../src/lib/router';

let fake: FakeIndexedDB;
const bytes = new TextEncoder().encode('a bundle from an editor');

beforeEach(() => {
  fake = installFakeIndexedDB();
  resetHandoffClaims();
});

describe('the contract with core', () => {
  it('names the same database, store, parameter and TTL', () => {
    expect(HANDOFF_DB).toBe(CORE_DB);
    expect(HANDOFF_STORE).toBe(CORE_STORE);
    expect(HANDOFF_PARAM).toBe(CORE_PARAM);
    expect(HANDOFF_TTL_MS).toBe(CORE_TTL);
  });

  it('claims what an editor staged, once', async () => {
    const staged = (await stageBundleHandoff(bytes, 'notes', 'studio', 'publish'))!;
    const url = new URL(handoffUrl('/', 'publish', staged.id), 'http://site.test');
    const { opened, id } = handoffIdFrom(url.search);
    expect(opened).toBe(true);
    expect(id).toBe(staged.id);
    const result = await takeBundleHandoff(id);
    expect(result.ok && result.handoff.name).toBe('notes');
    expect(result.ok && result.handoff.from).toBe('studio');
    expect(fake.records(HANDOFF_DB, HANDOFF_STORE).size).toBe(0);
    resetHandoffClaims();
    expect(await takeBundleHandoff(id)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('is sent to the route the site shows the publish form at, whatever the base', () => {
    for (const base of ['/', '', 'http://localhost:1421', '/softn/']) {
      const url = new URL(handoffUrl(base, 'publish', 'some-id-0000000000'), 'http://site.test');
      const prefix = base.startsWith('http') ? '' : base.replace(/\/+$/, '');
      expect(url.pathname).toBe(`${prefix}/publish`);
      expect(openedForHandoff(url.search)).toBe(true);
    }
    // The site's own router owns /publish; it does not own the root as the publish page.
    expect(isOwnedPath('/publish')).toBe(true);
    expect(openedForHandoff('?from=handoff&handoff=x')).toBe(true);
    expect(openedForHandoff('?open=handoff&handoff=x')).toBe(false);
  });

  it('leaves a record addressed to the runtime for the runtime', async () => {
    const staged = (await stageBundleHandoff(bytes, 'notes', 'builder', 'runtime'))!;
    expect(await takeBundleHandoff(staged.id)).toEqual({ ok: false, reason: 'wrong-destination' });
    expect(fake.records(HANDOFF_DB, HANDOFF_STORE).has(staged.id)).toBe(true);
  });

  it('refuses an expired record, an unknown id, a missing id and an aborted transaction', async () => {
    const old = (await stageBundleHandoff(bytes, 'notes', 'builder', 'publish', 0))!;
    expect(await takeBundleHandoff(old.id, HANDOFF_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(await takeBundleHandoff('never-staged-0000000')).toEqual({ ok: false, reason: 'unknown' });
    expect(await takeBundleHandoff(null)).toEqual({ ok: false, reason: 'no-id' });
    const fresh = (await stageBundleHandoff(bytes, 'notes', 'builder', 'publish'))!;
    fake.abortNextTransaction = true;
    expect(await takeBundleHandoff(fresh.id)).toEqual({ ok: false, reason: 'storage' });
  });
});
