/**
 * The ids the parser gives the elements of a page are its own.
 *
 * An id was the time in milliseconds and a count that started again at each
 * page read, so the pages of a bundle read in one millisecond had the same
 * ids, root and all, and anything that went by id took one page's elements
 * for another's (savedPoint.ts had to ask which page is active as well as
 * which root the canvas has). The count goes on from page to page now. An
 * id is never written into a file, and one kept in a saved session is
 * restored as it was (utils/openProject.ts), so no id a person has changes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { loadBundle } from './bundleLoader';
import { parseSource } from './sourceParser';

afterEach(() => vi.restoreAllMocks());

describe('pages read in one millisecond', () => {
  it('have no id in common', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const first = parseSource('<App>\n  <Text>One</Text>\n</App>\n');
    const second = parseSource('<App>\n  <Text>Two</Text>\n</App>\n');
    expect(first.rootId).not.toBe(second.rootId);
    expect([...first.elements.keys()].filter((id) => second.elements.has(id))).toEqual([]);
  });

  it('have no id in common when a bundle is opened', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const manifest = { name: 'Two pages', version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui', 'ui/other.ui'], logic: [], xdb: [], assets: [] } };
    const bundle = await loadBundle(zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'ui/main.ui': strToU8('<App>\n  <Text>Main</Text>\n</App>\n'),
      'ui/other.ui': strToU8('<App>\n  <Text>Other</Text>\n</App>\n'),
    }));
    const ids = [...bundle.uiFiles.values()].flatMap((page) => [...page.elements.keys()]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
