import type { ValidationError, VFSFile, Blueprint } from '../types/studio';

/**
 * Run basic validation checks on VFS files and blueprint.
 * Returns an array of validation errors/warnings/info.
 */
export function validateProject(
  files: Map<string, VFSFile>,
  blueprint: Blueprint | null,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 1. Check for manifest.json
  const manifest = files.get('manifest.json');
  if (!manifest) {
    errors.push({
      file: 'manifest.json',
      level: 'warning',
      type: 'missing-manifest',
      message: 'No manifest.json found. Export and preview may not work correctly.',
      suggestion: 'Create a manifest.json with at least a "name" and "entry" field.',
    });
  } else if (typeof manifest.content === 'string') {
    try {
      const parsed = JSON.parse(manifest.content);
      if (!parsed.entry) {
        errors.push({
          file: 'manifest.json',
          level: 'warning',
          type: 'missing-entry',
          message: 'manifest.json has no "entry" field. Preview won\'t know which page to load.',
          suggestion: 'Add an "entry" field pointing to your main HTML or UI file.',
        });
      } else if (!files.has(parsed.entry)) {
        errors.push({
          file: 'manifest.json',
          level: 'error',
          type: 'broken-entry',
          message: `Entry file "${parsed.entry}" referenced in manifest does not exist.`,
          suggestion: 'Create the entry file or update the manifest entry path.',
        });
      }
    } catch {
      errors.push({
        file: 'manifest.json',
        level: 'error',
        type: 'invalid-json',
        message: 'manifest.json contains invalid JSON.',
      });
    }
  }

  // 2. Check HTML files for basic validity
  for (const [path, file] of files) {
    if (typeof file.content !== 'string') continue;

    if (path.endsWith('.html') || path.endsWith('.htm')) {
      if (!file.content.includes('<html') && !file.content.includes('<!DOCTYPE') && !file.content.includes('<!doctype')) {
        errors.push({
          file: path,
          level: 'info',
          type: 'html-fragment',
          message: 'This HTML file may be a fragment (no <html> or <!DOCTYPE> tag).',
        });
      }
    }

    // 3. Check JSON files for parse errors
    if (path.endsWith('.json') || path.endsWith('.xdb')) {
      try {
        JSON.parse(file.content);
      } catch {
        errors.push({
          file: path,
          level: 'error',
          type: 'invalid-json',
          message: 'This file contains invalid JSON.',
        });
      }
    }
  }

  // 4. Check blueprint pages have matching files
  if (blueprint) {
    for (const page of blueprint.pages) {
      const slugName = page.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const expectedPaths = [
        `pages/${slugName}.html`,
        `pages/${slugName}.ui`,
        `ui/${slugName}.ui`,
      ];
      const hasFile = expectedPaths.some((p) => files.has(p));
      if (!hasFile) {
        errors.push({
          file: `pages/${slugName}.html`,
          level: 'info',
          type: 'missing-page-file',
          message: `Blueprint page "${page.name}" has no matching file.`,
          suggestion: 'Ask the AI to generate this page.',
        });
      }
    }
  }

  // 5. Check for empty files
  for (const [path, file] of files) {
    if (typeof file.content === 'string' && file.content.trim().length === 0) {
      errors.push({
        file: path,
        level: 'info',
        type: 'empty-file',
        message: 'This file is empty.',
      });
    }
  }

  return errors;
}
