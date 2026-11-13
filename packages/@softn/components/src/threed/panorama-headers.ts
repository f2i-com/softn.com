/**
 * What a panorama's file says of itself, read before its reader is let near
 * it.
 *
 * A Radiance `.hdr` and an OpenEXR `.exr` each begin with a header that says
 * how big the picture is. three's readers believe it: they make an array of
 * that size before they have looked at whether the file could hold such a
 * picture, and the OpenEXR one looks for the end of each name in its header
 * by walking forward until it meets a zero byte, with nothing to stop it at
 * the end of the file. So a file of sixty bytes could ask for a gigabyte and
 * four seconds of the page's one thread, and a file of nine bytes could stop
 * the page for good. A panorama's address is the app's to give and may be
 * anywhere on the web the app is allowed to reach: its bytes are not to be
 * trusted with either.
 *
 * What is here reads each header itself, never past the end of the file and
 * never for long, and refuses a file that is not what it says: before
 * anything is made of it. The reader is then given a file whose header is
 * known to end where this reading found it to.
 *
 * Every refusal is an Error whose words finish the sentence "the environment
 * could not be loaded: ...".
 */

/**
 * The largest panorama that is read: 8192 across by 4096 down. One that size
 * is already a quarter of a gigabyte once it is unpacked (four values to a
 * pixel, two bytes to a value), and takes the page about a second to unpack.
 */
export const MAX_PANORAMA_WIDTH = 8192;
export const MAX_PANORAMA_HEIGHT = 4096;

/**
 * Refuse a picture of a size that is not one, larger than a panorama may be,
 * or larger than the device can draw (`maxTextureSize`, where the renderer
 * says: such a picture would be refused when it was first drawn, and leave
 * the scene lit by nothing).
 */
export function refusePanoramaSize(width: number, height: number, maxTextureSize?: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('it declares a picture of no size');
  }
  if (width > MAX_PANORAMA_WIDTH || height > MAX_PANORAMA_HEIGHT) {
    throw new Error(`it is ${width} by ${height}, and a panorama may be ${MAX_PANORAMA_WIDTH} by ${MAX_PANORAMA_HEIGHT} at most`);
  }
  if (typeof maxTextureSize === 'number' && maxTextureSize > 0 && (width > maxTextureSize || height > maxTextureSize)) {
    throw new Error(`it is ${width} by ${height}, larger than this device can draw (${maxTextureSize} either way)`);
  }
}

/**
 * Refuse what a reader made of a file unless it is the picture the header
 * declared, with exactly its values: a reader given fewer pixels than the
 * header says hands back a short array, which the graphics card then refuses
 * and the scene is lit by black.
 */
export function refuseOtherThanDeclared(
  made: { width: number; height: number; data: { length: number } },
  width: number,
  height: number,
  channels: number
): void {
  if (made.width !== width || made.height !== height || made.data.length !== width * height * channels) {
    throw new Error('what was read of it is not the picture its header declares');
  }
}

// ── Radiance .hdr ───────────────────────────────────────────────────────────

/** A Radiance file's header is a few lines of text: one that has not ended by here is not one. */
const HDR_HEADER_LIMIT = 65536;

export interface HdrHeader {
  width: number;
  height: number;
  /** Where the pixels begin: the byte after the line that gives the size. */
  dataStart: number;
}

const text = new TextDecoder();

/**
 * A Radiance file's header: a first line beginning `#?`, lines of which one
 * is `FORMAT=...`, and the line that ends it, `-Y <height> +X <width>`
 * (rows from the top, the only order three reads).
 */
export function readHdrHeader(bytes: Uint8Array): HdrHeader {
  const end = Math.min(bytes.length, HDR_HEADER_LIMIT);
  let at = 0;
  let first = true;
  let format = false;
  while (at < end) {
    let stop = at;
    while (stop < end && bytes[stop] !== 10) stop += 1;
    // No end of line before the end of the file, or of what a header may be.
    if (stop >= end) break;
    const line = text.decode(bytes.subarray(at, stop));
    at = stop + 1;
    if (first) {
      if (!/^#\?\S/.test(line)) throw new Error('it is not a Radiance .hdr file');
      first = false;
      continue;
    }
    if (line.charAt(0) === '#') continue;
    if (/^\s*FORMAT=\S+\s*$/.test(line)) {
      format = true;
      continue;
    }
    const size = /^\s*-Y\s+(\d{1,9})\s+\+X\s+(\d{1,9})\s*$/.exec(line);
    if (size) {
      if (!format) throw new Error('its header names no format');
      return { height: parseInt(size[1], 10), width: parseInt(size[2], 10), dataStart: at };
    }
  }
  if (first) throw new Error('it is not a Radiance .hdr file');
  throw new Error('its header does not say how big the picture is');
}

/**
 * The pixels of a Radiance file as the reader is to be given them, or a
 * refusal for a file too short to hold the picture it declares. Written
 * flat, a pixel is four bytes, and what follows the last pixel is left off.
 * Written in runs (each row begins 2, 2 and its width), a row takes four
 * bytes and then, for each of its four channels, two bytes for every 127
 * pixels at the very least.
 */
export function hdrPixels(bytes: Uint8Array, header: HdrHeader): Uint8Array {
  const { width, height } = header;
  const data = bytes.subarray(header.dataStart);
  // As three decides it.
  const inRuns = !(width < 8 || width > 0x7fff) && data[0] === 2 && data[1] === 2 && !((data[2] ?? 0) & 0x80);
  const least = inRuns ? height * (4 + 8 * Math.ceil(width / 127)) : 4 * width * height;
  if (data.length < least) throw new Error(`it declares a picture of ${width} by ${height} and is too short to hold one`);
  return inRuns ? data : data.subarray(0, least);
}

/**
 * A Radiance file with a header written here, of one known shape, before
 * `pixels`: the reader is never shown the header the file came with, so it
 * cannot read a size or a start of the pixels other than the ones found
 * above (its own reading of a long line differs from the format's).
 */
export function hdrWithOwnHeader(header: HdrHeader, pixels: Uint8Array): ArrayBuffer {
  const lines = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${header.height} +X ${header.width}\n`);
  const out = new Uint8Array(lines.length + pixels.length);
  out.set(lines);
  out.set(pixels, lines.length);
  return out.buffer;
}

// ── OpenEXR .exr ────────────────────────────────────────────────────────────

/** An OpenEXR header that has not ended by here, or holds more attributes than this, is not read. */
const EXR_HEADER_LIMIT = 1024 * 1024;
const EXR_MOST_ATTRIBUTES = 1000;
/** A name in the header, with the zero byte that ends it, is at most this long. */
const EXR_NAME_LIMIT = 256;

/** How many rows of the picture a chunk of a scan-line file holds, by the number of its compression. */
const EXR_ROWS_TO_A_CHUNK = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256];

/** How many bytes three's reader takes for a value of a type whose size is fixed: whatever size the file gives it. */
const EXR_FIXED: Record<string, number> = {
  chromaticities: 32,
  compression: 1,
  box2i: 16,
  envmap: 1,
  tiledesc: 9,
  lineOrder: 1,
  float: 4,
  v2f: 8,
  v3f: 12,
  int: 4,
  rational: 8,
  timecode: 8,
};
/** The types whose value three's reader keeps under the attribute's name, taking as many bytes as the file says. */
const EXR_SIZED = new Set(['string', 'stringvector', 'iccProfile', 'preview']);

export interface ExrHeader {
  width: number;
  height: number;
  /** The number of its compression, 0 to 9. */
  compression: number;
  /** Stored in tiles, not in rows. */
  tiled: boolean;
  /** Where the header ends: the table of where each chunk begins follows. */
  end: number;
}

/**
 * An OpenEXR file's header, walked as three's reader walks it and never past
 * the end of the file: so that the reader, given the same bytes, is known to
 * stop where this stopped. Refused: what is not an OpenEXR file of version 2;
 * a deep or a multi-part file, or any other kind three does not read; a name
 * or a type with no zero byte to end it within 256 bytes and within the
 * file; an attribute whose size is not what its type takes, or runs past the
 * end of the file; a list of channels that does not end where its size says;
 * a header that does not end, has more than a thousand attributes or runs
 * past a megabyte; and one that does not say how big the picture is, how it
 * is compressed or what its channels are.
 */
export function readExrHeader(bytes: Uint8Array): ExrHeader {
  const length = bytes.length;
  if (length < 8 || bytes[0] !== 0x76 || bytes[1] !== 0x2f || bytes[2] !== 0x31 || bytes[3] !== 0x01) {
    throw new Error('it is not an OpenEXR file');
  }
  if (bytes[4] !== 2) throw new Error(`it is OpenEXR version ${bytes[4]}, and version 2 is what is read`);
  const flags = bytes[5];
  if (flags & 0x08) throw new Error('it is a deep OpenEXR file, which is not read');
  if (flags & 0x10) throw new Error('it is an OpenEXR file of several parts, which is not read');
  if (flags & ~0x06) throw new Error('it is a kind of OpenEXR file that is not read');
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const limit = Math.min(length, EXR_HEADER_LIMIT);
  let at = 8;
  /** A name from `at`, up to its zero byte: the reader's own scan, with an end. */
  const name = (): string => {
    const most = Math.min(limit, at + EXR_NAME_LIMIT);
    let stop = at;
    while (stop < most && bytes[stop] !== 0) stop += 1;
    if (stop >= most) throw new Error('a name in its header does not end');
    const value = text.decode(bytes.subarray(at, stop));
    at = stop + 1;
    return value;
  };
  let window: { width: number; height: number } | 'other' | undefined;
  let compression: number | 'other' | undefined;
  let channels: number | 'other' | undefined;
  let attributes = 0;
  for (;;) {
    if (at >= limit) throw new Error(length > EXR_HEADER_LIMIT ? 'its header runs past a megabyte' : 'its header does not end');
    const attribute = name();
    // Where three's reader takes the header to have ended: at an empty name,
    // and (it compares the name with nought loosely) at any name that reads as nought.
    if (Number(attribute) === 0) break;
    attributes += 1;
    if (attributes > EXR_MOST_ATTRIBUTES) throw new Error('its header has more than a thousand attributes');
    const type = name();
    if (at + 4 > length) throw new Error('its header runs past the end of the file');
    const size = view.getUint32(at, true);
    at += 4;
    if (size > length - at) throw new Error(`the attribute "${attribute.slice(0, 40)}" of its header is longer than the file`);
    const start = at;
    const fixed = Object.prototype.hasOwnProperty.call(EXR_FIXED, type) ? EXR_FIXED[type] : undefined;
    if (fixed !== undefined) {
      // The reader takes these many bytes whatever the size says: a file that
      // says otherwise would have it reading on from somewhere else.
      if (size !== fixed) throw new Error(`the attribute "${attribute.slice(0, 40)}" of its header is not the size of its type`);
      if (attribute === 'dataWindow') {
        if (type === 'box2i') {
          const xMin = view.getInt32(at, true);
          const yMin = view.getInt32(at + 4, true);
          const xMax = view.getInt32(at + 8, true);
          const yMax = view.getInt32(at + 12, true);
          window = { width: xMax - xMin + 1, height: yMax - yMin + 1 };
        } else window = 'other';
      } else if (attribute === 'compression') {
        compression = type === 'compression' ? bytes[at] : 'other';
      } else if (attribute === 'channels') channels = 'other';
      at = start + size;
    } else if (type === 'chlist') {
      // The reader's own walk of the channels: a name, then sixteen bytes, until one byte short of the end.
      let count = 0;
      while (at < start + size - 1) {
        name();
        at += 16;
        count += 1;
        if (at > length) throw new Error('the channels of its header run past the end of the file');
      }
      at += 1;
      if (at !== start + size) throw new Error('the channels of its header do not end where they say');
      if (attribute === 'channels') channels = count;
      else if (attribute === 'dataWindow') window = 'other';
      else if (attribute === 'compression') compression = 'other';
    } else {
      at = start + size;
      // A type the reader keeps the value of stands in the way of an earlier one of the name; any other is passed over.
      if (EXR_SIZED.has(type)) {
        if (attribute === 'dataWindow') window = 'other';
        else if (attribute === 'compression') compression = 'other';
        else if (attribute === 'channels') channels = 'other';
      }
    }
  }
  if (window === undefined || window === 'other') throw new Error('its header does not say how big the picture is');
  if (typeof compression !== 'number' || compression > 9) throw new Error('its header does not say how it is compressed, in a way that is read');
  if (typeof channels !== 'number' || channels < 1) throw new Error('its header names no channels');
  return { width: window.width, height: window.height, compression, tiled: (flags & 0x02) !== 0, end: at };
}

/**
 * Refuse a scan-line OpenEXR file too short to hold the table that says
 * where each of its chunks begins: eight bytes a chunk, and as many chunks
 * as its rows need at the number of rows its compression puts in one.
 */
export function refuseShortExr(bytes: Uint8Array, header: ExrHeader): void {
  if (header.tiled) return;
  const chunks = Math.ceil(header.height / EXR_ROWS_TO_A_CHUNK[header.compression]);
  if (header.end + 8 * chunks > bytes.length) {
    throw new Error(`it declares a picture of ${header.width} by ${header.height} and is too short to hold one`);
  }
}

/**
 * The file with eight zero bytes after it, for three's reader. The reader
 * finds the end of a name by walking forward to a zero byte and does not
 * stop at the end of what it was given: with these there is always one to
 * meet, in the header and in the data of a chunk alike. What follows the
 * last chunk changes nothing else, since the reader goes by where the file
 * says each chunk begins.
 */
export function exrWithAnEnd(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.length + 8);
  out.set(bytes);
  return out.buffer;
}
