/**
 * Indexed state paths keep arrays as arrays.
 *
 * Two `setState` implementations copied every intermediate segment with
 * `{ ...current[part] }`, arrays included. The first `:bind={todos[0].title}`
 * keystroke therefore replaced `todos` with an object keyed "0", "1", … — the
 * edit landed, but every `#each` over the list rendered nothing from then on
 * and `todos.length` read undefined. SoftNRenderer's own copy already handled
 * arrays; these are the other two.
 */

import { useEffect } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect } from 'vitest';
import { SoftNProvider, useSoftNState } from '../src/runtime/context';
import { SoftNBundleRenderer } from '../src/bundle/runtime';
import type { SoftNBundle } from '../src/bundle/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('SoftNProvider setState', () => {
  it('keeps an array an array when writing through an index', () => {
    type Setter = (path: string, value: unknown) => void;
    let latest: Record<string, unknown> = {};
    let setState: Setter = () => {};

    function Probe(): null {
      const [state, set] = useSoftNState();
      latest = state;
      useEffect(() => {
        setState = set;
      }, [set]);
      return null;
    }

    const { root, cleanup } = mount();
    try {
      act(() => {
        root.render(
          <SoftNProvider initialState={{ todos: [{ title: 'a' }, { title: 'b' }] }}>
            <Probe />
          </SoftNProvider>
        );
      });

      act(() => setState('todos[0].title', 'edited'));

      expect(Array.isArray(latest.todos)).toBe(true);
      expect(latest.todos).toEqual([{ title: 'edited' }, { title: 'b' }]);
    } finally {
      cleanup();
    }
  });
});

describe('SoftNBundleRenderer setState', () => {
  function makeBundle(ui: string): SoftNBundle {
    return {
      manifest: {
        name: 'Array path probe',
        version: '1.0.0',
        main: 'main.ui',
        files: { ui: ['main.ui'], assets: [] },
      },
      files: new Map([['main.ui', { path: 'main.ui', type: 'ui' as const, content: ui, size: ui.length }]]),
      uiFiles: new Map(),
      logicFiles: new Map(),
      xdbData: new Map(),
    };
  }

  it('keeps an array an array when a :bind writes through an index', async () => {
    const bundle = makeBundle(
      '<input :bind={todos[0].title} />\n<ul>\n#each (t in todos)\n<li>{t.title}</li>\n#end\n</ul>'
    );
    const { container, root, cleanup } = mount();
    try {
      await act(async () => {
        root.render(
          <SoftNBundleRenderer
            bundle={bundle}
            initialState={{ todos: [{ title: 'a' }, { title: 'b' }] }}
          />
        );
        await Promise.resolve();
      });

      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(container.querySelectorAll('li')).toHaveLength(2);

      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'edited');
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Still a list: both rows render, the first with the edit.
      const items = Array.from(container.querySelectorAll('li')).map((li) => li.textContent);
      expect(items).toEqual(['edited', 'b']);
    } finally {
      cleanup();
    }
  });
});
