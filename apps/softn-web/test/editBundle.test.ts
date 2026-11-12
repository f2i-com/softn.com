/**
 * The bundle the editor hands back (src/edit/bundle.ts): the app's own
 * pictures and files byte for byte, its text as edited, in an archive the
 * runtime and any other reader of a .softn opens.
 */

import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { openBundleArchive, readManifest } from '@softn/core';
import { readZip } from '@softn/runtime-shell/bundleProcessor';
import { bundleWith, zipOf } from '../src/edit/bundle';

const MANIFEST = JSON.stringify({ name: 'Bundle', version: '1.0.0', main: 'ui/main.ui' });
const PICTURE = Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 0xff);
const LONG = '<div>\n' + '  <p class="line">The same words, many times over.</p>\n'.repeat(400) + '</div>\n';

const original = zipSync({
  'manifest.json': strToU8(MANIFEST),
  'ui/main.ui': strToU8('<div><h1>Old</h1></div>\n'),
  'ui/gone.ui': strToU8('<p>gone</p>\n'),
  'styles/app.css': strToU8('.a { color: red; }\n'),
  'assets/photo.png': PICTURE,
});

describe('a bundle with its text as edited', () => {
  it('keeps the pictures as they were, writes the text given, and leaves out text that was taken away', async () => {
    const text = new Map([
      ['manifest.json', MANIFEST],
      ['ui/main.ui', LONG],
      ['styles/app.css', '.a { color: teal; }\n'],
      ['ui/añadido.ui', '<p>añadido ✓</p>\n'],
    ]);
    const edited = await bundleWith(original, text);
    // Any reader of an archive opens it.
    const entries = unzipSync(edited);
    expect(Object.keys(entries).sort()).toEqual(['assets/photo.png', 'manifest.json', 'styles/app.css', 'ui/añadido.ui', 'ui/main.ui']);
    expect(Array.from(entries['assets/photo.png'])).toEqual(Array.from(PICTURE));
    expect(strFromU8(entries['ui/main.ui'])).toBe(LONG);
    expect(strFromU8(entries['ui/añadido.ui'])).toBe('<p>añadido ✓</p>\n');
    expect(strFromU8(entries['styles/app.css'])).toBe('.a { color: teal; }\n');
    // And so does the runtime, by its own reader and its own checks.
    const read = readZip(edited);
    expect(readManifest(read.textFiles).name).toBe('Bundle');
    expect(read.textFiles.get('ui/main.ui')).toBe(LONG);
    expect(read.textFiles.has('ui/gone.ui')).toBe(false);
    expect(Array.from(read.binaryFiles.get('assets/photo.png')!)).toEqual(Array.from(PICTURE));
    // Packed where the browser packs: the page of repeated lines is far smaller than it reads.
    if (typeof CompressionStream !== 'undefined') expect(edited.length).toBeLessThan(LONG.length / 4 + PICTURE.length + 2000);
  });

  it('never writes text over a picture, whatever name it is given', async () => {
    const edited = await bundleWith(original, new Map([['manifest.json', MANIFEST], ['ui/main.ui', '<p>x</p>'], ['assets/photo.png', 'not a picture']]));
    expect(Array.from(unzipSync(edited)['assets/photo.png'])).toEqual(Array.from(PICTURE));
  });

  it('makes the same bytes from the same files', async () => {
    const entries: Array<[string, Uint8Array]> = [
      ['a.txt', strToU8('one '.repeat(100))],
      ['b/c.txt', strToU8('')],
      ['d.bin', PICTURE],
    ];
    const first = await zipOf(entries);
    const second = await zipOf(entries);
    expect(Array.from(second)).toEqual(Array.from(first));
    const read = unzipSync(first);
    expect(strFromU8(read['a.txt'])).toBe('one '.repeat(100));
    expect(read['b/c.txt'].length).toBe(0);
    expect(Array.from(read['d.bin'])).toEqual(Array.from(PICTURE));
  });

  it('writes an archive other readers open at its edges: empty and tiny files, a large one, one that does not pack, many, and names beyond ASCII', async () => {
    const big = 'The same line of a page, many times over.\n'.repeat(120_000); // about 5 MB of text
    const entries: Array<[string, Uint8Array]> = [
      ['manifest.json', strToU8(JSON.stringify({ name: 'Edge', version: '1.0.0', main: 'ui/main.ui' }))],
      ['ui/main.ui', strToU8('<div><h1>Edge</h1></div>\n')],
      ['empty.txt', new Uint8Array(0)],
      ['sixty-three.txt', strToU8('a'.repeat(63))],
      ['sixty-four.txt', strToU8('a'.repeat(64))],
      ['sixty-five.txt', strToU8('a'.repeat(65))],
      ['ui/añadido ✓ 日本語.ui', strToU8('<p>añadido ✓</p>\n')],
      ['data/big.txt', strToU8(big)],
      ['assets/noise.bin', noise(300_000)],
      ['assets/with space/a b.png', noise(1000, 3)],
    ];
    for (let i = 0; i < 1500; i++) entries.push([`many/file-${i}.txt`, strToU8(`file ${i}\n`.repeat(i % 40))]);
    const bytes = await zipOf(entries);
    const same = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i]);
    // The runtime's own reader, every entry verified against its checksum and against what was written.
    const read = openBundleArchive(bytes).readAll();
    expect(read.size).toBe(entries.length);
    expect(entries.filter(([name, content]) => !same(read.get(name), content)).map(([name]) => name)).toEqual([]);
    // And another reader of the format.
    const again = unzipSync(bytes);
    expect(Object.keys(again).length).toBe(entries.length);
    expect(entries.filter(([name, content]) => !same(again[name], content)).map(([name]) => name)).toEqual([]);
  }, 120_000);

  it('writes a text file nobody changed from the bundle’s own bytes: a byte order mark stays, and text that is not UTF-8 is not rewritten', async () => {
    // A bundle as an ordinary tool writes it: a folder as an entry, a text file with a byte order mark and one that is not UTF-8.
    const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...strToU8('id,name\n1,Ada\n')]);
    const tool = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Other', version: '1.0.0', main: 'ui/main.ui' })),
      'ui/': new Uint8Array(0),
      'ui/main.ui': strToU8('<div><h1>Other</h1></div>\n'),
      'data/latin1.txt': latin1,
      'data/bom.json': bom,
      LICENSE: strToU8('MIT\n'),
      'assets/logo.png': noise(500, 9),
    });
    const before = openBundleArchive(tool).readAll();
    // The text as the runtime reads it, which is what the editor holds.
    const text = new Map<string, string>();
    for (const [name, content] of before) if (!/\.png$/.test(name) && name !== 'LICENSE') text.set(name, new TextDecoder().decode(content));
    const report = (after: Map<string, Uint8Array>): Record<string, string> => {
      const said: Record<string, string> = {};
      for (const [name, content] of before) {
        const now = after.get(name);
        said[name] = now === undefined ? 'DROPPED' : now.length === content.length && now.every((byte, i) => byte === content[i]) ? 'same bytes' : `CHANGED (${Array.from(content).slice(0, 8)} -> ${Array.from(now).slice(0, 8)})`;
      }
      return said;
    };
    const copy = await bundleWith(tool, text);
    expect(report(openBundleArchive(copy).readAll())).toEqual(Object.fromEntries([...before.keys()].map((name) => [name, 'same bytes'])));

    // One page changed: that page is written as typed, and every other file is still the bytes it was.
    const edited = await bundleWith(tool, new Map(text).set('ui/main.ui', '<div><h1>Mine</h1></div>\n'));
    const after = openBundleArchive(edited).readAll();
    expect(new TextDecoder().decode(after.get('ui/main.ui'))).toBe('<div><h1>Mine</h1></div>\n');
    expect(report(after)).toEqual(Object.fromEntries([...before.keys()].map((name) => [name, name === 'ui/main.ui' ? expect.stringMatching(/^CHANGED/) : 'same bytes'])));
  });

  it('says which file is damaged, of a bundle with a file that cannot be read, and writes nothing', async () => {
    const packed = 'A line of a file nothing in the app reads.\n'.repeat(2000);
    const bundle = zipSync({
      'manifest.json': strToU8(MANIFEST),
      'ui/main.ui': strToU8('<div><h1>Old</h1></div>\n'),
      'assets/unread.dat': strToU8(packed),
      'data/unread.txt': strToU8(packed),
    });
    const damage = (bytes: Uint8Array, path: string): Uint8Array => {
      const out = bytes.slice();
      const name = strToU8(path);
      let header = -1;
      for (let at = 0; at + 30 + name.length < out.length && header < 0; at++) {
        if (out[at] === 0x50 && out[at + 1] === 0x4b && out[at + 2] === 3 && out[at + 3] === 4 && name.every((byte, i) => out[at + 30 + i] === byte)) header = at;
      }
      expect(header, path).toBeGreaterThanOrEqual(0);
      const start = header + 30 + name.length + (out[header + 28] | (out[header + 29] << 8));
      for (let i = 20; i < 60; i++) out[start + i] ^= 0xff;
      return out;
    };
    const text = new Map([['manifest.json', MANIFEST], ['ui/main.ui', '<div><h1>New</h1></div>\n'], ['data/unread.txt', packed]]);
    // A picture or another file carried as it is.
    await expect(bundleWith(damage(bundle, 'assets/unread.dat'), text)).rejects.toThrow('“assets/unread.dat” in this app is damaged and cannot be read, so the app cannot be copied or written as a file.');
    // A text file, whether the editor holds its text or could never read it: not quietly left out as if it had been removed.
    await expect(bundleWith(damage(bundle, 'data/unread.txt'), text)).rejects.toThrow('“data/unread.txt” in this app is damaged and cannot be read');
    const without = new Map(text);
    without.delete('data/unread.txt');
    await expect(bundleWith(damage(bundle, 'data/unread.txt'), without)).rejects.toThrow('“data/unread.txt” in this app is damaged and cannot be read');
    // Whole, the same bundle is written.
    expect(unzipSync(await bundleWith(bundle, text))['assets/unread.dat'].length).toBe(packed.length);
  });
});

/** Bytes that do not pack: the same each time, from a seed. */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}
