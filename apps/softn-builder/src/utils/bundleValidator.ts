/**
 * Bundle Validator - Validates .softn bundle integrity
 *
 * One resolver for "the file the manifest names", shared with the loader.
 * The validator and the loader used to look files up differently — the
 * validator by three spellings of the declared path, the loader by those
 * and a folder-prefix guess — so a bundle could pass validation and still
 * load a different file, or load a file the validator had said was missing.
 * Both ask {@link resolveEntry} now, and a path that resolves nowhere is an
 * error that names the path and the group, not a warning that leaves the
 * project silently short of a file the manifest promised. The runtime and
 * the directory refuse such a bundle too (packages/@softn/core inspectEntries),
 * so opening it here as if it were whole would only defer the failure.
 */

import type { BundleManifest } from './bundleExporter';

export interface ValidationResult {
  valid: boolean;
  errors: string[];   // Fatal: bundle cannot be loaded
  warnings: string[]; // Non-fatal: bundle loads but may be incomplete
}

/** The file groups the runtime reads (packages/@softn/core inspect.ts FILE_GROUPS). */
export type FileGroup = 'ui' | 'logic' | 'server' | 'xdb' | 'assets';
export const FILE_GROUPS: readonly FileGroup[] = ['ui', 'logic', 'server', 'xdb', 'assets'];

export interface ResolvedEntry {
  /** The archive path the file was found at: the project's path for it from here on. */
  path: string;
  bytes: Uint8Array;
  /**
   * True when the file was found somewhere other than the declared path —
   * a legacy manifest naming `main.ui` for an archive holding `ui/main.ui`.
   * The export then names the archive path, which is a deliberate migration
   * (utils/migrations.ts); a file found at its declared path is not moved.
   */
  migrated: boolean;
}

/** The archive entries a manifest path could mean, most literal first. */
function candidates(declared: string, group?: FileGroup): string[] {
  const out: string[] = [declared];
  let normalized = declared.replace(/\\/g, '/');
  while (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized !== declared) out.push(normalized);
  if (group) {
    const prefix = `${group}/`;
    // Older manifests named files without their folder.
    if (!normalized.startsWith(prefix)) out.push(prefix + normalized);
  }
  // Older archives put files at the root while the manifest carried the folder.
  for (const prefix of FILE_GROUPS.map((g) => `${g}/`)) {
    if (normalized.startsWith(prefix)) out.push(normalized.slice(prefix.length));
  }
  return out;
}

/**
 * The entry a manifest path names, at that path when the archive has it and
 * by the legacy spellings only when it does not.
 */
export function resolveEntry(
  files: Map<string, Uint8Array>,
  declared: string,
  group?: FileGroup
): ResolvedEntry | undefined {
  for (const path of candidates(declared, group)) {
    const bytes = files.get(path);
    if (bytes) return { path, bytes, migrated: path !== declared };
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a bundle's manifest and file contents
 */
export function validateBundle(
  manifest: BundleManifest,
  files: Map<string, Uint8Array>
): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  const error = (text: string) => {
    result.errors.push(text);
    result.valid = false;
  };

  // Required manifest fields
  if (!manifest.name) error('Manifest missing required field: name');
  if (!manifest.version) error('Manifest missing required field: version');
  if (!manifest.main) error('Manifest missing required field: main');

  const groups = (manifest as { files?: unknown }).files;
  if (groups !== undefined && !isObject(groups)) {
    error('manifest.files must be an object of file groups (ui, logic, server, xdb, assets)');
  }

  // Main entry point exists, and is a UI file the Builder will load.
  if (manifest.main) {
    const main = resolveEntry(files, manifest.main, 'ui');
    if (!main) {
      error(`Entry file "${manifest.main}" (manifest.main) is not in the bundle. Add the file, or point main at a UI file the bundle has.`);
    } else if (isObject(groups) && Array.isArray(groups.ui)) {
      const listed = groups.ui.some((p) => typeof p === 'string' && resolveEntry(files, p, 'ui')?.path === main.path);
      if (!listed) {
        error(`Entry file "${manifest.main}" is not listed in manifest.files.ui, so it would not be loaded. Add it to the ui group.`);
      }
    }
  }

  // Every file a group promises must be there: the runtime resolves them by
  // these paths and the directory checks the archive against them.
  if (isObject(groups)) {
    for (const [group, list] of Object.entries(groups)) {
      const known = (FILE_GROUPS as readonly string[]).includes(group);
      if (!Array.isArray(list)) {
        error(`manifest.files.${group} must be a list of paths`);
        continue;
      }
      for (const item of list) {
        if (typeof item !== 'string') {
          error(`manifest.files.${group} has an entry that is not a path`);
          continue;
        }
        const found = resolveEntry(files, item, known ? (group as FileGroup) : undefined);
        if (found) continue;
        const text = `manifest.files.${group} lists "${item}", but the bundle has no such file. Add the file or remove it from the manifest.`;
        if (known) error(text);
        else result.warnings.push(text);
      }
      if (!known) {
        result.warnings.push(`manifest.files.${group} is not a group the runtime reads; it is kept as declared.`);
      }
    }
  }

  // XDB files are readable JSON. The runtime treats an unreadable one as an
  // empty collection, so this is a warning; the loader reports it too.
  const decoder = new TextDecoder();
  if (isObject(groups) && Array.isArray(groups.xdb)) {
    for (const xdbPath of groups.xdb) {
      if (typeof xdbPath !== 'string') continue;
      const found = resolveEntry(files, xdbPath, 'xdb');
      if (!found) continue;
      try {
        const parsed = JSON.parse(decoder.decode(found.bytes));
        if (!isObject(parsed) || !parsed.collection) {
          result.warnings.push(`XDB file "${xdbPath}" missing 'collection' field`);
        }
      } catch {
        result.warnings.push(`XDB file "${xdbPath}" contains invalid JSON`);
      }
    }
  }

  return result;
}
