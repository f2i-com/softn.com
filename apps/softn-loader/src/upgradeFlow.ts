/**
 * The loader's installation-identity and upgrade decisions, kept free of
 * React and Tauri so they can be tested as the pure state machine they are
 * (R2-SN-03, R3-SN-01, R3-SN-02).
 *
 * Every transition that matters is DURABLE before it is claimed:
 *  - an upgrade is staged (backup verified, pending record saved) before the
 *    new package touches the data;
 *  - it is complete only when the new package has started AND the completion
 *    was saved; a failed save keeps the pending record and stops the app;
 *  - undoing it reports separately whether the DATA was restored and whether
 *    the METADATA transition was recorded, and never claims more.
 */
import {
  type InstallationRecord,
  type PendingUpgrade,
  type UpgradeOperation,
  beginUpgrade,
  completeUpgrade,
  loadRegistry,
  pendingMatches,
  recordNewInstallation,
  resolveInstallation,
  rollbackUpgrade,
  saveRegistry,
} from './installations';

export type { UpgradeOperation as UpgradeInProgress } from './installations';

/** The question a changed package asks before it touches any data (audit SN-03). */
export interface InstallationChoice {
  kind: 'upgrade';
  bundleId: string;
  name: string;
  version?: string;
  candidates: InstallationRecord[];
}

/** The registry itself is unreadable: nothing about an unknown package can be decided (R2-SN-03). */
export interface RegistryDamagedChoice {
  kind: 'registry-damaged';
  quarantineKey: string | null;
  reason: string;
}

/**
 * The installation this package maps to has an upgrade to ANOTHER package
 * that never finished (R3-SN-01). Roll the data back to the pre-upgrade
 * snapshot and open this package, or cancel and open the newer package to
 * finish the upgrade.
 */
export interface UnresolvedUpgradeChoice {
  kind: 'upgrade-unresolved';
  dataId: string;
  name: string;
  pending: PendingUpgrade;
}

export type LoaderQuestion = InstallationChoice | RegistryDamagedChoice | UnresolvedUpgradeChoice;
export type LoaderDecision = { kind: 'new' } | { kind: 'upgrade'; dataId: string } | { kind: 'discard' } | { kind: 'rollback' } | { kind: 'cancel' };

export class UpgradeBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'UpgradeBlockedError'; }
}

export interface RegistryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** False when nothing written here survives the session (opaque origin fallback). */
  durable?: boolean;
}

// One in-memory registry for the whole session when the webview has no
// storage (opaque origin): identity is at least stable while the runtime is
// open, and it is marked non-durable so no upgrade can be staged on it.
const sessionRegistry = new Map<string, string>();

/** The runtime's own storage for the installation registry; never an app's records. */
export function registryStorage(): RegistryStorageLike {
  try {
    if (typeof localStorage !== 'undefined') return { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), durable: true };
  } catch {
    // Opaque origin: fall back to the session registry below.
  }
  return { getItem: key => sessionRegistry.get(key) ?? null, setItem: (key, value) => { sessionRegistry.set(key, value); }, durable: false };
}

export type IdentityDecision = { dataId: string; upgrade?: UpgradeOperation };

/**
 * Resolve the DATA identity for an opened bundle. The digest stays the
 * integrity identity; a mapped digest reuses its data namespace; an unmapped
 * digest that repeats an installed name asks the person before anything is
 * seeded or shown (open as new, or upgrade one installation). Nothing is
 * ever inherited on a name alone.
 *
 * An upgrade is STAGED, not approved (R2-SN-03): it needs a verified backup
 * and a durable registry write first, otherwise it stops with an actionable
 * error; the digest is mapped only when the new package has started, and a
 * failed start restores the snapshot and drops the staging.
 *
 * Gating (R3-SN-01 / R3-SN-02): an unreadable registry opens nothing; an
 * installation with an unfinished upgrade opens no package until the person
 * rolls back (here) or finishes it (by opening the newer package).
 */
export async function resolveDataIdentity(
  bundleId: string,
  manifest: { name?: string; version?: string },
  ask: (question: LoaderQuestion) => Promise<LoaderDecision>,
  backup: (dataId: string) => Promise<string>,
  restore: (dataId: string, backup: string) => Promise<void>,
  storage: RegistryStorageLike = registryStorage()
): Promise<IdentityDecision | null> {
  let registry = loadRegistry(storage);
  let resolution = resolveInstallation(registry, bundleId, manifest.name);
  if (resolution.kind === 'registry-unavailable') {
    throw new UpgradeBlockedError(`The installation records could not be read (${resolution.reason}), so this package cannot be matched to its data. Nothing was opened and nothing was changed; make the runtime's storage readable and try again.`);
  }
  if (resolution.kind === 'registry-damaged') {
    const decision = await ask({ kind: 'registry-damaged', quarantineKey: resolution.quarantineKey, reason: resolution.reason });
    if (decision.kind !== 'discard') return null;
    // The quarantined copy stays; the valid records (if any) are rewritten under the key.
    if (!saveRegistry(storage, registry, { acknowledgeDamage: true })) {
      throw new UpgradeBlockedError('The installation records could not be rewritten. Nothing was opened.');
    }
    registry = loadRegistry(storage);
    resolution = resolveInstallation(registry, bundleId, manifest.name);
    if (resolution.kind === 'registry-damaged' || resolution.kind === 'registry-unavailable') throw new UpgradeBlockedError('The installation records are still unreadable after discarding them. Nothing was opened.');
  }
  if (resolution.kind === 'recovery-required') {
    const r = resolution.record.recoveryRequired!;
    throw new UpgradeBlockedError(`This installation needs recovery before it can be opened: a failed upgrade could not be rolled back (${r.reason}). Its pre-upgrade backup is ${r.backup}.`);
  }
  if (resolution.kind === 'pending-upgrade') {
    // The previous session approved this upgrade and never confirmed it
    // started. Try again with the SAME backup; completion is recorded on load.
    return { dataId: resolution.dataId, upgrade: { dataId: resolution.dataId, bundleId, backup: resolution.pending.backup } };
  }
  if (resolution.kind === 'upgrade-unresolved') {
    const { dataId, pending, record } = resolution;
    const decision = await ask({ kind: 'upgrade-unresolved', dataId, name: record.name, pending });
    if (decision.kind !== 'rollback') return null;
    try {
      await restore(dataId, pending.backup);
    } catch (error) {
      throw new UpgradeBlockedError(`The pre-upgrade backup could not be restored (${error instanceof Error ? error.message : String(error)}). The installation stays blocked and its data was not changed by this attempt; the backup is at ${pending.backup}.`);
    }
    rollbackUpgrade(registry, dataId, { restored: true });
    if (!saveRegistry(storage, registry)) {
      throw new UpgradeBlockedError(`The data was restored from ${pending.backup}, but the upgrade record could not be cleared, so the installation stays blocked until the runtime's storage is writable. Nothing else was changed.`);
    }
    return { dataId };
  }
  if (resolution.kind === 'known') return { dataId: resolution.dataId };
  const persistNew = (): IdentityDecision => {
    recordNewInstallation(registry, bundleId, manifest.name, manifest.version);
    if (!saveRegistry(storage, registry)) {
      throw new UpgradeBlockedError('The installation record could not be saved, so this app was not opened: its data would be lost after a restart. Free storage and try again.');
    }
    return { dataId: bundleId };
  };
  if (resolution.kind === 'new') return persistNew();
  const choice = resolution;
  const decision = await ask({ kind: 'upgrade', bundleId, name: choice.name, version: manifest.version, candidates: choice.candidates });
  if (decision.kind !== 'new' && decision.kind !== 'upgrade') return null;
  if (decision.kind === 'new') return persistNew();
  if (storage.durable === false) {
    throw new UpgradeBlockedError('This runtime has no durable storage for installation records here (private browsing or an opaque origin), so an interrupted upgrade could never be recovered after a restart. The upgrade was not applied; open the previous package, or open this one as a new app.');
  }

  // Upgrade: verified snapshot FIRST, then a durable staging record, then the
  // package may touch the data. Either failure stops the upgrade unapplied.
  let backupPath: string;
  try {
    backupPath = await backup(decision.dataId);
  } catch (error) {
    throw new UpgradeBlockedError(`The upgrade was not applied because a backup of the installed data could not be taken (${error instanceof Error ? error.message : String(error)}). Reopen the previous package, or free disk space and try again.`);
  }
  beginUpgrade(registry, bundleId, decision.dataId, { backup: backupPath, manifestName: manifest.name, version: manifest.version });
  if (!saveRegistry(storage, registry)) {
    throw new UpgradeBlockedError('The upgrade was not applied because its record could not be saved; without it the upgrade would be forgotten after a restart. Free storage and try again.');
  }
  return { dataId: decision.dataId, upgrade: { dataId: decision.dataId, bundleId, backup: backupPath } };
}

export type FinishOutcome = { finalized: true } | { finalized: false; reason: string };

/**
 * The new package started: map its digest DURABLY. Not finalized means the
 * pending record is still the truth; the caller must not let the app run on
 * as if the upgrade were complete (R3-SN-01). Idempotent: a completion that
 * was already recorded by an earlier attempt is reported as finalized.
 */
export function finishUpgrade(upgrade: UpgradeOperation, storage: RegistryStorageLike = registryStorage()): FinishOutcome {
  const registry = loadRegistry(storage);
  if (registry.unavailable) return { finalized: false, reason: `the installation records could not be read (${registry.unavailable.reason})` };
  if (registry.damaged) return { finalized: false, reason: `the installation records are damaged (${registry.damaged.reason})` };
  const record = registry.installations[upgrade.dataId];
  if (!record) return { finalized: false, reason: 'the installation is no longer registered' };
  if (!record.pendingUpgrade) {
    return record.bundleIds.includes(upgrade.bundleId)
      ? { finalized: true }
      : { finalized: false, reason: 'no pending upgrade matches this package' };
  }
  if (!pendingMatches(record, upgrade)) return { finalized: false, reason: 'the pending upgrade record belongs to a different operation' };
  completeUpgrade(registry, upgrade.dataId);
  return saveRegistry(storage, registry) ? { finalized: true } : { finalized: false, reason: 'the completion could not be saved' };
}

export interface AbandonOutcome {
  /** The data snapshot was restored (true) or the restore failed (false). */
  restored: boolean;
  /** The registry transition (undo, or recovery-only marker) was saved. */
  finalized: boolean;
  message: string;
}

/**
 * The new package failed to start: put the data snapshot back and drop the
 * staged upgrade, or leave an explicit recovery-only state when the snapshot
 * cannot be restored. The two results are reported separately (R3-SN-01):
 * a restored snapshot with an unsaved record is NOT "the upgrade was undone",
 * and an unsaved recovery marker is NOT "the installation is in recovery
 * mode" — in both cases the pending record remains and keeps every package
 * of the installation gated until the person resolves it.
 */
export async function abandonUpgrade(
  upgrade: UpgradeOperation,
  restore: (dataId: string, backup: string) => Promise<void>,
  storage: RegistryStorageLike = registryStorage()
): Promise<AbandonOutcome> {
  const registry = loadRegistry(storage);
  if (registry.unavailable) return { restored: false, finalized: false, message: `The installation records could not be read (${registry.unavailable.reason}), so whether this upgrade changed the data cannot be confirmed here. Its pre-upgrade backup is at ${upgrade.backup}.` };
  const record = registry.installations[upgrade.dataId];
  if (registry.damaged && !record) return { restored: false, finalized: false, message: `The installation records are damaged (${registry.damaged.reason}), so this upgrade cannot be undone automatically. Its pre-upgrade backup is at ${upgrade.backup}.` };
  if (!pendingMatches(record, upgrade)) return { restored: false, finalized: false, message: 'The upgrade record is missing or belongs to a different operation; the installed data was not changed by this loader.' };
  try {
    await restore(upgrade.dataId, upgrade.backup);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    rollbackUpgrade(registry, upgrade.dataId, { restored: false, reason });
    if (saveRegistry(storage, registry)) {
      return { restored: false, finalized: true, message: `The app failed to start AND its data could not be restored from the pre-upgrade backup (${reason}). The installation is in a recovery-only state; the backup is at ${upgrade.backup}.` };
    }
    return { restored: false, finalized: false, message: `The app failed to start, its data could not be restored from the pre-upgrade backup (${reason}), and that recovery state could not be recorded either. The upgrade stays recorded as pending, so this installation remains blocked for every package until the runtime's storage is writable; the backup is at ${upgrade.backup}.` };
  }
  rollbackUpgrade(registry, upgrade.dataId, { restored: true });
  if (saveRegistry(storage, registry)) {
    return { restored: true, finalized: true, message: 'The app failed to start, so its data was restored from the pre-upgrade backup and the upgrade was undone.' };
  }
  return { restored: true, finalized: false, message: `The app failed to start and its data was restored from the pre-upgrade backup, but the upgrade record could not be updated, so the upgrade is still recorded as pending. Opening either package will ask you to resolve it; nothing else was changed. The backup is at ${upgrade.backup}.` };
}
