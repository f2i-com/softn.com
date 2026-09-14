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
