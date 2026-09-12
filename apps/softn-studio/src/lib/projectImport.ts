import { MAX_ZIP_INPUT_BYTES, readBundleEntries } from '@softn/core';
import { canonicalKey, normalizeProjectPath } from './paths';

export interface ProjectImportEntry {
  path: string;
  content: string | Uint8Array;
}

const TEXT_FILE = /\.(ui|logic|json|xdb|md|txt|html|css|js|ts|tsx|jsx|svg|xml|yaml|yml|toml)$/i;

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
  const entries: ProjectImportEntry[] = [];
  const canonicalPaths = new Set<string>();
  for (const [rawPath, content] of readBundleEntries(data)) {
    const path = normalizeProjectPath(rawPath);
    if (!path) throw new Error(`Archive contains an unsafe project path: ${rawPath}`);
    const canonicalPath = canonicalKey(path);
    if (canonicalPaths.has(canonicalPath)) {
      throw new Error(`Archive contains colliding project paths: ${rawPath}`);
    }
    canonicalPaths.add(canonicalPath);
    entries.push({
      path,
      content: TEXT_FILE.test(path) ? decoder.decode(content) : content,
    });
  }
  return entries;
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
