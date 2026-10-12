/**
 * The inspector says what the directory will refuse, before the upload. These
 * are the refusals it did not know about, or only reached after unpacking
 * everything: apps/softn-api/lib/bundle.php is the other side of each.
 */
import { describe, it, expect } from 'vitest';
import { inspectBundle, inspectEntries } from '../src/inspect';
import { craftZip, enc } from './craft';

const MANIFEST = enc(JSON.stringify({ name: 'Limits', version: '1.0.0', description: 'd', main: 'main.ui', icon: 'icon.png' }));
const base = [
  { name: 'manifest.json', data: MANIFEST },
  { name: 'main.ui', data: enc('<div/>') },
  { name: 'icon.png', data: new Uint8Array(8) },
  { name: 'permission.json', data: enc('{"permissions":{}}') },
];
const errors = (report: { level: string; text: string }[]) => report.filter((l) => l.level === 'error').map((l) => l.text);

describe('inspectBundle and the directory’s limits', () => {
  it('has nothing to say about a bundle inside them', () => {
    expect(errors(inspectBundle(craftZip(base).bytes).report)).toEqual([]);
  });

  it('reports a bundle that declares more than 128 MB without unpacking it', () => {
    // Three entries of 50 MB each by their own declaration, over streams that
    // do not inflate. Reading them first, as the inspector did, either spends
    // the memory before the limit is looked at or, here, fails on the first
    // stream and calls the file "not a .softn bundle".
    const unreadable = new Uint8Array(64).fill(0xff);
    const big = (name: string) => ({ name, method: 8, payload: unreadable, uncompressedSize: 50 * 1024 * 1024, crc: 0 });
    const inspection = inspectBundle(craftZip([...base, big('a.bin'), big('b.bin'), big('c.bin')]).bytes);
    expect(inspection.problem).toBe('The bundle unpacks to 150.0 MB; the directory takes at most 128 MB.');
    expect(inspection.files).toBe(7);
  });

  it('counts folders towards the 4000 entries, as the directory does', () => {
    const files = Array.from({ length: 3995 }, (_, i) => ({ name: `assets/f${i}.txt` }));
    const zip = craftZip([...base, ...files, { name: 'assets/' }, { name: 'empty/' }]).bytes;
    const inspection = inspectBundle(zip);
    expect(inspection.files).toBe(3999);
    expect(inspection.problem).toBe('The bundle has 4001 entries, folders included; the directory takes at most 4000.');
  });

  it('reports a path written with backslashes, which the reader accepts and the directory refuses', () => {
    // What Compress-Archive wrote on Windows PowerShell 5.1. The reader turns
    // the backslashes into slashes before anyone sees the name, so the check
    // for them in `inspectEntries` never saw one in an archive.
    const zip = craftZip([...base, { name: 'assets\\logo.png', data: new Uint8Array(4) }]).bytes;
    const inspection = inspectBundle(zip);
    expect(inspection.files).toBe(5);
    expect(inspection.problem).toBe('The bundle has a file whose path is written with backslashes: assets\\logo.png. The directory refuses those; zip the bundle with forward slashes.');
  });

  it('reports a folder entry that climbs out of the bundle', () => {
    const inspection = inspectBundle(craftZip([...base, { name: '../outside/' }]).bytes);
    expect(inspection.problem).toBe('The bundle has a file with an unsafe path: ../outside/');
  });
});

describe('inspectEntries and the sizes the directory reads whole', () => {
  const files = () => new Map(base.map((e) => [e.name, e.data]));

  it('refuses a manifest.json over 256 KB', () => {
    const padded = JSON.stringify({ name: 'Limits', version: '1.0.0', description: 'd', main: 'main.ui', icon: 'icon.png', pad: 'x'.repeat(256 * 1024) });
    const inspection = inspectEntries(files().set('manifest.json', enc(padded)));
    expect(errors(inspection.report)).toEqual(['The manifest.json is larger than 256 KB; the directory will refuse the bundle.']);
    expect(inspection.name).toBe('Limits');
  });

  it('refuses a manifest.json or permission.json that starts with a byte order mark', () => {
    // Notepad's "UTF-8 with BOM". The runtime's decoder drops the mark and
    // reads the file; PHP's json_decode does not, and the directory answers
    // "not valid JSON" for a manifest the author can see nothing wrong with.
    const bom = (bytes: Uint8Array) => Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]);
    const withBom = files();
    withBom.set('manifest.json', bom(MANIFEST));
    withBom.set('permission.json', bom(enc('{"permissions":{"net":{"enabled":true}}}')));
    const inspection = inspectEntries(withBom);
    expect(errors(inspection.report)).toEqual([
      'The manifest.json starts with a byte order mark, which the directory reads as invalid JSON. Save it as UTF-8 without one.',
      'The permission.json starts with a byte order mark, which the directory reads as invalid JSON. Save it as UTF-8 without one.',
    ]);
    // The rest is still read, as the runtime reads it.
    expect(inspection.name).toBe('Limits');
    expect(inspection.capabilities).toEqual(['net']);
  });

  it('refuses a permission.json over 64 KB', () => {
    const padded = JSON.stringify({ permissions: {}, note: 'x'.repeat(64 * 1024) });
    const inspection = inspectEntries(files().set('permission.json', enc(padded)));
    expect(errors(inspection.report)).toEqual(['The permission.json is larger than 64 KB; the directory will refuse the bundle.']);
  });
});
