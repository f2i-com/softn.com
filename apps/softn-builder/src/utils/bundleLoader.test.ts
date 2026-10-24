/**
 * The Builder opens what core opens (audit-apps H1).
 *
 * The runtime reads the entry by `main`, whether or not `files.ui` lists it,
 * so a bundle that names it only there is a valid bundle everywhere else.
 * The Builder used to refuse it; it loads the entry now, says so, and the
 * export lists it.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { loadBundle } from './bundleLoader';

const manifest = (files: unknown) =>
  strToU8(JSON.stringify({ name: 'Unlisted', version: '1.0.0', main: 'ui/main.ui', files }));

// The reader leaves out a file whose name has two dots in a row (an older export wrote them), and
// the project opened without it with nothing said: saved again, it was gone for good.
describe('a file the reader leaves out', () => {
  it('opens the rest, and says which file is not there and why', async () => {
    const bundle = zipSync({
      'manifest.json': manifest({ ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] }),
      'ui/main.ui': strToU8('<App><Text>entry</Text></App>\n'),
      'assets/version..png': new Uint8Array([1, 2, 3]),
    });
    const loaded = await loadBundle(bundle);
    expect(loaded.warnings).toContain('assets/version..png was left out: SoftN takes ".." anywhere in a path, a leading "/" or a drive letter for a way out of the bundle, and opens no such file. The export will not have it.');
  });

  it('says why a file the manifest lists is not there, when the reader left it out', async () => {
    const bundle = zipSync({
      'manifest.json': manifest({ ui: ['ui/main.ui'], logic: [], xdb: [], assets: ['assets/version..png'] }),
      'ui/main.ui': strToU8('<App><Text>entry</Text></App>\n'),
      'assets/version..png': new Uint8Array([1, 2, 3]),
    });
    await expect(loadBundle(bundle)).rejects.toThrow(/lists "assets\/version\.\.png", which SoftN leaves out wherever it opens a bundle/);
  });
});

describe('an entry file the manifest names but does not list', () => {
  it('opens, with the entry loaded as the main UI file', async () => {
    const bundle = zipSync({
      'manifest.json': manifest({ ui: ['ui/Other.ui'], logic: [], xdb: [], assets: [] }),
      'ui/main.ui': strToU8('<App><Text>entry</Text></App>\n'),
      'ui/Other.ui': strToU8('<Stack><Text>other</Text></Stack>\n'),
    });
    const loaded = await loadBundle(bundle);
    const paths = [...loaded.uiFiles.values()].map((f) => f.path).sort();
    expect(paths).toEqual(['ui/Other.ui', 'ui/main.ui']);
    expect(loaded.uiFiles.get(loaded.mainFileId!)?.path).toBe('ui/main.ui');
    expect(loaded.warnings.join('\n')).toMatch(/not listed in manifest\.files\.ui/);
  });

  it('opens a manifest with no files at all', async () => {
    const bundle = zipSync({
      'manifest.json': manifest(undefined),
      'ui/main.ui': strToU8('<App><Text>entry</Text></App>\n'),
    });
    const loaded = await loadBundle(bundle);
    expect([...loaded.uiFiles.values()].map((f) => f.path)).toEqual(['ui/main.ui']);
    expect(loaded.uiFiles.get(loaded.mainFileId!)?.path).toBe('ui/main.ui');
  });
});

describe('a manifest whose name, version or entry is not text', () => {
  it('is refused, saying which, as the runtime refuses it', async () => {
    // A name of {} was opened, and the toolbar that draws the name blanked
    // the whole Builder.
    for (const [field, value] of [['name', {}], ['version', 1], ['main', ['ui/main.ui']]] as const) {
      const bundle = zipSync({
        'manifest.json': strToU8(JSON.stringify({ name: 'App', version: '1.0.0', main: 'ui/main.ui', [field]: value })),
        'ui/main.ui': strToU8('<App></App>\n'),
      });
      await expect(loadBundle(bundle), field).rejects.toThrow(new RegExp(`Manifest field "${field}" must be text`));
    }
  });
});

describe('a logic file a UI file links but the manifest does not list', () => {
  const bundle = () => zipSync({
    'manifest.json': manifest({ ui: ['ui/main.ui'], logic: [], xdb: [], assets: [], server: ['server/api.py'] }),
    'ui/main.ui': strToU8('<logic src="../logic/app.py" />\n<App><Text>{count}</Text></App>\n'),
    'logic/app.py': strToU8('count = 0\n'),
    'server/api.py': strToU8('x = 1\n'),
  });

  it('is loaded as logic, so it can be opened and edited, and not kept as an opaque entry', async () => {
    const loaded = await loadBundle(bundle());
    expect([...loaded.logicFiles.values()].map((f) => [f.path, f.content])).toEqual([['logic/app.py', 'count = 0\n']]);
    expect(loaded.extraEntries.has('logic/app.py')).toBe(false);
    expect(loaded.warnings.join('\n')).toContain('logic/app.py');
    // A server file stays the server group's.
    expect(loaded.extraEntries.has('server/api.py')).toBe(true);
  });

  it('is listed, once, by the export', async () => {
    const { commitProjectSnapshot, prepareProjectSnapshot } = await import('./openProject');
    const { buildProjectBundle } = await import('./buildProjectBundle');
    const { parseBundle } = await import('./bundleExporter');
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle())));
    const written = parseBundle(await buildProjectBundle());
    expect(written.manifest.files.logic).toEqual(['logic/app.py']);
    expect(new TextDecoder().decode(written.files.get('logic/app.py'))).toBe('count = 0\n');
  });
});
