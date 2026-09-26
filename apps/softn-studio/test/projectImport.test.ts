import { describe, expect, it, vi } from 'vitest';
import { MAX_ZIP_INPUT_BYTES } from '@softn/core';
import { strToU8, zipSync } from 'fflate';
import {
  hasZipSignature,
  normalizeProjectPath,
  readJsonProject,
  readProjectArchive,
  readProjectFile,
  resolveProjectRelativePath,
} from '../src/lib/projectImport';

describe('project import', () => {
  it('rejects an oversized local file before reading or allocating its bytes', async () => {
    const arrayBuffer = vi.fn();
    await expect(readProjectFile({ name: 'large.softn', size: MAX_ZIP_INPUT_BYTES + 1, arrayBuffer })).rejects.toThrow('smaller than 200 MB');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('explains a local file read failure and accepts an available file', async () => {
    await expect(readProjectFile({ name: 'missing.softn', size: 10, arrayBuffer: async () => { throw new Error('NotReadableError'); } })).rejects.toThrow('Check that the file is still available');
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(readProjectFile({ name: 'notes.SOFTN', size: bytes.length, arrayBuffer: async () => bytes.buffer })).resolves.toEqual(bytes);
  });

  it('recognizes normal and empty ZIP records without treating arbitrary data as an archive', () => {
    expect(hasZipSignature(zipSync({ 'hello.txt': strToU8('hello') }))).toBe(true);
    expect(hasZipSignature(zipSync({}))).toBe(true);
    expect(hasZipSignature(strToU8('PK but not a ZIP record'))).toBe(false);
    expect(hasZipSignature(strToU8('plain text'))).toBe(false);
  });

  it('reads text and binary entries through the validated archive reader', () => {
    const archive = zipSync({
      'ui/main.ui': strToU8('<Text>Hello</Text>'),
      'assets/pixel.png': new Uint8Array([137, 80, 78, 71]),
    });

    const entries = readProjectArchive(archive);
    expect(entries).toEqual([
      { path: 'ui/main.ui', content: '<Text>Hello</Text>' },
      { path: 'assets/pixel.png', content: new Uint8Array([137, 80, 78, 71]) },
    ]);
  });

  it('rejects an archive whose entry bytes no longer match its checksum', () => {
    const payload = strToU8('checksum payload');
    const archive = zipSync({ 'data.txt': payload }, { level: 0 });
    const start = archive.findIndex((_byte, index) =>
      payload.every((payloadByte, offset) => archive[index + offset] === payloadByte)
    );
    expect(start).toBeGreaterThan(-1);
    archive[start] ^= 0xff;

    expect(hasZipSignature(archive)).toBe(true);
    expect(() => readProjectArchive(archive)).toThrow();
  });

  it('rejects archive entries whose paths collide canonically', () => {
    const archive = zipSync({
      'UI/Main.ui': strToU8('<Text>First</Text>'),
      'ui/main.ui': strToU8('<Text>Second</Text>'),
    });

    expect(() => readProjectArchive(archive)).toThrow(/colliding project paths/i);
  });

  it('rejects paths that escape or alias the project root', () => {
    expect(normalizeProjectPath('../secret.ui')).toBeNull();
    expect(normalizeProjectPath('/absolute.ui')).toBeNull();
    expect(normalizeProjectPath('C:\\absolute.ui')).toBeNull();
    expect(normalizeProjectPath('ui/./main.ui')).toBeNull();
    expect(normalizeProjectPath('ui//main.ui')).toBeNull();
    expect(normalizeProjectPath('ui\\\\main.ui')).toBeNull();
    expect(normalizeProjectPath('ui\\main.ui')).toBe('ui/main.ui');
  });

  it('resolves relative imports canonically and refuses to traverse above the root', () => {
    expect(resolveProjectRelativePath('ui/pages/home.ui', '../components/card.ui')).toBe(
      'ui/components/card.ui'
    );
    expect(resolveProjectRelativePath('ui/main.ui', '../logic/main.logic')).toBe(
      'logic/main.logic'
    );
    expect(resolveProjectRelativePath('ui/main.ui', 'logic/shared.logic')).toBe(
      'logic/shared.logic'
    );
    expect(resolveProjectRelativePath('ui/main.ui', '../../outside.logic')).toBeNull();
    expect(resolveProjectRelativePath('ui/main.ui', './/components/card.ui')).toBeNull();
  });

  it('keeps only safe string files from JSON projects', () => {
    expect(
      readJsonProject(
        JSON.stringify({
          files: {
            'ui/main.ui': '<Text>Hello</Text>',
            '../outside.ui': '<Text>No</Text>',
            'data.json': { unexpected: true },
          },
        })
      )
    ).toEqual([{ path: 'ui/main.ui', content: '<Text>Hello</Text>' }]);
  });

  it('rejects JSON projects with paths that alias after canonicalization', () => {
    expect(
      readJsonProject(
        JSON.stringify({
          files: {
            'ui/main.ui': '<Text>First</Text>',
            'ui\\main.ui': '<Text>Second</Text>',
          },
        })
      )
    ).toEqual([]);

    expect(
      readJsonProject(
        JSON.stringify({
          files: {
            'UI/Main.ui': '<Text>First</Text>',
            'ui/main.ui': '<Text>Second</Text>',
          },
        })
      )
    ).toEqual([]);
  });
});

/**
 * Text or bytes is core's decision. Studio's own extension list had no `.py`,
 * so a Python app imported with its logic as bytes: not shown to the model,
 * not composable in the preview, not readable by the validator.
 */
describe('which imported entries are text', () => {
  it('decodes Python logic as text and keeps images and fonts as bytes, as classifyAsset says', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const font = new Uint8Array([0, 1, 0, 0]);
    // Core carries SVG as bytes, but Studio decodes it so the model can edit
    // an icon as it always could.
    const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const archive = zipSync({
      'assets/logo.svg': svg,
      'logic/main.py': strToU8('count = 0\n'),
      'shaders/glow.wgsl': strToU8('@fragment fn main() {}'),
      'models/cube.gltf': strToU8('{"asset":{"version":"2.0"}}'),
      'assets/pixel.png': png,
      'assets/face.woff2': font,
    });

    const entries = new Map(readProjectArchive(archive).map((entry) => [entry.path, entry.content]));
    expect(entries.get('logic/main.py')).toBe('count = 0\n');
    expect(entries.get('shaders/glow.wgsl')).toBe('@fragment fn main() {}');
    expect(entries.get('models/cube.gltf')).toBe('{"asset":{"version":"2.0"}}');
    expect(entries.get('assets/pixel.png')).toEqual(png);
    expect(entries.get('assets/face.woff2')).toEqual(font);
    expect(entries.get('assets/logo.svg')).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  it("decodes a private backend's migrations as text, so its agent can read the schema and write the next one", () => {
    const archive = zipSync({
      'server/main.logic': strToU8('function listItems(req) { return {status: 200, body: {}}; }'),
      'server/migrations/001.sql': strToU8('CREATE TABLE items(id INTEGER PRIMARY KEY);'),
    });
    const entries = new Map(readProjectArchive(archive).map((entry) => [entry.path, entry.content]));
    expect(entries.get('server/migrations/001.sql')).toBe('CREATE TABLE items(id INTEGER PRIMARY KEY);');
    expect(entries.get('server/main.logic')).toContain('function listItems');
  });

  it('keeps decoding the source formats Studio always read as text, which core has no entry for', () => {
    const archive = zipSync({
      'src/helper.ts': strToU8('export const a = 1;\n'),
      'config/app.yaml': strToU8('name: app\n'),
      'config/app.toml': strToU8('name = "app"\n'),
    });
    const entries = new Map(readProjectArchive(archive).map((entry) => [entry.path, entry.content]));
    expect(entries.get('src/helper.ts')).toBe('export const a = 1;\n');
    expect(entries.get('config/app.yaml')).toBe('name: app\n');
    expect(entries.get('config/app.toml')).toBe('name = "app"\n');
  });
});
