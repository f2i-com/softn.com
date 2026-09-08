/**
 * The demand-read archive against the eager reader.
 *
 * `readBundleEntries` is the oracle: every archive bundle-zip-integrity.test.ts
 * rejects, `openBundleArchive` must reject too — at open for a structural
 * fault, or on the read that touches a bad entry for a checksum or size lie —
 * with the same message, and what it reads must be byte-for-byte what the
 * eager reader returns. The tamper helpers below are copies of that file's,
 * which are private to it and which this file must not change.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fflate from 'fflate';
import { zipSync } from 'fflate';
import {
  inflateEntries,
  openBundleArchive,
  readBundleEntries,
  MAX_ZIP_INPUT_BYTES,
} from '../src/bundle/zip';

vi.mock('fflate', async (importOriginal) => {
  const original = await importOriginal<typeof import('fflate')>();
  return { ...original, inflateSync: vi.fn(original.inflateSync) };
});

const inflateSpy = fflate.inflateSync as unknown as ReturnType<typeof vi.fn>;

/** jsdom's TextEncoder returns a cross-realm Uint8Array, which fflate does not recognise. */
const enc = (s: string) => Uint8Array.from(new TextEncoder().encode(s));
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

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

/** Walk the central directory to the record named `name` and hand it to `edit`. */
function editRecord(
  zip: Uint8Array,
  name: string,
  edit: (out: Uint8Array, view: DataView, record: number) => void
): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  const eocd = findEocd(out);
  const decoder = new TextDecoder();
  let offset = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
    const nameLength = view.getUint16(offset + 28, true);
    if (decoder.decode(out.subarray(offset + 46, offset + 46 + nameLength)) === name) {
      edit(out, view, offset);
      return out;
    }
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error(`no entry named ${name}`);
}

/** Overwrite one entry's compressed payload with bytes no inflater can read. */
function ruinPayload(zip: Uint8Array, name: string): Uint8Array {
  return editRecord(zip, name, (out, view, record) => {
    const localHeader = view.getUint32(record + 42, true);
    const start =
      localHeader +
      30 +
      view.getUint16(localHeader + 26, true) +
      view.getUint16(localHeader + 28, true);
    out.fill(0xff, start, start + view.getUint32(record + 20, true));
  });
}

/** Declare one deflated entry a byte longer than its stream produces. */
function overstateSize(zip: Uint8Array, name: string): Uint8Array {
  return editRecord(zip, name, (_out, view, record) => {
    view.setUint32(record + 24, view.getUint32(record + 24, true) + 1, true);
  });
}

/** Rename an entry in both its records; names must be the same length. */
function renameEntry(zip: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('renameEntry needs equal-length names');
  return editRecord(zip, from, (out, view, record) => {
    out.set(enc(to), record + 46);
    out.set(enc(to), view.getUint32(record + 42, true) + 30);
  });
}

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

/** Compressible payloads, so every entry is a real deflate stream. */
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 7);

function mixedBundle(): Uint8Array {
  const deflated = zipSync(
    {
      'manifest.json': enc(MANIFEST),
      'main.ui': enc('<div>hello</div>'),
      'assets/a.png': bytes(4096, 3),
      'assets/b.glb': bytes(8192, 5),
      'nested/dir/': new Uint8Array(0),
      '../escape.bin': bytes(64, 1),
    },
    { level: 6 }
  );
  return deflated;
}

/** Fake bytes of the right length: what a lying extractor would return. */
const wrongBytes = (n: number) => new Uint8Array(n).fill(0x42);

describe('openBundleArchive', () => {
  it('reads exactly what readBundleEntries reads', () => {
    const zip = mixedBundle();
    const eager = readBundleEntries(zip);
    const archive = openBundleArchive(zip);
    expect(archive.names()).toEqual([...eager.keys()]);
    expect(archive.names()).toEqual(['manifest.json', 'main.ui', 'assets/a.png', 'assets/b.glb']);
    const all = archive.readAll();
    expect([...all.keys()]).toEqual([...eager.keys()]);
    for (const [name, content] of eager) expect(all.get(name)).toEqual(content);
    expect(archive.declaredSize('assets/b.glb')).toBe(8192);
    expect(archive.declaredSize('nested/dir/')).toBeUndefined();
  });

  it('drops directory and escaping names at index time, without inflating them', () => {
    const zip = ruinPayload(mixedBundle(), '../escape.bin');
    const archive = openBundleArchive(zip);
    expect(archive.has('../escape.bin')).toBe(false);
    expect(archive.has('nested/dir/')).toBe(false);
    expect(archive.read('../escape.bin')).toBeUndefined();
    expect(() => archive.readAll()).not.toThrow();
    expect([...readBundleEntries(zip).keys()]).toEqual(archive.names());
  });

  describe('rejects at open what the eager reader rejects before extracting', () => {
    it.each([
      ['entry counts disagree', () => setTotalEntries(mixedBundle(), 1), /counts disagree/i],
      [
        'a stored entry declaring two sizes',
        () => {
          const zip = zipSync({ 'a.bin': new Uint8Array(2048).fill(67) }, { level: 0 });
          const out = new Uint8Array(zip);
          const view = new DataView(out.buffer);
          for (let i = 0; i + 4 <= out.byteLength; i++) {
            if (view.getUint32(i, true) === 2048) view.setUint32(i, 4096, true);
          }
          const cd = view.getUint32(findEocd(out) + 16, true);
          view.setUint32(cd + 20, 2048, true);
          return out;
        },
        /two different sizes/i,
      ],
      [
        'two records under one name',
        () =>
          renameEntry(
            zipSync({
              'manifest.json': enc('{"name":"Safe"}'),
              'manifesX.json': enc('{"name":"Evil"}'),
            }),
            'manifesX.json',
            'manifest.json'
          ),
        /share the name/i,
      ],
      ['a truncated archive', () => mixedBundle().subarray(0, 40), /missing end-of-central/i],
    ])('%s', (_label, build, message) => {
      const zip = build();
      let eager: unknown;
      try {
        readBundleEntries(zip);
      } catch (err) {
        eager = err;
      }
      expect(eager).toBeInstanceOf(Error);
      expect(() => openBundleArchive(zip)).toThrow((eager as Error).message);
      expect(() => openBundleArchive(zip)).toThrow(message);
    });

    it('refuses oversize input before looking at it', () => {
      const tooLarge = new Uint8Array(MAX_ZIP_INPUT_BYTES + 1);
      expect(() => openBundleArchive(tooLarge)).toThrow('Bundle too large');
      expect(() => readBundleEntries(tooLarge)).toThrow('Bundle too large');
    });
  });

  describe('rejects on the read that touches a bad entry', () => {
    it('a checksum mismatch, with the eager reader’s message, and remembers it', () => {
      const zip = tamperedBundle('SAFE', 'EVIL');
      let eager: unknown;
      try {
        readBundleEntries(zip);
      } catch (err) {
        eager = err;
      }
      const archive = openBundleArchive(zip);
      expect(dec(archive.read('manifest.json'))).toBe(MANIFEST);
      expect(() => archive.read('main.ui')).toThrow((eager as Error).message);
      expect(() => archive.read('main.ui')).toThrow(/checksum mismatch for main\.ui/);
      expect(archive.isRead('main.ui')).toBe(false);
      expect(archive.heldBytes()).toBe(archive.declaredSize('manifest.json'));
      expect(() => archive.readAll()).toThrow(/checksum mismatch/);
    });

    it('an unreadable stream', () => {
      const zip = ruinPayload(mixedBundle(), 'assets/b.glb');
      expect(() => readBundleEntries(zip)).toThrow(/could not decompress assets\/b\.glb/);
      const archive = openBundleArchive(zip);
      expect(archive.read('assets/a.png')).toHaveLength(4096);
      expect(() => archive.read('assets/b.glb')).toThrow(/could not decompress assets\/b\.glb/);
    });

    it('a size the stream does not produce', () => {
      const zip = overstateSize(mixedBundle(), 'assets/a.png');
      expect(() => readBundleEntries(zip)).toThrow(/size mismatch for assets\/a\.png/);
      const archive = openBundleArchive(zip);
      expect(() => archive.read('assets/a.png')).toThrow(/size mismatch for assets\/a\.png/);
      expect(archive.heldBytes()).toBe(0);
    });
  });

  it('inflates an entry once and charges the budget once', () => {
    const archive = openBundleArchive(mixedBundle());
    inflateSpy.mockClear();
    expect(archive.heldBytes()).toBe(0);
    expect(archive.isRead('assets/a.png')).toBe(false);

    const first = archive.read('assets/a.png');
    expect(first).toHaveLength(4096);
    expect(archive.isRead('assets/a.png')).toBe(true);
    expect(archive.heldBytes()).toBe(4096);
    expect(inflateSpy).toHaveBeenCalledTimes(1);

    expect(archive.read('assets/a.png')).toBe(first);
    expect(archive.heldBytes()).toBe(4096);
    expect(inflateSpy).toHaveBeenCalledTimes(1);

    archive.read('assets/b.glb');
    expect(archive.heldBytes()).toBe(4096 + 8192);
    expect(archive.read('assets/missing.png')).toBeUndefined();
    expect(archive.heldBytes()).toBe(4096 + 8192);

    const total = [...readBundleEntries(mixedBundle()).values()].reduce((n, b) => n + b.length, 0);
    archive.readAll();
    expect(archive.heldBytes()).toBe(total);
  });

  describe('warm', () => {
    it('reads the named entries synchronously in steps when it has no extractor', async () => {
      const archive = openBundleArchive(mixedBundle());
      await archive.warm(['assets/a.png', 'assets/b.glb', 'not/there.png', 'assets/a.png']);
      expect(archive.isRead('assets/a.png')).toBe(true);
      expect(archive.isRead('assets/b.glb')).toBe(true);
      expect(archive.isRead('main.ui')).toBe(false);
      inflateSpy.mockClear();
      expect(archive.read('assets/b.glb')).toHaveLength(8192);
      expect(inflateSpy).not.toHaveBeenCalled();
    });

    it('accepts an extractor’s bytes only after verifying them here', async () => {
      const zip = mixedBundle();
      const expected = readBundleEntries(zip).get('assets/b.glb');
      const archive = openBundleArchive(zip);
      const copy = zip.slice();
      const asked: string[][] = [];
      const extract = vi.fn(async (names: string[]) => {
        asked.push(names);
        return inflateEntries(copy, names);
      });

      archive.read('assets/a.png');
      await archive.warm(['assets/a.png', 'assets/b.glb', 'main.ui'], { extract });
      // Only what was not already held is asked for.
      expect(asked).toEqual([['assets/b.glb', 'main.ui']]);
      expect(archive.isRead('assets/b.glb')).toBe(true);
      expect(archive.heldBytes()).toBe(4096 + 8192 + archive.declaredSize('main.ui')!);

      inflateSpy.mockClear();
      expect(archive.read('assets/b.glb')).toEqual(expected);
      expect(inflateSpy).not.toHaveBeenCalled();
    });

    it('rejects an extractor that returns the wrong bytes and keeps the memo clean', async () => {
      const zip = mixedBundle();
      const archive = openBundleArchive(zip);
      const lying = async (names: string[]) =>
        new Map(names.map((name) => [name, wrongBytes(archive.declaredSize(name)!)]));
      await expect(archive.warm(['assets/b.glb'], { extract: lying })).rejects.toThrow(
        /checksum mismatch for assets\/b\.glb/
      );
      expect(archive.isRead('assets/b.glb')).toBe(false);
      expect(archive.heldBytes()).toBe(0);

      const short = async (names: string[]) =>
        new Map(names.map((name) => [name, wrongBytes(archive.declaredSize(name)! - 1)]));
      await expect(archive.warm(['assets/b.glb'], { extract: short })).rejects.toThrow(
        /size mismatch for assets\/b\.glb/
      );
      expect(archive.isRead('assets/b.glb')).toBe(false);

      // The entry itself is fine: a lying extractor says nothing about it.
      expect(archive.read('assets/b.glb')).toEqual(readBundleEntries(zip).get('assets/b.glb'));
    });

    it('falls back to synchronous reads when the extractor fails or returns less', async () => {
      const archive = openBundleArchive(mixedBundle());
      const failing = vi.fn(async () => {
        throw new Error('worker gone');
      });
      await archive.warm(['assets/a.png', 'assets/b.glb'], { extract: failing });
      expect(failing).toHaveBeenCalledTimes(1);
      expect(archive.isRead('assets/a.png')).toBe(true);
      expect(archive.isRead('assets/b.glb')).toBe(true);

      const zip = mixedBundle();
      const partial = openBundleArchive(zip);
      const half = async (names: string[]) => inflateEntries(zip.slice(), names.slice(0, 1));
      await partial.warm(['assets/a.png', 'assets/b.glb'], { extract: half });
      expect(partial.isRead('assets/a.png')).toBe(true);
      expect(partial.isRead('assets/b.glb')).toBe(true);
    });

    it('surfaces a corrupt entry the extractor hit, with the same message', async () => {
      const zip = ruinPayload(mixedBundle(), 'assets/b.glb');
      const archive = openBundleArchive(zip);
      const copy = zip.slice();
      const extract = async (names: string[]) => inflateEntries(copy, names);
      await expect(archive.warm(['assets/a.png', 'assets/b.glb'], { extract })).rejects.toThrow(
        /could not decompress assets\/b\.glb/
      );
      expect(archive.isRead('assets/a.png')).toBe(true);
      expect(archive.isRead('assets/b.glb')).toBe(false);
    });

    it('asks for about two megabytes at a time', async () => {
      const mb = 1024 * 1024;
      const zip = zipSync(
        {
          'a.bin': new Uint8Array(mb).fill(1),
          'b.bin': new Uint8Array(mb).fill(2),
          'c.bin': new Uint8Array(mb).fill(3),
        },
        { level: 0 }
      );
      const archive = openBundleArchive(zip);
      const asked: string[][] = [];
      const extract = async (names: string[]) => {
        asked.push(names);
        return inflateEntries(zip, names);
      };
      await archive.warm(['a.bin', 'b.bin', 'c.bin'], { extract });
      expect(asked).toEqual([['a.bin', 'b.bin'], ['c.bin']]);
      expect(archive.heldBytes()).toBe(3 * mb);
    });

    it('stops at the next step when aborted', async () => {
      const zip = zipSync(
        {
          'a.bin': new Uint8Array(3 * 1024 * 1024).fill(1),
          'b.bin': new Uint8Array(16).fill(2),
        },
        { level: 0 }
      );
      const archive = openBundleArchive(zip);
      const controller = new AbortController();
      const extract = async (names: string[]) => {
        controller.abort();
        return inflateEntries(zip, names);
      };
      await expect(
        archive.warm(['a.bin', 'b.bin'], { extract, signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(archive.isRead('a.bin')).toBe(false);
      expect(archive.isRead('b.bin')).toBe(false);

      const aborted = new AbortController();
      aborted.abort();
      await expect(archive.warm(['b.bin'], { signal: aborted.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    it('does nothing with what arrives after release', async () => {
      const zip = mixedBundle();
      const archive = openBundleArchive(zip);
      const extract = async (names: string[]) => {
        archive.release();
        return inflateEntries(zip.slice(), names);
      };
      await expect(archive.warm(['assets/a.png'], { extract })).resolves.toBeUndefined();
      expect(archive.heldBytes()).toBe(0);
      expect(archive.released).toBe(true);
    });
  });

  describe('forget and compact', () => {
    it('forget() drops one entry, refunds its budget, and a later read inflates it again', () => {
      const archive = openBundleArchive(mixedBundle());
      const first = archive.read('assets/a.png')!;
      archive.read('assets/b.glb');
      expect(archive.heldBytes()).toBe(4096 + 8192);

      archive.forget('assets/a.png');
      expect(archive.isRead('assets/a.png')).toBe(false);
      expect(archive.isRead('assets/b.glb')).toBe(true);
      expect(archive.heldBytes()).toBe(8192);
      // Again, and a name never held or never in the bundle: nothing to refund.
      archive.forget('assets/a.png');
      archive.forget('main.ui');
      archive.forget('not/there.png');
      expect(archive.heldBytes()).toBe(8192);

      inflateSpy.mockClear();
      const again = archive.read('assets/a.png');
      expect(again).toEqual(first);
      expect(again).not.toBe(first);
      expect(inflateSpy).toHaveBeenCalledTimes(1);
      expect(archive.heldBytes()).toBe(4096 + 8192);
      expect(archive.compacted).toBe(false);
    });

    it('compact() drops the bundle bytes only once every entry has been produced', async () => {
      const zip = mixedBundle();
      const archive = openBundleArchive(zip);
      expect(archive.compact()).toBe(false);
      expect(archive.compacted).toBe(false);

      archive.read('manifest.json');
      archive.read('main.ui');
      archive.read('assets/a.png');
      expect(archive.compact()).toBe(false);
      // Forgetting an entry does not undo its having been produced.
      archive.forget('manifest.json');
      expect(archive.compact()).toBe(false);
      expect(archive.compacted).toBe(false);

      // The read that completes the set compacts by itself; asking again is true.
      archive.read('assets/b.glb');
      expect(archive.compacted).toBe(true);
      expect(archive.compact()).toBe(true);
      expect(archive.released).toBe(false);
      const held = archive.declaredSize('main.ui')! + 4096 + 8192;
      expect(archive.heldBytes()).toBe(held);

      // Held entries answer from the memo; the index still answers; the
      // forgotten one cannot be produced without the bytes, and says so.
      const expected = readBundleEntries(zip).get('assets/b.glb');
      inflateSpy.mockClear();
      expect(dec(archive.read('main.ui'))).toBe('<div>hello</div>');
      expect(archive.read('assets/b.glb')).toEqual(expected);
      expect(inflateSpy).not.toHaveBeenCalled();
      expect(archive.has('manifest.json')).toBe(true);
      expect(archive.declaredSize('manifest.json')).toBe(MANIFEST.length);
      expect(() => archive.read('manifest.json')).toThrow(/compacted: manifest\.json/);
      expect(() => archive.readAll()).toThrow(/compacted/);
      expect(archive.read('not/there.png')).toBeUndefined();
      // Nothing left to warm is not an error.
      await expect(archive.warm(['assets/a.png', 'assets/b.glb'])).resolves.toBeUndefined();
      // A forgotten entry can still be forgotten again, or another dropped.
      archive.forget('main.ui');
      expect(archive.heldBytes()).toBe(4096 + 8192);
    });

    it('counts a corrupt entry as settled: it will never need the bytes either', () => {
      const archive = openBundleArchive(ruinPayload(mixedBundle(), 'assets/b.glb'));
      archive.read('manifest.json');
      archive.read('main.ui');
      archive.read('assets/a.png');
      expect(archive.compacted).toBe(false);
      expect(() => archive.read('assets/b.glb')).toThrow(/could not decompress assets\/b\.glb/);
      expect(archive.compacted).toBe(true);
      expect(() => archive.read('assets/b.glb')).toThrow(/could not decompress assets\/b\.glb/);
      expect(archive.read('assets/a.png')).toHaveLength(4096);
    });

    it('compacts when a warm-up through an extractor lands the last entry', async () => {
      const zip = mixedBundle();
      const archive = openBundleArchive(zip);
      const copy = zip.slice();
      const extract = async (names: string[]) => inflateEntries(copy, names);
      await archive.warm(archive.names(), { extract });
      expect(archive.compacted).toBe(true);
      expect(archive.heldBytes()).toBe(
        [...readBundleEntries(zip).values()].reduce((n, b) => n + b.length, 0)
      );
      expect(archive.read('assets/a.png')).toEqual(readBundleEntries(zip).get('assets/a.png'));
    });

    it('the eager read compacts what it opened, and inflateEntries is unaffected', () => {
      const zip = mixedBundle();
      const archive = openBundleArchive(zip);
      const all = archive.readAll();
      expect(archive.compacted).toBe(true);
      expect([...all.keys()]).toEqual(archive.names());
      // A worker's archive over its own copy answers the same whether or not
      // an earlier request happened to cover every entry.
      const first = inflateEntries(zip, archive.names());
      const second = inflateEntries(zip, ['assets/a.png']);
      expect(second.get('assets/a.png')).toEqual(first.get('assets/a.png'));
    });

    it('release() still works after compact', () => {
      const archive = openBundleArchive(mixedBundle());
      archive.readAll();
      expect(archive.compacted).toBe(true);
      archive.release();
      expect(archive.released).toBe(true);
      expect(archive.compacted).toBe(false);
      expect(archive.heldBytes()).toBe(0);
      expect(archive.isRead('assets/a.png')).toBe(false);
      expect(() => archive.read('assets/a.png')).toThrow(/released/);
      expect(archive.compact()).toBe(false);
      expect(archive.has('assets/a.png')).toBe(true);
    });
  });

  it('release() drops the bytes and the archive; the index still answers', async () => {
    const archive = openBundleArchive(mixedBundle());
    archive.read('assets/a.png');
    archive.release();
    expect(archive.released).toBe(true);
    expect(archive.heldBytes()).toBe(0);
    expect(archive.isRead('assets/a.png')).toBe(false);
    expect(archive.has('assets/a.png')).toBe(true);
    expect(archive.names()).toContain('assets/a.png');
    expect(archive.declaredSize('assets/a.png')).toBe(4096);
    expect(() => archive.read('assets/a.png')).toThrow(/released/);
    expect(archive.read('not/there.png')).toBeUndefined();
    expect(() => archive.readAll()).toThrow(/released/);
    await expect(archive.warm(['assets/a.png'])).rejects.toThrow(/released/);
  });
});

describe('inflateEntries', () => {
  it('returns the named entries as views that own their buffers', () => {
    const zip = mixedBundle();
    const eager = readBundleEntries(zip);
    const produced = inflateEntries(zip, ['assets/b.glb', 'main.ui', 'missing', 'assets/b.glb']);
    expect([...produced.keys()]).toEqual(['assets/b.glb', 'main.ui']);
    for (const [name, view] of produced) {
      expect(view).toEqual(eager.get(name));
      expect(view.byteOffset).toBe(0);
      expect(view.byteLength).toBe(view.buffer.byteLength);
    }
  });

  it('verifies what it produces', () => {
    const zip = tamperedBundle('SAFE', 'EVIL');
    expect(() => inflateEntries(zip, ['main.ui'])).toThrow(/checksum mismatch for main\.ui/);
    expect(() => inflateEntries(setTotalEntries(zip, 0), ['main.ui'])).toThrow(/counts disagree/i);
  });
});
