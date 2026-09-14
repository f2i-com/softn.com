/**
 * Reading a bundle's manifest the one way every host agrees on.
 *
 * Each host used to read `manifest.json` for itself, and they disagreed: the
 * browser runtime checked `name` and `main` and then dereferenced `files`
 * unguarded, the desktop loader checked nothing and surfaced a raw
 * SyntaxError, the single-app host refused any manifest without `files`, and
 * the Builder refused an entry file that was present but not listed in
 * `files.ui`. Core itself has always been lenient — `composeBundleSource`
 * needs only `main` and defaults every file group to an empty list — so a
 * bundle could open in one host and crash or be refused in another.
 *
 * `readManifest` is that leniency, spelled out once:
 *
 * - `files` may be absent; each group (`ui`, `logic`, `xdb`, `assets`, and
 *   any other the author wrote) is returned as an array of strings, entries
 *   that are not strings dropped the way the runtime ignores them;
 * - a file a group lists but the archive lacks is not an error here: the
 *   runtime skips it, and the directory's inspector (`inspectBundle`) is
 *   where a publisher hears about it;
 * - `name` must be a non-empty string and `main` must name a file the
 *   bundle has, because nothing can run without them;
 * - `version` is kept as written (a string; a number is stringified; absent
 *   is the empty string), since only the directory insists on one;
 * - every other field is kept as written.
 *
 * What is refused is refused with the inspector's wording, so a bad bundle
 * reads the same on the publish page and in every host, and with a typed
 * `ManifestError` a host can tell from an archive or network failure.
 */

import type { AppPermissions, SoftNManifest } from './types';
import type { PermissionConfig } from '../runtime/script-runtime';

export type ManifestErrorCode =
  /** The bundle has no manifest.json. */
  | 'missing'
  /** manifest.json is not JSON, or not a JSON object. */
  | 'malformed'
  /** The manifest has no name. */
  | 'no-name'
  /** The manifest names no entry file. */
  | 'no-main'
  /** The manifest names an entry file the bundle does not have. */
  | 'entry-missing'
  /** `files` or one of its groups is not the shape the runtime reads. */
  | 'bad-files';

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

/** The file groups every host reads, and any other an author declared. */
export interface NormalizedManifestFiles {
  ui: string[];
  logic: string[];
  xdb: string[];
  assets: string[];
  [group: string]: string[];
}

/**
 * A manifest as `readManifest` returns it. `M` is the host's own manifest
 * type when it has one, so the fields it reads beyond these keep their
 * declared types (the parse is untyped JSON either way, as it always was).
 */
export type NormalizedManifest<M = SoftNManifest> = Omit<M, 'name' | 'version' | 'main' | 'files'> & {
  name: string;
  version: string;
  main: string;
  files: NormalizedManifestFiles;
};

export interface ReadManifestOptions {
  /**
   * Whether the bundle has a file at this path. Defaults to a lookup in the
   * map given; the Builder passes its own, which also finds a legacy path
   * written without its folder.
   */
  has?: (path: string) => boolean;
}

const KNOWN_GROUPS = ['ui', 'logic', 'xdb', 'assets'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalise a manifest already parsed from JSON. `has` says whether the
 * bundle holds a file at a path; the entry file is checked against it.
 */
export function normalizeManifest<M = SoftNManifest>(
  raw: unknown,
  has: (path: string) => boolean
): NormalizedManifest<M> {
  if (!isRecord(raw)) throw new ManifestError('malformed', 'The manifest.json is not a JSON object.');

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new ManifestError('no-name', 'The manifest has no name.');

  const main = typeof raw.main === 'string' ? raw.main : '';
  if (!main) throw new ManifestError('no-main', 'The manifest names no entry file (main).');
  if (!has(main)) throw new ManifestError('entry-missing', `The manifest's entry file is not in the bundle: ${main}`);

  const version =
    typeof raw.version === 'string' ? raw.version : typeof raw.version === 'number' ? String(raw.version) : '';

  const files: NormalizedManifestFiles = { ui: [], logic: [], xdb: [], assets: [] };
  if (raw.files !== undefined && raw.files !== null) {
    if (!isRecord(raw.files)) throw new ManifestError('bad-files', 'manifest.files must be an object of file groups.');
    for (const [group, list] of Object.entries(raw.files)) {
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) throw new ManifestError('bad-files', `manifest.files.${group} must be a list of paths.`);
      files[group] = list.filter((item): item is string => typeof item === 'string');
    }
    for (const group of KNOWN_GROUPS) files[group] ??= [];
  }

  return { ...(raw as object), name, version, main, files } as NormalizedManifest<M>;
}

/**
 * Read and normalise `manifest.json` from a bundle's files (text, or the raw
 * entries `readBundleEntries` returns). Throws `ManifestError` and nothing
 * else for a manifest that cannot be used.
 */
export function readManifest<M = SoftNManifest>(
  files: ReadonlyMap<string, string | Uint8Array>,
  options: ReadManifestOptions = {}
): NormalizedManifest<M> {
  const entry = files.get('manifest.json');
  if (entry === undefined) throw new ManifestError('missing', 'The bundle has no manifest.json.');
  const text = typeof entry === 'string' ? entry : new TextDecoder().decode(entry);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError('malformed', 'The manifest.json is not valid JSON.');
  }
  return normalizeManifest<M>(raw, options.has ?? ((path) => files.has(path)));
}

/**
 * The permission declaration a bundle carries: `permission.json` when the
 * bundle ships one, else the legacy `manifest.permissions` block mapped the
 * way the browser runtime and the single-app hosts have always mapped it
 * (`network` → `net`, `filesystem` → `files`; the other legacy flags named
 * nothing the runtime gates and are dropped), else `null` for a bundle that
 * declared nothing at all.
 *
 * A malformed `permission.json` is an empty declaration, not an absent one:
 * every capability is then refused, which is the safe reading of "the author
 * meant to declare something". (`checkPermission` refuses everything for a
 * null config too, so the difference is only in what the host tells the
 * author: "this bundle ships no permission.json" is false here.)
 *
 * One function for every host (audit-core 2.2): the desktop loader used to
 * read only `permission.json`, so a bundle published before that file
 * existed ran with the network in the browser and was refused it on the
 * desktop, with an error telling the author to add a file they cannot add
 * to a published bundle.
 */
export function extractPermissions(
  textFiles: ReadonlyMap<string, string>,
  manifest: { permissions?: AppPermissions | null } | null | undefined
): PermissionConfig | null {
  // An empty file is read as no file, as every host read it before this.
  const permJson = textFiles.get('permission.json');
  if (permJson) {
    try {
      const parsed: unknown = JSON.parse(permJson);
      if (!isRecord(parsed)) {
        console.error('[SoftN] permission.json is not an object — denying all capabilities');
        return { permissions: {} };
      }
      return parsed as unknown as PermissionConfig;
    } catch (e) {
      console.error('[SoftN] Invalid permission.json — denying all capabilities:', e);
      return { permissions: {} };
    }
  }
  const legacy = manifest?.permissions;
  if (legacy && typeof legacy === 'object') {
    return {
      permissions: {
        net: legacy.network ? { enabled: true } : undefined,
        files: legacy.filesystem ? { enabled: true } : undefined,
      },
    };
  }
  return null;
}
