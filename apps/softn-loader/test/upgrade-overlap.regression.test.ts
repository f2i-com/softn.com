/**
 * R4-SN-01 / R4-SN-02 regressions, adopted from the round-4 review handoff
 * (F2i-Ecosystem-Round-4-Handoff-2026-09-15, checks/upgrade-overlap.regression.test.ts).
 * Registry mutations must preserve other operations across await boundaries,
 * and recovery must have a successful exit. Synthetic storage and callbacks.
 */
import { describe, expect, it } from 'vitest';
import { REGISTRY_KEY, loadRegistry, resolveInstallation } from '../src/installations';
import { abandonUpgrade, resolveDataIdentity, type LoaderDecision } from '../src/upgradeFlow';

const a1 = 'bundle-' + 'a'.repeat(64);
const a2 = 'bundle-' + 'b'.repeat(64);
const a3 = 'bundle-' + 'c'.repeat(64);
const b1 = 'bundle-' + 'd'.repeat(64);
const at = '2026-09-15T00:00:00.000Z';
const backupPath = '/synthetic/pre-upgrade.sqlite';
function fixture(pending = false) {
  return { version: 1, installations: { [a1]: {
    dataId: a1, name: 'Fixture A', bundleIds: [a1], createdAt: at, updatedAt: at,
    ledger: [{ from: null, to: a1, at }],
    ...(pending ? { pendingUpgrade: { from: a1, to: a2, backup: backupPath, at } } : {}),
  } } };
}
function memory(pending = false) {
  const values = new Map<string, string>([[REGISTRY_KEY, JSON.stringify(fixture(pending))]]);
  return {
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
const approve = async (): Promise<LoaderDecision> => ({ kind: 'upgrade', dataId: a1 });
const cancel = async (): Promise<LoaderDecision> => ({ kind: 'cancel' });
const restore = async () => {};

describe('registry mutations preserve other operations across await boundaries', () => {
  it('keeps a new unrelated installation when an older backup operation finishes', async () => {
    const storage = memory();
    const entered = latch(), releaseBackup = latch();
    const openingA = resolveDataIdentity(a2, { name: 'Fixture A' }, approve,
      async () => { entered.release(); await releaseBackup.promise; return backupPath; }, restore, storage);
    await entered.promise;
    const openingB = resolveDataIdentity(b1, { name: 'Fixture B' }, cancel,
      async () => '/synthetic/B.sqlite', restore, storage);
    // Do not require B to finish while A is blocked: serialization is a valid fix.
    await Promise.resolve();
    releaseBackup.release();
    await Promise.all([openingA, openingB]);
    expect(loadRegistry(storage).installations[b1]?.bundleIds).toContain(b1);
  });

  it('does not accept two competing pending upgrades from stale registry snapshots', async () => {
    const storage = memory();
    const entered = latch(), releaseBackup = latch();
    const openingV2 = resolveDataIdentity(a2, { name: 'Fixture A' }, approve,
      async () => { entered.release(); await releaseBackup.promise; return backupPath; }, restore, storage);
    await entered.promise;
    const openingV3 = resolveDataIdentity(a3, { name: 'Fixture A' }, approve,
      async () => '/synthetic/pre-v3.sqlite', restore, storage);
    // Observe rejections immediately; allow either serialization or conflict rejection.
    const settled = Promise.allSettled([openingV2, openingV3]);
    await Promise.resolve();
    releaseBackup.release();
    const results = await settled;
    const accepted = results.filter(result => result.status === 'fulfilled' && !!result.value?.upgrade);
    expect(accepted).toHaveLength(1);
  });

  it('keeps a newer unrelated installation when a rollback finishes', async () => {
    const storage = memory(true);
    const entered = latch(), releaseRestore = latch();
    const rollback = abandonUpgrade({ dataId: a1, bundleId: a2, backup: backupPath },
      async () => { entered.release(); await releaseRestore.promise; }, storage);
    await entered.promise;
    const openingB = resolveDataIdentity(b1, { name: 'Fixture B' }, cancel,
      async () => '/synthetic/B.sqlite', restore, storage);
    await Promise.resolve();
    releaseRestore.release();
    await Promise.all([rollback, openingB]);
    expect(loadRegistry(storage).installations[b1]?.bundleIds).toContain(b1);
  });
});

describe('recovery succeeds after a transient rollback failure', () => {
  it('clears the matching recovery marker only after a verified successful retry', async () => {
    const storage = memory(true);
    const operation = { dataId: a1, bundleId: a2, backup: backupPath };
    await abandonUpgrade(operation, async () => { throw new Error('synthetic transient failure'); }, storage);
    expect(resolveInstallation(loadRegistry(storage), a1, 'Fixture A').kind).toBe('recovery-required');
    const retried = await abandonUpgrade(operation, restore, storage);
    expect(retried).toMatchObject({ restored: true, finalized: true });
    const registry = loadRegistry(storage);
    expect(registry.installations[a1].pendingUpgrade).toBeUndefined();
    expect(registry.installations[a1].recoveryRequired).toBeUndefined();
    expect(resolveInstallation(registry, a1, 'Fixture A').kind).toBe('known');
  });
});
