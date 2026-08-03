import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  hasZipSignature,
  normalizeProjectPath,
  readJsonProject,
  readProjectArchive,
  resolveProjectRelativePath,
} from '../src/lib/projectImport';

describe('project import', () => {
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
