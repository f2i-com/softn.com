/**
 * The page's side of the native data identity (src-tauri/src/data_identity.rs):
 * what it hands over at start, and how it asks for data to be bound.
 */
import { describe, expect, it, vi } from 'vitest';
import { REGISTRY_KEY } from '../src/installations';
import { bindDataIdentity, chooseDataIdentity, handOverRegistry } from '../src/nativeIdentity';
import type { InstallationChoice } from '../src/upgradeFlow';

const stored = JSON.stringify({ version: 1, installations: {} });

describe('handing the registry over at start', () => {
  it('sends the stored text as it is, for the native side to judge', async () => {
    const invoke = vi.fn().mockResolvedValue({ imported: 0, skipped: 0 });
    await handOverRegistry(invoke, { getItem: (key) => (key === REGISTRY_KEY ? stored : null) });
    expect(invoke).toHaveBeenCalledWith('import_installations', { registry: stored });
  });

  it('says there is none when nothing is stored', async () => {
    const invoke = vi.fn().mockResolvedValue({ imported: 0, skipped: 0 });
    await handOverRegistry(invoke, { getItem: () => null });
    expect(invoke).toHaveBeenCalledWith('import_installations', { registry: null });
  });

  it('sends nothing when the storage cannot be read, so a later start can still hand it over', async () => {
    const invoke = vi.fn();
    await handOverRegistry(invoke, { getItem: () => { throw new Error('SecurityError'); } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('takes a refusal (the ordinary answer after the first start) quietly', async () => {
    const invoke = vi.fn().mockRejectedValue('The installation records are no longer taken from the page');
    await expect(handOverRegistry(invoke, { getItem: () => stored })).resolves.toBeUndefined();
  });

  it('does nothing outside the native runtime', async () => {
    await expect(handOverRegistry(undefined, { getItem: () => stored })).resolves.toBeUndefined();
  });
});

describe('binding and the upgrade question', () => {
  const question: InstallationChoice = {
    kind: 'upgrade',
    bundleId: 'bundle-new',
    name: 'Notes',
    candidates: [
      { dataId: 'bundle-old', name: 'Notes', bundleIds: ['bundle-old'], createdAt: '', updatedAt: '', ledger: [] },
      { dataId: 'bundle-older', name: 'Notes', bundleIds: ['bundle-older'], createdAt: '', updatedAt: '', ledger: [] },
    ],
  };

  it('asks the native side, naming the candidates in the order the page ranked them', async () => {
    const invoke = vi.fn().mockResolvedValue({ kind: 'upgrade', dataId: 'bundle-old' });
    await expect(chooseDataIdentity(question, invoke)).resolves.toEqual({ kind: 'upgrade', dataId: 'bundle-old' });
    expect(invoke).toHaveBeenCalledWith('choose_data_identity', { bundleId: 'bundle-new', candidates: ['bundle-old', 'bundle-older'] });
  });

  it('reads anything but a whole answer as cancel', async () => {
    for (const reply of [{ kind: 'new' }, { kind: 'cancel' }, { kind: 'upgrade' }, { kind: 'upgrade', dataId: 7 }, null, 'yes']) {
      const decision = await chooseDataIdentity(question, vi.fn().mockResolvedValue(reply));
      expect(decision).toEqual(reply && typeof reply === 'object' && reply.kind === 'new' ? { kind: 'new' } : { kind: 'cancel' });
    }
  });

  it('binds with the digest the page computed and the manifest name only when it is text', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    await bindDataIdentity('bundle-new', 'bundle-old', { name: ['Notes'], version: '2.0' }, false, invoke);
    expect(invoke).toHaveBeenCalledWith('bind_data_identity', { bundleId: 'bundle-new', dataId: 'bundle-old', name: undefined, version: '2.0', start: false });
    await bindDataIdentity('bundle-new', 'bundle-old', {}, true, invoke);
    expect(invoke).toHaveBeenLastCalledWith('bind_data_identity', { bundleId: 'bundle-new', dataId: 'bundle-old', name: undefined, version: undefined, start: true });
    await expect(bindDataIdentity('bundle-new', 'bundle-old', {}, false, vi.fn().mockRejectedValue('Not opened'))).rejects.toBe('Not opened');
    await expect(bindDataIdentity('bundle-new', 'bundle-old', {}, false, undefined)).rejects.toThrow('not available');
  });
});
