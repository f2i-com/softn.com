/**
 * The media an app's page is served from its bundle's `assets/`: pictures,
 * sound, video, fonts, 3D models, and shader and text files, by extension, each
 * under the type SoftN's other hosts give it (core's asset classification;
 * test/media.test.mjs holds the two to the same types). Nothing that runs is
 * served (HTML, JavaScript): an app can show these and read them, no more.
 *
 * They were pictures, sound and two font formats only, so an app's video, its
 * TrueType fonts, its models or a compute shader came back from `asset()` as
 * an empty string. FormLogic holds uploads to the same list, so what it keeps
 * is what the page can be given.
 */
export const FRAME_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  // Pictures
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml',
  hdr: 'image/vnd.radiance', exr: 'image/x-exr',
  // Sound
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
  // Video
  mp4: 'video/mp4', webm: 'video/webm',
  // Fonts
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  // 3D models, and a glTF's buffer
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', stl: 'model/stl', fbx: 'application/octet-stream', bin: 'application/octet-stream',
  // Shaders and text an app reads
  wgsl: 'text/plain', txt: 'text/plain', md: 'text/markdown',
});

/**
 * The type a file is served under, by its extension, or undefined for one it is not. A list's own
 * entries only: a file named `x.constructor` or `x.toString` is no type, where it was served under
 * the name of a function every object has.
 */
function typeOf(types: Readonly<Record<string, string>>, path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  return Object.hasOwn(types, extension) ? types[extension] : undefined;
}

/**
 * A media file's bytes, from what the parent sent for it. Base64 text, which every parent may send,
 * is decoded here once, by the browser's own decoder (the one a `data:` URL was read with: it passes
 * over spaces and line breaks, takes text whose `=` padding is left off, and refuses anything
 * else); text that is not base64 is no file. Bytes, a Uint8Array or an ArrayBuffer, are taken as
 * they came, so a parent need not turn a file into text and back (main.tsx tells it the frame
 * takes them). Anything else is no file.
 */
function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value !== 'string') return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Each address made here, with the file it serves: what `sameMedia` reads back. */
const made = new Map<string, Blob>();

/**
 * The `blob:` URL a bundle asset is served as, or null for one the page is not given. Each call
 * makes a new one.
 *
 * It was a `data:` URL, which carries the file as base64 text: a 24 MB model was a 32 MB string,
 * put in the page wherever it was named and decoded again each time it was read, and an app with
 * large media lagged. A `blob:` URL is a short name for bytes the frame holds once, as SoftN Web
 * gives an app's files. It is this document's own, under the frame's opaque origin, and reaches no
 * network; framePolicy.ts lets the page read it where it reads media. (Core hands an SVG out as a
 * `data:` URL because its hosts' `blob:` addresses are pages of their site; this frame's are of no
 * site, and links.ts keeps a link to one from replacing the app.)
 */
export function mediaUrl(path: string, value: unknown): string | null {
  const type = typeOf(FRAME_MEDIA_TYPES, path);
  if (!type) return null;
  const bytes = bytesOf(value);
  if (!bytes) return null;
  let blob: Blob;
  try {
    blob = new Blob([bytes as BlobPart], { type });
  } catch {
    // Memory a Blob is not made from in a browser (shared, or a buffer that can grow) is no file either.
    return null;
  }
  const url = URL.createObjectURL(blob);
  made.set(url, blob);
  return url;
}

/**
 * Whether `url`, an address `mediaUrl` made, serves what `value` holds as `path` is served: the same
 * type and the same bytes. A newer version of an app sends all of its media again, and a file that
 * holds what it held keeps the address the page has for it, so nothing showing it is loaded again.
 * The bytes are compared, not a digest of them, and the file is read back only where its type and
 * its size are the same. An address this module did not make, or has let go of, holds nothing to
 * compare.
 */
export async function sameMedia(url: string, path: string, value: unknown): Promise<boolean> {
  const blob = made.get(url);
  const type = typeOf(FRAME_MEDIA_TYPES, path);
  if (!blob || !type || blob.type !== type) return false;
  const bytes = bytesOf(value);
  if (!bytes || bytes.byteLength !== blob.size) return false;
  const held = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0; i < held.length; i++) if (held[i] !== bytes[i]) return false;
  return true;
}

/**
 * Lets go of an address `mediaUrl` made: the file is freed, and the address serves nothing from
 * then on. Any other address is left alone.
 */
export function releaseMedia(url: string): void {
  if (made.delete(url)) URL.revokeObjectURL(url);
}

/**
 * The app's own text files the page is given by name as well: data it reads, never a page or code
 * it would run. `fetch('data/levels.json')` reads one in SoftN Web and in the single-app page, and
 * here it was not found, because the frame served media alone: the parent sends an app's JSON with
 * its pages, as text, not under `assets/`.
 */
export const FRAME_TEXT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  json: 'application/json',
});

/**
 * The `data:` URL one of the app's text files is served as, or null for one the page is not given.
 *
 * Still a `data:` URL, unlike media: one is made for each version's file the page asks for, and a
 * `data:` URL is let go with the version that made it, where a `blob:` URL would be held until it
 * was revoked, and revoking one the page may still read is not safe. The app's JSON is text it
 * already holds, and small beside its media.
 */
export function textFileUrl(path: string, text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const type = typeOf(FRAME_TEXT_TYPES, path);
  return type ? `data:${type};charset=utf-8,${encodeURIComponent(text)}` : null;
}
