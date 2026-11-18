import { parseManifest } from '@softn/editor-shared/formlogicBackend';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';

/** Private sources travel in the full project but stay outside the frontend file tree. */
export function readBuilderBackendFiles(
  project: Pick<ReturnType<typeof useProjectStore.getState>, 'source' | 'projectFormat'> = useProjectStore.getState(),
): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  for (const [path, data] of project.source.extraEntries) {
    if (/^server\/.*\.(logic|sql)$/i.test(path)) files[path] = new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  const manifest = project.source.manifest ?? (project.projectFormat === 'web' ? { formatVersion: 2, engine: 2 } : { formatVersion: '1.0' });
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
  return files;
}

export function applyBuilderBackendFiles(changes: Record<string, string>): void {
  const project = useProjectStore.getState();
  const source = project.source;
  const extraEntries = new Map(source.extraEntries);
  let manifest = source.manifest;
  const nodes = [...useFilesStore.getState().nodes.values()];
  for (const [path, text] of Object.entries(changes)) {
    if (path === 'manifest.json') manifest = parseManifest(text);
    else {
      if (!/^server\/(?:[\w.-]+\/)*[\w.-]+\.(logic|sql)$/.test(path) || path.includes('..')) throw new Error('Choose a server source or migration file.');
      if (nodes.some(n => n.path.replace(/^\//, '').toLowerCase() === path.toLowerCase())) throw new Error(`A project file already uses ${path}.`);
      extraEntries.set(path, new TextEncoder().encode(text));
    }
  }
  project.setSource({ ...source, manifest, extraEntries });
  project.markDirty();
}
