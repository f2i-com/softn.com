/**
 * A `key={…}` on an `#each` that cannot be worked out for a row.
 *
 *     #each (row in rows) key={JSON.parse(row.meta).id}
 *
 * One row whose `meta` is not JSON threw out of the renderer, and the whole
 * page was replaced by the error screen. A condition or an iterable that
 * throws has long been survived (false, and an empty list); the key was the
 * one structural expression still evaluated bare. A row whose key cannot be
 * worked out is keyed by its index, and the page says so in the console.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { click, drawPage, removeDrawnPages } from './helpers/drawn-page';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement | undefined;

afterEach(async () => {
  removeDrawnPages();
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
});

const rows = () => [
  { name: 'One', meta: '{"id":"a"}' },
  { name: 'Two', meta: '{not json' },
  { name: 'Three', meta: '{"id":"c"}' },
];

describe('an #each key that throws for one row', () => {
  it('draws every row, the bad one keyed by its index, and says so', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { all } = drawPage('#each (row in rows) key={JSON.parse(row.meta).id}\n<i>{row.name}</i>\n#end\n<p>after</p>', { rows: rows() });
    expect(all('i').map((i) => i.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(all('p').map((p) => p.textContent)).toEqual(['after']);
    const said = errors.mock.calls.filter((call) => String(call[0]).startsWith('[SoftN] #each key threw'));
    expect(said).toHaveLength(1);
    expect(String(said[0][0])).toBe('[SoftN] #each key threw; using "1":');
    expect(said[0][1]).toBeInstanceOf(SyntaxError);
  });

  it('draws the rows of a key that is nothing text can be made of', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bare = Object.create(null) as Record<string, unknown>;
    const { all } = drawPage('#each (row in rows) key={row.tag}\n<i>{row.name}</i>\n#end', {
      rows: [{ name: 'One', tag: 'a' }, { name: 'Two', tag: bare }],
    });
    expect(all('i').map((i) => i.textContent)).toEqual(['One', 'Two']);
  });

  it('keeps the rows’ own keys where they can be worked out: a row keeps its element when the list is turned round', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { all, one } = drawPage(
      '#each (row in rows) key={JSON.parse(row.meta).id}\n<input data-name={row.name} />\n#end\n<button @click={rows = [rows[2], rows[1], rows[0]]}>turn</button>',
      { rows: rows() }
    );
    const before = all('input');
    click(one('button'));
    const after = all('input');
    expect(after.map((input) => input.dataset.name)).toEqual(['Three', 'Two', 'One']);
    // "a" and "c" are the same elements, moved; the row keyed by index stays where its index is.
    expect(after[0]).toBe(before[2]);
    expect(after[2]).toBe(before[0]);
  });

  it('leaves the app on the page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    const failed: Error[] = [];
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <SoftNRenderer
          source={'<div>\n#each (row in rows) key={JSON.parse(row.meta).id}\n<i>{row.name}</i>\n#end\n</div>'}
          appId="each-key-throws"
          scriptExecutionMode="main"
          initialState={{ rows: rows() }}
          onError={(error) => failed.push(error)}
        />
      );
      await sleep(20);
    });
    expect(Array.from(container.querySelectorAll('i'), (i) => i.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(failed).toEqual([]);
  });
});
