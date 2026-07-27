/**
 * Round-tripping assets through the saved session.
 *
 * Assets were omitted from the session entirely, so restoring brought back a
 * project whose every `asset('logo.png')` resolved to nothing — images and
 * sounds gone, while the file tree still listed them. Silent loss of the
 * user's own files is the worst outcome available here, so the encoding is
 * worth pinning byte for byte.
 */

import { describe, it, expect } from 'vitest';
import { encodeAsset, decodeAsset } from './sessionAssets';

function asset(data: Uint8Array, name = 'logo.png', type = 'image/png') {
  return { name, type, data };
}

describe('encoding an asset', () => {
  it('round-trips the bytes exactly', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const out = decodeAsset(encodeAsset(asset(bytes)));

    expect(Array.from(out.data)).toEqual(Array.from(bytes));
    expect(out.name).toBe('logo.png');
    expect(out.type).toBe('image/png');
  });

  it('round-trips every byte value', () => {
    // A naive text encoding mangles the high half of the range.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    expect(Array.from(decodeAsset(encodeAsset(asset(bytes))).data)).toEqual(Array.from(bytes));
  });

  it('handles an asset larger than the argument limit', () => {
    // `String.fromCharCode(...bytes)` throws on anything much over 64k, which
    // is a small image — hence the chunking.
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const out = decodeAsset(encodeAsset(asset(bytes, 'big.bin', 'application/octet-stream')));
    expect(out.data.length).toBe(bytes.length);
    expect(out.data[0]).toBe(bytes[0]);
    expect(out.data[299_999]).toBe(bytes[299_999]);
  });

  it('handles an empty asset', () => {
    const out = decodeAsset(encodeAsset(asset(new Uint8Array(0))));
    expect(out.data.length).toBe(0);
  });

  it('is far more compact than JSON of the raw array', () => {
    // The reason for base64: JSON.stringify of a Uint8Array produces
    // `{"0":80,"1":75,…}`, which would push most projects past the quota.
    const bytes = new Uint8Array(10_000).fill(200);
    const base64 = JSON.stringify(encodeAsset(asset(bytes))).length;
    const naive = JSON.stringify({ data: bytes }).length;

    expect(base64).toBeLessThan(naive / 3);
  });
});
