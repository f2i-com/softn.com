import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  normalizeProjectPath,
  readJsonProject,
  readProjectArchive,
} from '../src/lib/projectImport';

describe('project import', () => {
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

  it('rejects paths that escape or alias the project root', () => {
    expect(normalizeProjectPath('../secret.ui')).toBeNull();
    expect(normalizeProjectPath('/absolute.ui')).toBeNull();
    expect(normalizeProjectPath('C:\\absolute.ui')).toBeNull();
    expect(normalizeProjectPath('ui/./main.ui')).toBeNull();
    expect(normalizeProjectPath('ui\\main.ui')).toBe('ui/main.ui');
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
});
