import {quantizeRow} from './kernel-math.mjs';
/** Q4_K block decoding, for backends that read a quantized weight as they use it.
 *
 * A port of `dequantize_row_q4_K` as ggml defines it, kept deliberately literal
 * so it can be read against that source rather than trusted. The layout of one
 * 144-byte block, holding 256 values:
 *
 *   [0..2]     f16 d        super-block scale
 *   [2..4]     f16 dmin     super-block minimum
 *   [4..16]    u8  scales   eight 6-bit scales and eight 6-bit minimums, packed
 *   [16..144]  u8  qs       256 four-bit quants, low nibbles then high
 *
 * The eight sub-blocks of 32 are walked two at a time: the low nibbles of 32
 * bytes give one sub-block, the high nibbles of the same 32 bytes give the next.
 *
 * Nothing here is approximate. Decoding is exact arithmetic on integers and two
 * half-precision scales, so a matmul that decodes as it reads produces exactly
 * what the same matmul over decoded values produces -- which is the contract
 * the tests hold it to, and the reason a quantized weight changes what a device
 * must hold without changing what it computes.
 */
const f = Math.fround;

export const Q4_K_BLOCK = 256;
export const Q4_K_BYTES = 144;
export const Q6_K_BLOCK = 256;
export const Q6_K_BYTES = 210;

/** Every format a backend can read without expanding it, by Graph v2 name. */
export const FORMATS = Object.freeze({
  q4_k: Object.freeze({block: Q4_K_BLOCK, bytes: Q4_K_BYTES}),
  q6_k: Object.freeze({block: Q6_K_BLOCK, bytes: Q6_K_BYTES}),
});

/** One IEEE half, as the float32 it names exactly. */
export function readHalf(bytes, at) {
  const bits = bytes[at] | (bytes[at + 1] << 8);
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 0x1f, fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** The scale and minimum of sub-block `j`, unpacked from the 12 scale bytes.
 * Sub-blocks 0 to 3 are a plain six bits; 4 to 7 have their high two bits
 * borrowed from the bytes of the first four. */
function scaleMin(scales, at, j, out) {
  if (j < 4) {
    out[0] = scales[at + j] & 0x3f;
    out[1] = scales[at + j + 4] & 0x3f;
  } else {
    out[0] = (scales[at + j + 4] & 0x0f) | ((scales[at + j - 4] >>> 6) << 4);
    out[1] = (scales[at + j + 4] >>> 4) | ((scales[at + j] >>> 6) << 4);
  }
}

/**
 * Decode one block into `out` at `outAt`. `bytes` is the whole weight and
 * `at` the block's first byte, so a caller decodes a row without copying it
 * out first.
 */
export function decodeQ4KBlock(bytes, at, out, outAt) {
  // Every intermediate rounds to float32, because ggml's does: the sub-block
  // scale, the minimum, and the product before the minimum is taken off. Doing
  // the arithmetic in double and rounding once at the end agrees most of the
  // time and differs in the last bit the rest of it, which over a table with
  // millions of values is not "most of the time" at all.
  const d = readHalf(bytes, at), dmin = readHalf(bytes, at + 2);
  const scales = at + 4, qs = at + 16;
  const pair = [0, 0];
  let y = outAt, q = qs;
  for (let is = 0; is < 8; is += 2) {
    scaleMin(bytes, scales, is, pair);
    const d1 = f(d * pair[0]), m1 = f(dmin * pair[1]);
    scaleMin(bytes, scales, is + 1, pair);
    const d2 = f(d * pair[0]), m2 = f(dmin * pair[1]);
    // The store into a Float32Array rounds the subtraction, which is the
    // second and last rounding.
    for (let l = 0; l < 32; l++) out[y + l] = f(d1 * (bytes[q + l] & 0x0f)) - m1;
    for (let l = 0; l < 32; l++) out[y + 32 + l] = f(d2 * ((bytes[q + l] >>> 4) & 0x0f)) - m2;
    y += 64;
    q += 32;
  }
}

/** Decode `count` values starting at block `block`, into `out`. */
export function decodeQ4K(bytes, block, count, out) {
  const blocks = count / Q4_K_BLOCK;
  for (let i = 0; i < blocks; i++) {
    decodeQ4KBlock(bytes, (block + i) * Q4_K_BYTES, out, i * Q4_K_BLOCK);
  }
}

/** Q6_K block decoding.
 *
 * A port of `dequantize_row_q6_K`, and the same discipline as Q4_K above: the
 * scale product rounds to float32 before it meets the quant, because ggml's
 * does. One 210-byte block, holding 256 values:
 *
 *   [0..128]    u8  ql      low four bits of each value
 *   [128..192]  u8  qh      high two bits, four values to a byte
 *   [192..208]  i8  scales  one signed scale per group of sixteen
 *   [208..210]  f16 d       super-block scale
 *
 * Each value is `(low4 | high2 << 4) - 32`, times `d * scales[group]`.
 */
export function decodeQ6KBlock(bytes, at, out, outAt) {
  const d = readHalf(bytes, at + 208);
  for (let half = 0; half < 2; half++) {
    const ql = at + 64 * half, qh = at + 128 + 32 * half, sc = at + 192 + 8 * half;
    for (let sub = 0; sub < 4; sub++) {
      const lowNibble = sub < 2, shift = 2 * sub, sub32 = (sub & 1) * 32;
      for (let l = 0; l < 32; l++) {
        const byte = bytes[ql + l + sub32];
        const low = lowNibble ? byte & 0x0f : byte >>> 4;
        const high = (bytes[qh + l] >>> shift) & 0x03;
        // The scale runs per group of sixteen within the 32.
        const scale = (bytes[sc + (l >>> 4) + 2 * sub] << 24) >> 24; // signed
        out[outAt + 128 * half + 32 * sub + l] = f(d * scale) * ((low | (high << 4)) - 32);
      }
    }
  }
}

/** Decode `count` values starting at block `block`, into `out`. */
export function decodeQ6K(bytes, block, count, out) {
  const blocks = count / Q6_K_BLOCK;
  for (let i = 0; i < blocks; i++) {
    decodeQ6KBlock(bytes, (block + i) * Q6_K_BYTES, out, i * Q6_K_BLOCK);
  }
}

/** One block of whichever format, so a backend dispatches once per row rather
 * than once per value. */
export function blockDecoder(dtype) {
  if (dtype === 'q4_k') return decodeQ4KBlock;
  if (dtype === 'q6_k') return decodeQ6KBlock;
  throw new Error(`No block decoder for ${dtype}`);
}

/**
 * Quantizes a weight the way `matmul_fixed` would, once, for a graph to hold.
 *
 * `rows` is either a Float32Array of `n * k` values or the bytes of a Q4_K or
 * Q6_K tensor of that shape; `dtype` says which. The result is what an `i16`
 * input node and its scales input want: `quants` as little-endian bytes -- the
 * byte order this protocol reads every multi-byte field in -- and `scales` as
 * one float32 per output column.
 *
 * This is the whole of the bind-time form. `matmul_fixed` over the result is
 * bit-for-bit what `matmul_fixed` over the original weight gives, because it is
 * the same `quantizeRow` over the same values; all that moved is when it ran.
 * What it costs is memory: two bytes a value against Q4_K's 0.5625, so 3.56
 * times more on the device, in exchange for a decode and a requantise that no
 * longer happen on every step.
 */
export function quantizeWeight(rows, n, k, dtype = 'f32') {
  // Checked here rather than left to fail later. This reads `rows` by computed
  // offset, so a length that does not match the shape reads past the end, and
  // `undefined` quantizes to NaN -- a plausible weight of nothing, produced
  // silently. The graph validator would eventually refuse the result's length,
  // but it would name the wrong thing.
  if (dtype !== 'f32' && !Object.hasOwn(FORMATS, dtype))
    throw new Error(`quantizeWeight: unknown dtype ${String(dtype)}`);
  const expected = dtype === 'f32' ? n * k : (n * k / FORMATS[dtype].block) * FORMATS[dtype].bytes;
  if (rows?.length !== expected)
    throw new Error(`quantizeWeight: a [${n}, ${k}] ${dtype} weight is ${expected} ` +
      `${dtype === 'f32' ? 'values' : 'bytes'}; got ${rows?.length}`);
  const quants = new Uint8Array(n * k * 2), scales = new Float32Array(n);
  const row = new Float32Array(k), out = new Int16Array(k);
  const decode = dtype === 'f32' ? null : blockDecoder(dtype);
  const per = decode ? k / FORMATS[dtype].block : 0, size = decode ? FORMATS[dtype].bytes : 0;
  for (let c = 0; c < n; c++) {
    if (decode) for (let t = 0; t < per; t++) decode(rows, (c * per + t) * size, row, t * FORMATS[dtype].block);
    else for (let j = 0; j < k; j++) row[j] = rows[c * k + j];
    scales[c] = quantizeRow(row, 0, k, out, 0);
    // Written a byte at a time rather than through an Int16Array view, so the
    // bytes are little-endian wherever this runs and not whatever the host is.
    for (let j = 0, at = c * k * 2; j < k; j++, at += 2) {
      quants[at] = out[j] & 0xff; quants[at + 1] = (out[j] >> 8) & 0xff;
    }
  }
  return {quants, scales};
}

/** The int16 quants of an `i16` input, read out of its little-endian bytes. */
export function readFixedQuants(bytes, count) {
  const out = new Int16Array(count);
  for (let i = 0, at = 0; i < count; i++, at += 2) out[i] = (bytes[at] | (bytes[at + 1] << 8)) << 16 >> 16;
  return out;
}
