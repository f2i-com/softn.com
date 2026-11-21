import { classifyAsset, composeBundleSource, inspectEntries } from '@softn/core/authoring';
import type { ValidationError, VFSFile, Blueprint } from '../types/studio';
import { planBundle } from './exportBundle';
import { pageParseProblems } from './pageDiagnostics';
import { normalizeProjectPath } from './paths';
import { resolveProjectRelativePath } from './projectImport';
import { projectContainerMode } from './sourceKinds';
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
 *
 * Every page is parsed as well, by core's parser, each as its own file
 * (lib/pageDiagnostics.ts). Whether the logic compiles is the engine's to
 * say, which takes a moment, so it is asked apart from this
 * (lib/logicCheck.ts, run with this by lib/projectCheck.ts).
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
    const isV2Container = projectContainerMode(files) === 'web';
    if (isV2Container) {
      errors.push(...v2ContainerLinkProblems(entries));
      errors.push(...v2ContainerBackendProblems(entries));
    } else {
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
        suggestion: 'Write server logic in JavaScript. Python can be used for the logic of the pages.',
      });
    }
  }

  // What core's parser says of each page, at the page's own lines (v1 template bundles only).
  if (projectContainerMode(files) !== 'web') {
    errors.push(...pageParseProblems(files));
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
  if (blueprint && projectContainerMode(files) !== 'web') {
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

const CONTAINER_BACKEND_RUNTIMES = new Set(['php', 'rust', 'javascript', 'typescript', 'python']);

function readManifestObject(entries: Map<string, Uint8Array>): Record<string, unknown> | null {
  const bytes = entries.get('manifest.json');
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function v2ContainerBackendProblems(entries: Map<string, Uint8Array>): ValidationError[] {
  const out: ValidationError[] = [];
  const manifest = readManifestObject(entries);
  if (!manifest) return out;

  const backend = manifest.backend;
  if (backend !== undefined) {
    if (!backend || typeof backend !== 'object' || Array.isArray(backend)) {
      out.push({
        file: 'manifest.json',
        level: 'error',
        type: 'invalid-backend',
        message: 'manifest.json "backend" must be an object with "runtime" and "entry".',
      });
    } else {
      const cfg = backend as Record<string, unknown>;
      const runtime = typeof cfg.runtime === 'string' ? cfg.runtime.toLowerCase() : '';
      if (!CONTAINER_BACKEND_RUNTIMES.has(runtime)) {
        out.push({
          file: 'manifest.json',
          level: 'error',
          type: 'invalid-backend',
          message: `manifest.json backend.runtime "${String(cfg.runtime ?? '')}" is not supported; use php, rust, javascript, typescript, or python.`,
        });
      }
      const entry = typeof cfg.entry === 'string' ? normalizeProjectPath(cfg.entry.replace(/^\.?\//, '')) : null;
      if (!entry) {
        out.push({
          file: 'manifest.json',
          level: 'error',
          type: 'invalid-backend',
          message: 'manifest.json backend.entry must name a backend source file in the bundle.',
        });
      } else if (!entries.has(entry)) {
        out.push({
          file: 'manifest.json',
          level: 'error',
          type: 'missing-reference',
          message: `manifest.json backend.entry "${String(cfg.entry)}" is not in the bundle.`,
          suggestion: 'Create the backend entry file or update backend.entry in manifest.json.',
        });
      }
    }
  }

  if (Array.isArray(manifest.databases)) {
    for (const rawDb of manifest.databases) {
      if (!rawDb || typeof rawDb !== 'object' || Array.isArray(rawDb)) continue;
      const db = rawDb as Record<string, unknown>;
      if (typeof db.seedSql === 'string' && /\.sql$/i.test(db.seedSql.trim()) && !/\s/.test(db.seedSql.trim())) {
        const seedPath = normalizeProjectPath(db.seedSql.trim().replace(/^\.?\//, ''));
        if (!seedPath || !entries.has(seedPath)) {
          out.push({
            file: 'manifest.json',
            level: 'error',
            type: 'missing-reference',
            message: `manifest.json databases seedSql "${db.seedSql}" is not in the bundle.`,
            suggestion: 'Create the SQL schema/seed file or update databases[].seedSql in manifest.json.',
          });
        }
      }
    }
  }

  return out;
}

function v2ContainerLinkProblems(entries: Map<string, Uint8Array>): ValidationError[] {
  const out: ValidationError[] = [];
  const manifest = readManifestObject(entries);
  const rawFrontendRoot = typeof manifest?.frontendRoot === 'string'
    ? manifest.frontendRoot.trim().replace(/^\/+|\/+$/g, '')
    : '';
  const frontendRoot = rawFrontendRoot ? normalizeProjectPath(rawFrontendRoot) ?? '' : '';

  for (const [pagePath, bytes] of entries) {
    if (!/\.html?$/i.test(pagePath) || /^assets\//i.test(pagePath)) continue;
    if (/(?:^|\/)(?:vendor|node_modules|backend)\//i.test(pagePath)) continue;
    const html = decoder.decode(bytes);
    const checkRef = (rawRef: string, kind: 'script' | 'stylesheet') => {
      const clean = rawRef.trim().split(/[?#]/)[0];
      if (!clean || /^(?:softn:|https?:|data:|blob:)/i.test(clean)) return;
      const candidates: Array<string | null> = clean.startsWith('/')
        ? [
            normalizeProjectPath(clean.slice(1)),
            frontendRoot ? normalizeProjectPath(`${frontendRoot}/${clean.slice(1)}`) : null,
          ]
        : [resolveProjectRelativePath(pagePath, clean)];
      if (!candidates.some((p) => p !== null && entries.has(p))) {
        out.push({
          file: pagePath,
          level: 'error',
          type: 'missing-reference',
          message: `${pagePath} references ${kind} "${rawRef}", which is not in the bundle.`,
          suggestion: 'Create the missing file or update the path in the HTML tag.',
        });
      }
    };
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      checkRef(m[1], 'script');
    }
    for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi)) {
      const hm = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
      if (hm) checkRef(hm[1], 'stylesheet');
    }
  }
  return out;
}

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
