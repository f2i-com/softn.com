/**
 * R3-SN-01 / R3-SN-02: the upgrade state machine is gated by DATA
 * installation, every claimed transition is durable, and an unreadable or
 * partly invalid registry is never mistaken for an empty healthy one. These
 * are the round-3 review's probe scenarios promoted into the project suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY_KEY, loadRegistry, resolveInstallation, saveRegistry } from '../src/installations';
import { UpgradeBlockedError, abandonUpgrade, finishUpgrade, resolveDataIdentity, type LoaderDecision, type LoaderQuestion } from '../src/upgradeFlow';

const v1 = 'bundle-' + 'a'.repeat(64);
const v2 = 'bundle-' + 'b'.repeat(64);
const at = '2026-09-14T00:00:00.000Z';

function fixture() {
  return { version: 1, installations: { installation: {
    dataId: 'installation', name: 'Fixture', bundleIds: [v1], createdAt: at, updatedAt: at, ledger: [{ from: null, to: v1, at }],
    pendingUpgrade: { from: v1, to: v2, backup: '/backups/pre-upgrade.sqlite', at },
  } } };
}

function memory(value: unknown, options: { failWrite?: boolean; durable?: boolean } = {}) {
  const map = new Map<string, string>([[REGISTRY_KEY, JSON.stringify(value)]]);
  return {
    map,
    durable: options.durable,
    getItem(key: string) { return map.get(key) ?? null; },
    setItem(key: string, raw: string) { if (options.failWrite) throw new Error('write failure'); map.set(key, raw); },
    snapshot() { return JSON.parse(map.get(REGISTRY_KEY)!); },
  };
}

const upgrade = { dataId: 'installation', bundleId: v2, backup: '/backups/pre-upgrade.sqlite' };
const never = async () => { throw new Error('should not be called'); };

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('R3-SN-01: the installation is gated until the upgrade is finished or undone durably', () => {
  it('does not open the OLD package normally while its installation has a pending upgrade', async () => {
    const storage = memory(fixture());
    expect(resolveInstallation(loadRegistry(storage), v1, 'Fixture').kind).toBe('upgrade-unresolved');
    const asked: LoaderQuestion[] = [];
    const ask = async (q: LoaderQuestion): Promise<LoaderDecision> => { asked.push(q); return { kind: 'cancel' }; };
    expect(await resolveDataIdentity(v1, { name: 'Fixture' }, ask, never, never, storage)).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'upgrade-unresolved', dataId: 'installation', pending: { to: v2, backup: '/backups/pre-upgrade.sqlite' } });
    // Cancel changed nothing: still gated.
    expect(storage.snapshot().installations.installation.pendingUpgrade).toBeDefined();
  });

  it('rolls the installation back on request: restore first, then the record; a failed record write keeps the gate', async () => {
    const restored: string[] = [];
    const restore = async (dataId: string, backup: string) => { restored.push(`${dataId}:${backup}`); };
    const rollback = async (): Promise<LoaderDecision> => ({ kind: 'rollback' });

    const ok = memory(fixture());
    expect(await resolveDataIdentity(v1, { name: 'Fixture' }, rollback, never, restore, ok)).toEqual({ dataId: 'installation' });
    expect(restored).toEqual(['installation:/backups/pre-upgrade.sqlite']);
    expect(ok.snapshot().installations.installation.pendingUpgrade).toBeUndefined();
    expect(resolveInstallation(loadRegistry(ok), v1, 'Fixture').kind).toBe('known');

    // Restore failure: nothing recorded, still gated, error names the backup.
    const failing = memory(fixture());
    await expect(resolveDataIdentity(v1, { name: 'Fixture' }, rollback, never, async () => { throw new Error('disk error'); }, failing)).rejects.toThrow(/could not be restored \(disk error\).*pre-upgrade\.sqlite/);
    expect(failing.snapshot().installations.installation.pendingUpgrade).toBeDefined();

    // Restore succeeded but the record could not be cleared: still gated, error says so.
    const unsaveable = memory(fixture(), { failWrite: true });
    await expect(resolveDataIdentity(v1, { name: 'Fixture' }, rollback, never, restore, unsaveable)).rejects.toThrow(/restored from .*but the upgrade record could not be cleared/);
    expect(resolveInstallation(loadRegistry(unsaveable), v1, 'Fixture').kind).toBe('upgrade-unresolved');
  });

  it('reports finalization failure so the app is not left running on a stale pending record', () => {
    const unsaveable = memory(fixture(), { failWrite: true });
    expect(finishUpgrade(upgrade, unsaveable)).toEqual({ finalized: false, reason: 'the completion could not be saved' });
    expect(unsaveable.snapshot().installations.installation.pendingUpgrade).toBeDefined();
    expect(resolveInstallation(loadRegistry(unsaveable), v2, 'Fixture').kind).toBe('pending-upgrade');
    expect(resolveInstallation(loadRegistry(unsaveable), v1, 'Fixture').kind).toBe('upgrade-unresolved');

    const ok = memory(fixture());
    expect(finishUpgrade(upgrade, ok)).toEqual({ finalized: true });
    expect(ok.snapshot().installations.installation.bundleIds).toEqual([v1, v2]);
    expect(ok.snapshot().installations.installation.pendingUpgrade).toBeUndefined();
    // Idempotent on retry after the completion was recorded.
    expect(finishUpgrade(upgrade, ok)).toEqual({ finalized: true });
  });

  it('binds completion and undo to the operation identity, never to whatever is pending', async () => {
    const other = { dataId: 'installation', bundleId: 'bundle-' + 'c'.repeat(64), backup: '/backups/other.sqlite' };
    const storage = memory(fixture());
    expect(finishUpgrade(other, storage)).toEqual({ finalized: false, reason: 'the pending upgrade record belongs to a different operation' });
    const outcome = await abandonUpgrade(other, never, storage);
    expect(outcome).toMatchObject({ restored: false, finalized: false });
    expect(outcome.message).toMatch(/different operation/);
    expect(storage.snapshot().installations.installation.pendingUpgrade).toMatchObject({ to: v2 });
  });

  it('reports "data restored" and "record updated" separately when the registry write fails', async () => {
    const storage = memory(fixture(), { failWrite: true });
    let restoreCalled = false;
    const outcome = await abandonUpgrade(upgrade, async () => { restoreCalled = true; }, storage);
    expect(restoreCalled).toBe(true);
    expect(outcome.restored).toBe(true);
    expect(outcome.finalized).toBe(false);
    expect(outcome.message).not.toMatch(/upgrade was undone/);
    expect(outcome.message).toMatch(/still recorded as pending/);
    expect(storage.snapshot().installations.installation.pendingUpgrade).toBeDefined();
    // Both packages stay gated on reload.
    expect(resolveInstallation(loadRegistry(storage), v1, 'Fixture').kind).toBe('upgrade-unresolved');
    expect(resolveInstallation(loadRegistry(storage), v2, 'Fixture').kind).toBe('pending-upgrade');
  });

  it('keeps the gate enforced when both the restore and the recovery marker fail', async () => {
    const storage = memory(fixture(), { failWrite: true });
    const outcome = await abandonUpgrade(upgrade, async () => { throw new Error('restore failure'); }, storage);
    expect(outcome).toMatchObject({ restored: false, finalized: false });
    expect(outcome.message).not.toMatch(/is in a recovery-only state/);
    expect(outcome.message).toMatch(/could not be recorded either/);
    expect(storage.snapshot().installations.installation.recoveryRequired).toBeUndefined();
    expect(resolveInstallation(loadRegistry(storage), v1, 'Fixture').kind).toBe('upgrade-unresolved');
    expect(resolveInstallation(loadRegistry(storage), v2, 'Fixture').kind).toBe('pending-upgrade');
  });

  it('records the ordinary outcomes durably: undone, or recovery-only', async () => {
    const undone = memory(fixture());
    expect(await abandonUpgrade(upgrade, async () => {}, undone)).toMatchObject({ restored: true, finalized: true });
    expect(undone.snapshot().installations.installation.pendingUpgrade).toBeUndefined();
    expect(resolveInstallation(loadRegistry(undone), v1, 'Fixture').kind).toBe('known');

    const stuck = memory(fixture());
    const outcome = await abandonUpgrade(upgrade, async () => { throw new Error('restore failure'); }, stuck);
    expect(outcome).toMatchObject({ restored: false, finalized: true });
    expect(outcome.message).toMatch(/recovery-only state/);
    expect(stuck.snapshot().installations.installation.recoveryRequired).toMatchObject({ backup: '/backups/pre-upgrade.sqlite', reason: 'restore failure' });
    expect(resolveInstallation(loadRegistry(stuck), v1, 'Fixture').kind).toBe('recovery-required');
  });

  it('refuses to stage an upgrade on non-durable storage, but still opens new installations', async () => {
    const storage = memory({ version: 1, installations: { [v1]: { dataId: v1, name: 'Fixture', bundleIds: [v1], createdAt: at, updatedAt: at, ledger: [] } } }, { durable: false });
    const chooseUpgrade = async (): Promise<LoaderDecision> => ({ kind: 'upgrade', dataId: v1 });
    await expect(resolveDataIdentity(v2, { name: 'Fixture' }, chooseUpgrade, async () => '/b', never, storage)).rejects.toThrow(UpgradeBlockedError);
    expect(storage.snapshot().installations[v1].pendingUpgrade).toBeUndefined();
    const chooseNew = async (): Promise<LoaderDecision> => ({ kind: 'new' });
    expect(await resolveDataIdentity(v2, { name: 'Fixture' }, chooseNew, never, never, storage)).toEqual({ dataId: v2 });
  });
});

describe('R3-SN-02: an unreadable or partly invalid registry is never an empty healthy one', () => {
  it('treats a failing read as unavailable: nothing resolves, nothing is saved, nothing is opened', async () => {
    const storage = { getItem(): string | null { throw new Error('read failure'); }, setItem() { throw new Error('unreachable'); } };
    const registry = loadRegistry(storage);
    expect(registry.unavailable).toEqual({ reason: 'read failure' });
    expect(resolveInstallation(registry, 'bundle-unseen', 'Fixture')).toEqual({ kind: 'registry-unavailable', reason: 'read failure' });
    const asked: LoaderQuestion[] = [];
    await expect(resolveDataIdentity('bundle-unseen', { name: 'Fixture' }, async q => { asked.push(q); return { kind: 'new' }; }, never, never, storage)).rejects.toThrow(/could not be read \(read failure\)/);
    expect(asked).toHaveLength(0);
  });

  it('keeps an invalid record as damaged material, gates its packages, and refuses ordinary saves', () => {
    const invalid = fixture();
    (invalid.installations.installation as { dataId: string }).dataId = 'mismatched';
    const storage = memory(invalid);
    const before = storage.map.get(REGISTRY_KEY);
    const registry = loadRegistry(storage);
    expect(Object.keys(registry.installations)).toEqual([]);
    expect(registry.damaged?.records).toHaveLength(1);
    expect(registry.damaged?.records[0]).toMatchObject({ dataId: 'installation', bundleIds: [v1] });
    expect(registry.damaged?.records[0].raw).toEqual(invalid.installations.installation);
    expect(registry.damaged?.reason).toMatch(/does not match its key/);
    // The package the damaged record named is gated; the stored bytes are intact and quarantined.
    expect(resolveInstallation(registry, v1, 'Fixture').kind).toBe('registry-damaged');
    expect(resolveInstallation(registry, v2, 'Fixture').kind).toBe('registry-damaged');
    expect(storage.map.get(REGISTRY_KEY)).toBe(before);
    expect(storage.map.get(registry.damaged!.quarantineKey!)).toBe(before);
    // An ordinary save is refused; only an explicit discard rewrites the key.
    expect(saveRegistry(storage, registry)).toBe(false);
    expect(storage.map.get(REGISTRY_KEY)).toBe(before);
    const quarantineKey = registry.damaged!.quarantineKey!;
    expect(saveRegistry(storage, registry, { acknowledgeDamage: true })).toBe(true);
    expect(storage.map.get(quarantineKey)).toBe(before);
    expect(JSON.parse(storage.map.get(REGISTRY_KEY)!)).toEqual({ version: 1, installations: {} });
  });

  it('treats malformed pending or recovery metadata as damage instead of dropping the gate', () => {
    const badPending = fixture();
    (badPending.installations.installation.pendingUpgrade as { backup: unknown }).backup = 42;
    const registry = loadRegistry(memory(badPending));
    expect(registry.installations.installation).toBeUndefined();
    expect(registry.damaged?.records[0]).toMatchObject({ dataId: 'installation', reason: 'pending upgrade metadata is invalid' });
    expect(resolveInstallation(registry, v1, 'Fixture').kind).toBe('registry-damaged');

    const badRecovery = fixture();
    delete (badRecovery.installations.installation as { pendingUpgrade?: unknown }).pendingUpgrade;
    (badRecovery.installations.installation as { recoveryRequired?: unknown }).recoveryRequired = { backup: null };
    const recovery = loadRegistry(memory(badRecovery));
    expect(recovery.damaged?.records[0]).toMatchObject({ reason: 'recovery marker is invalid' });
    expect(resolveInstallation(recovery, v1, 'Fixture').kind).toBe('registry-damaged');
  });

  it('still loads a healthy registry, and a healthy record next to a damaged one, without prompts', () => {
    const healthy = loadRegistry(memory(fixture()));
    expect(healthy.damaged).toBeUndefined();
    expect(healthy.unavailable).toBeUndefined();
    expect(healthy.installations.installation.pendingUpgrade).toMatchObject({ to: v2 });

    const mixed = fixture() as { installations: Record<string, unknown> };
    mixed.installations.other = { dataId: 'other', name: 'Other', bundleIds: ['bundle-other'], createdAt: at, updatedAt: at, ledger: [] };
    mixed.installations.broken = { dataId: 'nope', bundleIds: ['bundle-broken'] };
    const registry = loadRegistry(memory(mixed));
    expect(Object.keys(registry.installations).sort()).toEqual(['installation', 'other']);
    expect(resolveInstallation(registry, 'bundle-other', 'Other')).toMatchObject({ kind: 'known', dataId: 'other' });
    expect(resolveInstallation(registry, 'bundle-broken', 'Broken').kind).toBe('registry-damaged');
    expect(resolveInstallation(registry, 'bundle-unseen', 'Unseen').kind).toBe('registry-damaged');
  });

  it('finish and abandon report an unreadable or damaged registry instead of acting on it', async () => {
    const unreadable = { getItem(): string | null { throw new Error('read failure'); }, setItem() {} };
    expect(finishUpgrade(upgrade, unreadable)).toMatchObject({ finalized: false, reason: expect.stringMatching(/could not be read/) });
    let restoreCalled = false;
    const outcome = await abandonUpgrade(upgrade, async () => { restoreCalled = true; }, unreadable);
    expect(restoreCalled).toBe(false);
    expect(outcome).toMatchObject({ restored: false, finalized: false });
    expect(outcome.message).toMatch(/cannot be confirmed/);
  });
});
