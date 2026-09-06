/**
 * The capability schema: what a bundle's `permission.json` may ask for.
 *
 * One list, one set of words, versioned. The runtime enforces these names in
 * `checkPermission`; the web launcher asks consent for them; the directory
 * inspects a published bundle for them and its pages describe them. Until now
 * each of those kept its own copy of the list, and the copies drifted: the
 * directory's PHP enumerated nine names while the runtime enforced ten, so an
 * app that asked for host acceleration was shown to visitors as asking for
 * nothing of the kind. A capability declared here and nowhere else is a
 * build error in TypeScript (the label maps are typed on {@link Capability})
 * and a test failure for the PHP and the site, which are compared against
 * this list by `apps/softn-web/test/capability-schema.test.ts`.
 *
 * A declaration is what the bundle *asks for*. Whether it is granted is the
 * host's decision, made per capability after the person running it has been
 * told; whether it is *available* depends on the device and the browser.
 * Nothing that reads this list should describe a declaration as anything
 * more than a request.
 */

/**
 * Bumped when a name is added, removed or changes meaning, or when what an
 * entry may say grows. A host can refuse a bundle whose `permission.json`
 * names a schema it does not know.
 *
 * 1: the ten names.
 * 2: `storage.collections`, a policy per collection (see STORAGE_POLICIES).
 */
export const CAPABILITY_SCHEMA_VERSION = 2;

/** Every capability, in the order the consent bar and the app page list them. */
export const CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage', 'accel'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityInfo {
  /** The short name a badge or a list item shows. */
  label: string;
  /** One clause, for a page describing what the app asked for. */
  summary: string;
  /**
   * Reaches outside the sandbox towards the person: their network, their
   * camera, their microphone, their files. The directory highlights these.
   */
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

// ── Storage collection policies ────────────────────────────────────────

/**
 * Who may do what to the records of one server-storage collection.
 *
 * Server storage is shared data: the app's database on the directory that
 * published it, reached by everyone running the app. That is the whole mode
 * unless a collection declares one of these, and each is a narrowing of it.
 * "Owner" is the visitor who inserted a record, known by a token the runtime
 * keeps in this browser; "publisher" is whoever holds the app's edit key.
 */
export const STORAGE_POLICIES = ['public', 'append-only', 'owner-write', 'private', 'publisher'] as const;

export type StoragePolicy = (typeof STORAGE_POLICIES)[number];

export interface StoragePolicyInfo {
  label: string;
  /** One clause: what a visitor can expect of records in such a collection. */
  summary: string;
}

export const STORAGE_POLICY_INFO: Record<StoragePolicy, StoragePolicyInfo> = {
  public: { label: 'shared', summary: 'anyone running the app can read, change and remove every record' },
  'append-only': { label: 'append-only', summary: 'anyone can add and read records; only the publisher can change or remove them' },
  'owner-write': { label: 'owner-write', summary: 'anyone can read; a record is changed or removed only by whoever added it, or the publisher' },
  private: { label: 'private to you', summary: 'each visitor sees and changes only the records they added; nobody else can read them' },
  publisher: { label: 'publisher only', summary: 'reading and writing need the edit key; the app cannot reach it from a visitor' },
};

export function isStoragePolicy(name: string): name is StoragePolicy {
  return (STORAGE_POLICIES as readonly string[]).includes(name);
}

/** A collection name as the directory accepts it, or `*` for every collection not named. */
const COLLECTION_NAME = /^(?:\*|[a-z][a-z0-9_]{0,31})$/;

/** What a `permission.json` declares, and what in it the schema cannot accept. */
export interface DeclarationReport {
  /** Capabilities declared with `enabled: true`, in schema order. */
  requested: Capability[];
  /** Names under `permissions` that are not capabilities. */
  unknown: string[];
  /** Names whose entry is not an object, or whose `enabled` is not a boolean. */
  malformed: string[];
  /**
   * Storage policies by collection name (`*` for the default), from
   * `storage.collections`. Empty when none are declared. Only meaningful
   * when `storage` is requested; reported either way so a typo is seen.
   */
  storagePolicies: Record<string, StoragePolicy>;
}

/**
 * Read a parsed `permission.json` against the schema.
 *
 * Tolerant of a missing `permissions` object (an empty declaration); strict
 * about what is inside it. A publisher's typo — `network` for `net`, or
 * `"enabled": "yes"`, or a policy called `readonly` — is reported by name
 * rather than silently becoming a bundle that declares nothing.
 */
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
    // `undefined` is how the launcher's manifest-compat path spells "not
    // declared"; it is not a declaration and not a mistake either.
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
    if (name === 'storage') readStoragePolicies((entry as { collections?: unknown }).collections, report);
  }
  for (const name of CAPABILITIES) {
    const entry = declared[name];
    if (entry && typeof entry === 'object' && (entry as { enabled?: unknown }).enabled === true) {
      report.requested.push(name);
    }
  }
  return report;
}

function readStoragePolicies(collections: unknown, report: DeclarationReport): void {
  if (collections === undefined) return;
  if (collections === null || typeof collections !== 'object' || Array.isArray(collections)) {
    report.malformed.push('storage.collections');
    return;
  }
  for (const [name, policy] of Object.entries(collections as Record<string, unknown>)) {
    if (!COLLECTION_NAME.test(name) || typeof policy !== 'string' || !isStoragePolicy(policy)) {
      report.malformed.push(`storage.collections.${name}`);
      continue;
    }
    report.storagePolicies[name] = policy;
  }
}

/** The policy that governs one collection under a declaration: named, else the default, else shared. */
export function storagePolicyFor(policies: Record<string, StoragePolicy> | undefined, collection: string): StoragePolicy {
  return policies?.[collection] ?? policies?.['*'] ?? 'public';
}
