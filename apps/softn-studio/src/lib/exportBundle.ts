import { zipSync } from 'fflate';
import type { VFSFile } from '../types/studio';

export function buildBundle(files: Map<string, VFSFile>): Uint8Array {
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

  return zipSync(entries, { level: 6 });
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
