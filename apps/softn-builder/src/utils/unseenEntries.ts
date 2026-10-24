import type { RetainedExportSource } from './bundleExporter';

/**
 * The files of an opened bundle the Builder does not show, which an export
 * writes back as they came (bundleLoader.ts keeps them): server logic, files
 * of groups the Builder does not know, files no group names, data files it
 * could not read. Nothing in the editor said they were there, so a template
 * edited and exported shipped them unseen, server code among them, which a
 * host runs (`server` in the manifest). The export dialog names them.
 */
export interface UnseenEntries {
  /** Server logic: the manifest's `server` group, and anything under `server/`. */
  server: string[];
  /** Every other file carried as it came. */
  other: string[];
}

export function unseenEntries(source: Pick<RetainedExportSource, 'manifest' | 'extraEntries'>): UnseenEntries {
  const files = source.manifest?.files;
  const group = files && typeof files === 'object' && !Array.isArray(files) ? (files as Record<string, unknown>).server : undefined;
  const declared = new Set(Array.isArray(group) ? group.filter((path): path is string => typeof path === 'string').map((path) => path.replace(/^\.\//, '')) : []);
  const server: string[] = [];
  const other: string[] = [];
  for (const path of [...source.extraEntries.keys()].sort((a, b) => a.localeCompare(b))) {
    (declared.has(path) || /^server\//i.test(path) ? server : other).push(path);
  }
  return { server, other };
}

/** A list of paths for a sentence: the first few, and how many more. */
export function namePaths(paths: string[], shown = 6): string {
  const named = paths.slice(0, shown).join(', ');
  return paths.length > shown ? `${named}, and ${paths.length - shown} more` : named;
}
