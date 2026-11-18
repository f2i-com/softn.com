import { compiledSourcePath, isGeneratedSourceModule } from '@softn/bundle-format/source-modules';

type WebEntry = string | Uint8Array;

function authoredEntries<T extends WebEntry>(entries: Record<string, T>): Record<string, T> {
  let authored = entries;
  for (const path of Object.keys(entries)) {
    if (!path.startsWith('__softn_generated__/')) continue;
    const file = entries[path];
    if (isGeneratedSourceModule(path, typeof file === 'string' ? file : new TextDecoder().decode(file))) {
      if (authored === entries) authored = { ...entries };
      delete authored[path];
    }
  }
  return authored;
}

/** Compile a snapshot. Keep every authored file, including byte-order marks and binary assets, as supplied. */
async function compiledModules(entries: Record<string, WebEntry>): Promise<Map<string, string>> {
  const decoder = new TextDecoder();
  const text = new Map<string, string>();
  for (const [path, file] of Object.entries(entries)) {
    // Pages and the manifest identify the project's framework imports. Other
    // paths establish references and output collisions without decoding large assets.
    const readsContent = compiledSourcePath(path) || /\.html?$/i.test(path) || path === 'manifest.json';
    const source = typeof file === 'string' ? file : readsContent ? decoder.decode(file) : '';
    text.set(path, source);
  }
  const { prepareWebSourceFiles } = await import('./webSourceCompiler');
  const prepared = await prepareWebSourceFiles(text);
  return new Map([...prepared].filter(([path, source]) => isGeneratedSourceModule(path, source)));
}

export async function webPreviewEntries(files: Record<string, WebEntry>): Promise<Record<string, WebEntry>> {
  const entries = authoredEntries(files);
  if (!Object.keys(entries).some((path) => compiledSourcePath(path))) return entries;
  return { ...entries, ...Object.fromEntries(await compiledModules(entries)) };
}

export async function webArchiveEntries(files: Record<string, Uint8Array>): Promise<Record<string, Uint8Array>> {
  const entries = authoredEntries(files);
  if (!Object.keys(entries).some((path) => compiledSourcePath(path))) return entries;
  const output = { ...entries };
  const encoder = new TextEncoder();
  for (const [path, source] of await compiledModules(entries)) output[path] = encoder.encode(source);
  return output;
}
