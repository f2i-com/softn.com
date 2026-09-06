import { inspectEntries } from '@softn/core';
import type { ValidationError, VFSFile, Blueprint } from '../types/studio';
import { normalizeManifestForBundle } from './exportBundle';

/**
 * The bundle the project would export, inspected the way the directory and
 * the runtime will inspect it — the same checks Builder runs before an
 * export and the site runs before an upload — plus what only Studio knows:
 * the blueprint's pages, and files that are still empty.
 *
 * Studio's validator used to look for a manifest `entry` field the runtime
 * never read, and pass an export the directory then refused for having no
 * `main`. Now it asks the one inspector.
 */
export function validateProject(
  files: Map<string, VFSFile>,
  blueprint: Blueprint | null,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // What the archive will hold: every project file except Studio's own, with
  // the manifest as the export writes it.
  const entries = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  for (const [path, file] of files) {
    if (path.startsWith('builder/')) continue;
    entries.set(path, typeof file.content === 'string' ? encoder.encode(file.content) : file.content);
  }
  const manifest = normalizeManifestForBundle(files);
  if (manifest !== null) entries.set('manifest.json', encoder.encode(manifest));

  if (entries.size > 0) {
    const inspection = inspectEntries(entries);
    for (const line of inspection.report) {
      const mentionsManifest = /manifest/i.test(line.text);
      const mentionsPermission = /permission\.json/i.test(line.text);
      errors.push({
        file: mentionsPermission ? 'permission.json' : mentionsManifest ? 'manifest.json' : fileNamedIn(line.text, files) ?? 'manifest.json',
        level: line.level === 'error' ? 'error' : 'warning',
        type: line.level === 'error' ? 'bundle-refused' : 'bundle-note',
        message: line.text,
        suggestion: line.level === 'error' ? 'The directory will refuse this bundle until it is fixed.' : undefined,
      });
    }
  }

  // JSON files must parse; the inspector reads only the manifest and the declaration.
  for (const [path, file] of files) {
    if (typeof file.content !== 'string') continue;
    if (path === 'manifest.json' || path === 'permission.json') continue;
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

  // Blueprint pages should each have a file, in either format.
  if (blueprint) {
    for (const page of blueprint.pages) {
      const slugName = page.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const expectedPaths = [
        `ui/pages/${slugName}.ui`,
        `ui/${slugName}.ui`,
        `pages/${slugName}.ui`,
        `pages/${slugName}.html`,
      ];
      const hasFile = expectedPaths.some((p) => files.has(p));
      if (!hasFile) {
        errors.push({
          file: `ui/pages/${slugName}.ui`,
          level: 'info',
          type: 'missing-page-file',
          message: `Blueprint page "${page.name}" has no matching file.`,
          suggestion: 'Ask the AI to generate this page.',
        });
      }
    }
  }

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

/** The project file a report line names, if it names one. */
function fileNamedIn(text: string, files: Map<string, VFSFile>): string | null {
  for (const path of files.keys()) {
    if (text.includes(path)) return path;
  }
  return null;
}
