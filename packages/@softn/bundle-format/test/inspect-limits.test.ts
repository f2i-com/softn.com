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

  it('reports an entry whose name is not UTF-8 text, which the directory refuses', () => {
    // A name in a legacy code page, as an old Windows zip tool writes it: the
    // runtime reads it with replacement characters, PHP's ZipArchive as code
    // page 437, so the two would list different files.
    const latin1 = Uint8Array.from([...enc('assets/caf'), 0xe9, ...enc('.png')]);
    const inspection = inspectBundle(craftZip([...base, { name: latin1, data: new Uint8Array(4) }]).bytes);
    expect(inspection.problem).toBe('The bundle has an entry whose name is not UTF-8 text. Zip it with a tool that writes UTF-8 names.');
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

  it('reads a manifest.json or permission.json that starts with a byte order mark, as the runtime and the directory do', () => {
    // Notepad's "UTF-8 with BOM". The runtime's decoder drops the mark, and
    // the directory now reads past it too, so it is not a problem to report.
    const bom = (bytes: Uint8Array) => Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]);
    const withBom = files();
    withBom.set('manifest.json', bom(MANIFEST));
    withBom.set('permission.json', bom(enc('{"permissions":{"net":{"enabled":true}}}')));
    const inspection = inspectEntries(withBom);
    expect(errors(inspection.report)).toEqual([]);
    expect(inspection.name).toBe('Limits');
    expect(inspection.capabilities).toEqual(['net']);
  });

  it('reads what an older manifest asks for when there is no permission.json, as the runtime grants it', () => {
    // `permissions: { network, filesystem }` in the manifest is what the
    // runtime grants a bundle that ships no permission.json (extractPermissions
    // in core); the directory lists it the same way. Reporting "declares
    // nothing" under such an app was wrong about what it would get.
    const legacy = files();
    legacy.delete('permission.json');
    legacy.set('manifest.json', enc(JSON.stringify({
      name: 'Limits', version: '1.0.0', description: 'd', main: 'main.ui', icon: 'icon.png',
      permissions: { network: true, filesystem: 1, camera: true },
    })));
    const inspection = inspectEntries(legacy);
    expect(inspection.capabilities).toEqual(['net', 'files']);
    const notes = inspection.report.map((l) => l.text);
    expect(notes.some((t) => t.startsWith('No permission.json: the app declares nothing'))).toBe(false);
    expect(notes).toContain('No permission.json: the manifest\'s older "permissions" block asks for net, files, which the runtime grants. Move them to a permission.json to declare them the current way.');

    const nothing = files();
    nothing.delete('permission.json');
    nothing.set('manifest.json', enc(JSON.stringify({
      name: 'Limits', version: '1.0.0', description: 'd', main: 'main.ui', icon: 'icon.png',
      permissions: { network: false, filesystem: '' },
    })));
    expect(inspectEntries(nothing).capabilities).toEqual([]);
  });

  it('refuses a permission.json over 64 KB', () => {
    const padded = JSON.stringify({ permissions: {}, note: 'x'.repeat(64 * 1024) });
    const inspection = inspectEntries(files().set('permission.json', enc(padded)));
    expect(errors(inspection.report)).toEqual(['The permission.json is larger than 64 KB; the directory will refuse the bundle.']);
  });
});
