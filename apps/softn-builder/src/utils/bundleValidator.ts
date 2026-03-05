/**
 * Bundle Validator - Validates .softn bundle integrity
 */

import type { BundleManifest } from './bundleExporter';

export interface ValidationResult {
  valid: boolean;
  errors: string[];   // Fatal: bundle cannot be loaded
  warnings: string[]; // Non-fatal: bundle loads but may be incomplete
}

/**
 * Validate a bundle's manifest and file contents
 */
export function validateBundle(
  manifest: BundleManifest,
  files: Map<string, Uint8Array>
): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  // Required manifest fields
  if (!manifest.name) {
    result.errors.push('Manifest missing required field: name');
    result.valid = false;
  }
  if (!manifest.version) {
    result.errors.push('Manifest missing required field: version');
    result.valid = false;
  }
  if (!manifest.main) {
    result.errors.push('Manifest missing required field: main');
    result.valid = false;
  }

  // Main entry point exists
  if (manifest.main && !findFile(files, manifest.main)) {
    result.errors.push(`Main file "${manifest.main}" not found in bundle`);
    result.valid = false;
  }

  // All referenced UI files exist
  for (const uiPath of manifest.files?.ui || []) {
    if (!findFile(files, uiPath)) {
      result.warnings.push(`UI file "${uiPath}" referenced in manifest but not found`);
    }
  }

  // All referenced logic files exist
  for (const logicPath of manifest.files?.logic || []) {
    if (!findFile(files, logicPath)) {
      result.warnings.push(`Logic file "${logicPath}" referenced in manifest but not found`);
    }
  }

  // XDB files are valid JSON
  const decoder = new TextDecoder();
  for (const xdbPath of manifest.files?.xdb || []) {
    const content = findFile(files, xdbPath);
    if (!content) {
      result.warnings.push(`XDB file "${xdbPath}" referenced in manifest but not found`);
      continue;
    }
    try {
      const parsed = JSON.parse(decoder.decode(content));
      if (!parsed.collection) {
        result.warnings.push(`XDB file "${xdbPath}" missing 'collection' field`);
      }
    } catch {
      result.warnings.push(`XDB file "${xdbPath}" contains invalid JSON`);
    }
  }

  return result;
}

/**
 * Find a file in the bundle, checking multiple path variations
 */
function findFile(files: Map<string, Uint8Array>, path: string): Uint8Array | undefined {
  // Try as-is
  if (files.has(path)) return files.get(path);

  // Try without leading slash
  const noSlash = path.startsWith('/') ? path.slice(1) : path;
  if (files.has(noSlash)) return files.get(noSlash);

  // Try normalized (backslashes to forward slashes)
  const normalized = path.replace(/\\/g, '/');
  if (files.has(normalized)) return files.get(normalized);

  return undefined;
}
