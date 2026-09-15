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
 *
 * Truthfulness rules (R3-SN-01 / R3-SN-02):
 *  - A storage read that FAILS is `unavailable`, never an empty registry.
 *  - A record whose identity-critical fields are invalid (data id, bundle
 *    mapping, pending-upgrade or recovery metadata) is kept as DAMAGED
 *    material, never silently dropped; the registry refuses ordinary saves
 *    until the person explicitly discards the damaged copy.
 *  - An installation with a pending upgrade is gated for EVERY package that
 *    maps to it, not only for the new digest: old code must not run against
 *    data whose upgrade was interrupted until the person resolves it.
 */

export const REGISTRY_KEY = 'softn-loader:installations';
const REGISTRY_VERSION = 1;

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

/** A stored record whose identity-critical fields could not be trusted (R3-SN-02). */
export interface DamagedRecord {
  /** The key the record was stored under */
  dataId: string;
  reason: string;
  /** The stored value, untouched, for recovery */
  raw: unknown;
  /** Whatever bundle digests the raw record names, so those packages can be gated */
  bundleIds: string[];
}

export interface InstallationRegistry {
  version: typeof REGISTRY_VERSION;
  installations: Record<string, InstallationRecord>;
  /**
   * How many times the stored registry has been saved (ECO-S01). Read with
   * the registry, written back incremented by every save; a save that names
   * the revision it loaded is refused as `stale` when the stored copy has
   * moved on. Absent in registries written before this field existed, which
   * read as revision 0.
   */
  revision?: number;
  /**
   * Present when the stored registry, or part of it, could not be trusted
   * (R2-SN-03, R3-SN-02). The raw bytes were quarantined under
   * `quarantineKey`; `records` lists the individual records that failed
   * validation (the valid ones are still in `installations`). Unknown
   * packages are NOT opened as new (that would look like the only mapping
   * vanished), packages named by a damaged record are gated, and the
   * registry is not overwritten until the person discards the damaged copy.
   */
  damaged?: { quarantineKey: string | null; reason: string; records: DamagedRecord[] };
  /**
   * Present when the backing storage could not be READ at all (R3-SN-02).
   * Nothing is known: no package can be matched, and nothing may be saved,
   * because the write would replace records that could not be inspected.
   */
  unavailable?: { reason: string };
}

export type IdentityResolution =
  | { kind: 'known'; dataId: string; record: InstallationRecord }
  | { kind: 'new'; dataId: string }
  | { kind: 'choose'; bundleId: string; name: string; candidates: InstallationRecord[] }
  /** The registry is damaged: nothing can be decided about this package until it is resolved. */
  | { kind: 'registry-damaged'; quarantineKey: string | null; reason: string }
  /** The registry could not be read at all: nothing can be decided about any package. */
  | { kind: 'registry-unavailable'; reason: string }
  /** This digest is an approved upgrade still waiting for its first successful start. */
  | { kind: 'pending-upgrade'; dataId: string; record: InstallationRecord; pending: PendingUpgrade }
  /**
   * This digest is mapped to an installation whose upgrade to ANOTHER digest
   * was started and never finished (R3-SN-01). The data may already be
   * changed by the newer package; the person must roll back or finish the
   * upgrade before this older package runs against it.
   */
  | { kind: 'upgrade-unresolved'; dataId: string; record: InstallationRecord; pending: PendingUpgrade }
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

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Validate one stored record. Identity-critical fields (data id, bundle
 * mapping, pending upgrade, recovery marker) must be exactly right; display
 * fields (name, version, timestamps, ledger) are normalised leniently.
 */
function validateRecord(dataId: string, record: unknown): { ok: true; record: InstallationRecord } | { ok: false; reason: string; bundleIds: string[] } {
  const named = (value: unknown): string[] => {
    const ids = (value as { bundleIds?: unknown } | null)?.bundleIds;
    return Array.isArray(ids) ? ids.filter(isString) : [];
  };
  if (!record || typeof record !== 'object') return { ok: false, reason: 'not an object', bundleIds: [] };
  const r = record as Record<string, unknown>;
  if (r.dataId !== dataId) return { ok: false, reason: `data identity "${String(r.dataId)}" does not match its key "${dataId}"`, bundleIds: named(r) };
  if (!Array.isArray(r.bundleIds) || !r.bundleIds.every(isString)) return { ok: false, reason: 'bundle mapping is not a list of digests', bundleIds: named(r) };
  let pendingUpgrade: PendingUpgrade | undefined;
  if (r.pendingUpgrade !== undefined && r.pendingUpgrade !== null) {
    const p = r.pendingUpgrade as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || !isString(p.to) || !isString(p.backup) || p.backup === '' || !(p.from === null || isString(p.from))) {
      return { ok: false, reason: 'pending upgrade metadata is invalid', bundleIds: named(r) };
    }
    pendingUpgrade = { from: p.from as string | null, to: p.to, backup: p.backup, at: stringOrDefault(p.at, new Date(0).toISOString()), version: isString(p.version) ? p.version : undefined, name: isString(p.name) ? p.name : undefined };
  }
  let recoveryRequired: InstallationRecord['recoveryRequired'];
  if (r.recoveryRequired !== undefined && r.recoveryRequired !== null) {
    const m = r.recoveryRequired as Record<string, unknown> | null;
    if (!m || typeof m !== 'object' || !isString(m.backup) || !isString(m.reason)) {
      return { ok: false, reason: 'recovery marker is invalid', bundleIds: named(r) };
    }
    recoveryRequired = { backup: m.backup, reason: m.reason, at: stringOrDefault(m.at, new Date(0).toISOString()) };
  }
  return {
    ok: true,
    record: {
      dataId,
      name: stringOrDefault(r.name, ''),
      bundleIds: r.bundleIds as string[],
      version: isString(r.version) ? r.version : undefined,
      createdAt: stringOrDefault(r.createdAt, new Date(0).toISOString()),
      updatedAt: stringOrDefault(r.updatedAt, new Date(0).toISOString()),
      ledger: Array.isArray(r.ledger) ? r.ledger.filter((e): e is InstallationLedgerEntry => !!e && typeof e === 'object' && typeof (e as InstallationLedgerEntry).to === 'string') : [],
      pendingUpgrade,
      recoveryRequired,
    },
  };
}

/**
 * Read the registry. A failed read is `unavailable`; a registry that cannot
 * be parsed, or any record that fails validation, is QUARANTINED and marked
 * `damaged` (R2-SN-03, R3-SN-02): the raw bytes are copied to a recovery
 * key, valid records still load, saveRegistry refuses to overwrite the
 * stored copy, and resolveInstallation gates every package the damage could
 * concern until the person discards the damaged copy.
 */
export function loadRegistry(storage: RegistryStorage): InstallationRegistry {
  let raw: string | null;
  try {
    raw = storage.getItem(REGISTRY_KEY);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[SoftN Loader] The installation registry could not be read (${reason}); nothing is known about installed apps`);
    return { ...emptyRegistry(), unavailable: { reason } };
  }
  if (!raw) return emptyRegistry();
  const quarantine = (): string | null => {
    let quarantineKey: string | null = `${REGISTRY_KEY}.corrupt.${Date.now().toString(36)}`;
    try { storage.setItem(quarantineKey, raw as string); } catch { quarantineKey = null; }
    return quarantineKey;
  };
  const damaged = (reason: string, records: DamagedRecord[] = []): InstallationRegistry => {
    console.error(`[SoftN Loader] The installation registry is unreadable (${reason}); quarantined and left in place`);
    return { ...emptyRegistry(), damaged: { quarantineKey: quarantine(), reason, records } };
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
    registry.revision = storedRevision(parsed);
    const invalid: DamagedRecord[] = [];
    for (const [dataId, record] of Object.entries((parsed as InstallationRegistry).installations)) {
      const checked = validateRecord(dataId, record);
      if (checked.ok) registry.installations[dataId] = checked.record;
      else invalid.push({ dataId, reason: checked.reason, raw: record, bundleIds: checked.bundleIds });
    }
    if (invalid.length > 0) {
      const reason = `${invalid.length} installation record${invalid.length === 1 ? '' : 's'} invalid: ${invalid.map(r => `${r.dataId} (${r.reason})`).join('; ')}`;
      console.error(`[SoftN Loader] ${reason}; the stored registry was quarantined and left in place`);
      registry.damaged = { quarantineKey: quarantine(), reason, records: invalid };
    }
    return registry;
  } catch (error) {
    return damaged(error instanceof Error ? error.message : String(error));
  }
}

/** The revision a stored (parsed) registry carries; 0 for one written before revisions existed. */
function storedRevision(parsed: unknown): number {
  const value = (parsed as { revision?: unknown } | null)?.revision;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The revision of whatever is stored right now: 0 when nothing (or nothing parseable) is. */
function currentStoredRevision(storage: RegistryStorage): number {
  try {
    const raw = storage.getItem(REGISTRY_KEY);
    return raw ? storedRevision(JSON.parse(raw)) : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist the registry. Returns false (and writes nothing) when the write
 * fails, when the stored copy could not be read (nothing may replace records
 * that were never inspected), or when the stored copy is damaged and the
 * caller did not explicitly acknowledge discarding it (the quarantined bytes
 * are kept either way; an acknowledged save keeps only the valid records).
 *
 * With `expectRevision` (ECO-S01) the save is conditional: it returns
 * `'stale'` and writes nothing when the stored copy's revision is no longer
 * the one the caller loaded, so a decision taken on an old read is never
 * written over a newer one. Every save stores the revision incremented.
 */
export function saveRegistry(
  storage: RegistryStorage,
  registry: InstallationRegistry,
  options: { acknowledgeDamage?: boolean; expectRevision?: number } = {}
): boolean | 'stale' {
  if (registry.unavailable) {
    console.error('[SoftN Loader] Refusing to overwrite an installation registry that could not be read');
    return false;
  }
  if (registry.damaged && !options.acknowledgeDamage) {
    console.error('[SoftN Loader] Refusing to overwrite a damaged installation registry without acknowledgement');
    return false;
  }
  const stored = currentStoredRevision(storage);
  if (options.expectRevision !== undefined && stored !== options.expectRevision) {
    console.error(`[SoftN Loader] The installation registry changed underneath this operation (stored revision ${stored}, loaded ${options.expectRevision}); not saving`);
    return 'stale';
  }
  try {
    const { damaged: _damaged, unavailable: _unavailable, ...clean } = registry;
    clean.revision = stored + 1;
    storage.setItem(REGISTRY_KEY, JSON.stringify(clean));
    registry.revision = clean.revision;
    delete registry.damaged;
    return true;
  } catch (error) {
    console.error('[SoftN Loader] Could not save the installation registry:', error);
    return false;
  }
}

function findByBundle(registry: InstallationRegistry, bundleId: string): InstallationRecord | undefined {
  return Object.values(registry.installations).find(record => record.bundleIds.includes(bundleId));
}

/**
 * Decide, WITHOUT side effects, what opening this bundle means for data.
 */
export function resolveInstallation(registry: InstallationRegistry, bundleId: string, manifestName: string | undefined): IdentityResolution {
  if (registry.unavailable) return { kind: 'registry-unavailable', reason: registry.unavailable.reason };
  const pending = Object.values(registry.installations).find(record => record.pendingUpgrade?.to === bundleId);
  if (pending?.pendingUpgrade) {
    if (pending.recoveryRequired) return { kind: 'recovery-required', dataId: pending.dataId, record: pending };
    return { kind: 'pending-upgrade', dataId: pending.dataId, record: pending, pending: pending.pendingUpgrade };
  }
  const known = findByBundle(registry, bundleId);
  if (known) {
    if (known.recoveryRequired) return { kind: 'recovery-required', dataId: known.dataId, record: known };
    // The installation is mid-upgrade to a different package (R3-SN-01):
    // this older package must not run against data the newer one may have
    // changed until the person rolls back or finishes the upgrade.
    if (known.pendingUpgrade) return { kind: 'upgrade-unresolved', dataId: known.dataId, record: known, pending: known.pendingUpgrade };
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
 * was restored. Until then every package mapped to the installation is
 * gated (`upgrade-unresolved`), because the new package may already have
 * changed the data.
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

/**
 * The operation a running session is finishing or undoing. Completion and
 * rollback are bound to it: a pending record for a DIFFERENT digest or backup
 * belongs to another operation and is never finished or undone by mistake.
 */
export interface UpgradeOperation {
  dataId: string;
  bundleId: string;
  backup: string;
}

/** Whether the installation's pending record is exactly this operation. */
export function pendingMatches(record: InstallationRecord | undefined, operation: UpgradeOperation): record is InstallationRecord & { pendingUpgrade: PendingUpgrade } {
  return !!record?.pendingUpgrade && record.pendingUpgrade.to === operation.bundleId && record.pendingUpgrade.backup === operation.backup;
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
 * pending digest, and the recovery marker of THIS operation if an earlier
 * attempt had left one (R4-SN-02: a successful retry must not leave the
 * installation blocked). When the snapshot could NOT be restored, the
 * installation enters an explicit recovery-only state instead
 * (`recoveryRequired`); the pending record stays so the gate holds.
 */
export function rollbackUpgrade(registry: InstallationRegistry, dataId: string, outcome: { restored: true } | { restored: false; reason: string }, now = new Date()): InstallationRecord {
  const record = registry.installations[dataId];
  if (!record?.pendingUpgrade) throw new Error('No pending upgrade to roll back.');
  const pending = record.pendingUpgrade;
  if (outcome.restored) {
    delete record.pendingUpgrade;
    if (record.recoveryRequired?.backup === pending.backup) delete record.recoveryRequired;
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
