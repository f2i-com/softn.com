/**
 * The PNG a canvas is read back as (`toDataURL`), made at once in the Worker (canvas-replay.ts):
 * its data compressed by a small deflate of its own. Read here by Node's zlib, which is what
 * every browser's PNG decoder agrees with.
 */
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { deflateFixed, encodePng } from '../src/canvas-replay';

/** A predictable run of bytes that does not repeat: what a photograph is to a compressor. */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const inflated = (data: Uint8Array): Uint8Array => new Uint8Array(zlib.inflateRawSync(data));

/** Whether two runs of bytes are the same, byte for byte. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('deflate, at once', () => {
  it('is read back to the same bytes, whatever they are', () => {
    const cases: Array<[string, Uint8Array]> = [
      ['nothing', new Uint8Array(0)],
      ['one byte', new Uint8Array([42])],
      ['two bytes', new Uint8Array([1, 2])],
      ['one colour', new Uint8Array(100_000).fill(255)],
      ['a pixel over and over', Uint8Array.from({ length: 64_000 }, (_, i) => [10, 20, 30, 255][i % 4])],
      ['stripes', Uint8Array.from({ length: 200_000 }, (_, i) => (Math.floor(i / 1000) % 2 ? 0 : 200))],
      ['noise', noise(100_000)],
      ['noise with a repeat far back', (() => { const a = noise(70_000, 3); a.set(a.subarray(0, 20_000), 45_000); return a; })()],
      ['longer than the window, repeating past it', (() => { const a = noise(10_000, 9); const b = new Uint8Array(150_000); for (let i = 0; i < b.length; i += 10_000) b.set(a.subarray(0, Math.min(10_000, b.length - i)), i); return b; })()],
      ['every byte value', Uint8Array.from({ length: 256 * 40 }, (_, i) => i & 0xff)],
    ];
    for (const [name, data] of cases) {
      const packed = deflateFixed(data);
      expect(same(inflated(packed), data), name).toBe(true);
    }
  });

  it('makes runs of one colour small, and is no more than a ninth larger than what it is given', () => {
    expect(deflateFixed(new Uint8Array(4_000_000).fill(255)).length).toBeLessThan(40_000);
    const random = noise(200_000);
    expect(deflateFixed(random).length).toBeLessThanOrEqual(Math.ceil((random.length * 9) / 8) + 16);
  });
});

describe('a canvas read back as a PNG', () => {
  /** The rows of a PNG as its decoder reads them: the filter byte, then the row's pixels. */
  function rowsOf(png: Uint8Array): { width: number; height: number; raw: Uint8Array } {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let at = 8;
    let width = 0;
    let height = 0;
    const data: Uint8Array[] = [];
    while (at < png.length) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      const body = png.subarray(at + 8, at + 8 + length);
      // Each chunk's check is the CRC of its type and data.
      expect(view.getUint32(at + 8 + length), `${type}'s check`).toBe(zlib.crc32(png.subarray(at + 4, at + 8 + length)));
      if (type === 'IHDR') {
        width = new DataView(body.buffer, body.byteOffset).getUint32(0);
        height = new DataView(body.buffer, body.byteOffset).getUint32(4);
      }
      if (type === 'IDAT') data.push(body);
      at += 12 + length;
    }
    // inflateSync checks the zlib header and the Adler-32 at its end.
    const joined = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of data) {
      joined.set(part, offset);
      offset += part.length;
    }
    return { width, height, raw: new Uint8Array(zlib.inflateSync(joined)) };
  }

  it('is a PNG every decoder reads, and holds the picture as it was', () => {
    const width = 37;
    const height = 23;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([x * 7, y * 11, (x * y) & 0xff, x < 10 ? 255 : 128], (y * width + x) * 4);
    const { width: w, height: h, raw } = rowsOf(encodePng(width, height, rgba));
    expect([w, h]).toEqual([width, height]);
    for (let y = 0; y < height; y++) {
      expect(raw[y * (width * 4 + 1)], `row ${y}'s filter`).toBe(0);
      expect([...raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))]).toEqual([...rgba.subarray(y * width * 4, (y + 1) * width * 4)]);
    }
  });

  it('is small for a large picture of few colours, as a chart drawn for a sharp screen is', () => {
    // 2,400 by 1,200 pixels: 11.5 MB as they are, which did not fit in an answer to the app.
    const width = 2400;
    const height = 1200;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let x = 0; x < width; x++) rgba.set([37, 99, 235, 255], (600 * width + x) * 4);
    const started = performance.now();
    const png = encodePng(width, height, rgba);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(png.length).toBeLessThan(200_000);
    const { raw } = rowsOf(png);
    expect(raw.length).toBe(height * (width * 4 + 1));
    expect([...raw.subarray(600 * (width * 4 + 1) + 1, 600 * (width * 4 + 1) + 5)]).toEqual([37, 99, 235, 255]);
  });
});
