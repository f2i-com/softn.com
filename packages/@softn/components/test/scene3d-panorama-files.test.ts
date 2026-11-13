/**
 * A panorama's file is not believed: what its header declares is read before
 * its reader is let near it.
 *
 * The files are written here byte by byte (scene3d-panoramas) and then cut
 * short, or told to lie, as a file from anywhere on the web may. The readers
 * are three's own, through the same `loadEnvironmentTexture` a scene uses
 * and a stubbed `fetch`. Before the header was read first, several of these
 * did not fail: one stopped the page for good (three's OpenEXR reader looks
 * for the end of a name by walking forward to a zero byte, and does not stop
 * at the end of the file), and one made a gigabyte of a file of sixty bytes.
 * Each test has a short time allowed it, so that a file that hangs the
 * reader is a failure and not a run that never ends.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { loadEnvironmentTexture } from '../src/threed/environment';
import {
  hdrPixels,
  MAX_PANORAMA_HEIGHT,
  MAX_PANORAMA_WIDTH,
  readExrHeader,
  readHdrHeader,
  refuseOtherThanDeclared,
  refusePanoramaSize,
} from '../src/threed/panorama-headers';
import { stubFetch } from './scene3d-doubles';
import { exrBytes, hdrBytes, hdrRunsBytes, type Light } from './scene3d-panoramas';

const SUN: Light = [4, 0.8, 0];
const DUSK: Light = [0, 0, 0.5];
const twoPixels = (x: number): Light => (x === 0 ? SUN : DUSK);
/** A short time: a reader that walks off the end of a file never comes back. */
const SOON = 4000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let cases = 0;
/** Fetch and read a file as a scene does. */
function load(bytes: Uint8Array<ArrayBuffer>, format: 'hdr' | 'exr', maxTextureSize?: number): Promise<THREE.Texture> {
  const url = `https://skies.test/case-${++cases}.${format}`;
  stubFetch({ [url]: () => bytes });
  return loadEnvironmentTexture({ url, format, policy: { judge: () => ({ allowed: true }) }, maxTextureSize });
}
/** The light of a panorama's pixels, as three read them. */
function lightOf(texture: THREE.Texture): number[] {
  const data = (texture.image as { data: Uint16Array | Float32Array }).data;
  return Array.from(data, (v) => Math.round((data instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat(v) : v) * 100) / 100);
}
const text = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const bytesOf = (...parts: Array<number[] | Uint8Array>): Uint8Array<ArrayBuffer> => new Uint8Array(parts.flatMap((part) => Array.from(part)));
/** Where the bytes after `words` begin in a file. */
function after(bytes: Uint8Array, words: string): number {
  const wanted = text(words);
  for (let i = 0; i + wanted.length <= bytes.length; i++) {
    if (wanted.every((byte, j) => bytes[i + j] === byte)) return i + wanted.length;
  }
  throw new Error(`the file has no ${JSON.stringify(words)}`);
}
const int32 = (n: number): number[] => {
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, n, true);
  return [0, 1, 2, 3].map((i) => view.getUint8(i));
};
function put(bytes: Uint8Array, at: number, values: number[]): void {
  values.forEach((value, i) => (bytes[at + i] = value));
}

describe('a Radiance .hdr is read only as far as its header can be believed', () => {
  const header = (lines: string) => new Uint8Array(text(lines));

  it('reads one written flat and one written in runs, to the same light', async () => {
    const wide = (x: number): Light => (x < 4 ? SUN : DUSK);
    for (const bytes of [hdrBytes(8, 2, wide), hdrRunsBytes(8, 2, wide)]) {
      const texture = (await load(bytes, 'hdr')) as THREE.DataTexture;
      expect([texture.image.width, texture.image.height]).toEqual([8, 2]);
      const light = lightOf(texture);
      expect(light).toHaveLength(8 * 2 * 4);
      expect(light.slice(0, 3)).toEqual([4, 0.8, 0]);
      expect(light.slice(7 * 4, 7 * 4 + 3)).toEqual([0, 0, 0.5]);
    }
    // A row of one value is the least a row in runs can take, and is not taken for too short.
    const least = hdrRunsBytes(8, 1, () => SUN);
    expect(least.length - readHdrHeader(least).dataStart).toBe(12);
    expect(lightOf(await load(least, 'hdr')).slice(0, 3)).toEqual([4, 0.8, 0]);
    // What follows the last pixel of a flat file is left off.
    const padded = bytesOf(hdrBytes(2, 1, twoPixels), [9, 9, 9, 9, 9, 9, 9, 9]);
    expect(lightOf(await load(padded, 'hdr'))).toHaveLength(8);
  }, SOON);

  it(
    'refuses a picture larger than 8192 by 4096 before anything is made of it: a file of sixty bytes declared a gigabyte',
    async () => {
      // A file in runs that says it is 16384 by 8192 and holds four bytes of its first row.
      const lying = bytesOf(text('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 8192 +X 16384\n'), [2, 2, 0x40, 0x00]);
      expect(lying.length).toBeLessThan(60);
      const began = performance.now();
      await expect(load(lying, 'hdr')).rejects.toThrow('it is 16384 by 8192, and a panorama may be 8192 by 4096 at most');
      // Not the seconds it took to make a gigabyte of it.
      expect(performance.now() - began).toBeLessThan(500);
      await expect(load(header('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4097 +X 8192\n'), 'hdr')).rejects.toThrow('at most');
      await expect(load(header('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 32767 +X 32767\n'), 'hdr')).rejects.toThrow('at most');
      // The largest that is read, declared by a file with nothing in it: too short, and nothing is made.
      await expect(load(header(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${MAX_PANORAMA_HEIGHT} +X ${MAX_PANORAMA_WIDTH}\n`), 'hdr')).rejects.toThrow(
        'it declares a picture of 8192 by 4096 and is too short to hold one'
      );
      await expect(load(header('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 0 +X 2\n'), 'hdr')).rejects.toThrow('a picture of no size');
    },
    SOON
  );

  it('refuses a file too short to hold the picture it declares, flat or in runs', async () => {
    const flat = hdrBytes(2, 1, twoPixels);
    await expect(load(flat.slice(0, flat.length - 1), 'hdr')).rejects.toThrow('it declares a picture of 2 by 1 and is too short to hold one');
    await expect(load(flat.slice(0, flat.length - 4), 'hdr')).rejects.toThrow('too short');
    const runs = hdrRunsBytes(8, 4, () => SUN);
    // Three of its four rows.
    await expect(load(runs.slice(0, runs.length - 12), 'hdr')).rejects.toThrow('it declares a picture of 8 by 4 and is too short to hold one');
  }, SOON);

  it('refuses one larger than the device can draw', async () => {
    await expect(load(hdrBytes(2, 1, twoPixels), 'hdr', 1)).rejects.toThrow('it is 2 by 1, larger than this device can draw (1 either way)');
    expect(lightOf(await load(hdrBytes(2, 1, twoPixels), 'hdr', 2))).toHaveLength(8);
  }, SOON);

  it('reads the header itself, as the format has it, and never far', () => {
    const two = hdrBytes(2, 1, twoPixels);
    // Its pixels begin where its last eight bytes do.
    expect(readHdrHeader(two)).toEqual({ width: 2, height: 1, dataStart: two.length - 8 });
    // Comments and other lines are passed over; a size before any format is not a size.
    const full = header('#?RGBE\n# made by hand\nEXPOSURE=1.0\nFORMAT=32-bit_rle_rgbe\n\n-Y 3 +X 5\nrest');
    expect(readHdrHeader(full)).toMatchObject({ width: 5, height: 3 });
    expect(() => readHdrHeader(header('#?RADIANCE\n-Y 3 +X 5\nFORMAT=32-bit_rle_rgbe\n'))).toThrow('its header names no format');
    expect(() => readHdrHeader(header('not a picture of anything'))).toThrow('it is not a Radiance .hdr file');
    expect(() => readHdrHeader(header('P6\n2 1\n255\n'))).toThrow('it is not a Radiance .hdr file');
    expect(() => readHdrHeader(header('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n'))).toThrow('its header does not say how big the picture is');
    expect(() => readHdrHeader(new Uint8Array(0))).toThrow('it is not a Radiance .hdr file');
    // A "header" of a megabyte of lines that never names a size is given up on after the first of it.
    const endless = new Uint8Array(1024 * 1024).fill(10);
    endless.set(text('#?RADIANCE\n'));
    const began = performance.now();
    expect(() => readHdrHeader(endless)).toThrow('its header does not say how big the picture is');
    expect(performance.now() - began).toBeLessThan(200);
    // The pixels of a flat file are four bytes each, and no more of the file than that.
    const flat = hdrBytes(2, 1, twoPixels);
    expect(hdrPixels(bytesOf(flat, [1, 2, 3]), readHdrHeader(flat))).toHaveLength(8);
  });

  it('checks what a reader hands back against what the header declared, and the size against what may be drawn', () => {
    const picture = { width: 2, height: 1, data: new Uint16Array(8) };
    expect(() => refuseOtherThanDeclared(picture, 2, 1, 4)).not.toThrow();
    // A short array: what a reader made of a file with fewer pixels than it said.
    expect(() => refuseOtherThanDeclared({ ...picture, data: new Uint16Array(4) }, 2, 1, 4)).toThrow('not the picture its header declares');
    expect(() => refuseOtherThanDeclared(picture, 2, 2, 4)).toThrow('not the picture its header declares');
    expect(() => refuseOtherThanDeclared({ width: 2, height: 1, data: new Uint16Array(2) }, 2, 1, 1)).not.toThrow();
    expect(() => refusePanoramaSize(8192, 4096, 16384)).not.toThrow();
    expect(() => refusePanoramaSize(8193, 4096)).toThrow('at most');
    expect(() => refusePanoramaSize(8192, 4096, 4096)).toThrow('larger than this device can draw');
    for (const [w, h] of [[0, 1], [-4, 2], [1.5, 2], [Number.NaN, 2]]) expect(() => refusePanoramaSize(w, h)).toThrow('a picture of no size');
  });
});

describe('an OpenEXR .exr is read only as far as its header can be believed', () => {
  const valid = () => exrBytes(2, 1, twoPixels);

  it('still reads a valid one', async () => {
    const texture = (await load(valid(), 'exr')) as THREE.DataTexture;
    expect([texture.image.width, texture.image.height]).toEqual([2, 1]);
    const light = lightOf(texture);
    expect(light.slice(0, 3)).toEqual([4, 0.8, 0]);
    expect(light.slice(4, 7)).toEqual([0, 0, 0.5]);
    expect(readExrHeader(valid())).toMatchObject({ width: 2, height: 1, compression: 0, tiled: false });
  }, SOON);

  it(
    'refuses at once the nine bytes that stopped the page for good: a header whose first name never ends',
    async () => {
      const nine = Uint8Array.from(atob('di8xAQIAAABB'), (c) => c.charCodeAt(0));
      expect(nine).toHaveLength(9);
      const began = performance.now();
      await expect(load(nine, 'exr')).rejects.toThrow('a name in its header does not end');
      expect(performance.now() - began).toBeLessThan(1000);
    },
    SOON
  );

  it(
    'refuses or reads every beginning of a valid file, from its first byte to all of it, and never hangs on one',
    async () => {
      const whole = valid();
      const read: number[] = [];
      const refused: Record<string, number> = {};
      const began = performance.now();
      for (let length = 1; length <= whole.length; length++) {
        try {
          const texture = await load(whole.slice(0, length), 'exr');
          read.push(length);
          texture.dispose();
        } catch (err) {
          const why = (err as Error).message.replace(/"[^"]*"/, '""');
          refused[why] = (refused[why] ?? 0) + 1;
        }
      }
      const took = performance.now() - began;
      // Told in the run's output: how long every beginning of the file took, and why each was refused.
      console.info(`[panorama] ${whole.length} beginnings of a ${whole.length}-byte .exr in ${took.toFixed(0)} ms; read at lengths ${read.join(', ')}; refused: ${JSON.stringify(refused)}`);
      // The whole file is read. So is one cut within its last eight bytes, which the zero bytes it is given an end
      // with stand in for; nothing shorter is.
      expect(read.at(-1)).toBe(whole.length);
      expect(read.every((length) => length >= whole.length - 8)).toBe(true);
      expect(took).toBeLessThan(SOON * 2);
    },
    SOON * 4
  );

  it('refuses a header that is not what it says, each for what is wrong with it', () => {
    const cut = (to: number) => valid().slice(0, to);
    expect(() => readExrHeader(new Uint8Array([1, 2, 3]))).toThrow('it is not an OpenEXR file');
    expect(() => readExrHeader(new Uint8Array(text('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n')))).toThrow('it is not an OpenEXR file');
    const other = valid();
    other[4] = 1;
    expect(() => readExrHeader(other)).toThrow('it is OpenEXR version 1');

    // A deep file, a file of several parts, and any other kind three's reader does not take.
    for (const [flag, why] of [[0x08, 'a deep OpenEXR file'], [0x10, 'several parts'], [0x18, 'a deep OpenEXR file'], [0x20, 'a kind of OpenEXR file that is not read']] as const) {
      const flagged = valid();
      flagged[5] = flag;
      expect(() => readExrHeader(flagged)).toThrow(why);
    }

    // A name with no zero byte to end it: at the end of the file, and within a longer one.
    expect(() => readExrHeader(bytesOf([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0], text('channels')))).toThrow('a name in its header does not end');
    expect(() => readExrHeader(bytesOf([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0], new Array<number>(5000).fill(0x41), [0]))).toThrow('a name in its header does not end');
    // A type the same.
    expect(() => readExrHeader(bytesOf([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0], text('channels\0'), new Array<number>(400).fill(0x42)))).toThrow('a name in its header does not end');

    // An attribute whose size runs past the end of the file.
    const long = valid();
    put(long, after(long, 'screenWindowWidth\0float\0'), int32(0x7fffffff));
    expect(() => readExrHeader(long)).toThrow('the attribute "screenWindowWidth" of its header is longer than the file');
    const unknown = valid();
    put(unknown, after(unknown, 'pixelAspectRatio\0'), text('fleat'));
    put(unknown, after(unknown, 'pixelAspectRatio\0fleat\0'), int32(100000));
    expect(() => readExrHeader(unknown)).toThrow('the attribute "pixelAspectRatio" of its header is longer than the file');

    // A size that is not what the type takes: three's reader takes the type's own, and would read on from elsewhere.
    const sized = valid();
    put(sized, after(sized, 'dataWindow\0box2i\0'), int32(4));
    expect(() => readExrHeader(sized)).toThrow('the attribute "dataWindow" of its header is not the size of its type');
    // A list of channels that does not end where it says.
    const channels = valid();
    put(channels, after(channels, 'channels\0chlist\0'), int32(20));
    expect(() => readExrHeader(channels)).toThrow('the channels of its header do not end where they say');

    // A header that never ends, in the file and past a megabyte; and one of too many attributes.
    expect(() => readExrHeader(cut(after(valid(), 'screenWindowWidth\0float\0') + 8))).toThrow('its header does not end');
    const attribute = bytesOf(text('a\0b\0'), int32(0));
    const many = bytesOf([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0], ...new Array<Uint8Array>(1001).fill(attribute), [0]);
    expect(() => readExrHeader(many)).toThrow('its header has more than a thousand attributes');
    const filler = bytesOf(text('note\0string\0'), int32(4000), new Array<number>(4000).fill(0x20));
    const endless = bytesOf([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0], ...new Array<Uint8Array>(300).fill(filler));
    expect(endless.length).toBeGreaterThan(1024 * 1024);
    expect(() => readExrHeader(endless)).toThrow('its header runs past a megabyte');

    // A header that says nothing of the picture's size, of its compression or of its channels.
    const start = [0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0];
    const box = bytesOf(text('dataWindow\0box2i\0'), int32(16), int32(0), int32(0), int32(1), int32(0));
    const zip = bytesOf(text('compression\0compression\0'), int32(1), [0]);
    const list = bytesOf(text('channels\0chlist\0'), int32(19), text('R\0'), int32(1), [0, 0, 0, 0], int32(1), int32(1), [0]);
    expect(() => readExrHeader(bytesOf(start, zip, list, [0]))).toThrow('its header does not say how big the picture is');
    expect(() => readExrHeader(bytesOf(start, box, list, [0]))).toThrow('its header does not say how it is compressed');
    expect(() => readExrHeader(bytesOf(start, box, zip, [0]))).toThrow('its header names no channels');
    expect(readExrHeader(bytesOf(start, box, zip, list, [0]))).toMatchObject({ width: 2, height: 1, compression: 0 });
    // A name three's reader takes for the end of the header (it reads as nought) is where the header ends here too.
    expect(() => readExrHeader(bytesOf(start, zip, list, text('0\0'), box, [0]))).toThrow('its header does not say how big the picture is');
    // A compression that is no compression.
    const packed = valid();
    packed[after(packed, 'compression\0compression\0') + 4] = 77;
    expect(() => readExrHeader(packed)).toThrow('its header does not say how it is compressed');
  });

  it(
    'refuses a window of 16384 by 8192 in an otherwise valid file, and one that is empty or inside out: as for an .hdr',
    async () => {
      const window = (xMax: number, yMax: number, xMin = 0, yMin = 0) => {
        const bytes = valid();
        put(bytes, after(bytes, 'dataWindow\0box2i\0') + 4, [...int32(xMin), ...int32(yMin), ...int32(xMax), ...int32(yMax)]);
        return bytes;
      };
      const began = performance.now();
      await expect(load(window(16383, 8191), 'exr')).rejects.toThrow('it is 16384 by 8192, and a panorama may be 8192 by 4096 at most');
      await expect(load(window(0x7fffffff, 0x7fffffff), 'exr')).rejects.toThrow('at most');
      await expect(load(window(-1, 0), 'exr')).rejects.toThrow('a picture of no size');
      await expect(load(window(1, 0, 5, 0), 'exr')).rejects.toThrow('a picture of no size');
      await expect(load(window(1, 0), 'exr', 1)).rejects.toThrow('larger than this device can draw');
      // As tall as a panorama may be, in a file with one row in it: too short for the table of where its rows begin.
      await expect(load(window(1, 4095), 'exr')).rejects.toThrow('it declares a picture of 2 by 4096 and is too short to hold one');
      // None of them was unpacked first.
      expect(performance.now() - began).toBeLessThan(1500);
    },
    SOON
  );

  it(
    'does not hang on a chunk of data with no zero byte in it, where the reader looks for the end of a name again',
    async () => {
      // The valid file, said to be DWAA-compressed; its one chunk says it holds a byte, and what follows is
      // two hundred bytes of ones: a compression header the reader accepts, then a rule whose name never ends.
      const whole = valid();
      whole[after(whole, 'compression\0compression\0') + 4] = 8;
      const chunk = whole.length - 24 - 8;
      const garbage = bytesOf(whole.slice(0, chunk), int32(0), int32(1), new Array<number>(200).fill(1));
      expect(Array.from(garbage.slice(chunk + 8)).includes(0)).toBe(false);
      const decoded = vi.spyOn(TextDecoder.prototype, 'decode');
      const began = performance.now();
      let outcome = 'read';
      try {
        const texture = (await load(garbage, 'exr')) as THREE.DataTexture;
        // Read, it is the picture its header declares and nothing else.
        expect([texture.image.width, texture.image.height]).toEqual([2, 1]);
      } catch (err) {
        outcome = (err as Error).message;
      }
      expect(performance.now() - began).toBeLessThan(2000);
      expect(typeof outcome).toBe('string');
      // The reader did look for the end of that name: it read on through the hundred and ten ones left of the
      // file after the ninety bytes of the compression's own header, and stopped at the end it was given.
      expect(decoded.mock.results.map((result) => result.value as unknown)).toContain('\u0001'.repeat(110));
    },
    SOON
  );
});
