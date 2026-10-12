/**
 * What a bundle says about itself, read before anything is done with it.
 *
 * The directory refuses a bundle it cannot store; the runtime refuses one it
 * cannot open. This runs the same checks first — in Studio and Builder before
 * an export, on the site before an upload — so the report is in front of the
 * author while the file is still theirs to fix. Errors are what the directory
 * or the runtime will refuse; warnings are what will make the listing worse
 * than it needs to be.
 *
 * The site, which does not depend on the engine, imports this module as it
 * is (apps/softn-site/src/lib/inspectBundle.ts). The directory's side of each
 * check is apps/softn-api/lib/bundle.php, in PHP, and can only be kept equal
 * by hand: a limit added there needs its line here. The declaration is read
 * by {@link inspectDeclaration}, which is also what the runtime enforces.
 */

import { openBundleArchive } from './zip';
import { inspectDeclaration, CAPABILITIES, STORAGE_POLICIES } from './capabilities';

export interface BundleReportLine {
  level: 'error' | 'warn';
  text: string;
}

export interface BundleInspection {
  name: string;
  version: string;
  description: string;
  main: string;
  files: number;
  /** Bytes when unpacked. */
  bytes: number;
  capabilities: string[];
  storagePolicies: Record<string, string>;
  execution: string;
  /** The Python packages `config.python.packages` asks the runtime for, e.g. `['torch']`. */
  pythonPackages: string[];
  iconDataUrl: string | null;
  /** The first error, for the one line a drop zone shows and a submit button reads. */
  problem: string | null;
  report: BundleReportLine[];
}

/** The directory's own limits, from apps/softn-api/lib/bundle.php. */
const MAX_ENTRIES = 4000;
const MAX_UNCOMPRESSED = 128 * 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
/** The two JSON files are decoded whole by the directory, so it caps them before reading. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PERMISSION_BYTES = 64 * 1024;
/** Not limits — sizes past which a bundle is slow to open on a phone. */
const LARGE_FILE_BYTES = 8 * 1024 * 1024;
const LARGE_BUNDLE_BYTES = 48 * 1024 * 1024;

const FILE_GROUPS = ['ui', 'logic', 'server', 'xdb', 'assets'] as const;

/**
 * The Python packages a bundle can ask the runtime for, by the name it imports.
 *
 * A package is opt-in because it is large and most apps never import it:
 * torch is a machine-learning library, and an app that trains or runs a model
 * says so in its manifest rather than every app paying for it. The engine the
 * runtime loads today carries torch built in; a declaration is what lets the
 * runtime choose an engine or load the package for the apps that need it, and
 * it is refused by name when the loaded engine cannot provide it.
 */
export const PYTHON_PACKAGES: readonly string[] = ['torch'];

/**
 * Read `config.python.packages` out of a parsed manifest: the packages it
 * declares, and what is wrong with the declaration. Anything but a list of
 * names this runtime offers is a problem, because a misspelt `"pytorch"` that
 * was quietly ignored would surface only when the app's first `import torch`
 * was refused.
 */
export function readPythonPackages(manifest: unknown): { packages: string[]; problems: string[] } {
  const config = manifest && typeof manifest === 'object' ? (manifest as { config?: unknown }).config : undefined;
  const python = config && typeof config === 'object' ? (config as { python?: unknown }).python : undefined;
  if (python === undefined) return { packages: [], problems: [] };
  if (!python || typeof python !== 'object' || Array.isArray(python)) {
    return { packages: [], problems: ['manifest.json config.python must be an object, such as { "packages": ["torch"] }.'] };
  }
  const declared = (python as { packages?: unknown }).packages;
  if (declared === undefined) return { packages: [], problems: [] };
  if (!Array.isArray(declared)) {
    return { packages: [], problems: ['manifest.json config.python.packages must be a list of package names, such as ["torch"].'] };
  }
  const packages: string[] = [];
  const problems: string[] = [];
  for (const name of declared) {
    if (typeof name !== 'string' || !PYTHON_PACKAGES.includes(name)) {
      problems.push(`manifest.json config.python.packages names ${JSON.stringify(name)}; the runtime offers ${PYTHON_PACKAGES.join(', ')}.`);
    } else if (!packages.includes(name)) {
      packages.push(name);
    }
  }
  return { packages, problems };
}

function fmt(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * What a bundle with no permission.json asks for in the older `permissions`
 * block of its manifest, as the runtime grants it (extractPermissions in
 * core's bundle/manifest.ts) and the directory lists it (legacyCapabilities in
 * apps/softn-api/lib/bundle.php): `network` is net and `filesystem` is files,
 * each when JavaScript counts its value as true. The block's other names
 * gated nothing.
 */
function legacyCapabilities(legacy: unknown): string[] {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return [];
  const block = legacy as Record<string, unknown>;
  const capabilities: string[] = [];
  if (block.network) capabilities.push('net');
  if (block.filesystem) capabilities.push('files');
  return capabilities;
}

function unpackedTooLarge(total: number): string {
  return `The bundle unpacks to ${fmt(total)}; the directory takes at most 128 MB.`;
}

/** Inspect bundle bytes. Never throws: an archive that will not open is a report with one error. */
export function inspectBundle(bytes: Uint8Array): BundleInspection {
  let entries: Map<string, Uint8Array>;
  let unsafe: string[];
  let backslashed: string[];
  let notUtf8: string[];
  try {
    const archive = openBundleArchive(bytes);
    // The directory's two limits on the archive as a whole are read off its
    // index, before anything is inflated. The reader's own limits are several
    // times the directory's (500 MB against 128), so unpacking first spent up
    // to 500 MB of this tab to learn what the index already said. The count
    // is of records, folders included, because that is what the directory
    // counts.
    const names = archive.names();
    const declared = names.reduce((n, name) => n + (archive.declaredSize(name) ?? 0), 0);
    const over: string[] = [];
    if (archive.recordCount() > MAX_ENTRIES) {
      over.push(`The bundle has ${archive.recordCount()} entries, folders included; the directory takes at most ${MAX_ENTRIES}.`);
    }
    if (declared > MAX_UNCOMPRESSED) over.push(unpackedTooLarge(declared));
    if (over.length > 0) {
      const report = over.map((text): BundleReportLine => ({ level: 'error', text }));
      return { ...nothingRead(), files: names.length, bytes: declared, report, problem: report[0].text };
    }
    entries = archive.readAll();
    unsafe = archive.unsafeNames();
    backslashed = archive.backslashNames();
    notUtf8 = archive.nonUtf8Names();
  } catch {
    return inspectEntries(null);
  }
  const inspection = inspectEntries(entries);
  if (unsafe.length === 0 && backslashed.length === 0 && notUtf8.length === 0) return inspection;
  // The archive reader drops escape attempts so the runtime can open the rest,
  // and reads a backslash as a slash; the inspector refuses the bundle
  // instead, as the directory always has.
  const report = [
    ...unsafe.map((p): BundleReportLine => ({ level: 'error', text: `The bundle has a file with an unsafe path: ${p}` })),
    ...backslashed.map((p): BundleReportLine => ({
      level: 'error',
      text: `The bundle has a file whose path is written with backslashes: ${p}. The directory refuses those; zip the bundle with forward slashes.`,
    })),
    // The directory's words, once however many names: the name itself cannot be shown as written.
    ...(notUtf8.length > 0
      ? [{ level: 'error' as const, text: 'The bundle has an entry whose name is not UTF-8 text. Zip it with a tool that writes UTF-8 names.' }]
      : []),
    ...inspection.report,
  ];
  return { ...inspection, report, problem: report.find((l) => l.level === 'error')?.text ?? null };
}

/**
 * Inspect a bundle's files by path. This is the whole check; `inspectBundle`
 * is it after unzipping. Studio and Builder call this on the files they hold
 * rather than zipping first.
 */
/** An inspection that learned nothing about the bundle, for a report to be laid over. */
function nothingRead(): Omit<BundleInspection, 'report' | 'problem'> {
  return {
    name: '',
    version: '',
    description: '',
    main: '',
    files: 0,
    bytes: 0,
    capabilities: [],
    storagePolicies: {},
    execution: 'main',
    pythonPackages: [],
    iconDataUrl: null,
  };
}

export function inspectEntries(entries: Map<string, Uint8Array> | null): BundleInspection {
  const report: BundleReportLine[] = [];
  const error = (text: string) => report.push({ level: 'error', text });
  const warn = (text: string) => report.push({ level: 'warn', text });
  const finish = (partial: Partial<BundleInspection>): BundleInspection => ({
    ...nothingRead(),
    ...partial,
    report,
    problem: report.find((l) => l.level === 'error')?.text ?? null,
  });

  if (!entries) {
    error('That file is not a .softn bundle (it does not open as an archive).');
    return finish({});
  }
  const paths = [...entries.keys()].filter((k) => !k.endsWith('/'));
  const total = paths.reduce((n, k) => n + entries.get(k)!.length, 0);
  if (paths.length === 0) error('The bundle is empty.');
  if (paths.length > MAX_ENTRIES) error(`The bundle has ${paths.length} files; the directory takes at most ${MAX_ENTRIES}.`);
  if (total > MAX_UNCOMPRESSED) error(unpackedTooLarge(total));
  for (const p of paths) {
    if (p.startsWith('/') || p.includes('\\') || /(^|\/)\.\.(\/|$)/.test(p)) error(`The bundle has a file with an unsafe path: ${p}`);
  }

  const decoder = new TextDecoder();
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) {
    error('The bundle has no manifest.json.');
    return finish({ files: paths.length, bytes: total });
  }
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    error(`The manifest.json is larger than ${fmt(MAX_MANIFEST_BYTES)}; the directory will refuse the bundle.`);
  }
  let manifest: {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    main?: unknown;
    icon?: unknown;
    config?: { execution?: unknown; python?: unknown };
    files?: Record<string, unknown>;
    permissions?: unknown;
  };
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes));
  } catch {
    error('The manifest.json is not valid JSON.');
    return finish({ files: paths.length, bytes: total });
  }
  if (!manifest || typeof manifest !== 'object') {
    error('The manifest.json is not a JSON object.');
    return finish({ files: paths.length, bytes: total });
  }

  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  const main = typeof manifest.main === 'string' ? manifest.main : '';
  if (!name) error('The manifest has no name.');
  else if (name.length > 64) error(`The name is ${name.length} characters; the directory keeps 64.`);
  if (!version) error('The manifest has no version.');
  if (!main) error('The manifest names no entry file (main).');
  else if (!entries.has(main)) error(`The manifest's entry file is not in the bundle: ${main}`);
  if (!description) warn('No description: the card will say "No description yet".');

  // Files the manifest promises must be there; the runtime resolves them by
  // these paths, and the directory checks the archive against them.
  if (manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files)) {
    for (const group of FILE_GROUPS) {
      const list = manifest.files[group];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        error(`manifest.files.${group} must be a list of paths.`);
        continue;
      }
      for (const item of list) {
        if (typeof item !== 'string') error(`manifest.files.${group} has an entry that is not a path.`);
        else if (!entries.has(item)) error(`manifest.files.${group} lists ${item}, but the bundle has no such file.`);
      }
    }
    for (const key of Object.keys(manifest.files)) {
      if (!(FILE_GROUPS as readonly string[]).includes(key)) warn(`manifest.files.${key} is not a group the runtime reads (${FILE_GROUPS.join(', ')}).`);
    }
  } else if (manifest.files !== undefined) {
    error('manifest.files must be an object of file groups.');
  }

  let execution = 'main';
  const declaredExecution = manifest.config?.execution;
  if (declaredExecution === 'worker') execution = 'worker';
  else if (declaredExecution !== undefined && declaredExecution !== 'main') {
    warn(`config.execution is "${String(declaredExecution)}"; the runtime knows "main" and "worker" and will use main.`);
  }
  const { packages: pythonPackages, problems: pythonPackageProblems } = readPythonPackages(manifest);
  for (const problem of pythonPackageProblems) error(problem);

  // The declaration, read the way the directory reads it: a name the runtime
  // does not have, or an entry it cannot read, is refused at publication.
  let capabilities: string[] = [];
  let storagePolicies: Record<string, string> = {};
  const perm = entries.get('permission.json');
  if (perm) {
    if (perm.length > MAX_PERMISSION_BYTES) {
      error(`The permission.json is larger than ${fmt(MAX_PERMISSION_BYTES)}; the directory will refuse the bundle.`);
    }
    let declaration: unknown = null;
    let parsed = false;
    try {
      declaration = JSON.parse(decoder.decode(perm));
      parsed = true;
    } catch {
      error('The permission.json is not valid JSON; the directory will refuse the bundle.');
    }
    if (parsed) {
      const d = inspectDeclaration(declaration);
      capabilities = d.requested;
      storagePolicies = d.storagePolicies;
      if (d.unknown.length > 0) {
        error(`permission.json names capabilities the runtime does not have: ${d.unknown.join(', ')}. The capabilities are ${CAPABILITIES.join(', ')}.`);
      }
      for (const m of d.malformed) {
        if (m.startsWith('storage.collections')) {
          error(`permission.json: ${m} is not a collection name with one of the policies ${STORAGE_POLICIES.join(', ')}.`);
        } else {
          error(`permission.json: "${m}" must be an object with a boolean "enabled".`);
        }
      }
      // Server storage with no policy is public: anyone running the app can
      // change or remove any record, a leaderboard included. That is a fine
      // choice made on purpose and a surprise made by default, so the author
      // hears it here, at the one moment they are around to decide. (A
      // malformed declaration is refused above and needs no second warning.)
      if (
        capabilities.includes('storage') &&
        Object.keys(storagePolicies).length === 0 &&
        !d.malformed.some((m) => m.startsWith('storage.collections'))
      ) {
        warn(
          'Server storage is enabled with no collection policies, so every collection is public: anyone running the app can change or remove any record, including other players\' scores. ' +
            'To keep records as they were added, declare "collections" under "storage" in permission.json — for example { "scores": "append-only" }.'
        );
      }
    }
  } else {
    capabilities = legacyCapabilities(manifest.permissions);
    if (capabilities.length > 0) {
      warn(
        `No permission.json: the manifest's older "permissions" block asks for ${capabilities.join(', ')}, which the runtime grants. ` +
          'Move them to a permission.json to declare them the current way.'
      );
    } else {
      warn('No permission.json: the app declares nothing and gets no capability. Fine for an app that needs none.');
    }
  }

  let iconDataUrl: string | null = null;
  if (typeof manifest.icon === 'string' && manifest.icon) {
    const icon = entries.get(manifest.icon);
    if (!icon) warn(`The manifest names an icon the bundle does not have: ${manifest.icon}. The card will show an initial.`);
    else if (icon.length > MAX_ICON_BYTES) warn(`The icon is ${fmt(icon.length)}; the directory shows icons up to ${fmt(MAX_ICON_BYTES)}, so the card will show an initial.`);
    else {
      const ext = manifest.icon.split('.').pop()?.toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : null;
      if (mime) iconDataUrl = `data:${mime};base64,${toBase64(icon)}`;
      else warn(`The icon ${manifest.icon} is not a PNG, JPEG, WebP or SVG, so the directory will not show it.`);
    }
  } else {
    warn('No icon: the card will show the first letter of the name.');
  }

  // Size is not a rule, but it is a wait on a phone before the first frame.
  const large = paths.filter((p) => entries.get(p)!.length > LARGE_FILE_BYTES);
  for (const p of large.slice(0, 5)) warn(`${p} is ${fmt(entries.get(p)!.length)}; every visitor downloads it before the app opens.`);
  if (large.length > 5) warn(`${large.length - 5} more files are over ${fmt(LARGE_FILE_BYTES)}.`);
  if (total > LARGE_BUNDLE_BYTES && total <= MAX_UNCOMPRESSED) warn(`The bundle unpacks to ${fmt(total)}. Say so in the description, and consider what a phone on mobile data will make of it.`);

  return finish({
    name,
    version,
    description,
    main,
    files: paths.length,
    bytes: total,
    capabilities,
    storagePolicies,
    execution,
    pythonPackages,
    iconDataUrl,
  });
}
