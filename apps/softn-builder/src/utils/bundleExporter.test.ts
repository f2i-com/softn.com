/**
 * Opening a bundle in the builder.
 *
 * `parseBundle` used a bare `unzipSync`: no size limits, no entry cap, no CRC
 * check, no path filtering. Opening a hostile .softn in the builder bypassed
 * every defence softn-web and softn-loader had — including the check that
 * catches an archive understating a file's size, which hands one reader a
 * truncated file while every other reader sees the whole one.
 */

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { exportMultiFileBundle, parseBundle } from './bundleExporter';

function bundle(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  return zipSync(entries, { level: 6 });
}

const MANIFEST = JSON.stringify({
  name: 'T',
  version: '1.0.0',
  description: '',
  main: 'ui/main.ui',
  files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] },
  config: { window: { title: 'T', width: 1, height: 1 }, theme: { mode: 'light' } },
});

describe('parseBundle', () => {
  it('reads an ordinary bundle', () => {
    const { manifest, files } = parseBundle(
      bundle({ 'manifest.json': MANIFEST, 'ui/main.ui': '<Stack></Stack>' })
    );
    expect(manifest.name).toBe('T');
    expect(files.has('ui/main.ui')).toBe(true);
  });

  it('rejects an archive whose checksum does not match its bytes', () => {
    // Stored rather than deflated, so the content sits in the file verbatim and
    // a single byte can be flipped without disturbing any header. The declared
    // CRC in the central directory is left untouched — which is exactly the
    // shape of the attack: an archive that lies self-consistently about its
    // own contents, so only the checksum catches it.
    const entries: Record<string, Uint8Array> = {
      'manifest.json': strToU8(MANIFEST),
      'ui/main.ui': strToU8('<Stack>MARKERMARKER</Stack>'),
    };
    const data = zipSync(entries, { level: 0 });

    const marker = strToU8('MARKERMARKER');
    const at = data.findIndex((_b, i) => marker.every((m, j) => data[i + j] === m));
    expect(at, 'the stored content should be findable').toBeGreaterThan(0);

    const tampered = new Uint8Array(data);
    tampered[at] = tampered[at] ^ 0xff;

    expect(() => parseBundle(tampered)).toThrow(/checksum|Corrupt/i);
  });

  it('drops entries that try to escape the bundle root', () => {
    const { files } = parseBundle(
      bundle({
        'manifest.json': MANIFEST,
        'ui/main.ui': '<Stack></Stack>',
        '../escape.txt': 'nope',
      })
    );
    expect([...files.keys()].some((k) => k.includes('..'))).toBe(false);
  });

  it('reads the manifest at the root and nowhere else, as the runtime does', () => {
    for (const path of ['assets/manifest.json', 'notmanifest.json', 'app/manifest.json']) {
      expect(() => parseBundle(bundle({ [path]: MANIFEST, 'ui/main.ui': '<Stack></Stack>' })), path).toThrow(/missing manifest\.json/);
    }
  });
});

describe('an export and a file named __proto__', () => {
  const exportWith = (bundlePath: string) =>
    exportMultiFileBundle({
      name: 'T',
      version: '1.0.0',
      description: '',
      themeMode: 'light',
      uiFiles: new Map([['a', { id: 'a', path: 'ui/main.ui', elements: new Map(), rootId: 'root', imports: [], originalSource: '<App></App>' }]]),
      logicFiles: new Map(),
      collections: [],
      assets: [{ name: 'x', type: 'application/octet-stream', data: new Uint8Array([7, 8, 9]), bundlePath }],
    });

  it('is refused at the root, by name, rather than archived as one entry per byte', async () => {
    await expect(exportWith('__proto__')).rejects.toThrow(/may not be named "__proto__"/);
  });

  it('is also refused inside a folder, while ordinary names archive cleanly', async () => {
    await expect(exportWith('assets/__proto__')).rejects.toThrow(/cannot name a file in a bundle/);
    const { files } = parseBundle(await exportWith('assets/proto.bin'));
    expect(files.get('assets/proto.bin')).toEqual(new Uint8Array([7, 8, 9]));
    expect([...files.keys()].sort()).toEqual(['assets/proto.bin', 'manifest.json', 'ui/main.ui']);
  });

  // Every reader drops a name with two dots in a row: the export wrote assets/version..png, and
  // the bundle opened without it. The dialog's pre-flight builds through here, so Export is held
  // back with the reason.
  it('refuses a file whose name no reader opens, naming it, rather than writing it', async () => {
    await expect(exportWith('assets/version..png')).rejects.toThrow(/"assets\/version\.\.png" has two dots in a row/);
    const { files } = parseBundle(await exportWith('assets/version.png'));
    expect(files.get('assets/version.png')).toEqual(new Uint8Array([7, 8, 9]));
  });
});

/** Each entry's compression method, from the archive's central directory. */
function methodsOf(data: Uint8Array): Map<string, number> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const methods = new Map<string, number>();
  let at = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0; n--) {
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength));
    methods.set(name, view.getUint16(at + 10, true));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return methods;
}

describe('the archive an export writes', () => {
  // Noise, as a compressed picture is to deflate.
  const picture = new Uint8Array(200_000);
  for (let at = 0; at < picture.length; at += 65_536) crypto.getRandomValues(picture.subarray(at, at + 65_536));
  const logic = 'export function add(a, b) {\n  return a + b;\n}\n'.repeat(400);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1" />'.repeat(300)}</svg>`;

  const exported = () =>
    exportMultiFileBundle({
      name: 'Pictures',
      version: '1.0.0',
      description: '',
      themeMode: 'light',
      uiFiles: new Map([['a', { id: 'a', path: 'ui/main.ui', elements: new Map(), rootId: 'root', imports: [], originalSource: '<logic src="../logic/main.logic" />\n<App></App>' }]]),
      logicFiles: new Map([['l', { id: 'l', path: 'logic/main.logic', content: logic }]]),
      collections: [],
      assets: [
        { name: 'photo.webp', type: 'image/webp', data: picture, bundlePath: 'assets/photo.webp' },
        { name: 'icon.png', type: 'image/png', data: picture.slice(0, 5_000), bundlePath: 'assets/icon.png' },
        { name: 'logo.svg', type: 'image/svg+xml', data: strToU8(svg), bundlePath: 'assets/logo.svg' },
      ],
    });

  it('stores what is compressed already and deflates the rest, and the reader gets back every byte', async () => {
    const data = await exported();
    const methods = methodsOf(data);
    expect(methods.get('assets/photo.webp')).toBe(0);
    for (const path of ['logic/main.logic', 'assets/logo.svg', 'assets/icon.png', 'ui/main.ui', 'manifest.json']) expect(methods.get(path), path).toBe(8);

    // The reader every runtime opens a bundle with (core's bundle/zip.ts).
    const { files } = parseBundle(data);
    expect(files.get('assets/photo.webp')).toEqual(picture);
    expect(files.get('assets/icon.png')).toEqual(picture.slice(0, 5_000));
    expect(new TextDecoder().decode(files.get('logic/main.logic'))).toBe(logic);
    expect(new TextDecoder().decode(files.get('assets/logo.svg'))).toBe(svg);
    // The text is deflated, and the pictures are not grown.
    expect(data.length).toBeLessThan(picture.length + 5_000 + 6_000);
  });
});

describe('opening a bundle with a file the reader leaves out', () => {
  it('says which, so a save does not lose it unremarked', () => {
    const { files, dropped } = parseBundle(bundle({ 'manifest.json': MANIFEST, 'ui/main.ui': '<Stack></Stack>', 'assets/version..png': 'x' }));
    expect(files.has('assets/version..png')).toBe(false);
    expect(dropped).toEqual(['assets/version..png']);
  });
});
