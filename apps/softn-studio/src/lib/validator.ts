import { classifyAsset, composeBundleSource, inspectEntries } from '@softn/core';
import type { ValidationError, VFSFile, Blueprint } from '../types/studio';
import { planBundle } from './exportBundle';
import { normalizeProjectPath } from './paths';
import { findPageFile, pageFileCandidates, pageSlugs } from './studioProject';

/**
 * The bundle the project would export, inspected the way the directory and
 * the runtime will inspect it — the same checks Builder runs before an
 * export and the site runs before an upload — plus what only Studio knows:
 * the blueprint's pages, and files that are still empty.
 *
 * Studio's validator used to look for a manifest `entry` field the runtime
 * never read, and pass an export the directory then refused for having no
 * `main`. Now it asks the one inspector, and it asks about the exact
 * entries the export will write — the same plan, so a path the export
 * refuses or a manifest entry it prunes is reported here first.
 */
export function validateProject(
  files: Map<string, VFSFile>,
  blueprint: Blueprint | null,
): ValidationError[] {
  const errors: ValidationError[] = [];

  const { entries, problems } = planBundle(files);
  errors.push(...problems);

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

    // The inspector reads the manifest; it does not compose the app. A
    // missing <logic src> target, JavaScript and Python in one app, inline
    // Python, or a .py file whose name Python cannot import all passed here
    // and then stopped the app at Run. The composer is what refuses them, so
    // it is run on the same entries, and what it says is reported as it said it.
    const refusal = compositionRefusal(entries);
    if (refusal) {
      errors.push({
        file: fileNamedIn(refusal.message, files) ?? refusal.main,
        level: 'error',
        type: 'bundle-refused',
        message: refusal.message,
        suggestion: 'The runtime cannot start this app until it is fixed.',
      });
    }
  }

  // Server logic runs on the PHP or Rust host, and both run it as JavaScript
  // only (docs/engineering/ZIPP_LANGUAGES.md), so Python there never runs.
  for (const path of files.keys()) {
    if (/^server\/.*\.py$/i.test(path)) {
      errors.push({
        file: path,
        level: 'error',
        type: 'bundle-refused',
        message: 'Server logic runs as JavaScript on every backend host; this Python file would never run.',
        suggestion: 'Write server logic as a .logic file in JavaScript. Python can be used for the client logic.',
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
    const slugs = pageSlugs(blueprint.pages);
    for (const [index, page] of blueprint.pages.entries()) {
      if (!findPageFile(files, blueprint.pages, index)) {
        errors.push({
          file: pageFileCandidates(slugs[index])[0],
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

const decoder = new TextDecoder();

/**
 * Why the runtime's composer would refuse the planned bundle, or null when it
 * would compose it — or when there is no entry to compose from, which the
 * inspector has already reported. It is given what the runtime is given: the
 * text entries as the export writes them, the manifest's `main`, and its
 * logic group, which is the order helpers are loaded in.
 */
function compositionRefusal(entries: Map<string, Uint8Array>): { main: string; message: string } | null {
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) return null;
  let manifest: { main?: unknown; files?: { logic?: unknown } } | null;
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes)) as typeof manifest;
  } catch {
    return null;
  }
  const main = typeof manifest?.main === 'string' ? normalizeProjectPath(manifest.main) : null;
  if (!main || !entries.has(main)) return null;

  const text = new Map<string, string>();
  for (const [path, bytes] of entries) {
    if (!classifyAsset(path).binary) text.set(path, decoder.decode(bytes));
  }
  const declared = manifest?.files?.logic;
  const logic = Array.isArray(declared) ? declared.filter((path): path is string => typeof path === 'string') : [];
  try {
    composeBundleSource(text, main, logic);
    return null;
  } catch (err) {
    return { main, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The project file a report line names, if it names one. */
function fileNamedIn(text: string, files: Map<string, VFSFile>): string | null {
  for (const path of files.keys()) {
    if (text.includes(path)) return path;
  }
  return null;
}
