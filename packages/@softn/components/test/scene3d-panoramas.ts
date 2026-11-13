/**
 * Panoramas small enough to write in a test: a Radiance `.hdr` and an OpenEXR
 * `.exr`, built byte by byte, so nothing is fetched from anywhere and three's
 * own readers have a real file to read.
 *
 * Kept free of any `three` import, like scene3d-doubles.
 */

/** One pixel of light: red, green and blue, where 1 is white and more is brighter. */
export type Light = [number, number, number];

/**
 * A pixel as Radiance stores it: three mantissas and one exponent between
 * them. three reads a channel as `mantissa × 2^(exponent − 128) ÷ 255`.
 */
function rgbe([r, g, b]: Light): [number, number, number, number] {
  const most = Math.max(r, g, b);
  if (!(most > 0)) return [0, 0, 0, 0];
  // The exponent at which the brightest channel's mantissa is the largest that fits.
  const exponent = Math.ceil(Math.log2(most)) + 128;
  const scale = 255 / Math.pow(2, exponent - 128);
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * scale)));
  return [byte(r), byte(g), byte(b), exponent];
}

/** A Radiance `.hdr` of `width` by `height`, rows from the top, written flat (no run-length coding). */
export function hdrBytes(width: number, height: number, pixel: (x: number, y: number) => Light): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const out = new Uint8Array(header.length + width * height * 4);
  out.set(header);
  let at = header.length;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out.set(rgbe(pixel(x, y)), at);
      at += 4;
    }
  }
  return out;
}

/**
 * A Radiance `.hdr` written in runs, as most programs write one: each row
 * begins 2, 2 and its width, and then holds every red of the row, every
 * green, every blue and every exponent, each as runs of one value (a count
 * above 128, then the value). `width` must be from 8 to 32767: narrower or
 * wider than that the format has no runs.
 */
export function hdrRunsBytes(width: number, height: number, pixel: (x: number, y: number) => Light): Uint8Array<ArrayBuffer> {
  const out: number[] = Array.from(new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`));
  for (let y = 0; y < height; y++) {
    out.push(2, 2, width >> 8, width & 255);
    const row = Array.from({ length: width }, (_, x) => rgbe(pixel(x, y)));
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        const value = row[x][channel];
        let run = 1;
        while (x + run < width && run < 127 && row[x + run][channel] === value) run += 1;
        out.push(128 + run, value);
        x += run;
      }
    }
  }
  return new Uint8Array(out);
}

/** An OpenEXR `.exr` of `width` by `height`, rows from the top: three 32-bit float channels, uncompressed, one row a block. */
export function exrBytes(width: number, height: number, pixel: (x: number, y: number) => Light): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  const text = (s: string) => {
    for (const c of s) bytes.push(c.charCodeAt(0));
    bytes.push(0);
  };
  const scratch = new DataView(new ArrayBuffer(8));
  const int32 = (n: number) => {
    scratch.setInt32(0, n, true);
    for (let i = 0; i < 4; i++) bytes.push(scratch.getUint8(i));
  };
  const float32 = (n: number) => {
    scratch.setFloat32(0, n, true);
    for (let i = 0; i < 4; i++) bytes.push(scratch.getUint8(i));
  };
  const attribute = (name: string, type: string, write: () => void) => {
    text(name);
    text(type);
    const sizeAt = bytes.length;
    int32(0);
    const start = bytes.length;
    write();
    scratch.setInt32(0, bytes.length - start, true);
    for (let i = 0; i < 4; i++) bytes[sizeAt + i] = scratch.getUint8(i);
  };
  const box = () => {
    int32(0);
    int32(0);
    int32(width - 1);
    int32(height - 1);
  };

  int32(20000630); // the format's magic number
  int32(2); // version 2, one part, scan lines
  attribute('channels', 'chlist', () => {
    // In the order of their names, each a 32-bit float sampled at every pixel.
    for (const name of ['B', 'G', 'R']) {
      text(name);
      int32(2);
      bytes.push(0, 0, 0, 0);
      int32(1);
      int32(1);
    }
    bytes.push(0);
  });
  attribute('compression', 'compression', () => bytes.push(0));
  attribute('dataWindow', 'box2i', box);
  attribute('displayWindow', 'box2i', box);
  attribute('lineOrder', 'lineOrder', () => bytes.push(0));
  attribute('pixelAspectRatio', 'float', () => float32(1));
  attribute('screenWindowCenter', 'v2f', () => {
    float32(0);
    float32(0);
  });
  attribute('screenWindowWidth', 'float', () => float32(1));
  bytes.push(0); // the header ends

  // Where each row's block begins, then the blocks.
  const rowBytes = width * 3 * 4;
  const first = bytes.length + height * 8;
  for (let y = 0; y < height; y++) {
    int32(first + y * (8 + rowBytes));
    int32(0);
  }
  for (let y = 0; y < height; y++) {
    int32(y);
    int32(rowBytes);
    // A row is each channel's values in turn: every blue, every green, every red.
    for (const channel of [2, 1, 0]) {
      for (let x = 0; x < width; x++) float32(pixel(x, y)[channel]);
    }
  }
  return new Uint8Array(bytes);
}
