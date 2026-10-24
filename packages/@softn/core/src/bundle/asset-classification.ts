/**
 * Asset classification — one registry of what a file extension means.
 *
 * Every bundle reader answers the same two questions about a path: are its
 * bytes text or binary, and what MIME type serves them. Four private copies of
 * those answers existed — softn-web, softn-loader, core's own reader and the
 * demo build script — and they disagreed. .glb was binary in three of the
 * lists but had a MIME type in none, so a model's bytes travelled intact
 * through the whole pipeline and then resolved to an empty URL at the last
 * step; core's reader knew no audio format at all and UTF-8-decoded the bytes,
 * which is not reversible. One registry, and every reader asks it.
 *
 * The examples' build script (scripts/build-bundle.cjs in
 * f2i-com/softn-Examples) is CommonJS and cannot import this module; its
 * extension list is maintained by hand against this one.
 */

export type AssetKind = 'model' | 'audio' | 'video' | 'image' | 'font' | 'text' | 'binary';

export interface AssetClassification {
  /** What the file is, independent of how it is stored */
  kind: AssetKind;
  /** MIME type to serve the bytes under */
  mime: string;
  /** Whether the bytes must never pass through a text decoder */
  binary: boolean;
}

/** Extension (no dot, lowercase) → classification. */
export const ASSET_CLASSIFICATIONS: Record<string, AssetClassification> = {
  // Models
  glb: { kind: 'model', mime: 'model/gltf-binary', binary: true },
  // .gltf is the JSON form of the same scene .glb packs — text, unlike its
  // sibling, which is why neither a "models are binary" nor a "JSON is text"
  // rule of thumb can classify the pair.
  gltf: { kind: 'model', mime: 'model/gltf+json', binary: false },
  obj: { kind: 'model', mime: 'model/obj', binary: false },
  fbx: { kind: 'model', mime: 'application/octet-stream', binary: true },
  stl: { kind: 'model', mime: 'model/stl', binary: true },
  // glTF external buffer payload
  bin: { kind: 'model', mime: 'application/octet-stream', binary: true },

  // Audio
  mp3: { kind: 'audio', mime: 'audio/mpeg', binary: true },
  wav: { kind: 'audio', mime: 'audio/wav', binary: true },
  ogg: { kind: 'audio', mime: 'audio/ogg', binary: true },
  // An .opus file is Opus in an Ogg container; audio/ogg is the type browsers
  // report playable via canPlayType, audio/opus names the bare RTP codec.
  opus: { kind: 'audio', mime: 'audio/ogg', binary: true },
  aac: { kind: 'audio', mime: 'audio/aac', binary: true },
  flac: { kind: 'audio', mime: 'audio/flac', binary: true },
  m4a: { kind: 'audio', mime: 'audio/mp4', binary: true },

  // Video
  mp4: { kind: 'video', mime: 'video/mp4', binary: true },
  webm: { kind: 'video', mime: 'video/webm', binary: true },

  // Images
  png: { kind: 'image', mime: 'image/png', binary: true },
  jpg: { kind: 'image', mime: 'image/jpeg', binary: true },
  jpeg: { kind: 'image', mime: 'image/jpeg', binary: true },
  gif: { kind: 'image', mime: 'image/gif', binary: true },
  webp: { kind: 'image', mime: 'image/webp', binary: true },
  ico: { kind: 'image', mime: 'image/x-icon', binary: true },
  bmp: { kind: 'image', mime: 'image/bmp', binary: true },
  avif: { kind: 'image', mime: 'image/avif', binary: true },
  tiff: { kind: 'image', mime: 'image/tiff', binary: true },
  tif: { kind: 'image', mime: 'image/tiff', binary: true },
  hdr: { kind: 'image', mime: 'image/vnd.radiance', binary: true },
  exr: { kind: 'image', mime: 'image/x-exr', binary: true },
  // SVG is XML, but every reader has always carried it as bytes and the icon
  // paths read only the binary map — reclassifying it as text would silently
  // drop every .svg icon. Bytes served under the right MIME type are the same
  // picture.
  svg: { kind: 'image', mime: 'image/svg+xml', binary: true },

  // Fonts
  woff: { kind: 'font', mime: 'font/woff', binary: true },
  woff2: { kind: 'font', mime: 'font/woff2', binary: true },
  ttf: { kind: 'font', mime: 'font/ttf', binary: true },
  otf: { kind: 'font', mime: 'font/otf', binary: true },
  eot: { kind: 'font', mime: 'application/vnd.ms-fontobject', binary: true },

  // Text formats
  css: { kind: 'text', mime: 'text/css', binary: false },
  json: { kind: 'text', mime: 'application/json', binary: false },
  md: { kind: 'text', mime: 'text/markdown', binary: false },
  ui: { kind: 'text', mime: 'text/plain', binary: false },
  logic: { kind: 'text', mime: 'text/plain', binary: false },
  // Python app logic. Without this entry a .py fell to the opaque default, so
  // every loader kept it out of the text files the composer reads and a
  // Python app failed at Run with its own main.py "not in the bundle".
  py: { kind: 'text', mime: 'text/x-python', binary: false },
  // A private backend's migrations (server/migrations/*.sql). Without this entry an editor held
  // them as opaque bytes: its agent could neither read the schema nor write the next migration.
  sql: { kind: 'text', mime: 'application/sql', binary: false },
  // Inside a bundle, .softn names a source document, not a nested archive —
  // manifests point main at e.g. ui/main.softn. This registry only ever sees
  // paths from within a bundle, so the on-disk zip meaning does not apply.
  softn: { kind: 'text', mime: 'text/plain', binary: false },
  // WebGPU shader source
  wgsl: { kind: 'text', mime: 'text/plain', binary: false },
  xdb: { kind: 'text', mime: 'application/json', binary: false },
  html: { kind: 'text', mime: 'text/html', binary: false },
  js: { kind: 'text', mime: 'application/javascript', binary: false },
  txt: { kind: 'text', mime: 'text/plain', binary: false },
  xml: { kind: 'text', mime: 'application/xml', binary: false },

  // Documents
  pdf: { kind: 'binary', mime: 'application/pdf', binary: true },
};

/**
 * Classify a bundle path by its extension.
 *
 * Unknown extensions are opaque bytes: decoding an unrecognised format as text
 * destroys it, while carrying a text file as bytes loses nothing.
 */
export function classifyAsset(path: string): AssetClassification {
  const dot = path.lastIndexOf('.');
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  return (
    ASSET_CLASSIFICATIONS[ext] ?? {
      kind: 'binary',
      mime: 'application/octet-stream',
      binary: true,
    }
  );
}

/**
 * Types a browser opens as an active document: an asset of one of them is
 * handed out as plain text.
 */
const DOCUMENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'application/xml', 'text/xml', 'application/javascript', 'text/javascript']);

function base64Of(content: Uint8Array | string): string {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/**
 * The address a bundle's asset is handed out at (`asset("…")`).
 *
 * A `blob:` URL belongs to the page that made it, and opened as a page (a
 * link to it, the address pasted into a tab) it is a page of this site. An
 * `.html`, `.xml` or `.svg` asset was the bundle's own document there, on the
 * site's origin, held back by nothing but the page's `<meta>` CSP, and not by
 * that in a new tab, where its script ran. So an SVG is handed out as a
 * `data:` URL, which an `<img>` and CSS draw and a browser will not open as a
 * page of any site; a document type as plain text, which opens as text.
 * Everything else is a `blob:` URL of its own type, as it was. A `blob:` URL
 * is revoked with `URL.revokeObjectURL`, which leaves a `data:` URL alone.
 */
export function assetObjectUrl(path: string, content: Uint8Array | string): string {
  const { mime } = classifyAsset(path);
  if (mime === 'image/svg+xml') return `data:image/svg+xml;base64,${base64Of(content)}`;
  const type = DOCUMENT_TYPES.has(mime) ? 'text/plain;charset=utf-8' : mime;
  return URL.createObjectURL(new Blob([content as BlobPart], { type }));
}
