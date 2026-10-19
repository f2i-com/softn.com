import {check, integer, safePath, sha256, checkHash} from './common.mjs';
import {decodeUTF8, parseJSON} from './json.mjs';

/** Host-supplied file capabilities, not filesystem paths or network URLs.
 * Blobs are immutable; supplied typed arrays are copied once on registration.
 */
export class FileMapSource {
  #files = new Map();
  constructor(entries, {maxEntries = 1024, maxTotalBytes = 512 * 1024 * 1024} = {}) {
    check(entries instanceof Map, 'SOURCE', 'Pass an explicit Map of allowed files');
    integer(entries.size, 1, maxEntries, 'Source file count');
    let total = 0;
    for (const [path, value] of entries) {
      safePath(path);
      const isBlob = typeof Blob !== 'undefined' && value instanceof Blob;
      check(isBlob || value instanceof Uint8Array, 'SOURCE', 'Files must be Blob/File or Uint8Array');
      total += isBlob ? value.size : value.byteLength;
      integer(total, 0, maxTotalBytes, 'Source bytes');
      this.#files.set(path, isBlob ? value : new Uint8Array(value));
    }
  }
  size(path) {
    safePath(path); check(this.#files.has(path), 'MISSING', `Asset not supplied: ${path}`);
    const f = this.#files.get(path); return f instanceof Uint8Array ? f.byteLength : f.size;
  }
  async read(path, offset, length) {
    const size = this.size(path);
    integer(offset, 0, size, 'Read offset'); integer(length, 0, size - offset, 'Read length');
    const f = this.#files.get(path);
    return f instanceof Uint8Array ? f.slice(offset, offset + length) : new Uint8Array(await f.slice(offset, offset + length).arrayBuffer());
  }
}
/** Use a validated archive's entries under one explicit model/plugin prefix.
 * The archive owner must enforce decompression limits BEFORE creating this Map.
 */
export function sourceFromBundle(entries, prefix) {
  safePath(prefix); const scoped = new Map(), start = `${prefix}/`;
  for (const [path, bytes] of entries) {
    safePath(path);
    if (path.startsWith(start)) scoped.set(path.slice(start.length), bytes);
  }
  return new FileMapSource(scoped);
}
export function sourceFromFiles(files) {
  const list = Array.from(files); check(list.length > 0, 'SOURCE', 'No files selected');
  const useRoot = list.every(f => typeof f.webkitRelativePath === 'string' && f.webkitRelativePath.includes('/'));
  const root = useRoot ? list[0].webkitRelativePath.split('/')[0] : null;
  const entries = new Map();
  for (const file of list) {
    const raw = useRoot ? file.webkitRelativePath : file.name;
    if (useRoot) check(raw.startsWith(`${root}/`), 'PATH', 'Select one root folder');
    const path = safePath(useRoot ? raw.slice(root.length + 1) : raw);
    check(!entries.has(path), 'PATH', 'Duplicate selected path'); entries.set(path, file);
  }
  return new FileMapSource(entries);
}
export async function readAll(source, path, maxBytes) {
  const size = source.size(path); integer(size, 0, maxBytes, `Asset ${path} bytes`);
  const bytes = await source.read(path, 0, size);
  check(bytes instanceof Uint8Array && bytes.byteLength === size, 'SOURCE', 'Short or invalid read');
  return bytes;
}
export async function readJSON(source, path, maxBytes) {
  return parseJSON(decodeUTF8(await readAll(source, path, maxBytes)), {maxChars: maxBytes});
}
/** Optional host-side same-origin download. Never called by an architecture plugin.
 * Exactly bounded streaming; redirects, credentials and URL-bearing manifests are refused.
 */
export async function fetchBytes(url, {maxBytes, signal, origin = globalThis.location?.origin} = {}) {
  const u = new URL(url, globalThis.location?.href);
  check(origin && u.origin === origin && ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password,
    'NETWORK', 'Only explicitly approved same-origin resources are allowed');
  integer(maxBytes, 1, 512 * 1024 * 1024, 'Download byte limit');
  const response = await fetch(u, {signal, credentials: 'omit', redirect: 'error', cache: 'no-store'});
  check(response.ok && response.body, 'NETWORK', 'Asset download failed');
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) { await response.body.cancel(); check(false, 'LIMIT', 'Download is too large'); }
  }
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength; check(total <= maxBytes, 'LIMIT', 'Stream exceeds download budget'); chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const out = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
export async function fetchPinned(url, digest, options) {
  checkHash(digest); const bytes = await fetchBytes(url, options);
  check(await sha256(bytes) === digest, 'HASH', 'Downloaded content does not match the pinned hash'); return bytes;
}
