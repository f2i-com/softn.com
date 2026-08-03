import { readBundleEntries } from '@softn/core';

export interface ProjectImportEntry {
  path: string;
  content: string | Uint8Array;
}

const TEXT_FILE = /\.(ui|logic|json|xdb|md|txt|html|css|js|ts|tsx|jsx|svg|xml|yaml|yml|toml)$/i;

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
    const canonicalPath = path.toLowerCase();
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

/** Return a canonical bundle-relative path, or null for an escape/alias. */
export function normalizeProjectPath(value: string): string | null {
  const path = value.replace(/\\/g, '/');
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.includes('//') ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return null;
  }

  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

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
    const canonicalPath = path.toLowerCase();
    if (canonicalPaths.has(canonicalPath)) return [];
    canonicalPaths.add(canonicalPath);
    entries.push({ path, content });
  }
  return entries;
}
