import { readBundleEntries } from '@softn/core';

export interface ProjectImportEntry {
  path: string;
  content: string | Uint8Array;
}

const TEXT_FILE = /\.(ui|logic|json|xdb|md|txt|html|css|js|ts|tsx|jsx|svg|xml|yaml|yml|toml)$/i;

/**
 * Read an archive through core's bounded, checksum-verifying ZIP reader.
 * Studio used to call fflate's `unzipSync` directly, which let a small archive
 * allocate its declared inflated size before Studio had a chance to inspect it.
 */
export function readProjectArchive(data: Uint8Array): ProjectImportEntry[] {
  const decoder = new TextDecoder();
  return Array.from(readBundleEntries(data), ([path, content]) => ({
    path,
    content: TEXT_FILE.test(path) ? decoder.decode(content) : content,
  }));
}

/** Return a canonical bundle-relative path, or null for an escape/alias. */
export function normalizeProjectPath(value: string): string | null {
  const path = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!path || path.startsWith('/') || path.includes('\0') || /^[a-zA-Z]:/.test(path)) {
    return null;
  }

  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
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
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalizeProjectPath(rawPath);
    if (path && typeof content === 'string') entries.push({ path, content });
  }
  return entries;
}
