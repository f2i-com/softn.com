import { declaresContainer, zeroConfigEntry } from '@softn/bundle-format/engine';
import { isUnsafeEntryName, MAX_ZIP_ENTRIES, MAX_ZIP_FILE_BYTES, MAX_ZIP_INPUT_BYTES } from '@softn/bundle-format/zip';
import { Zip, ZipPassThrough } from 'fflate';

const encoder = new TextEncoder();
const buildHint = 'Choose the built app folder (usually dist or build), or a folder containing a plain HTML app.';
const viteConfig = /^vite\.config\.[cm]?[jt]s$/i;
const privateOrDependency = /(?:^|\/)(?:node_modules|\.git|\.svn|\.hg|\.ssh|\.npmrc|\.env(?:\.[^/]*)?)(?:\/|$)/i;

/** Inspect names and sizes before reading any file, including the manifest. */
function indexFolder(files: readonly File[]) {
  if (!files.length) throw new Error(`This folder is empty. ${buildHint}`);
  if (files.length > MAX_ZIP_ENTRIES) throw new Error(`This folder has too many files. ${buildHint}`);

  const folder = files[0].webkitRelativePath.split('/')[0];
  const byPath = new Map<string, File>();
  // Each streamed ZIP entry has 76 bytes of headers, a 16-byte descriptor, and two names.
  let archiveSize = 22;
  for (const file of files) {
    const relative = file.webkitRelativePath;
    const path = relative.slice(folder.length + 1);
    if (!folder || !relative.startsWith(folder + '/') || relative.includes('\\') ||
        isUnsafeEntryName(folder) || isUnsafeEntryName(path)) {
      throw new Error(`This selection contains an unsupported file path “${relative}”. Choose one app folder.`);
    }
    if (viteConfig.test(path) || privateOrDependency.test(relative)) {
      throw new Error(`The selection includes “${relative}”. ${buildHint}`);
    }
    if (byPath.has(path)) throw new Error(`The folder has two files named “${path}”.`);
    if (file.size > MAX_ZIP_FILE_BYTES) throw new Error(`“${path}” exceeds the ${MAX_ZIP_FILE_BYTES / 1024 / 1024} MB file limit.`);
    byPath.set(path, file);
    const nameLength = encoder.encode(path).byteLength;
    if (nameLength > 0xffff) throw new Error(`The path to “${file.name}” is too long for an app archive.`);
    archiveSize += 92 + 2 * nameLength + file.size;
  }
  if (archiveSize > MAX_ZIP_INPUT_BYTES) throw new Error(`This app folder exceeds the ${MAX_ZIP_INPUT_BYTES / 1024 / 1024} MB archive limit.`);
  return { folder, byPath, archiveSize };
}

/** The archive copy of an installable web app can carry both sets of manifest fields. */
function webManifest(bytes: Uint8Array<ArrayBuffer>, byPath: ReadonlyMap<string, File>, entry: string | null): Uint8Array<ArrayBuffer> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The app’s manifest.json is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The app’s manifest.json must be an object.');
  const manifest = raw as Record<string, unknown>;
  if (declaresContainer(manifest)) {
    if (typeof manifest.main !== 'string' || !/\.html?$/i.test(manifest.main) || !byPath.has(manifest.main)) {
      throw new Error('The SoftN web manifest must name an HTML entry that exists in this folder.');
    }
    return bytes;
  }
  if (['engine', 'container', 'main', 'files', 'permissions', 'config'].some((key) => key in manifest)) {
    throw new Error('This folder contains a SoftN project manifest. Open its exported .softn file, or choose a built web app folder.');
  }
  const looksLikeWebManifest = typeof manifest.start_url === 'string' ||
    (typeof manifest.display === 'string' && ['fullscreen', 'standalone', 'minimal-ui', 'browser'].includes(manifest.display)) ||
    ((typeof manifest.name === 'string' || typeof manifest.short_name === 'string') &&
      Array.isArray(manifest.icons) && manifest.icons.some((icon) => typeof icon?.src === 'string'));
  if (!entry || !looksLikeWebManifest) {
    throw new Error('SoftN cannot identify this manifest.json. Name a Web App Manifest manifest.webmanifest and update its link, or supply a SoftN web app manifest.');
  }
  const name = [manifest.name, manifest.short_name].find((value) => typeof value === 'string' && value.trim()) ?? 'Web App';
  return encoder.encode(JSON.stringify({ ...manifest, name, main: entry, engine: 2 }));
}

async function readBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(`“${file.name}” could not be read. Choose the folder again after checking the file is available.`);
  }
}

/** Package the contents of a browser folder selection for the normal local-bundle open path. */
export async function readLocalWebFolder(files: readonly File[]): Promise<{ data: Uint8Array; fileName: string }> {
  const { folder, byPath, archiveSize } = indexFolder(files);
  const entry = zeroConfigEntry(byPath.keys());
  const manifest = byPath.get('manifest.json');
  if (!manifest && !entry) throw new Error(`This folder has no HTML entry at its root. ${buildHint}`);
  const manifestBytes = manifest && webManifest(await readBytes(manifest), byPath, entry);
  const finalSize = archiveSize + (manifestBytes?.byteLength ?? 0) - (manifest?.size ?? 0);
  if (finalSize > MAX_ZIP_INPUT_BYTES || (manifestBytes && manifestBytes.byteLength > MAX_ZIP_FILE_BYTES)) {
    throw new Error('The packaged web app exceeds the archive size limit.');
  }

  // The cache and permission answers belong to the hash of the archive. Identical files
  // must produce the same bytes regardless of selection order, modification times or time zone.
  // Write straight into the final buffer, freeing each input file before reading the next.
  const data = new Uint8Array(finalSize);
  let offset = 0;
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    data.set(chunk, offset);
    offset += chunk.length;
  });
  for (const path of [...byPath.keys()].sort()) {
    const file = new ZipPassThrough(path);
    file.mtime = new Date(2000, 0, 1);
    zip.add(file);
    const bytes = path === 'manifest.json' && manifestBytes ? manifestBytes : await readBytes(byPath.get(path)!);
    file.push(bytes, true);
  }
  zip.end();
  return { data, fileName: `${folder}.softn` };
}
