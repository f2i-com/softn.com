/**
 * Shared `.softn` bundle validation helpers.
 *
 * Reuses `openBundleArchive` and `inspectEntries` so generated bundles pass the
 * exact same path, ZIP, manifest, capability, and migration checks enforced by
 * the runtime and directory API.
 */

import { inspectBundle, inspectEntries, type BundleInspection } from './inspect';
import { isUnsafeEntryName } from './zip';

const FATAL_UTF8_ENCODER = new TextEncoder();

export interface BundleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  inspection: BundleInspection;
}

/**
 * Validate a single bundle entry path before adding it to an archive.
 * Returns a human-readable error message or `null` if the path is valid.
 */
export function validateBundlePath(rawPath: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return 'Bundle file path must be a non-empty string.';
  }
  if (rawPath.includes('\\')) {
    return `Bundle file path "${rawPath}" must use forward slashes (/) instead of backslashes.`;
  }
  if (rawPath.endsWith('/')) {
    return `Bundle file path "${rawPath}" must name a file, not a directory.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    return `Bundle file path "${rawPath}" contains control characters.`;
  }
  if (isUnsafeEntryName(rawPath)) {
    return `Bundle file path "${rawPath}" is unsafe (no leading slash, "..", ".", empty segments, drive letters, or __proto__).`;
  }
  if (FATAL_UTF8_ENCODER.encode(rawPath).byteLength > 1024) {
    return `Bundle file path "${rawPath}" exceeds 1024 UTF-8 bytes.`;
  }
  return null;
}

/**
 * Validate optional `manifest.databases` declarations, including versioned schema migrations.
 */
export function validateDatabaseConfigs(
  databases: unknown,
  entries?: ReadonlyMap<string, Uint8Array>
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (databases === undefined) return { errors, warnings };
  if (!Array.isArray(databases)) {
    errors.push('manifest.databases must be an array of database declarations.');
    return { errors, warnings };
  }
  const seenNames = new Set<string>();
  for (let i = 0; i < databases.length; i++) {
    const item = databases[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`manifest.databases[${i}] must be an object.`);
      continue;
    }
    const db = item as Record<string, unknown>;
    const name = typeof db.name === 'string' ? db.name.trim() : '';
    if (!name) {
      errors.push(`manifest.databases[${i}] must have a non-empty "name".`);
    } else if (seenNames.has(name.toLowerCase())) {
      errors.push(`manifest.databases contains duplicate database name "${name}".`);
    } else {
      seenNames.add(name.toLowerCase());
    }
    if (db.engine !== undefined && db.engine !== 'sqlite') {
      errors.push(`manifest.databases[${i}].engine must be "sqlite" (got ${JSON.stringify(db.engine)}).`);
    }
    if (db.file !== undefined) {
      if (typeof db.file !== 'string') {
        errors.push(`manifest.databases[${i}].file must be a string path.`);
      } else {
        const pathErr = validateBundlePath(db.file);
        if (pathErr) errors.push(`manifest.databases[${i}].file: ${pathErr}`);
      }
    }
    if (db.schemaVersion !== undefined) {
      if (typeof db.schemaVersion !== 'number' || !Number.isInteger(db.schemaVersion) || db.schemaVersion < 1) {
        errors.push(`manifest.databases[${i}].schemaVersion must be a positive integer.`);
      }
    }
    if (db.migrations !== undefined) {
      if (!Array.isArray(db.migrations)) {
        errors.push(`manifest.databases[${i}].migrations must be an array.`);
      } else {
        const seenVersions = new Set<number>();
        let prevVersion = 0;
        let maxVersion = 0;
        for (let m = 0; m < db.migrations.length; m++) {
          const mig = db.migrations[m];
          if (!mig || typeof mig !== 'object' || Array.isArray(mig)) {
            errors.push(`manifest.databases[${i}].migrations[${m}] must be an object.`);
            continue;
          }
          const migObj = mig as Record<string, unknown>;
          const ver = migObj.version;
          if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < 1) {
            errors.push(`manifest.databases[${i}].migrations[${m}].version must be a positive integer.`);
          } else {
            if (seenVersions.has(ver)) {
              errors.push(`manifest.databases[${i}].migrations contains duplicate version ${ver}.`);
            }
            if (ver < prevVersion) {
              errors.push(`manifest.databases[${i}].migrations must be ordered by ascending version (found ${ver} after ${prevVersion}).`);
            }
            seenVersions.add(ver);
            prevVersion = ver;
            if (ver > maxVersion) maxVersion = ver;
          }
          const hasFile = typeof migObj.file === 'string' && migObj.file.trim().length > 0;
          const hasSql = typeof migObj.sql === 'string' && migObj.sql.trim().length > 0;
          if (!hasFile && !hasSql) {
            errors.push(`manifest.databases[${i}].migrations[${m}] must specify a "file" or inline "sql".`);
          }
          if (hasFile) {
            const migFile = (migObj.file as string).replace(/^\/+/, '');
            const fileErr = validateBundlePath(migFile);
            if (fileErr) {
              errors.push(`manifest.databases[${i}].migrations[${m}].file: ${fileErr}`);
            } else if (entries && !entries.has(migFile)) {
              errors.push(`manifest.databases[${i}].migrations[${m}].file "${migFile}" is not present in the bundle.`);
            }
          }
        }
        if (typeof db.schemaVersion === 'number' && Number.isInteger(db.schemaVersion) && maxVersion > db.schemaVersion) {
          errors.push(`manifest.databases[${i}].schemaVersion (${db.schemaVersion}) is lower than highest migration version (${maxVersion}).`);
        }
      }
    }
  }
  return { errors, warnings };
}

function extraManifestChecks(entries: ReadonlyMap<string, Uint8Array>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawManifest = entries.get('manifest.json');
  if (!rawManifest) return { errors, warnings };
  let parsed: Record<string, unknown>;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(rawManifest)) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return { errors, warnings };
    parsed = decoded as Record<string, unknown>;
  } catch {
    return { errors, warnings };
  }
  if (parsed.backend !== undefined) {
    if (!parsed.backend || typeof parsed.backend !== 'object' || Array.isArray(parsed.backend)) {
      errors.push('manifest.backend must be an object.');
    } else {
      const backend = parsed.backend as Record<string, unknown>;
      const runtime = typeof backend.runtime === 'string' ? backend.runtime.toLowerCase() : '';
      if (!['rust', 'php', 'javascript', 'typescript', 'python'].includes(runtime)) {
        errors.push(`manifest.backend.runtime "${String(backend.runtime ?? '')}" is not supported.`);
      }
      const entry = typeof backend.entry === 'string' ? backend.entry.replace(/^\/+/, '') : '';
      if (!entry) {
        errors.push('manifest.backend.entry must name a file in the bundle.');
      } else {
        const entryErr = validateBundlePath(entry);
        if (entryErr) errors.push(`manifest.backend.entry: ${entryErr}`);
        else if (!entries.has(entry)) {
          errors.push(`manifest.backend.entry "${entry}" is not present in the bundle.`);
        }
      }
    }
  }
  const dbCheck = validateDatabaseConfigs(parsed.databases, entries);
  errors.push(...dbCheck.errors);
  warnings.push(...dbCheck.warnings);
  return { errors, warnings };
}

/** Validate an in-memory map or plain record of bundle entries. */
export function validateBundleEntries(
  entries: Map<string, Uint8Array> | Record<string, Uint8Array>
): BundleValidationResult {
  const map = entries instanceof Map ? entries : new Map<string, Uint8Array>(Object.entries(entries));
  const inspection = inspectEntries(map);
  const extra = extraManifestChecks(map);
  const errors = [
    ...inspection.report.filter((l) => l.level === 'error').map((l) => l.text),
    ...extra.errors,
  ];
  const warnings = [
    ...inspection.report.filter((l) => l.level === 'warn').map((l) => l.text),
    ...extra.warnings,
  ];
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    inspection: {
      ...inspection,
      problem: errors[0] ?? null,
      report: [
        ...inspection.report,
        ...extra.errors.map((text) => ({ level: 'error' as const, text })),
        ...extra.warnings.map((text) => ({ level: 'warn' as const, text })),
      ],
    },
  };
}

/** Validate a compiled `.softn` ZIP byte buffer. */
export function validateBundleBytes(bytes: Uint8Array): BundleValidationResult {
  const inspection = inspectBundle(bytes);
  const errors = inspection.report.filter((l) => l.level === 'error').map((l) => l.text);
  const warnings = inspection.report.filter((l) => l.level === 'warn').map((l) => l.text);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    inspection,
  };
}
