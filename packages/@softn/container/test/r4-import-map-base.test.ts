/**
 * An import map's relative targets are resolved against the page that holds the map, as a
 * browser resolves them, not against the module that imports the mapped name.
 */
import { describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { resolveModuleSpecifier } from '../src/esm-linker';

const MAP =
  '<script type="importmap">{"imports":{"lib":"./vendor/lib.js","pkg/":"./vendor/pkg/","here/":"./",' +
  '"cdn":"https://esm.sh/x","pct":"./vendor/100%25.js"}}</script>';

describe('an import map in the entry page', () => {
  it('maps a name to the page’s file for a module in a folder', async () => {
    const archive = await ContainerArchive.open({
      'index.html': `<!doctype html><html><head>${MAP}</head><body><script type="module" src="src/main.js"></script></body></html>`,
      'src/main.js': "import lib from 'lib'; import x from 'pkg/x.js';",
      'vendor/lib.js': 'export default 1;',
      'vendor/pkg/x.js': 'export default 2;',
      'vendor/100%.js': 'export default 3;',
    });
    const map = archive.manifest.importMap ?? {};
    const files = new Set(['src/main.js', 'vendor/lib.js', 'vendor/pkg/x.js', 'vendor/100%.js']);
    const has = (path: string) => files.has(path);
    expect(resolveModuleSpecifier('lib', 'src/main.js', map, has)).toMatchObject({ kind: 'vfs', path: 'vendor/lib.js' });
    expect(resolveModuleSpecifier('pkg/x.js', 'src/main.js', map, has)).toMatchObject({ kind: 'vfs', path: 'vendor/pkg/x.js' });
    expect(resolveModuleSpecifier('here/vendor/lib.js', 'src/deep/a.js', map, has)).toMatchObject({ kind: 'vfs', path: 'vendor/lib.js' });
    expect(resolveModuleSpecifier('pct', 'src/main.js', map, has)).toMatchObject({ kind: 'vfs', path: 'vendor/100%.js' });
    expect(map.cdn).toBe('https://esm.sh/x');
  });

  it('resolves against the page inside the frontend root', async () => {
    const archive = await ContainerArchive.open({
      'manifest.json': JSON.stringify({ engine: 2, main: './app/pages/index.html', frontendRoot: './app/' }),
      'app/pages/index.html': `<!doctype html><html><head>${MAP}</head><body></body></html>`,
      'app/pages/vendor/lib.js': 'export default 1;',
    });
    const map = archive.manifest.importMap ?? {};
    const has = (path: string) => path === 'pages/vendor/lib.js';
    expect(resolveModuleSpecifier('lib', 'pages/src/main.js', map, has)).toMatchObject({ kind: 'vfs', path: 'pages/vendor/lib.js' });
  });
});
