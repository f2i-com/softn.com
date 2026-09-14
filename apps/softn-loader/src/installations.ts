/**
 * Stable installation identity for native app data (audit SN-03).
 *
 * A bundle's SHA-256 (`computeBundleAppId`) stays the INTEGRITY identity of
 * the bytes that were opened: it isolates untrusted packages from each other
 * and cannot be spoofed by a manifest. It is a poor DATA identity, though:
 * any change to the package bytes — a new version, or even a repack of the
 * same contents — is a different digest, and the app appears to start empty.
 *
 * This registry maps bundle digests to a DATA identity that survives approved
 * upgrades. Rules:
 *  - A digest that is already mapped opens its mapped data. Nothing to ask.
 *  - A digest that is not mapped and matches no installed app's name opens
 *    as a new installation whose data identity is the digest itself.
 *  - A digest that is not mapped but shares a display name with installed
 *    apps is a CHOICE for the person: open as new, or upgrade one of those
 *    installations. The name is author-controlled, so it is only a hint that
 *    triggers the question; it never grants access on its own.
 *  - Approving an upgrade records the digest under the existing data
 *    identity, appends a ledger entry and keeps the pre-upgrade backup path.
 *    Every previously mapped digest stays mapped, so reopening the previous
 *    package still reaches the same data (rollback by reopening the file).
 *  - Permissions are NOT inherited: the runtime reads the new package's own
 *    permission.json, so data continuity never approves new capabilities.
 *
 * The registry lives in the runtime's own storage (`localStorage` of the
 * loader webview), separate from any app's records.
 */

export const REGISTRY_KEY = 'softn-loader:installations';
export const REGISTRY_VERSION = 1;

export interface InstallationLedgerEntry {
  /** Bundle digest the person upgraded FROM (the last known one) */
  from: string | null;
  /** Bundle digest the person upgraded TO */
  to: string;
  at: string;
  version?: string;
  /** Pre-upgrade backup of the data namespace, when one could be taken */
  backup?: string;
}

/**
 * An upgrade that was approved but not yet proven (R2-SN-03): the new
 * package's digest, the verified pre-upgrade snapshot and the digest it
 * upgrades from. It is written durably BEFORE the new package touches the
 * data; only a successful start of the new package completes it, and a
 * failed start rolls the data back from the snapshot and drops it.
 */
export interface PendingUpgrade {
  from: string | null;
  to: string;
  backup: string;
  at: string;
  version?: string;
  name?: string;
}

export interface InstallationRecord {
  /** The XDB namespace this installation's records live in */
  dataId: string;
  /** Display name as declared by the package at first install (a hint, not an identity) */
  name: string;
  /** Every bundle digest approved for this data identity, oldest first */
  bundleIds: string[];
  version?: string;
  createdAt: string;
  updatedAt: string;
  ledger: InstallationLedgerEntry[];
  /** Set while an upgrade is approved but the new package has not started successfully yet. */
  pendingUpgrade?: PendingUpgrade;
  /** Set when a failed upgrade could not be rolled back automatically; the person must resolve it. */
  recoveryRequired?: { backup: string; reason: string; at: string };
}

export interface InstallationRegistry {
  version: typeof REGISTRY_VERSION;
  installations: Record<string, InstallationRecord>;
  /**
   * Present when the stored registry could not be read (R2-SN-03). The raw
   * bytes were quarantined under `quarantineKey`; unknown packages are NOT
   * opened as new (that would look like the only mapping vanished) and the
   * registry is not overwritten until the person discards the damaged copy.
   */
  damaged?: { quarantineKey: string | null; reason: string };
}

export type IdentityResolution =
  | { kind: 'known'; dataId: string; record: InstallationRecord }
  | { kind: 'new'; dataId: string }
  | { kind: 'choose'; bundleId: string; name: string; candidates: InstallationRecord[] }
  /** The registry is damaged: nothing can be decided about an unknown package until it is resolved. */
  | { kind: 'registry-damaged'; quarantineKey: string | null; reason: string }
  /** This digest is an approved upgrade still waiting for its first successful start. */
  | { kind: 'pending-upgrade'; dataId: string; record: InstallationRecord; pending: PendingUpgrade }
  /** The installation is in an explicit recovery-only state. */
  | { kind: 'recovery-required'; dataId: string; record: InstallationRecord };

export interface RegistryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function normaliseName(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

export function emptyRegistry(): InstallationRegistry {
  return { version: REGISTRY_VERSION, installations: {} };
}

/**
 * A damaged registry is QUARANTINED, not replaced (R2-SN-03): its raw bytes
 * are copied to a recovery key, the returned registry is marked `damaged`,
 * saveRegistry refuses to overwrite it, and resolveInstallation refuses to
 * treat unknown packages as new until the person discards the damaged copy.
 */
export function loadRegistry(storage: RegistryStorage): InstallationRegistry {
  let raw: string | null;
  try {
    raw = storage.getItem(REGISTRY_KEY);
  } catch {
    return emptyRegistry();
  }
  if (!raw) return emptyRegistry();
  const damaged = (reason: string): InstallationRegistry => {
    let quarantineKey: string | null = `${REGISTRY_KEY}.corrupt.${Date.now().toString(36)}`;
    try { storage.setItem(quarantineKey, raw as string); } catch { quarantineKey = null; }
    console.error(`[SoftN Loader] The installation registry is unreadable (${reason}); quarantined and left in place`);
    return { ...emptyRegistry(), damaged: { quarantineKey, reason } };
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== 'object' || (parsed as InstallationRegistry).version !== REGISTRY_VERSION
      || typeof (parsed as InstallationRegistry).installations !== 'object' || (parsed as InstallationRegistry).installations === null
    ) {
      return damaged('unknown shape');
    }
    const registry = emptyRegistry();
    for (const [dataId, record] of Object.entries((parsed as InstallationRegistry).installations)) {
      if (!record || typeof record !== 'object' || record.dataId !== dataId || !Array.isArray(record.bundleIds)) continue;
      registry.installations[dataId] = {
        dataId,
        name: typeof record.name === 'string' ? record.name : '',
        bundleIds: record.bundleIds.filter((id): id is string => typeof id === 'string'),
        version: typeof record.version === 'string' ? record.version : undefined,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        ledger: Array.isArray(record.ledger) ? record.ledger.filter((e): e is InstallationLedgerEntry => !!e && typeof e === 'object' && typeof (e as InstallationLedgerEntry).to === 'string') : [],
        pendingUpgrade: record.pendingUpgrade && typeof record.pendingUpgrade === 'object' && typeof record.pendingUpgrade.to === 'string' && typeof record.pendingUpgrade.backup === 'string' ? record.pendingUpgrade : undefined,
        recoveryRequired: record.recoveryRequired && typeof record.recoveryRequired === 'object' && typeof record.recoveryRequired.backup === 'string' ? record.recoveryRequired : undefined,
      };
    }
    return registry;
  } catch (error) {
    return damaged(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Persist the registry. Returns false (and writes nothing) when the write
 * fails or when the stored copy is damaged and the caller did not explicitly
 * acknowledge discarding it (the quarantined bytes are kept either way).
 */
export function saveRegistry(storage: RegistryStorage, registry: InstallationRegistry, options: { acknowledgeDamage?: boolean } = {}): boolean {
  if (registry.damaged && !options.acknowledgeDamage) {
    console.error('[SoftN Loader] Refusing to overwrite a damaged installation registry without acknowledgement');
    return false;
  }
  try {
    const { damaged: _damaged, ...clean } = registry;
    storage.setItem(REGISTRY_KEY, JSON.stringify(clean));
    delete registry.damaged;
    return true;
  } catch (error) {
    console.error('[SoftN Loader] Could not save the installation registry:', error);
    return false;
  }
}

export function findByBundle(registry: InstallationRegistry, bundleId: string): InstallationRecord | undefined {
  return Object.values(registry.installations).find(record => record.bundleIds.includes(bundleId));
}

/**
 * Decide, WITHOUT side effects, what opening this bundle means for data.
 */
export function resolveInstallation(registry: InstallationRegistry, bundleId: string, manifestName: string | undefined): IdentityResolution {
  const pending = Object.values(registry.installations).find(record => record.pendingUpgrade?.to === bundleId);
  if (pending?.pendingUpgrade) {
    if (pending.recoveryRequired) return { kind: 'recovery-required', dataId: pending.dataId, record: pending };
    return { kind: 'pending-upgrade', dataId: pending.dataId, record: pending, pending: pending.pendingUpgrade };
  }
  const known = findByBundle(registry, bundleId);
  if (known) {
    if (known.recoveryRequired) return { kind: 'recovery-required', dataId: known.dataId, record: known };
    return { kind: 'known', dataId: known.dataId, record: known };
  }
  if (registry.damaged) return { kind: 'registry-damaged', quarantineKey: registry.damaged.quarantineKey, reason: registry.damaged.reason };
  const name = normaliseName(manifestName);
  const candidates = name
    ? Object.values(registry.installations).filter(record => normaliseName(record.name) === name)
    : [];
  if (candidates.length === 0) return { kind: 'new', dataId: bundleId };
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { kind: 'choose', bundleId, name: manifestName ?? '', candidates };
}

export function recordNewInstallation(registry: InstallationRegistry, bundleId: string, manifestName: string | undefined, version?: string, now = new Date()): InstallationRecord {
  const at = now.toISOString();
  const record: InstallationRecord = {
    dataId: bundleId,
    name: manifestName ?? '',
    bundleIds: [bundleId],
    version,
    createdAt: at,
    updatedAt: at,
    ledger: [{ from: null, to: bundleId, at, version }],
  };
  registry.installations[bundleId] = record;
  return record;
}

/**
 * Map a new bundle digest onto an EXISTING data identity after the person
 * approved it. Idempotent; previously approved digests stay mapped.
 */
export function approveUpgrade(
  registry: InstallationRegistry,
  bundleId: string,
  dataId: string,
  details: { manifestName?: string; version?: string; backup?: string } = {},
  now = new Date()
): InstallationRecord {
  const record = registry.installations[dataId];
  if (!record) throw new Error('Cannot upgrade an installation that is not registered.');
  const at = now.toISOString();
  if (!record.bundleIds.includes(bundleId)) {
    record.ledger.push({ from: record.bundleIds[record.bundleIds.length - 1] ?? null, to: bundleId, at, version: details.version, backup: details.backup });
    record.bundleIds.push(bundleId);
  }
  if (details.manifestName) record.name = details.manifestName;
  if (details.version) record.version = details.version;
  record.updatedAt = at;
  return record;
}

/**
 * Stage an approved upgrade (R2-SN-03). Requires a verified backup path; the
 * digest is NOT mapped yet — `completeUpgrade` maps it once the new package
 * started successfully, `rollbackUpgrade` drops it after the data snapshot
 * was restored. Until then reopening the previous package still reaches the
 * same data (its digest stays mapped).
 */
export function beginUpgrade(
  registry: InstallationRegistry,
  bundleId: string,
  dataId: string,
  details: { backup: string; manifestName?: string; version?: string },
  now = new Date()
): InstallationRecord {
  const record = registry.installations[dataId];
  if (!record) throw new Error('Cannot upgrade an installation that is not registered.');
  if (!details.backup) throw new Error('An upgrade needs a verified pre-upgrade backup before it can be approved.');
  if (record.recoveryRequired) throw new Error('This installation needs recovery before it can be upgraded.');
  if (record.pendingUpgrade && record.pendingUpgrade.to !== bundleId) throw new Error('Another upgrade of this installation is still pending; resolve it first.');
  record.pendingUpgrade = { from: record.bundleIds[record.bundleIds.length - 1] ?? null, to: bundleId, backup: details.backup, at: now.toISOString(), version: details.version, name: details.manifestName };
  return record;
}

/** The new package started: map its digest and record the ledger entry. */
export function completeUpgrade(registry: InstallationRegistry, dataId: string, now = new Date()): InstallationRecord {
  const record = registry.installations[dataId];
  if (!record?.pendingUpgrade) throw new Error('No pending upgrade to complete.');
  const pending = record.pendingUpgrade;
  approveUpgrade(registry, pending.to, dataId, { manifestName: pending.name, version: pending.version, backup: pending.backup }, now);
  delete record.pendingUpgrade;
  return record;
}

/**
 * The new package failed and the data snapshot was restored: forget the
 * pending digest. When the snapshot could NOT be restored, the installation
 * enters an explicit recovery-only state instead (`recoveryRequired`).
 */
export function rollbackUpgrade(registry: InstallationRegistry, dataId: string, outcome: { restored: true } | { restored: false; reason: string }, now = new Date()): InstallationRecord {
  const record = registry.installations[dataId];
  if (!record?.pendingUpgrade) throw new Error('No pending upgrade to roll back.');
  const pending = record.pendingUpgrade;
  if (outcome.restored) {
    delete record.pendingUpgrade;
  } else {
    record.recoveryRequired = { backup: pending.backup, reason: outcome.reason, at: now.toISOString() };
  }
  record.updatedAt = now.toISOString();
  return record;
}

/** Short, human-comparable form of an identity for the choice dialog. */
export function shortIdentity(id: string): string {
  const hex = id.startsWith('bundle-') ? id.slice(7) : id;
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}
