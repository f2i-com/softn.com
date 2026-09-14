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
}

export interface InstallationRegistry {
  version: typeof REGISTRY_VERSION;
  installations: Record<string, InstallationRecord>;
}

export type IdentityResolution =
  | { kind: 'known'; dataId: string; record: InstallationRecord }
  | { kind: 'new'; dataId: string }
  | { kind: 'choose'; bundleId: string; name: string; candidates: InstallationRecord[] };

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

/** A damaged registry is reported through the console and treated as empty; nothing is deleted. */
export function loadRegistry(storage: RegistryStorage): InstallationRegistry {
  let raw: string | null;
  try {
    raw = storage.getItem(REGISTRY_KEY);
  } catch {
    return emptyRegistry();
  }
  if (!raw) return emptyRegistry();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== 'object' || (parsed as InstallationRegistry).version !== REGISTRY_VERSION
      || typeof (parsed as InstallationRegistry).installations !== 'object' || (parsed as InstallationRegistry).installations === null
    ) {
      console.error('[SoftN Loader] Ignoring an installation registry with an unknown shape');
      return emptyRegistry();
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
      };
    }
    return registry;
  } catch (error) {
    console.error('[SoftN Loader] Ignoring an unreadable installation registry:', error);
    return emptyRegistry();
  }
}

export function saveRegistry(storage: RegistryStorage, registry: InstallationRegistry): boolean {
  try {
    storage.setItem(REGISTRY_KEY, JSON.stringify(registry));
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
  const known = findByBundle(registry, bundleId);
  if (known) return { kind: 'known', dataId: known.dataId, record: known };
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

/** Short, human-comparable form of an identity for the choice dialog. */
export function shortIdentity(id: string): string {
  const hex = id.startsWith('bundle-') ? id.slice(7) : id;
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}
