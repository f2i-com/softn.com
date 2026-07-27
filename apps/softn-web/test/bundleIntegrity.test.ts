/**
 * Bundle integrity regressions.
 *
 * A `.softn` is a ZIP the user may have received from anyone, and every check
 * here guards a way a crafted one could either be read differently by this
 * reader than by the others, or allocate far more than its size suggests.
 */

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readZip } from '../src/lib/bundleProcessor';

/** Rewrite every little-endian u32 equal to `from` as `to`. */
function patchU32(zip: Uint8Array, from: number, to: number): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.byteLength; i++) {
    if (view.getUint32(i, true) === from) view.setUint32(i, to, true);
  }
  return out;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEocd(view: DataView, len: number): number {
  for (let i = len - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error('no EOCD');
}

describe('bundle integrity', () => {
  it('reads an honest bundle', () => {
    const zip = zipSync({ 'a.txt': strToU8('hello'), 'b.bin': new Uint8Array([1, 2, 3]) });
    const { textFiles, binaryFiles } = readZip(zip);
    expect(textFiles.get('a.txt')).toBe('hello');
    expect(binaryFiles.has('b.bin') || textFiles.has('b.bin')).toBe(true);
  });

  it('rejects an entry whose declared size understates its contents', () => {
    // fflate decompresses to the *declared* size and verifies nothing, so this
    // used to yield a silently truncated file — while core's own reader and the
    // Rust one saw the whole thing. Checking the length back cannot catch it:
    // the lie is self-consistent. Only the checksum can.
    const body = 'X'.repeat(1000);
    const zip = zipSync({ 'big.txt': strToU8(body) });
    const lying = patchU32(zip, 1000, 42);
    expect(() => readZip(lying)).toThrow(/checksum mismatch|size mismatch/i);
  });

  it('rejects two central-directory entries sharing one local header', () => {
    // The size budget is charged once per entry, but the bytes are extracted
    // once per entry too — so one payload named many times multiplies freely.
    const payload = new Uint8Array(4096).fill(66);
    const zip = zipSync({ 'one.bin': payload }, { level: 0 });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = findEocd(view, zip.byteLength);
    const cdOffset = view.getUint32(eocd + 16, true);
    const cdSize = view.getUint32(eocd + 12, true);

    const cd = zip.slice(cdOffset, cdOffset + cdSize);
    const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    expect(cdView.getUint32(0, true)).toBe(CEN_SIG);
    const nameLen = cdView.getUint16(28, true);

    // A second entry, different name, same local header offset.
    const clone = cd.slice(0);
    new TextEncoder().encodeInto('two', clone.subarray(46, 46 + nameLen));

    const head = zip.slice(0, cdOffset);
    const newCd = new Uint8Array(cd.byteLength + clone.byteLength);
    newCd.set(cd, 0);
    newCd.set(clone, cd.byteLength);

    const tail = zip.slice(eocd);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    tailView.setUint16(8, 2, true);
    tailView.setUint16(10, 2, true);
    tailView.setUint32(12, newCd.byteLength, true);
    tailView.setUint32(16, cdOffset, true);

    const bomb = new Uint8Array(head.byteLength + newCd.byteLength + tail.byteLength);
    bomb.set(head, 0);
    bomb.set(newCd, head.byteLength);
    bomb.set(tail, head.byteLength + newCd.byteLength);

    expect(() => readZip(bomb)).toThrow(/share a local header/i);
  });

  it('rejects entries claiming more compressed data than the file holds', () => {
    // A stored entry extracts its *compressed* size whatever it claims
    // uncompressed, so budgeting only the uncompressed figure left it unbounded.
    const payload = new Uint8Array(2048).fill(67);
    const zip = zipSync({ 'one.bin': payload }, { level: 0 });
    const inflatedClaim = patchU32(zip, 2048, 0x00ffffff);
    expect(() => readZip(inflatedClaim)).toThrow();
  });
});
