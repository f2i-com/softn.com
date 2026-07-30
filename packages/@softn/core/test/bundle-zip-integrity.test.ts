/**
 * Bundle reader integrity regressions.
 *
 * A `.softn` is a ZIP the user may have received from anyone. Everything here
 * guards a way a crafted one could be validated as one archive and extracted as
 * a different one — the shape of bug that lets every size cap, every path
 * filter and every checksum be skipped without touching a single byte of the
 * archive body.
 */

import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { readBundleEntries } from '../src/bundle/zip';
import { readBundle } from '../src/bundle/bundle';

/** jsdom's TextEncoder returns a cross-realm Uint8Array, which fflate does not recognise. */
const enc = (s: string) => Uint8Array.from(new TextEncoder().encode(s));

const EOCD_SIG = 0x06054b50;

function findEocd(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = data.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error('no EOCD');
}

/** Rewrite EOCD+10 ("total entries") and leave EOCD+8 ("entries on this disk") alone. */
function setTotalEntries(zip: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(zip);
  new DataView(out.buffer).setUint16(findEocd(out) + 10, n, true);
  return out;
}

/** Overwrite one entry's compressed payload with bytes no inflater can read. */
function ruinPayload(zip: Uint8Array, name: string): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  const eocd = findEocd(out);
  const decoder = new TextDecoder();
  let offset = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
    const nameLength = view.getUint16(offset + 28, true);
    if (decoder.decode(out.subarray(offset + 46, offset + 46 + nameLength)) === name) {
      const localHeader = view.getUint32(offset + 42, true);
      const start =
        localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true);
      out.fill(0xff, start, start + view.getUint32(offset + 20, true));
      return out;
    }
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error(`no entry named ${name}`);
}

/** Offset of `needle` in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

const MANIFEST = JSON.stringify({
  name: 'T',
  version: '1.0.0',
  main: 'main.ui',
  files: { ui: ['main.ui'] },
});

/** A stored archive with `marker` swapped for `replacement`, leaving every header intact. */
function tamperedBundle(marker: string, replacement: string): Uint8Array {
  const zip = zipSync(
    { 'manifest.json': enc(MANIFEST), 'main.ui': enc(`<div>${marker}</div>`) },
    { level: 0 }
  );
  const at = indexOfBytes(zip, enc(marker));
  expect(at, 'stored content should sit in the archive verbatim').toBeGreaterThan(0);
  const tampered = new Uint8Array(zip);
  tampered.set(enc(replacement), at);
  return tampered;
}

describe('readBundleEntries', () => {
  it('reads an honest bundle', () => {
    const zip = zipSync({ 'a.txt': enc('hello'), 'b/c.txt': enc('world') });
    const files = readBundleEntries(zip);
    expect(new TextDecoder().decode(files.get('a.txt')!)).toBe('hello');
    expect(new TextDecoder().decode(files.get('b/c.txt')!)).toBe('world');
  });

  it('rejects an archive whose two end-of-central-directory counts disagree', () => {
    // The counts are separate 16-bit fields. Validation used to read "total
    // entries" while fflate's extractor read "entries on this disk", so setting
    // the first to zero left the checksums, the size caps and the path filter
    // inspecting nothing at all while every entry was still inflated.
    const tampered = tamperedBundle('SAFE', 'EVIL');
    expect(() => readBundleEntries(tampered)).toThrow(/checksum mismatch/i);
    expect(() => readBundleEntries(setTotalEntries(tampered, 0))).toThrow(/counts disagree/i);
  });

  it('does not quietly extract the entries a lowered count hid', () => {
    const zip = zipSync({
      'main.ui': enc('<div/>'),
      'extra-a.bin': enc('a'.repeat(64)),
      'extra-b.bin': enc('b'.repeat(64)),
    });
    // Claiming one entry while the archive carries three used to be accepted:
    // the walk saw main.ui, the extractor produced all three.
    expect(() => readBundleEntries(setTotalEntries(zip, 1))).toThrow(/counts disagree/i);
  });

  it('never inflates an entry whose name it is going to discard', () => {
    // The caps used to be charged against what came back, which meant the
    // archive had already been materialised in full — including the entries the
    // path filter then threw away, so a few hundred kilobytes could buy hundreds
    // of megabytes of resident memory with no header tampering at all. A payload
    // no inflater can read stands in for that cost: reaching it at all is a
    // failure, whatever it would have expanded to.
    const zip = ruinPayload(
      zipSync({ 'main.ui': enc('<div/>'), '../pad.bin': enc('p'.repeat(512)) }),
      '../pad.bin'
    );
    expect([...readBundleEntries(zip).keys()]).toEqual(['main.ui']);
  });

  it('verifies an entry whose name an extractor would decode differently', () => {
    // Bit 11 of the general purpose flag says the name is UTF-8; without it a
    // ZIP name is latin1. The validating walk always decoded UTF-8 while
    // fflate honoured the flag, so clearing that one bit filed the same entry
    // under two different names, the checksum lookup missed, and the entry came
    // back unverified — the same split as the entry counts, one field over.
    const CEN_SIG = 0x02014b50;
    const zip = zipSync({ 'café.ui': enc('<div>SAFE</div>') }, { level: 0 });
    const out = new Uint8Array(zip);
    const view = new DataView(out.buffer);
    const at = indexOfBytes(out, enc('SAFE'));
    expect(at).toBeGreaterThan(0);
    out.set(enc('EVIL'), at);

    view.setUint16(6, view.getUint16(6, true) & ~0x800, true);
    for (let i = 0; i + 4 <= out.byteLength; i++) {
      if (view.getUint32(i, true) === CEN_SIG) {
        view.setUint16(i + 8, view.getUint16(i + 8, true) & ~0x800, true);
      }
    }
    expect(() => readBundleEntries(out)).toThrow(/checksum mismatch/i);
  });

  it('rejects a stored entry that declares two different sizes', () => {
    // Stored means the two figures describe the same bytes. Letting them differ
    // charged the budget one number and copied the other.
    const zip = zipSync({ 'a.bin': new Uint8Array(2048).fill(67) }, { level: 0 });
    const out = new Uint8Array(zip);
    const view = new DataView(out.buffer);
    for (let i = 0; i + 4 <= out.byteLength; i++) {
      if (view.getUint32(i, true) === 2048) view.setUint32(i, 4096, true);
    }
    // Put the compressed size back so only the uncompressed figure is inflated.
    const eocd = findEocd(out);
    const cd = view.getUint32(eocd + 16, true);
    view.setUint32(cd + 20, 2048, true);
    expect(() => readBundleEntries(out)).toThrow(/two different sizes/i);
  });
});

describe('two entries under one name', () => {
  /**
   * Rename an entry in both its central-directory record and its local header.
   * Names must be the same length so no offset moves — which is exactly what
   * makes this attack cheap to mount by hand.
   */
  function renameEntry(zip: Uint8Array, from: string, to: string): Uint8Array {
    if (from.length !== to.length) throw new Error('renameEntry needs equal-length names');
    const out = new Uint8Array(zip);
    const view = new DataView(out.buffer);
    const decoder = new TextDecoder();
    const eocd = findEocd(out);
    let offset = view.getUint32(eocd + 16, true);
    for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
      const nameLength = view.getUint16(offset + 28, true);
      if (decoder.decode(out.subarray(offset + 46, offset + 46 + nameLength)) === from) {
        out.set(enc(to), offset + 46);
        const localHeader = view.getUint32(offset + 42, true);
        out.set(enc(to), localHeader + 30);
        return out;
      }
      offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    throw new Error(`no entry named ${from}`);
  }

  it('rejects an archive where two records share a filename', () => {
    // Filenames take part in no checksum, so both records pass every integrity
    // check the reader has. Which one wins is then reader-dependent: .NET keeps
    // the first, this reader and fflate keep the last. A bundle could show an
    // inspector one manifest.json and hand the runtime a different one.
    // 'manifesX.json' is the same length as 'manifest.json', so renaming it
    // moves no offsets and the archive stays structurally perfect.
    const zip = zipSync({
      'manifest.json': enc('{"name":"Safe"}'),
      'manifesX.json': enc('{"name":"Evil"}'),
    });
    const duped = renameEntry(zip, 'manifesX.json', 'manifest.json');
    expect(() => readBundleEntries(duped)).toThrow(/share the name/i);
  });
});

describe('readBundle', () => {
  it('refuses bytes that do not match the archive checksum', async () => {
    // bundle.ts carried a second ZIP reader that had drifted from the shared
    // one: it verified decompressed lengths but never a CRC, so tampering with
    // a stored entry opened here while every other reader rejected it.
    await expect(readBundle(tamperedBundle('SAFE', 'EVIL'))).rejects.toThrow(/checksum mismatch/i);
  });
});
