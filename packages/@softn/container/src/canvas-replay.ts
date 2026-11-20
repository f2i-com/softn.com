/**
 * What an app drew on a canvas, drawn: the commands its script made of its drawing, run on a
 * real 2D context. On the page, where the canvas is shown; and in the Worker, on a canvas of
 * the Worker's own that nobody sees, for the app's script to read its picture back from at
 * once (`toDataURL`, `getImageData`), which a canvas a thread away cannot answer.
 */
import { base64ToBytes } from './archive';
import { canvasPropertyAllowed } from './host-policy';
import type { Canvas2DCmd } from './types';

/** A 2D context the commands are run on: the page's, or an OffscreenCanvas's. */
export type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Run an app's drawing commands on a context. `imageFor` finds the picture a `drawImage`
 * names, by the caller's own rule, or null for one that is not drawn.
 */
export function replayCanvasCommands(ctx: DrawingContext, cmds: readonly Canvas2DCmd[], imageFor: (ref: string) => CanvasImageSource | null): void {
  for (const cmd of cmds) {
    try {
      replayOne(ctx, cmd, imageFor);
    } catch {
      // A command a browser throws for (a picture that is broken, a negative radius) threw at
      // the app's call there; here, a thread later, it draws nothing, and the rest is drawn.
    }
  }
}

function replayOne(ctx: DrawingContext, cmd: Canvas2DCmd, imageFor: (ref: string) => CanvasImageSource | null): void {
  {
    switch (cmd[0]) {
      case 'prop':
        // A drawing property of the context, by name (host-policy.ts): not any name, and
        // not a filter that names an address.
        if (canvasPropertyAllowed(cmd[1], cmd[2])) (ctx as unknown as Record<string, unknown>)[cmd[1]] = cmd[2];
        break;
      case 'grad': {
        const prop = cmd[1];
        if (prop !== 'fillStyle' && prop !== 'strokeStyle') break;
        const a = cmd[3];
        const g =
          cmd[2] === 'radial'
            ? ctx.createRadialGradient(a[0], a[1], a[2], a[3], a[4], a[5])
            : ctx.createLinearGradient(a[0], a[1], a[2], a[3]);
        for (const [off, col] of cmd[4]) {
          try {
            g.addColorStop(off, col);
          } catch {
            // ignore invalid stop
          }
        }
        ctx[prop] = g;
        break;
      }
      case 'clearRect':
        ctx.clearRect(cmd[1], cmd[2], cmd[3], cmd[4]);
        break;
      case 'fillRect':
        ctx.fillRect(cmd[1], cmd[2], cmd[3], cmd[4]);
        break;
      case 'strokeRect':
        ctx.strokeRect(cmd[1], cmd[2], cmd[3], cmd[4]);
        break;
      case 'beginPath':
        ctx.beginPath();
        break;
      case 'closePath':
        ctx.closePath();
        break;
      case 'moveTo':
        ctx.moveTo(cmd[1], cmd[2]);
        break;
      case 'lineTo':
        ctx.lineTo(cmd[1], cmd[2]);
        break;
      case 'arc':
        ctx.arc(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
        break;
      case 'ellipse':
        ctx.ellipse(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6], cmd[7], cmd[8]);
        break;
      case 'rect':
        ctx.rect(cmd[1], cmd[2], cmd[3], cmd[4]);
        break;
      case 'roundRect':
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5]);
        } else {
          ctx.rect(cmd[1], cmd[2], cmd[3], cmd[4]);
        }
        break;
      case 'quadraticCurveTo':
        ctx.quadraticCurveTo(cmd[1], cmd[2], cmd[3], cmd[4]);
        break;
      case 'bezierCurveTo':
        ctx.bezierCurveTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
        break;
      case 'fill':
        if (cmd[1]) ctx.fill(cmd[1] as CanvasFillRule);
        else ctx.fill();
        break;
      case 'stroke':
        ctx.stroke();
        break;
      case 'clip':
        if (cmd[1]) ctx.clip(cmd[1] as CanvasFillRule);
        else ctx.clip();
        break;
      case 'save':
        ctx.save();
        break;
      case 'restore':
        ctx.restore();
        break;
      case 'scale':
        ctx.scale(cmd[1], cmd[2]);
        break;
      case 'rotate':
        ctx.rotate(cmd[1]);
        break;
      case 'translate':
        ctx.translate(cmd[1], cmd[2]);
        break;
      case 'transform':
        ctx.transform(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
        break;
      case 'setTransform':
        ctx.setTransform(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
        break;
      case 'resetTransform':
        ctx.resetTransform();
        break;
      case 'setLineDash':
        ctx.setLineDash(cmd[1]);
        break;
      case 'fillText':
        if (cmd[4] !== undefined) ctx.fillText(cmd[1], cmd[2], cmd[3], cmd[4]);
        else ctx.fillText(cmd[1], cmd[2], cmd[3]);
        break;
      case 'strokeText':
        if (cmd[4] !== undefined) ctx.strokeText(cmd[1], cmd[2], cmd[3], cmd[4]);
        else ctx.strokeText(cmd[1], cmd[2], cmd[3]);
        break;
      case 'putImageData': {
        const raw = base64ToBytes(cmd[1]);
        const w = cmd[2];
        const h = cmd[3];
        if (typeof ImageData === 'function' && raw.byteLength === w * h * 4) {
          const imgData = new ImageData(new Uint8ClampedArray(raw), w, h);
          ctx.putImageData(imgData, cmd[4], cmd[5]);
        }
        break;
      }
      case 'drawImage': {
        const srcRef = cmd[1];
        const source = imageFor(srcRef);
        if (!source) break;
        if (cmd[7] !== undefined && cmd[8] !== undefined && cmd[9] !== undefined) {
          ctx.drawImage(source, cmd[2], cmd[3], cmd[4]!, cmd[5]!, cmd[6]!, cmd[7], cmd[8], cmd[9]);
        } else if (cmd[4] !== undefined && cmd[5] !== undefined) {
          ctx.drawImage(source, cmd[2], cmd[3], cmd[4], cmd[5]);
        } else {
          ctx.drawImage(source, cmd[2], cmd[3]);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- a picture as a PNG, at once

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- deflate, at once

/** Each length a match may have (3 to 258): its code's number past 257, the extra bits it takes, and their value. */
const LENGTH_BASES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASES = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** A code's bits the other way about: deflate writes a code from its first bit, into a stream read from its last. */
function reversed(code: number, length: number): number {
  let out = 0;
  for (let i = 0; i < length; i++) {
    out = (out << 1) | (code & 1);
    code >>>= 1;
  }
  return out;
}

/** The fixed codes (RFC 1951, 3.2.6): for each literal or length symbol, its bits (already turned about) and how many. */
const FIXED_CODES = (() => {
  const codes = new Uint16Array(288);
  const lengths = new Uint8Array(288);
  for (let symbol = 0; symbol < 288; symbol++) {
    let code: number;
    let length: number;
    if (symbol < 144) [code, length] = [0x30 + symbol, 8];
    else if (symbol < 256) [code, length] = [0x190 + symbol - 144, 9];
    else if (symbol < 280) [code, length] = [symbol - 256, 7];
    else [code, length] = [0xc0 + symbol - 280, 8];
    codes[symbol] = reversed(code, length);
    lengths[symbol] = length;
  }
  return { codes, lengths };
})();

/** For each length 3 to 258, which of LENGTH_BASES it is in. */
const LENGTH_INDEX = (() => {
  const index = new Uint8Array(259);
  for (let i = 0; i < LENGTH_BASES.length; i++) {
    const end = i + 1 < LENGTH_BASES.length ? LENGTH_BASES[i + 1] : 259;
    for (let length = LENGTH_BASES[i]; length < end && length < 259; length++) index[length] = i;
  }
  index[258] = 28;
  return index;
})();

function distanceIndex(distance: number): number {
  let lo = 0;
  let hi = DISTANCE_BASES.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DISTANCE_BASES[mid] <= distance) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Bytes as a deflate stream (RFC 1951) in one block of the fixed codes, each run that came
 * before within 32 KB written as where it was and how long. Small and quick, and enough for
 * what a canvas's picture mostly is: runs of one colour, rows like the row before. (A better
 * compressor chooses codes for the data; this one is for answering at once.)
 */
export function deflateFixed(data: Uint8Array): Uint8Array;
export function deflateFixed(data: Uint8Array, limit: number): Uint8Array | null;
export function deflateFixed(data: Uint8Array, limit = Infinity): Uint8Array | null {
  const WINDOW = 32768;
  const HASH_SIZE = 1 << 15;
  const MAX_CHAIN = 16;
  const n = data.length;
  // Never more than 9 bits a byte, and a few for the block's head and end; and never more
  // than the limit, past which there is no answer (and no use going on).
  const out = new Uint8Array(Math.min(Math.ceil((n * 9) / 8), limit) + 16);
  let at = 0;
  let bits = 0;
  let count = 0;
  const put = (value: number, length: number) => {
    bits |= value << count;
    count += length;
    while (count >= 8) {
      out[at++] = bits & 0xff;
      bits >>>= 8;
      count -= 8;
    }
  };
  const symbol = (s: number) => put(FIXED_CODES.codes[s], FIXED_CODES.lengths[s]);
  // The last block, of the fixed codes.
  put(1, 1);
  put(1, 2);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW);
  const hashAt = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);
  const insert = (i: number) => {
    const h = hashAt(i);
    prev[i & (WINDOW - 1)] = head[h];
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLength = 0;
    let bestDistance = 0;
    if (i + 3 <= n) {
      const max = Math.min(258, n - i);
      let candidate = head[hashAt(i)];
      let chain = MAX_CHAIN;
      while (candidate >= 0 && i - candidate <= WINDOW && chain-- > 0) {
        if (data[candidate + bestLength] === data[i + bestLength]) {
          let length = 0;
          while (length < max && data[candidate + length] === data[i + length]) length++;
          if (length > bestLength) {
            bestLength = length;
            bestDistance = i - candidate;
            if (length === max) break;
          }
        }
        const next = prev[candidate & (WINDOW - 1)];
        // A link older than the window, or one written over by a later place: the chain ends.
        if (next >= candidate) break;
        candidate = next;
      }
      insert(i);
    }
    if (bestLength >= 3) {
      const li = LENGTH_INDEX[bestLength];
      symbol(257 + li);
      if (LENGTH_EXTRA[li] > 0) put(bestLength - LENGTH_BASES[li], LENGTH_EXTRA[li]);
      const di = distanceIndex(bestDistance);
      put(reversed(di, 5), 5);
      if (DISTANCE_EXTRA[di] > 0) put(bestDistance - DISTANCE_BASES[di], DISTANCE_EXTRA[di]);
      for (let k = 1; k < bestLength; k++) if (i + k + 3 <= n) insert(i + k);
      i += bestLength;
    } else {
      symbol(data[i]);
      i++;
    }
    if (at > limit) return null;
  }
  symbol(256);
  if (count > 0) out[at++] = bits & 0xff;
  return out.subarray(0, at);
}

/**
 * A picture's pixels (RGBA, a row after a row) as a PNG file, made at once: the browser's own
 * encoder answers later (`toBlob`, `convertToBlob`), and what asks for a picture as a `data:`
 * address waits for nothing. Compressed by deflateFixed: a chart drawn at twice its size for a
 * sharp screen is millions of pixels, and stored as they are, they were more than an answer
 * carries to the app.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array;
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, maxBytes: number): Uint8Array | null;
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, maxBytes = Infinity): Uint8Array | null {
  const row = width * 4 + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * row + 1);
  // zlib: a header, the deflate stream, and the data's Adler-32. Past `maxBytes`, none at all.
  const deflated = deflateFixed(raw, maxBytes);
  if (!deflated) return null;
  const zlib = new Uint8Array(2 + deflated.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib.set(deflated, 2);
  let at = 2 + deflated.length;
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; ) {
    // In runs short enough that the sums cannot overflow before they are reduced.
    const end = Math.min(raw.length, i + 3800);
    for (; i < end; i++) {
      a += raw[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  zlib[at++] = b >>> 8;
  zlib[at++] = b & 0xff;
  zlib[at++] = a >>> 8;
  zlib[at++] = a & 0xff;
  const out = new Uint8Array(8 + 25 + (12 + zlib.length) + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(out.buffer);
  let pos = 8;
  const chunk = (type: string, data: Uint8Array) => {
    view.setUint32(pos, data.length);
    for (let i = 0; i < 4; i++) out[pos + 4 + i] = type.charCodeAt(i);
    out.set(data, pos + 8);
    view.setUint32(pos + 8 + data.length, crc32(out, pos + 4, pos + 8 + data.length));
    pos += 12 + data.length;
  };
  const header = new Uint8Array(13);
  const head = new DataView(header.buffer);
  head.setUint32(0, width);
  head.setUint32(4, height);
  header[8] = 8; // bits a channel
  header[9] = 6; // red, green, blue and alpha
  chunk('IHDR', header);
  chunk('IDAT', zlib);
  chunk('IEND', new Uint8Array(0));
  return out;
}