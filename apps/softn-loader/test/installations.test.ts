/**
 * Audit SN-03: bundle digests keep integrity identity; approved upgrades keep
 * a stable data identity; a name alone never grants access to old data.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REGISTRY_KEY,
  approveUpgrade,
  beginUpgrade,
  completeUpgrade,
  rollbackUpgrade,
  emptyRegistry,
  loadRegistry,
  recordNewInstallation,
  resolveInstallation,
  saveRegistry,
  shortIdentity,
} from '../src/installations';

function storage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { store, getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
}

const v1 = 'bundle-' + 'a'.repeat(64);
const v2 = 'bundle-' + 'b'.repeat(64);
const impostor = 'bundle-' + 'c'.repeat(64);

describe('installation identity', () => {
  it('opens an unknown package with no name match as a new installation keyed by its digest', () => {
    const registry = emptyRegistry();
    expect(resolveInstallation(registry, v1, 'Fieldnotes')).toEqual({ kind: 'new', dataId: v1 });
    const record = recordNewInstallation(registry, v1, 'Fieldnotes', '1.0.0', new Date('2026-09-14T00:00:00Z'));
    expect(record.dataId).toBe(v1);
    expect(record.ledger).toEqual([{ from: null, to: v1, at: '2026-09-14T00:00:00.000Z', version: '1.0.0' }]);
    expect(resolveInstallation(registry, v1, 'Fieldnotes')).toMatchObject({ kind: 'known', dataId: v1 });
  });

  it('asks instead of guessing when a different digest repeats an installed name', () => {
    const registry = emptyRegistry();
    recordNewInstallation(registry, v1, 'Fieldnotes', '1.0.0');
    const resolution = resolveInstallation(registry, v2, 'fieldnotes ');
    expect(resolution.kind).toBe('choose');
    if (resolution.kind !== 'choose') throw new Error('unreachable');
    expect(resolution.candidates.map(c => c.dataId)).toEqual([v1]);
    // Nothing changed in the registry: the question has no side effects.
    expect(resolveInstallation(registry, v2, 'Fieldnotes').kind).toBe('choose');
    // An unrelated package with the same name gets the same QUESTION, never the data.
    expect(resolveInstallation(registry, impostor, 'Fieldnotes').kind).toBe('choose');
    expect(Object.values(registry.installations).some(r => r.bundleIds.includes(impostor))).toBe(false);
  });

  it('keeps the data identity across an approved upgrade and remembers the rollback path', () => {
    const registry = emptyRegistry();
    recordNewInstallation(registry, v1, 'Fieldnotes', '1.0.0', new Date('2026-09-01T00:00:00Z'));
    const upgraded = approveUpgrade(registry, v2, v1, { manifestName: 'Fieldnotes', version: '2.0.0', backup: 'C:/data/apps/x/pre-upgrade-1.sqlite' }, new Date('2026-09-14T00:00:00Z'));
    expect(upgraded.dataId).toBe(v1);
    expect(upgraded.bundleIds).toEqual([v1, v2]);
    expect(upgraded.ledger[1]).toEqual({ from: v1, to: v2, at: '2026-09-14T00:00:00.000Z', version: '2.0.0', backup: 'C:/data/apps/x/pre-upgrade-1.sqlite' });
    // Both packages now open the same data; reopening v1 is the rollback.
    expect(resolveInstallation(registry, v2, 'Fieldnotes')).toMatchObject({ kind: 'known', dataId: v1 });
    expect(resolveInstallation(registry, v1, 'Fieldnotes')).toMatchObject({ kind: 'known', dataId: v1 });
    // Idempotent approval.
    approveUpgrade(registry, v2, v1);
    expect(upgraded.bundleIds).toEqual([v1, v2]);
    expect(upgraded.ledger).toHaveLength(2);
    expect(() => approveUpgrade(registry, v2, 'bundle-missing')).toThrow(/not registered/);
  });

  it('open-as-new keeps installations separate even with identical names', () => {
    const registry = emptyRegistry();
    recordNewInstallation(registry, v1, 'Fieldnotes');
    recordNewInstallation(registry, v2, 'Fieldnotes');
    expect(resolveInstallation(registry, v2, 'Fieldnotes')).toMatchObject({ kind: 'known', dataId: v2 });
    const resolution = resolveInstallation(registry, impostor, 'Fieldnotes');
    expect(resolution.kind).toBe('choose');
    if (resolution.kind === 'choose') expect(resolution.candidates).toHaveLength(2);
  });

  it('persists to the runtime storage and survives a damaged registry without deleting it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = storage();
    const registry = emptyRegistry();
    recordNewInstallation(registry, v1, 'Fieldnotes');
    expect(saveRegistry(store, registry)).toBe(true);
    expect(loadRegistry(store)).toEqual(registry);

    // R2-SN-03: a damaged registry is quarantined, marked, and never silently replaced.
    const damaged = storage({ [REGISTRY_KEY]: '{"version":1,"installations":{"x":' });
    const loadedDamaged = loadRegistry(damaged);
    expect(loadedDamaged.installations).toEqual({});
    expect(loadedDamaged.damaged?.quarantineKey).toMatch(/^softn-loader:installations\.corrupt\./);
    expect(damaged.store.get(loadedDamaged.damaged!.quarantineKey!)).toBe('{"version":1,"installations":{"x":');
    expect(damaged.store.get(REGISTRY_KEY)).toBe('{"version":1,"installations":{"x":');
    expect(resolveInstallation(loadedDamaged, v2, 'Fieldnotes').kind).toBe('registry-damaged');
    expect(saveRegistry(damaged, loadedDamaged)).toBe(false);
    expect(damaged.store.get(REGISTRY_KEY)).toBe('{"version":1,"installations":{"x":');
    expect(saveRegistry(damaged, loadedDamaged, { acknowledgeDamage: true })).toBe(true);
    expect(loadRegistry(damaged)).toEqual(emptyRegistry());

    const wrongShape = storage({ [REGISTRY_KEY]: JSON.stringify({ version: 1, installations: { [v1]: { dataId: 'other', bundleIds: [v1] }, [v2]: { dataId: v2, bundleIds: 'nope' }, [impostor]: { dataId: impostor, bundleIds: [impostor, 5] } } }) });
    const loaded = loadRegistry(wrongShape);
    expect(Object.keys(loaded.installations)).toEqual([impostor]);
    expect(loaded.installations[impostor].bundleIds).toEqual([impostor]);

    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadRegistry(throwing)).toEqual(emptyRegistry());
    expect(saveRegistry(throwing, registry)).toBe(false);
    errors.mockRestore();
  });

  // ── R2-SN-03: an upgrade is staged, completed only after the new package starts, or rolled back ──

  it('stages an upgrade with a verified backup, maps the digest only on completion, and rolls back otherwise', () => {
    const registry = emptyRegistry();
    recordNewInstallation(registry, v1, 'Fieldnotes', '1.0.0');
    expect(() => beginUpgrade(registry, v2, v1, { backup: '' })).toThrow(/verified pre-upgrade backup/);
    beginUpgrade(registry, v2, v1, { backup: '/data/pre-upgrade-1.sqlite', version: '2.0.0', manifestName: 'Fieldnotes' }, new Date('2026-09-14T00:00:00Z'));
    // Staged, not mapped: the new digest resolves as pending, the old one still works.
    expect(registry.installations[v1].bundleIds).toEqual([v1]);
    expect(resolveInstallation(registry, v2, 'Fieldnotes')).toMatchObject({ kind: 'pending-upgrade', dataId: v1 });
    expect(resolveInstallation(registry, v1, 'Fieldnotes')).toMatchObject({ kind: 'known', dataId: v1 });
    expect(() => beginUpgrade(registry, impostor, v1, { backup: '/x' })).toThrow(/still pending/);
    // The staging survives a save/load round trip (it is what a restart resumes from).
    const store = storage();
    expect(saveRegistry(store, registry)).toBe(true);
    expect(resolveInstallation(loadRegistry(store), v2, 'Fieldnotes')).toMatchObject({ kind: 'pending-upgrade' });

    // Rolled back after a failed start: the digest is forgotten, data identity untouched.
    const failed = loadRegistry(store);
    rollbackUpgrade(failed, v1, { restored: true });
    expect(failed.installations[v1].pendingUpgrade).toBeUndefined();
    expect(resolveInstallation(failed, v2, 'Fieldnotes').kind).toBe('choose');

    // Completed after a successful start: mapped with a ledger entry carrying the backup.
    const ok = loadRegistry(store);
    completeUpgrade(ok, v1, new Date('2026-09-14T01:00:00Z'));
    expect(ok.installations[v1].bundleIds).toEqual([v1, v2]);
    expect(ok.installations[v1].pendingUpgrade).toBeUndefined();
    expect(ok.installations[v1].ledger[1]).toMatchObject({ from: v1, to: v2, backup: '/data/pre-upgrade-1.sqlite', version: '2.0.0' });
    expect(() => completeUpgrade(ok, v1)).toThrow(/No pending upgrade/);

    // A rollback whose restore failed leaves an explicit recovery-only state that blocks opening.
    const stuck = loadRegistry(store);
    rollbackUpgrade(stuck, v1, { restored: false, reason: 'disk full' });
    expect(stuck.installations[v1].recoveryRequired).toMatchObject({ backup: '/data/pre-upgrade-1.sqlite', reason: 'disk full' });
    expect(resolveInstallation(stuck, v1, 'Fieldnotes').kind).toBe('recovery-required');
    expect(resolveInstallation(stuck, v2, 'Fieldnotes').kind).toBe('recovery-required');
    expect(() => beginUpgrade(stuck, impostor, v1, { backup: '/y' })).toThrow(/needs recovery/);
  });

  it('shortens identities for display without hiding their difference', () => {
    expect(shortIdentity(v1)).toBe('aaaaaaaa…aaaaaaaa');
    expect(shortIdentity(v2)).not.toBe(shortIdentity(v1));
    expect(shortIdentity('short')).toBe('short');
  });
});
