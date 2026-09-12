import { zipSync } from 'fflate';
import type { ValidationError, VFSFile } from '../types/studio';
import { resolveProjectPath } from './paths';

/**
 * The archive a project would become, before it becomes one.
 *
 * `entries` is exactly what the validator inspects and the export writes,
 * keyed by canonical path. Nothing is dropped on the way: a VFS key that is
 * not a valid project path, or that is the same file as another key on a
 * case-folding disk, is a `problems` error naming the key, and buildBundle
 * refuses to write an archive while there is one. That is the SHR-05
 * contract: the export used to skip such files silently, and let the later
 * of two aliases overwrite the earlier.
 */
export interface BundlePlan {
  entries: Map<string, Uint8Array>;
  /** The VFS key each canonical entry came from. */
  sources: Map<string, string>;
  problems: ValidationError[];
}

interface Collected {
  entries: Map<string, Uint8Array>;
  sources: Map<string, string>;
  /** Canonical entry path -> its case-folded identity. */
  keys: Set<string>;
  problems: ValidationError[];
}

const encoder = new TextEncoder();

/** The project's files as canonical archive entries, private state left out, problems reported. */
function collectEntries(files: Map<string, VFSFile>): Collected {
  const entries = new Map<string, Uint8Array>();
  const sources = new Map<string, string>();
  const byKey = new Map<string, string>();
  const keys = new Set<string>();
  const problems: ValidationError[] = [];

  for (const [rawPath, file] of files) {
    const verdict = resolveProjectPath(rawPath);
    if (!verdict.ok) {
      problems.push({
        file: rawPath,
        level: 'error',
        type: 'unsafe-path',
        message: `"${rawPath}" cannot go in the bundle: ${verdict.reason}.`,
        suggestion: 'Rename or delete the file. Nothing is exported while it is there.',
      });
      continue;
    }
    if (verdict.private) continue;
    const taken = byKey.get(verdict.key);
    if (taken !== undefined) {
      const collision = (a: string, b: string): ValidationError => ({
        file: a,
        level: 'error',
        type: 'path-collision',
        message: `"${a}" and "${b}" are the same file on a case-insensitive disk; the bundle can hold only one.`,
        suggestion: 'Rename or delete one of them.',
      });
      if (!problems.some((p) => p.type === 'path-collision' && p.file === taken)) problems.push(collision(taken, rawPath));
      problems.push(collision(rawPath, taken));
      continue;
    }
    byKey.set(verdict.key, rawPath);
    keys.add(verdict.key);
    entries.set(verdict.path, typeof file.content === 'string' ? encoder.encode(file.content) : file.content);
    sources.set(verdict.path, rawPath);
  }
  return { entries, sources, keys, problems };
}

const MANAGED_GROUPS = new Set(['ui', 'logic', 'server', 'xdb', 'assets']);

/**
 * The manifest a bundle needs, from whatever the project has, with the
 * warnings the rebuild raised.
 *
 * Studio's own scaffold and its model both once wrote `entry`; the runtime,
 * the loaders and the directory read `main`, and refused a bundle without
 * it. The runtime also resolves files by the manifest's `files` groups. So
 * an export normalises: `main` from `entry` where only that is set,
 * `version` where none is, and the groups from what the project actually
 * holds.
 *
 * Every managed group — ui, logic, server, xdb, assets — is rebuilt from the
 * canonical entries, and a group with nothing in it is removed rather than
 * left as it was. The old code spread the declared groups and only replaced
 * `server` when server files remained, so a `server` group declared once
 * outlived the deletion of its last file and the runtime was sent to load a
 * file that was not there (STU-08). A group this code does not manage is
 * kept, because forward-compatible metadata is worth keeping; but where it
 * is a list of paths, a path no longer in the project is left out and
 * reported, since a manifest that points at nothing is not metadata.
 * The project's own manifest file is left alone; this is what goes in the
 * archive.
 */
export function normalizeManifest(files: Map<string, VFSFile>): { manifest: string | null; warnings: ValidationError[] } {
  return normalizeManifestFrom(files, collectEntries(files));
}

function normalizeManifestFrom(files: Map<string, VFSFile>, collected: Collected): { manifest: string | null; warnings: ValidationError[] } {
  const warnings: ValidationError[] = [];
  const manifestSource = collected.sources.get('manifest.json');
  const manifestFile = manifestSource !== undefined ? files.get(manifestSource) : undefined;
  if (!manifestFile || typeof manifestFile.content !== 'string') return { manifest: null, warnings };
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestFile.content) as Record<string, unknown>;
  } catch {
    return { manifest: null, warnings };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { manifest: null, warnings };

  const out: Record<string, unknown> = { ...manifest };
  if (typeof out.main !== 'string' || !out.main) {
    if (typeof out.entry === 'string' && out.entry) out.main = out.entry;
    else if (collected.entries.has('ui/main.ui')) out.main = 'ui/main.ui';
  }
  if (typeof out.version !== 'string' || !out.version.trim()) out.version = '1.0.0';

  const declared = out.files && typeof out.files === 'object' && !Array.isArray(out.files) ? (out.files as Record<string, unknown>) : {};
  const paths = [...collected.entries.keys()].filter((p) => p !== 'manifest.json' && p !== 'permission.json');
  const group = (name: string, test: (p: string) => boolean) => {
    const remaining = new Map(paths.filter(test).sort().map((path) => [path.toLowerCase(), path]));
    const ordered: string[] = [];
    // Helper logic executes in manifest order. Sorting existing declarations
    // can run an initializer before the helper it depends on after an export.
    // Keep each surviving entry's order, then append newly authored files.
    if (Array.isArray(declared[name])) for (const member of declared[name]) {
      const verdict = typeof member === 'string' ? resolveProjectPath(member) : null;
      const path = verdict?.ok ? remaining.get(verdict.key) : undefined;
      if (path === undefined || !verdict?.ok) continue;
      ordered.push(path);
      remaining.delete(verdict.key);
    }
    return [...ordered, ...remaining.values()];
  };
  const ui = group('ui', (p) => /\.ui$/i.test(p));
  const logic = group('logic', (p) => /\.logic$/i.test(p) && !p.startsWith('server/'));
  const server = group('server', (p) => p.startsWith('server/') && /\.logic$/i.test(p));
  const xdb = group('xdb', (p) => /\.xdb$/i.test(p));
  const known = new Set([...ui, ...logic, ...server, ...xdb]);
  const assets = group('assets', (p) => !known.has(p));

  const groups: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(declared)) {
    if (MANAGED_GROUPS.has(name)) continue;
    if (!Array.isArray(value)) {
      groups[name] = value;
      continue;
    }
    const kept: unknown[] = [];
    for (const member of value) {
      const verdict = typeof member === 'string' ? resolveProjectPath(member) : null;
      if (verdict && verdict.ok && collected.keys.has(verdict.key)) {
        kept.push(verdict.path);
        continue;
      }
      warnings.push({
        file: 'manifest.json',
        level: 'warning',
        type: 'manifest-stale-entry',
        message: `manifest.json lists ${typeof member === 'string' ? member : JSON.stringify(member)} under "${name}", but the project has no such file; it is left out of the export.`,
        suggestion: 'Remove the entry from manifest.json, or restore the file.',
      });
    }
    groups[name] = kept;
  }
  groups.ui = ui;
  groups.logic = logic;
  if (server.length > 0) groups.server = server;
  groups.xdb = xdb;
  groups.assets = assets;
  out.files = groups;
  return { manifest: JSON.stringify(out, null, 2), warnings };
}

/** The normalised manifest text alone, for callers that only want the archive's copy. */
export function normalizeManifestForBundle(files: Map<string, VFSFile>): string | null {
  return normalizeManifest(files).manifest;
}

/** The archive the project would become: its canonical entries, and every reason it could not. */
export function planBundle(files: Map<string, VFSFile>): BundlePlan {
  const collected = collectEntries(files);
  const { manifest, warnings } = normalizeManifestFrom(files, collected);
  if (manifest !== null) collected.entries.set('manifest.json', encoder.encode(manifest));
  return { entries: collected.entries, sources: collected.sources, problems: [...collected.problems, ...warnings] };
}

/**
 * The project as an archive: exactly the planned entries. `level` 0 stores
 * rather than deflates, for a validation pass that only needs the bytes to
 * be right. Throws, naming the paths, when the plan has an error — a bundle
 * with a file missing from it is not the project.
 */
export function buildBundle(files: Map<string, VFSFile>, level: 0 | 6 = 6): Uint8Array {
  const plan = planBundle(files);
  const refused = plan.problems.filter((p) => p.level === 'error');
  if (refused.length > 0) {
    throw new Error(`Export refused: ${refused.map((p) => p.message).join(' ')}`);
  }
  return zipSync(Object.fromEntries(plan.entries), { level });
}

/**
 * Export VFS files as a .softn ZIP bundle.
 * Strips builder/ directory files from the output.
 */
export function exportAsBundle(
  files: Map<string, VFSFile>,
  projectName: string,
): Uint8Array {
  const result = buildBundle(files);

  // Trigger download
  const blob = new Blob([result as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName || 'app'}.softn`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return result;
}
