/**
 * The loader's installation-identity and upgrade decisions, kept free of
 * React and Tauri so they can be tested as the pure state machine they are
 * (R2-SN-03, R3-SN-01, R3-SN-02, R4-SN-01, R4-SN-02).
 *
 * Every transition that matters is DURABLE before it is claimed:
 *  - an upgrade is staged (backup verified, pending record saved) before the
 *    new package touches the data;
 *  - it is complete only when the new package has started AND the completion
 *    was saved; a failed save keeps the pending record and stops the app;
 *  - undoing it reports separately whether the DATA was restored and whether
 *    the METADATA transition was recorded, and never claims more.
 *
 * And no registry snapshot ever survives an await (R4-SN-01): a person's
 * decision, a backup or a restore can take arbitrarily long, and other
 * operations (another bundle opened in the meantime, another context sharing
 * the same storage) may have changed the registry. Every commit re-reads the
 * stored registry, revalidates the operation against it and writes only the
 * records it owns; a stale operation is refused, never applied. Within one
 * JavaScript context a commit is synchronous (read, mutate, write), so two
 * flows cannot interleave inside it; across contexts sharing one storage the
 * window is the read-modify-write itself, which browsers serialise per
 * origin — this is documented, not claimed to be a distributed lock.
 */
import {
  type InstallationRecord,
  type InstallationRegistry,
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

/**
 * A failed upgrade could not be rolled back and the installation is in the
 * recovery-only state (R4-SN-02). The person may retry the restore from the
 * same verified backup here, or cancel and keep the backup for a manual
 * recovery; the block lifts only after BOTH the restore and the record
 * update succeeded.
 */
export interface RecoveryRequiredChoice {
  kind: 'recovery-required';
  dataId: string;
  name: string;
  recovery: { backup: string; reason: string; at: string };
}

export type LoaderQuestion = InstallationChoice | RegistryDamagedChoice | UnresolvedUpgradeChoice | RecoveryRequiredChoice;
export type LoaderDecision =
  | { kind: 'new' }
  | { kind: 'upgrade'; dataId: string }
  | { kind: 'discard' }
  | { kind: 'rollback' }
  | { kind: 'retry-restore' }
  | { kind: 'cancel' };

export class UpgradeBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'UpgradeBlockedError'; }
}

export interface RegistryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** False when nothing written here survives the session (opaque origin fallback). */
  durable?: boolean;
}

/** Cancellation of the open that started an operation (a newer selection, home). */
export interface CancelSignal {
  readonly aborted: boolean;
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
 * One registry commit (R4-SN-01): read the CURRENT stored registry, let
 * `mutate` validate the operation against it and change only what it owns,
 * then save. `mutate` throws to refuse; the registry is then left as it was.
 * Synchronous end to end, so nothing can interleave inside it in this
 * context. Returns null when the save failed (the caller decides what that
 * means for its claim).
 */
export function commitRegistry<T>(
  storage: RegistryStorageLike,
  mutate: (registry: InstallationRegistry) => T,
  options: { acknowledgeDamage?: boolean } = {}
): { saved: true; result: T; registry: InstallationRegistry } | { saved: false; result: T; registry: InstallationRegistry } {
  const registry = loadRegistry(storage);
  const result = mutate(registry);
  return saveRegistry(storage, registry, options) ? { saved: true, result, registry } : { saved: false, result, registry };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
 * rolls back (here) or finishes it (by opening the newer package); a
 * recovery-only installation offers a verified retry (R4-SN-02).
 *
 * Every decision is re-derived from the stored registry after each await
 * (R4-SN-01); `signal.aborted` (the person opened something else meanwhile)
 * stops the operation before any new side effect. A restore that already
 * ran is still committed to the registry even when cancelled: abandoning a
 * finished data change would leave the record lying about the data.
 */
export async function resolveDataIdentity(
  bundleId: string,
  manifest: { name?: string; version?: string },
  ask: (question: LoaderQuestion) => Promise<LoaderDecision>,
  backup: (dataId: string) => Promise<string>,
  restore: (dataId: string, backup: string) => Promise<void>,
  storage: RegistryStorageLike = registryStorage(),
  signal: CancelSignal = { aborted: false }
): Promise<IdentityDecision | null> {
  // Bounded: every iteration either returns, throws, or changed the registry
  // so the next resolution differs (a recovery cleared markers, a discard
  // rewrote the key, or another operation changed the record meanwhile).
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal.aborted) return null;
    const resolution = resolveInstallation(loadRegistry(storage), bundleId, manifest.name);
    switch (resolution.kind) {
      case 'registry-unavailable':
        throw new UpgradeBlockedError(`The installation records could not be read (${resolution.reason}), so this package cannot be matched to its data. Nothing was opened and nothing was changed; make the runtime's storage readable and try again.`);

      case 'registry-damaged': {
        const decision = await ask({ kind: 'registry-damaged', quarantineKey: resolution.quarantineKey, reason: resolution.reason });
        if (decision.kind !== 'discard' || signal.aborted) return null;
        // The quarantined copy stays; the valid records (if any) are rewritten under the key.
        const commit = commitRegistry(storage, registry => {
          if (registry.unavailable) throw new UpgradeBlockedError('The installation records became unreadable; nothing was opened.');
        }, { acknowledgeDamage: true });
        if (!commit.saved) throw new UpgradeBlockedError('The installation records could not be rewritten. Nothing was opened.');
        continue;
      }

      case 'recovery-required': {
        const { dataId, record } = resolution;
        const recovery = record.recoveryRequired!;
        const decision = await ask({ kind: 'recovery-required', dataId, name: record.name, recovery });
        if (decision.kind !== 'retry-restore' || signal.aborted) return null;
        await recoverInstallation({ dataId, backup: recovery.backup }, restore, storage);
        if (signal.aborted) return null;
        continue;
      }

      case 'pending-upgrade':
        // The previous session approved this upgrade and never confirmed it
        // started. Try again with the SAME backup; completion is recorded on load.
        return { dataId: resolution.dataId, upgrade: { dataId: resolution.dataId, bundleId, backup: resolution.pending.backup } };

      case 'upgrade-unresolved': {
        const { dataId, pending, record } = resolution;
        const decision = await ask({ kind: 'upgrade-unresolved', dataId, name: record.name, pending });
        if (decision.kind !== 'rollback' || signal.aborted) return null;
        const operation: UpgradeOperation = { dataId, bundleId: pending.to, backup: pending.backup };
        try {
          await restore(dataId, pending.backup);
        } catch (error) {
          throw new UpgradeBlockedError(`The pre-upgrade backup could not be restored (${errorText(error)}). The installation stays blocked and its data was not changed by this attempt; the backup is at ${pending.backup}.`);
        }
        // The data changed: record it even if the open was cancelled meanwhile.
        const commit = commitRegistry(storage, registry => {
          const fresh = registry.installations[dataId];
          if (!pendingMatches(fresh, operation)) throw new UpgradeBlockedError(`The data was restored from ${pending.backup}, but the upgrade record changed meanwhile (another operation on this installation), so nothing was recorded for it. Reopen the file to see the current state.`);
          rollbackUpgrade(registry, dataId, { restored: true });
        });
        if (!commit.saved) throw new UpgradeBlockedError(`The data was restored from ${pending.backup}, but the upgrade record could not be cleared, so the installation stays blocked until the runtime's storage is writable. Nothing else was changed.`);
        if (signal.aborted) return null;
        return { dataId };
      }

      case 'known':
        return { dataId: resolution.dataId };

      case 'new': {
        const commit = commitRegistry(storage, registry => {
          const now = resolveInstallation(registry, bundleId, manifest.name);
          if (now.kind !== 'new') return false;
          recordNewInstallation(registry, bundleId, manifest.name, manifest.version);
          return true;
        });
        if (!commit.result) continue; // something else claimed or changed it meanwhile: decide again
        if (!commit.saved) throw new UpgradeBlockedError('The installation record could not be saved, so this app was not opened: its data would be lost after a restart. Free storage and try again.');
        return { dataId: bundleId };
      }

      case 'choose': {
        const choice = resolution;
        const decision = await ask({ kind: 'upgrade', bundleId, name: choice.name, version: manifest.version, candidates: choice.candidates });
        if (signal.aborted) return null;
        if (decision.kind === 'new') {
          const commit = commitRegistry(storage, registry => {
            const now = resolveInstallation(registry, bundleId, manifest.name);
            if (now.kind !== 'new' && now.kind !== 'choose') return false;
            recordNewInstallation(registry, bundleId, manifest.name, manifest.version);
            return true;
          });
          if (!commit.result) continue;
          if (!commit.saved) throw new UpgradeBlockedError('The installation record could not be saved, so this app was not opened: its data would be lost after a restart. Free storage and try again.');
          return { dataId: bundleId };
        }
        if (decision.kind !== 'upgrade') return null;
        if (storage.durable === false) {
          throw new UpgradeBlockedError('This runtime has no durable storage for installation records here (private browsing or an opaque origin), so an interrupted upgrade could never be recovered after a restart. The upgrade was not applied; open the previous package, or open this one as a new app.');
        }
        // The installation must still be eligible BEFORE the (slow) backup, and
        // again at commit; both checks read the stored registry, not a snapshot.
        assertUpgradable(loadRegistry(storage), bundleId, decision.dataId);
        let backupPath: string;
        try {
          backupPath = await backup(decision.dataId);
        } catch (error) {
          throw new UpgradeBlockedError(`The upgrade was not applied because a backup of the installed data could not be taken (${errorText(error)}). Reopen the previous package, or free disk space and try again.`);
        }
        if (signal.aborted) return null; // nothing staged: the backup file is an unused snapshot
        // Upgrade: verified snapshot FIRST, then a durable staging record, then the
        // package may touch the data. Either failure stops the upgrade unapplied.
        const commit = commitRegistry(storage, registry => {
          assertUpgradable(registry, bundleId, decision.dataId);
          beginUpgrade(registry, bundleId, decision.dataId, { backup: backupPath, manifestName: manifest.name, version: manifest.version });
        });
        if (!commit.saved) throw new UpgradeBlockedError('The upgrade was not applied because its record could not be saved; without it the upgrade would be forgotten after a restart. Free storage and try again.');
        return { dataId: decision.dataId, upgrade: { dataId: decision.dataId, bundleId, backup: backupPath } };
      }
    }
  }
  throw new UpgradeBlockedError('The installation records kept changing while this package was being opened. Nothing was opened; try again.');
}

/** Refuse an upgrade the CURRENT registry does not allow (R4-SN-01). */
function assertUpgradable(registry: InstallationRegistry, bundleId: string, dataId: string): void {
  if (registry.unavailable) throw new UpgradeBlockedError('The installation records became unreadable; the upgrade was not applied.');
  if (registry.damaged) throw new UpgradeBlockedError('The installation records are damaged; the upgrade was not applied until they are resolved.');
  const record = registry.installations[dataId];
  if (!record) throw new UpgradeBlockedError('The installation to upgrade is no longer registered; the upgrade was not applied.');
  if (record.recoveryRequired) throw new UpgradeBlockedError('This installation needs recovery before it can be upgraded; the upgrade was not applied.');
  if (record.pendingUpgrade && record.pendingUpgrade.to !== bundleId) throw new UpgradeBlockedError('Another upgrade of this installation is already pending; resolve it first. The upgrade was not applied.');
  const owner = Object.values(registry.installations).find(r => r.bundleIds.includes(bundleId) || (r.pendingUpgrade?.to === bundleId && r.dataId !== dataId));
  if (owner) throw new UpgradeBlockedError('This package was mapped to an installation meanwhile; reopen the file. The upgrade was not applied.');
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
 *
 * The registry is re-read after the restore (R4-SN-01): only this operation's
 * markers change, and only if they are still this operation's.
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
  const stale = 'the upgrade record changed meanwhile (another operation on this installation), so nothing was recorded for it';
  try {
    await restore(upgrade.dataId, upgrade.backup);
  } catch (error) {
    const reason = errorText(error);
    const commit = commitRegistry(storage, fresh => {
      if (!pendingMatches(fresh.installations[upgrade.dataId], upgrade)) return false;
      rollbackUpgrade(fresh, upgrade.dataId, { restored: false, reason });
      return true;
    });
    if (!commit.result) return { restored: false, finalized: false, message: `The app failed to start, its data could not be restored from the pre-upgrade backup (${reason}), and ${stale}. The backup is at ${upgrade.backup}.` };
    if (commit.saved) {
      return { restored: false, finalized: true, message: `The app failed to start AND its data could not be restored from the pre-upgrade backup (${reason}). The installation is in a recovery-only state; the backup is at ${upgrade.backup}.` };
    }
    return { restored: false, finalized: false, message: `The app failed to start, its data could not be restored from the pre-upgrade backup (${reason}), and that recovery state could not be recorded either. The upgrade stays recorded as pending, so this installation remains blocked for every package until the runtime's storage is writable; the backup is at ${upgrade.backup}.` };
  }
  const commit = commitRegistry(storage, fresh => {
    if (!pendingMatches(fresh.installations[upgrade.dataId], upgrade)) return false;
    rollbackUpgrade(fresh, upgrade.dataId, { restored: true });
    return true;
  });
  if (!commit.result) return { restored: true, finalized: false, message: `The app failed to start and its data was restored from the pre-upgrade backup, but ${stale}. Reopen the file to see the current state; the backup is at ${upgrade.backup}.` };
  if (commit.saved) {
    return { restored: true, finalized: true, message: 'The app failed to start, so its data was restored from the pre-upgrade backup and the upgrade was undone.' };
  }
  return { restored: true, finalized: false, message: `The app failed to start and its data was restored from the pre-upgrade backup, but the upgrade record could not be updated, so the upgrade is still recorded as pending. Opening either package will ask you to resolve it; nothing else was changed. The backup is at ${upgrade.backup}.` };
}

/**
 * Retry the recovery of a recovery-only installation from its verified
 * backup (R4-SN-02). The operation is identified by the installation and the
 * backup the recovery marker names: a stale request (different backup, or
 * the marker already cleared) changes nothing. The recovery marker and the
 * pending record it belongs to are cleared TOGETHER, only after the restore
 * succeeded and the record was saved; on either failure the block stays and
 * the error says what to retry.
 */
export async function recoverInstallation(
  operation: { dataId: string; backup: string },
  restore: (dataId: string, backup: string) => Promise<void>,
  storage: RegistryStorageLike = registryStorage()
): Promise<void> {
  const before = loadRegistry(storage);
  if (before.unavailable) throw new UpgradeBlockedError(`The installation records could not be read (${before.unavailable.reason}); recovery was not attempted.`);
  const record = before.installations[operation.dataId];
  if (!record?.recoveryRequired) throw new UpgradeBlockedError('This installation is not in the recovery-only state (it may have been recovered already); nothing was changed.');
  if (record.recoveryRequired.backup !== operation.backup) throw new UpgradeBlockedError(`The recovery request names a different backup (${operation.backup}) than the installation's recovery marker (${record.recoveryRequired.backup}); nothing was changed.`);
  try {
    await restore(operation.dataId, operation.backup);
  } catch (error) {
    throw new UpgradeBlockedError(`The backup could not be restored (${errorText(error)}). The installation stays in the recovery-only state; the backup is still at ${operation.backup}. Retry when the cause is fixed, or recover from that file by hand.`);
  }
  const commit = commitRegistry(storage, fresh => {
    const current = fresh.installations[operation.dataId];
    if (!current?.recoveryRequired || current.recoveryRequired.backup !== operation.backup) {
      throw new UpgradeBlockedError(`The data was restored from ${operation.backup}, but the installation's recovery marker changed meanwhile (another operation), so nothing was recorded for it. Reopen the file to see the current state.`);
    }
    delete current.recoveryRequired;
    if (current.pendingUpgrade?.backup === operation.backup) delete current.pendingUpgrade;
    current.updatedAt = new Date().toISOString();
  });
  if (!commit.saved) throw new UpgradeBlockedError(`The data was restored from ${operation.backup}, but the recovery could not be recorded, so the installation stays blocked. Free storage in this runtime and retry the recovery; the data will not be restored twice unnecessarily, but a second restore from the same verified backup is safe.`);
}
