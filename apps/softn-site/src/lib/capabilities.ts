/**
 * The capability schema, as the directory describes it.
 *
 * This is a copy of `packages/@softn/core/src/runtime/capabilities.ts`, the
 * one list of what a bundle's permission.json may ask for. The site does not
 * depend on the engine package — it is a directory, not a runtime — so the
 * list is carried here as data and `apps/softn-web/test/capability-schema.test.ts`
 * fails the build when the two drift. They did drift: `accel` was enforced by
 * the runtime and asked for by the consent bar for months while this site
 * and the directory's PHP had never heard of it, so an app that asked for it
 * was listed as asking for nothing of the kind.
 *
 * Everything here describes a *declaration*: what the bundle asks for. The
 * runtime grants each capability only after the person running the app has
 * been told and has allowed it, and whether a capability is available at all
 * depends on their device. A listing must not read as more than a request.
 */

export const CAPABILITY_SCHEMA_VERSION = 2;

export const CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage', 'accel'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityInfo {
  label: string;
  summary: string;
  /** Reaches towards the person: their network, camera, microphone or files. */
  sensitive: boolean;
}

export const CAPABILITY_INFO: Record<Capability, CapabilityInfo> = {
  net: { label: 'Network', summary: 'may call the internet; the runtime asks you first', sensitive: true },
  camera: { label: 'Camera', summary: 'may take pictures, with your permission', sensitive: true },
  mic: { label: 'Microphone', summary: 'may record audio, with your permission', sensitive: true },
  files: { label: 'Files', summary: 'may read files you choose, and save files it makes', sensitive: true },
  qr: { label: 'QR codes', summary: 'scans QR codes with your camera', sensitive: false },
  ai: { label: 'AI models', summary: 'downloads and runs a model in your browser', sensitive: false },
  gpu: { label: 'GPU', summary: 'uses your graphics card for compute', sensitive: false },
  sync: { label: 'Sync', summary: 'replicates its data to your other devices and to peers', sensitive: false },
  storage: {
    label: 'Server storage',
    summary: 'keeps records in its own database on this site, shared with everyone running the app unless a collection says otherwise',
    sensitive: false,
  },
  accel: {
    label: 'Host acceleration',
    summary: "runs the numeric code it generates on your browser's own engine, bound to its own data",
    sensitive: false,
  },
};

export function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name);
}

/**
 * Words for a declared name. A name the schema does not know is shown as
 * itself, marked so: the directory refuses such declarations at publication
 * now, but listings published before it did can still carry one.
 */
export function describeCapability(name: string): CapabilityInfo & { known: boolean } {
  if (isCapability(name)) return { ...CAPABILITY_INFO[name], known: true };
  return { label: name, summary: 'a capability this directory does not describe', sensitive: false, known: false };
}

// ── Storage collection policies ────────────────────────────────────────
// The same five as the schema's STORAGE_POLICIES, with the words the app
// page uses for each. Compared against the schema by the same drift test.

export const STORAGE_POLICIES = ['public', 'append-only', 'owner-write', 'private', 'publisher'] as const;

export type StoragePolicy = (typeof STORAGE_POLICIES)[number];

export const STORAGE_POLICY_INFO: Record<StoragePolicy, { label: string; summary: string }> = {
  public: { label: 'shared', summary: 'anyone running the app can read, change and remove every record' },
  'append-only': { label: 'append-only', summary: 'anyone can add and read records; only the publisher can change or remove them' },
  'owner-write': { label: 'owner-write', summary: 'anyone can read; a record is changed or removed only by whoever added it, or the publisher' },
  private: { label: 'private to you', summary: 'each visitor sees and changes only the records they added; nobody else can read them' },
  publisher: { label: 'publisher only', summary: 'reading and writing need the edit key; the app cannot reach it from a visitor' },
};

export function describeStoragePolicy(policy: string): { label: string; summary: string } {
  return (STORAGE_POLICY_INFO as Record<string, { label: string; summary: string }>)[policy] ?? { label: policy, summary: 'a policy this directory does not describe' };
}

// ── Reading a declaration ──────────────────────────────────────────────
// The same reading as core's inspectDeclaration, so the pre-publish report
// refuses exactly what the directory refuses. Held equal to core's by
// apps/softn-web/test/capability-schema.test.ts over a set of fixtures.

const COLLECTION_NAME = /^(?:\*|[a-z][a-z0-9_]{0,31})$/;

export interface DeclarationReport {
  requested: Capability[];
  unknown: string[];
  malformed: string[];
  storagePolicies: Record<string, StoragePolicy>;
}

export function isStoragePolicy(name: string): name is StoragePolicy {
  return (STORAGE_POLICIES as readonly string[]).includes(name);
}

export function inspectDeclaration(config: unknown): DeclarationReport {
  const report: DeclarationReport = { requested: [], unknown: [], malformed: [], storagePolicies: {} };
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    report.malformed.push('permissions');
    return report;
  }
  const permissions = (config as { permissions?: unknown }).permissions;
  if (permissions === undefined || permissions === null) return report;
  if (typeof permissions !== 'object' || Array.isArray(permissions)) {
    report.malformed.push('permissions');
    return report;
  }
  const declared = permissions as Record<string, unknown>;
  for (const name of Object.keys(declared)) {
    const entry = declared[name];
    if (!isCapability(name)) {
      report.unknown.push(name);
      continue;
    }
    if (entry === undefined) continue;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      report.malformed.push(name);
      continue;
    }
    const enabled = (entry as { enabled?: unknown }).enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      report.malformed.push(name);
      continue;
    }
    if (name === 'storage') {
      const collections = (entry as { collections?: unknown }).collections;
      if (collections !== undefined) {
        if (collections === null || typeof collections !== 'object' || Array.isArray(collections)) {
          report.malformed.push('storage.collections');
        } else {
          for (const [collection, policy] of Object.entries(collections as Record<string, unknown>)) {
            if (!COLLECTION_NAME.test(collection) || typeof policy !== 'string' || !isStoragePolicy(policy)) {
              report.malformed.push(`storage.collections.${collection}`);
              continue;
            }
            report.storagePolicies[collection] = policy;
          }
        }
      }
    }
  }
  for (const name of CAPABILITIES) {
    const entry = declared[name];
    if (entry && typeof entry === 'object' && (entry as { enabled?: unknown }).enabled === true) report.requested.push(name);
  }
  return report;
}
