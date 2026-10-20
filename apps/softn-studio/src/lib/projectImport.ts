import { MAX_ZIP_INPUT_BYTES, classifyAsset, readBundleEntries } from '@softn/core';
import { canonicalKey, normalizeProjectPath } from './paths';
import { keptAsBytes, readsAsText } from './fileKinds';

export interface ProjectImportEntry {
  path: string;
  content: string | Uint8Array;
}

/**
 * Whether an archive entry is text, decided by core's one registry.
 *
 * Studio kept its own list of text extensions, and it did not have `.py`: a
 * Python app imported with its logic as bytes, which the model was not shown,
 * the preview could not compose and the validator could not read. Every other
 * reader in SoftN asks `classifyAsset`, so a file is text here exactly when it
 * is text to the runtime that will open the bundle.
 *
 * Formats the model edits as source are the exception. Studio decoded them
 * before and the model can read and change them only as text: SVG, which core
 * carries as an image, and source formats core's registry has no entry for,
 * which it would carry as opaque bytes. Text is lossless for both on export.
 */
const SOURCE_TEXT = /\.(svg|ts|tsx|jsx|yaml|yml|toml)$/i;

/**
 * A type neither list names (a .csv, a README, a .txt) is text when its
 * bytes are: what the write tool wrote as text comes back as text, and a
 * binary file of an unknown kind stays the bytes it is. See fileKinds.ts.
 */
function isTextEntry(path: string, content: Uint8Array): boolean {
  if (SOURCE_TEXT.test(path) || !classifyAsset(path).binary) return true;
  return !keptAsBytes(path) && readsAsText(content);
}

/** Reject an oversized local file before allocating its bytes. */
export async function readProjectFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<Uint8Array> {
  if (file.size > MAX_ZIP_INPUT_BYTES) {
    throw new Error(`Choose a project file smaller than ${MAX_ZIP_INPUT_BYTES / 1024 / 1024} MB.`);
  }
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(`Could not read ${file.name}. Check that the file is still available, then choose it again.`);
  }
}

/** Whether bytes begin with one of the valid ZIP record signatures. */
export function hasZipSignature(data: Uint8Array): boolean {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
  const record = (data[2] << 8) | data[3];
  return record === 0x0304 || record === 0x0506 || record === 0x0708;
}

/**
 * Read an archive through core's bounded, checksum-verifying ZIP reader.
 * Studio used to call fflate's `unzipSync` directly, which let a small archive
 * allocate its declared inflated size before Studio had a chance to inspect it.
 */
export function readProjectArchive(data: Uint8Array): ProjectImportEntry[] {
  const decoder = new TextDecoder();
  let archive: ReturnType<typeof readBundleEntries>;
  try {
    archive = readBundleEntries(data);
  } catch (err) {
    throw explainArchiveFailure(err);
  }
  // Every path is judged before anything is set aside, so an unsafe one refuses the archive
  // wherever it sits, as it always has.
  const safe: Array<{ path: string; rawPath: string; content: Uint8Array }> = [];
  for (const [rawPath, content] of archive) {
    const path = normalizeProjectPath(rawPath);
    if (!path) throw new Error(`Archive contains an unsafe project path: ${rawPath}`);
    safe.push({ path, rawPath, content });
  }
  const kept = unwrapProjectFolder(safe.filter((entry) => !isArchiveLitter(entry.path)));

  // Names that collide by case are refused on the paths the project will have: the same two
  // files collide inside a folder and out of it.
  const entries: ProjectImportEntry[] = [];
  const canonicalPaths = new Set<string>();
  for (const { path, rawPath, content } of kept) {
    // Taken out of its folder a path is judged again: `Tasks/C:/notes.txt` is an odd name
    // inside the folder and a path with a drive letter once the folder's name is off it.
    if (normalizeProjectPath(path) !== path) throw new Error(`Archive contains an unsafe project path: ${rawPath}`);
    const canonicalPath = canonicalKey(path);
    if (canonicalPaths.has(canonicalPath)) {
      throw new Error(`Archive contains colliding project paths: ${rawPath}`);
    }
    canonicalPaths.add(canonicalPath);
    entries.push({
      path,
      content: isTextEntry(path, content) ? decoder.decode(content) : content,
    });
  }
  return entries;
}

/**
 * Why an archive could not be read, in the person's words. The reader's own ("Invalid ZIP:
 * missing end-of-central-directory") was shown as it was, after "Could not import": the
 * parser's terms, which leave the person to work out whether the file, the download or Studio
 * is at fault. The reader's words are kept as the error's `cause`. Matched as the runtime's
 * error card matches them (packages/@softn/runtime-shell/src/failure.ts).
 */
export function explainArchiveFailure(err: unknown): Error {
  const said = err instanceof Error ? err.message : String(err);
  const plain = (message: string) => new Error(message, { cause: err });
  if (/^(?:Encrypted|ZIP64) bundles are not supported|^Unsupported compression method/.test(said)) {
    return plain('This archive is of a kind Studio cannot open: a .softn bundle is a plain ZIP, not password-protected and not in the ZIP64 format very large archives use. Export the app again, or zip its folder without a password.');
  }
  if (/too large|too many files/i.test(said)) {
    return plain('This bundle holds more than Studio opens: too many files, or files too large. Take out what the app does not need, such as large media, and export it again.');
  }
  if (/Invalid ZIP|end-of-central-directory|Corrupt (?:ZIP|bundle)|not a zip/i.test(said)) {
    return plain('This file is not a readable .softn bundle or ZIP archive: it may be damaged, or only partly downloaded. Export or download it again, then import the new copy.');
  }
  return err instanceof Error ? err : new Error(said);
}

/**
 * What a folder compressed from Finder carries beside the project: the
 * `__MACOSX/` tree of resource forks, and a `.DS_Store` in any folder that
 * was looked at. Neither is the app's, and both were imported as its files
 * (`__MACOSX/ui/._main.ui` is bytes with a page's name).
 */
function isArchiveLitter(path: string): boolean {
  const segments = path.split('/');
  return segments[0] === '__MACOSX' || segments[segments.length - 1] === '.DS_Store';
}

/**
 * A bundle zipped as its folder holds the project one level down:
 * `Tasks/manifest.json`, `Tasks/ui/main.ui`. When every entry is inside one
 * folder and that folder holds the manifest, the project is what is inside
 * it, and the folder's name is taken off. Anything else is left as it is: a
 * file beside the folder, a manifest already at the root, a lone folder
 * with no manifest in it (that is just a bundle with one folder).
 */
function unwrapProjectFolder<T extends { path: string }>(entries: T[]): T[] {
  if (entries.length === 0 || entries.some((entry) => !entry.path.includes('/'))) return entries;
  const folder = entries[0].path.split('/')[0];
  const prefix = `${folder}/`;
  if (!entries.every((entry) => entry.path.startsWith(prefix))) return entries;
  if (!entries.some((entry) => entry.path === `${prefix}manifest.json`)) return entries;
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
}

// The path contract lives in ./paths so that import, the changeset check,
// validation and export cannot drift apart again; it is re-exported here
// because the rest of Studio learned to import it from this module.
export { normalizeProjectPath };

/**
 * Resolve an import from one project file to another without allowing it to
 * walk above the bundle root. Bare paths are already bundle-relative; only
 * explicit `./` and `../` paths inherit the importing file's directory.
 */
export function resolveProjectRelativePath(fromPath: string, value: string): string | null {
  const normalizedFrom = normalizeProjectPath(fromPath);
  const relative = value.replace(/\\/g, '/');
  if (
    !normalizedFrom ||
    !relative ||
    relative.startsWith('/') ||
    relative.includes('\0') ||
    relative.includes('//') ||
    /^[a-zA-Z]:/.test(relative)
  ) {
    return null;
  }

  if (!relative.startsWith('./') && !relative.startsWith('../')) {
    return normalizeProjectPath(relative);
  }

  const resolved = normalizedFrom.split('/');
  resolved.pop();
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return normalizeProjectPath(resolved.join('/'));
}

/**
 * Read the lightweight JSON project format used by Studio imports.
 * Only string file contents are accepted; objects otherwise become the
 * misleading text "[object Object]" when coerced.
 */
export function readJsonProject(text: string): ProjectImportEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const files = (parsed as { files?: unknown }).files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return [];

  const entries: ProjectImportEntry[] = [];
  const canonicalPaths = new Set<string>();
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalizeProjectPath(rawPath);
    if (!path || typeof content !== 'string') continue;

    // Backslash and case aliases are distinct JSON keys but become the same
    // project path on at least one supported platform. Reject the project
    // instead of silently allowing the later entry to overwrite the first.
    const canonicalPath = canonicalKey(path);
    if (canonicalPaths.has(canonicalPath)) return [];
    canonicalPaths.add(canonicalPath);
    entries.push({ path, content });
  }
  return entries;
}
