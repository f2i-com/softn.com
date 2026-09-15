/**
 * ECO-S01 (FormLogic 0.1.6 source-verified handoff): an installation's data
 * is owned by one operation at a time, a continuation cannot commit under a
 * lease it no longer holds, and a registry write on a stale read is refused
 * and redone on the current registry. Synthetic storage and callbacks; the
 * R4-SN-01/02 regressions next door stay as they are.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_KEY, loadRegistry, resolveInstallation, saveRegistry } from '../src/installations';
import {
  abandonUpgrade,
  activeOperation,
  finishUpgrade,
  recoverInstallation,
  resetOperationLeases,
  resolveDataIdentity,
  UpgradeBlockedError,
  type LoaderDecision,
} from '../src/upgradeFlow';

const a1 = 'bundle-' + 'a'.repeat(64);
const a2 = 'bundle-' + 'b'.repeat(64);
const b1 = 'bundle-' + 'd'.repeat(64);
const c1 = 'bundle-' + 'e'.repeat(64);
const at = '2026-09-15T00:00:00.000Z';
const backupA = '/synthetic/a-pre-upgrade.sqlite';
const backupB = '/synthetic/b-recovery.sqlite';

type Options = { pending?: boolean; recovery?: boolean; withB?: boolean };
function fixture({ pending = false, recovery = false, withB = false }: Options = {}) {
  const installations: Record<string, unknown> = {
    [a1]: {
      dataId: a1, name: 'Fixture A', bundleIds: [a1], createdAt: at, updatedAt: at, ledger: [{ from: null, to: a1, at }],
      ...(pending ? { pendingUpgrade: { from: a1, to: a2, backup: backupA, at } } : {}),
      ...(recovery ? { recoveryRequired: { backup: backupA, reason: 'synthetic', at } } : {}),
    },
  };
  if (withB) {
    installations[b1] = {
      dataId: b1, name: 'Fixture B', bundleIds: [b1], createdAt: at, updatedAt: at, ledger: [{ from: null, to: b1, at }],
      pendingUpgrade: { from: b1, to: c1, backup: backupB, at },
      recoveryRequired: { backup: backupB, reason: 'synthetic B', at },
    };
  }
  return { version: 1, installations };
}
function memory(options: Options = {}) {
  const values = new Map<string, string>([[REGISTRY_KEY, JSON.stringify(fixture(options))]]);
  return {
    values,
    durable: true,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const restoreOk = async () => {};

beforeEach(() => resetOperationLeases());

describe('one operation owns an installation at a time', () => {
  it('refuses a recovery and a second rollback while a rollback holds the installation, without touching the data', async () => {
    const storage = memory({ pending: true, recovery: true });
    const entered = latch(), release = latch();
    let restores = 0;
    const rollback = abandonUpgrade({ dataId: a1, bundleId: a2, backup: backupA }, async () => { restores++; entered.release(); await release.promise; }, storage);
    await entered.promise;
    expect(activeOperation(a1)).toBe('rollback');

    await expect(recoverInstallation({ dataId: a1, backup: backupA }, async () => { restores++; }, storage)).rejects.toThrow(/Another operation \(a rollback\) is in progress/);
    const second = await abandonUpgrade({ dataId: a1, bundleId: a2, backup: backupA }, async () => { restores++; }, storage);
    expect(second).toMatchObject({ restored: false, finalized: false });
    expect(second.message).toMatch(/in progress/);
    expect(restores).toBe(1);

    release.release();
    const first = await rollback;
    expect(first).toMatchObject({ restored: true, finalized: true });
    expect(activeOperation(a1)).toBeNull();
    expect(resolveInstallation(loadRegistry(storage), a1, 'Fixture A').kind).toBe('known');
  });

  it('refuses an upgrade of an installation whose recovery is in flight, before any backup is taken; afterwards it proceeds', async () => {
    const storage = memory({ pending: true, recovery: true });
    const entered = latch(), release = latch();
    const recovery = recoverInstallation({ dataId: a1, backup: backupA }, async () => { entered.release(); await release.promise; }, storage);
    await entered.promise;
    const approve = async (): Promise<LoaderDecision> => ({ kind: 'upgrade', dataId: a1 });
    let backups = 0;
    const backup = async () => { backups++; return '/synthetic/c.sqlite'; };
    // A new package with the same name is a CHOICE; approving the upgrade meets the lease, not the backup.
    await expect(resolveDataIdentity(c1, { name: 'Fixture A' }, approve, backup, restoreOk, storage)).rejects.toThrow(/Another operation \(a recovery\) is in progress/);
    expect(backups).toBe(0);
    release.release();
    await recovery;
    expect(activeOperation(a1)).toBeNull();
    // With the recovery done (marker and pending record cleared) the same open stages the upgrade.
    const staged = await resolveDataIdentity(c1, { name: 'Fixture A' }, approve, backup, restoreOk, storage);
    expect(staged).toMatchObject({ dataId: a1, upgrade: { dataId: a1, bundleId: c1, backup: '/synthetic/c.sqlite' } });
    expect(backups).toBe(1);
    expect(activeOperation(a1)).toBeNull();
  });
});

describe('a stale recovery cannot leave the registry describing a newer generation', () => {
  it('refuses to finish the upgrade while the old snapshot is being written back, and the outcome is the old generation', async () => {
    const storage = memory({ pending: true, recovery: true });
    const entered = latch(), release = latch();
    const recovery = recoverInstallation({ dataId: a1, backup: backupA }, async () => { entered.release(); await release.promise; }, storage);
    await entered.promise;

    const finish = finishUpgrade({ dataId: a1, bundleId: a2, backup: backupA }, storage);
    expect(finish).toMatchObject({ finalized: false });
    expect((finish as { reason: string }).reason).toMatch(/recovery .* in progress/);
    expect(loadRegistry(storage).installations[a1].pendingUpgrade).toBeDefined();

    release.release();
    await recovery;
    const registry = loadRegistry(storage);
    expect(registry.installations[a1].pendingUpgrade).toBeUndefined();
    expect(registry.installations[a1].recoveryRequired).toBeUndefined();
    expect(registry.installations[a1].bundleIds).toEqual([a1]);
    // The newer package is no longer a pending upgrade of anything: it cannot be finished late.
    expect(finishUpgrade({ dataId: a1, bundleId: a2, backup: backupA }, storage)).toMatchObject({ finalized: false });
  });
});

describe('a failed recovery followed by a verified retry clears only its own markers', () => {
  it('leaves another installation\'s recovery marker and the failed operation\'s markers alone until the retry succeeds', async () => {
    const storage = memory({ pending: true, recovery: true, withB: true });
    await expect(recoverInstallation({ dataId: a1, backup: backupA }, async () => { throw new Error('disk gone'); }, storage)).rejects.toThrow(/could not be restored \(disk gone\)/);
    let registry = loadRegistry(storage);
    expect(registry.installations[a1].recoveryRequired).toBeDefined();
    expect(registry.installations[a1].pendingUpgrade).toBeDefined();
    expect(registry.installations[b1].recoveryRequired).toBeDefined();

    await recoverInstallation({ dataId: a1, backup: backupA }, restoreOk, storage);
    registry = loadRegistry(storage);
    expect(registry.installations[a1].recoveryRequired).toBeUndefined();
    expect(registry.installations[a1].pendingUpgrade).toBeUndefined();
    expect(registry.installations[b1].recoveryRequired).toEqual({ backup: backupB, reason: 'synthetic B', at });
    expect(registry.installations[b1].pendingUpgrade?.to).toBe(c1);
    expect(resolveInstallation(registry, b1, 'Fixture B').kind).toBe('recovery-required');
  });

  it('refuses a recovery that names a different backup than the marker, changing nothing', async () => {
    const storage = memory({ pending: true, recovery: true });
    let restores = 0;
    await expect(recoverInstallation({ dataId: a1, backup: '/synthetic/other.sqlite' }, async () => { restores++; }, storage)).rejects.toThrow(/different backup/);
    expect(restores).toBe(0);
    expect(loadRegistry(storage).installations[a1].recoveryRequired?.backup).toBe(backupA);
  });
});

describe('registry writes are refused on a stale read and redone on the current registry', () => {
  it('a save that names an old revision is stale; a plain save increments the revision', () => {
    const storage = memory();
    const first = loadRegistry(storage);
    expect(first.revision).toBe(0);
    expect(saveRegistry(storage, first, { expectRevision: 0 })).toBe(true);
    expect(loadRegistry(storage).revision).toBe(1);
    // Another context wrote meanwhile: the copy loaded at revision 0 must not win.
    const old = { ...first, revision: 0 };
    expect(saveRegistry(storage, old, { expectRevision: 0 })).toBe('stale');
    expect(loadRegistry(storage).revision).toBe(1);
  });

  it('a commit whose registry another context changed underneath is redone, keeping both records', async () => {
    const storage = memory();
    // On the read right before the write (the revision check), let "another
    // context" register B first: the commit must notice, re-read and redo.
    let reads = 0;
    const external = () => {
      const registry = loadRegistry({ getItem: key => storage.values.get(key) ?? null, setItem: (k, v) => storage.values.set(k, v) });
      registry.installations[b1] = { dataId: b1, name: 'Fixture B', bundleIds: [b1], createdAt: at, updatedAt: at, ledger: [{ from: null, to: b1, at }] };
      saveRegistry({ getItem: key => storage.values.get(key) ?? null, setItem: (k, v) => storage.values.set(k, v) }, registry);
    };
    const racing = {
      durable: true,
      getItem(key: string) {
        reads++;
        if (reads === 2) external();
        return storage.values.get(key) ?? null;
      },
      setItem(key: string, value: string) { storage.values.set(key, value); },
    };
    const decision = await resolveDataIdentity(c1, { name: 'Fixture C' }, async () => ({ kind: 'cancel' }), async () => '/x', restoreOk, racing);
    expect(decision).toEqual({ dataId: c1 });
    const registry = loadRegistry(storage);
    expect(registry.installations[c1]?.bundleIds).toEqual([c1]);
    expect(registry.installations[b1]?.bundleIds).toEqual([b1]);
    expect(registry.installations[a1]?.bundleIds).toEqual([a1]);
    expect(registry.revision).toBe(2);
  });

  it('a registry written before revisions existed reads as revision 0 and is not refused', () => {
    const storage = memory();
    expect(JSON.parse(storage.values.get(REGISTRY_KEY)!).revision).toBeUndefined();
    const registry = loadRegistry(storage);
    expect(registry.revision).toBe(0);
    expect(saveRegistry(storage, registry, { expectRevision: registry.revision })).toBe(true);
    expect(JSON.parse(storage.values.get(REGISTRY_KEY)!).revision).toBe(1);
  });
});

describe('errors keep their type for the loader UI', () => {
  it('a lease refusal is an UpgradeBlockedError', async () => {
    const storage = memory({ pending: true, recovery: true });
    const entered = latch(), release = latch();
    const recovery = recoverInstallation({ dataId: a1, backup: backupA }, async () => { entered.release(); await release.promise; }, storage);
    await entered.promise;
    await expect(recoverInstallation({ dataId: a1, backup: backupA }, restoreOk, storage)).rejects.toBeInstanceOf(UpgradeBlockedError);
    release.release();
    await recovery;
  });
});
