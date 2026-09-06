import { zipSync } from 'fflate';
import type { VFSFile } from '../types/studio';

/**
 * The manifest a bundle needs, from whatever the project has.
 *
 * Studio's own scaffold and its model both once wrote `entry`; the runtime,
 * the loaders and the directory read `main`, and refused a bundle without
 * it. The runtime also resolves files by the manifest's `files` groups. So an
 * export normalises: `main` from `entry` where only that is set, `version`
 * where none is, and the groups from what the project actually holds. The
 * project's own manifest is left alone; this is what goes in the archive.
 */
export function normalizeManifestForBundle(files: Map<string, VFSFile>): string | null {
  const manifestFile = files.get('manifest.json');
  if (!manifestFile || typeof manifestFile.content !== 'string') return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestFile.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;

  const out: Record<string, unknown> = { ...manifest };
  if (typeof out.main !== 'string' || !out.main) {
    if (typeof out.entry === 'string' && out.entry) out.main = out.entry;
    else if (files.has('ui/main.ui')) out.main = 'ui/main.ui';
  }
  if (typeof out.version !== 'string' || !out.version.trim()) out.version = '1.0.0';

  const paths = [...files.keys()].filter((p) => !p.startsWith('builder/') && p !== 'manifest.json' && p !== 'permission.json');
  const group = (test: (p: string) => boolean) => paths.filter(test).sort();
  const ui = group((p) => /\.ui$/i.test(p));
  const logic = group((p) => /\.logic$/i.test(p) && !p.startsWith('server/'));
  const server = group((p) => p.startsWith('server/') && /\.logic$/i.test(p));
  const xdb = group((p) => /\.xdb$/i.test(p));
  const known = new Set([...ui, ...logic, ...server, ...xdb]);
  const assets = group((p) => !known.has(p));
  const declared = out.files && typeof out.files === 'object' && !Array.isArray(out.files) ? (out.files as Record<string, unknown>) : {};
  out.files = {
    ...declared,
    ui,
    logic,
    ...(server.length > 0 ? { server } : {}),
    xdb,
    assets,
  };
  return JSON.stringify(out, null, 2);
}

/**
 * The project as an archive. `builder/` is Studio's own working state and
 * stays out; the manifest goes in normalised. `level` 0 stores rather than
 * deflates, for a validation pass that only needs the bytes to be right.
 */
export function buildBundle(files: Map<string, VFSFile>, level: 0 | 6 = 6): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [rawPath, file] of files) {
    if (rawPath.startsWith('builder/')) continue;

    // Normalize path: forward slashes, no leading slash, no traversal
    const path = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
    if (!path || path.includes('..')) continue;

    const content =
      typeof file.content === 'string'
        ? new TextEncoder().encode(file.content)
        : file.content;
    entries[path] = content;
  }
  const manifest = normalizeManifestForBundle(files);
  if (manifest !== null) entries['manifest.json'] = new TextEncoder().encode(manifest);

  return zipSync(entries, { level });
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
