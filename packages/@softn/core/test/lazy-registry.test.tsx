/**
 * Lazily registered components: one stable wrapper per name, a loader that
 * runs once per generation however many callers ask, and a retry that is a
 * retry — React.lazy caches a rejected load forever, so the registry has to
 * hand out a new instance rather than reset a boundary around the old one.
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { parse } from '../src/parser';
import {
  ComponentRegistry,
  isMissingChunkError,
  renderDocument,
  type SoftNComponent,
} from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let mounts = 0;
const Hello: SoftNComponent = ({ label }) => {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <span data-hello="">{String(label ?? 'hi')}</span>;
};

/**
 * Loads fine and throws in render, the way an app's own error does, with a
 * message the missing-chunk heuristic would match if it were asked.
 */
const Broken: SoftNComponent = () => {
  throw new Error('Texture file not found: x.png');
};

/** Stub the connection state; jsdom's getter is on the prototype, so an own property shadows it. */
function goOffline(): () => void {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  return () => {
    delete (navigator as { onLine?: boolean }).onLine;
  };
}

const context: SoftNRenderContext = {
  state: {},
  setState: () => {},
  data: {},
  props: {},
  functions: {},
  asyncFunctions: {},
  computed: {},
};

function buttonsOf(message: Element | null): (string | null)[] {
  return Array.from(message?.querySelectorAll('button') ?? []).map((b) => b.textContent);
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let container: HTMLElement;
let root: Root;
let errorSpy: ReturnType<typeof vi.spyOn>;

// A load that fails on purpose is reported three ways — by the boundary, by
// React, and by jsdom as an uncaught window error from React's guarded
// callback. All three are the point of the tests below, not noise to read.
const swallow = (event: Event): void => event.preventDefault();

beforeEach(() => {
  mounts = 0;
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  window.addEventListener('error', swallow);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  errorSpy.mockRestore();
  window.removeEventListener('error', swallow);
});

function render(element: React.ReactElement): void {
  act(() => {
    root.render(element);
  });
}

function click(selector: string): void {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ComponentRegistry lazy registration', () => {
  it('answers with one wrapper per lazy name and reports it as idle', () => {
    const registry = new ComponentRegistry();
    const loader = vi.fn(() => Promise.resolve(Hello));
    registry.registerLazy('Late', loader, { feature: 'late' });
    registry.register('Now', Hello);

    expect(registry.has('Late')).toBe(true);
    expect(registry.getNames()).toEqual(['Now', 'Late']);
    expect(registry.get('Late')).toBeDefined();
    expect(registry.get('Late')).toBe(registry.get('Late'));
    expect(registry.get('Late')).not.toBe(Hello);
    expect(registry.getLoadState('Late')).toBe('idle');
    expect(registry.isLoaded('Late')).toBe(false);
    expect(registry.getFeature('Late')).toBe('late');
    expect(registry.getLoadState('Now')).toBe('eager');
    expect(registry.isLoaded('Now')).toBe(true);
    expect(registry.getLoadState('Nope')).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });

  it('lets the last registration of a name win, whichever kind it is', () => {
    const registry = new ComponentRegistry();
    registry.registerLazy('X', () => Promise.resolve(Hello));
    registry.register('X', Hello);
    expect(registry.get('X')).toBe(Hello);
    expect(registry.getLoadState('X')).toBe('eager');
    registry.registerLazy('X', () => Promise.resolve(Hello));
    expect(registry.get('X')).not.toBe(Hello);
    expect(registry.getLoadState('X')).toBe('idle');
    expect(registry.unregister('X')).toBe(true);
    expect(registry.has('X')).toBe(false);
  });

  it('preloads each idle loader once and skips eager, unknown and started names', async () => {
    const registry = new ComponentRegistry();
    const a = deferred<SoftNComponent>();
    const b = deferred<SoftNComponent>();
    const loadA = vi.fn(() => a.promise);
    const loadB = vi.fn(() => b.promise);
    registry.registerAllLazy({ A: loadA, B: loadB });
    registry.register('Now', Hello);

    const first = registry.preload(['A', 'A', 'B', 'Now', 'Nope']);
    const second = registry.preload(['A', 'B']);
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
    expect(registry.getLoadState('A')).toBe('loading');

    a.resolve(Hello);
    b.reject(new Error('no B'));
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(registry.getLoadState('A')).toBe('loaded');
    expect(registry.isLoaded('A')).toBe(true);
    expect(registry.getLoadState('B')).toBe('error');

    await registry.preload(['A', 'B']);
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed load failed until retry, which runs the loader again', async () => {
    const registry = new ComponentRegistry();
    let attempt = 0;
    const loader = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('first')) : Promise.resolve(Hello);
    });
    registry.registerLazy('Flaky', loader);

    await expect(registry.load('Flaky')).rejects.toThrow('first');
    await expect(registry.load('Flaky')).rejects.toThrow('first');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(registry.getLoadState('Flaky')).toBe('error');

    await expect(registry.retry('Flaky')).resolves.toBe(Hello);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(registry.getLoadState('Flaky')).toBe('loaded');
    await expect(registry.load('Flaky')).resolves.toBe(Hello);
    expect(loader).toHaveBeenCalledTimes(2);

    await expect(registry.load('Nope')).rejects.toThrow('Unknown component: Nope');
    registry.register('Now', Hello);
    await expect(registry.retry('Now')).resolves.toBe(Hello);
  });

  it('names the component when a loader resolves to nothing', async () => {
    const registry = new ComponentRegistry();
    registry.registerLazy('Typo', () => Promise.resolve(undefined as unknown as SoftNComponent));
    await expect(registry.load('Typo')).rejects.toThrow(
      'Lazy component "Typo" resolved to undefined'
    );
  });
});

describe('the lazy wrapper', () => {
  it('shows a busy placeholder while loading, then the component, without remounting it', async () => {
    const registry = new ComponentRegistry();
    const load = deferred<SoftNComponent>();
    registry.registerLazy('Late', () => load.promise);
    const Late = registry.get('Late')!;

    render(<Late label="one" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[data-hello]')).toBeNull();
    expect(registry.getLoadState('Late')).toBe('loading');

    load.resolve(Hello);
    await flush();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('[data-hello]')?.textContent).toBe('one');
    expect(mounts).toBe(1);

    render(<Late label="two" />);
    expect(container.querySelector('[data-hello]')?.textContent).toBe('two');
    expect(mounts).toBe(1);
    expect(registry.get('Late')).toBe(Late);
  });

  it('renders a preloaded component directly, with no placeholder frame', async () => {
    const registry = new ComponentRegistry();
    registry.registerLazy('Late', () => Promise.resolve(Hello));
    await registry.preload(['Late']);
    const Late = registry.get('Late')!;

    render(<Late label="ready" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('[data-hello]')?.textContent).toBe('ready');
  });

  it('shows a local message with Retry after a failed load, and Retry loads again', async () => {
    const registry = new ComponentRegistry();
    let attempt = 0;
    const loader = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(Hello);
    });
    registry.registerLazy('Flaky', loader);
    const Flaky = registry.get('Flaky')!;

    render(
      <div>
        <p data-sibling="">still here</p>
        <Flaky label="x" />
      </div>
    );
    await flush();
    const message = container.querySelector('[data-softn-lazy-error="Flaky"]');
    expect(message).not.toBeNull();
    expect(message?.textContent).toContain('<Flaky>');
    expect(message?.textContent).toContain('could not load: boom');
    expect(message?.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelector('[data-sibling]')).not.toBeNull();
    expect(registry.getLoadState('Flaky')).toBe('error');

    click('[data-softn-lazy-error="Flaky"] button');
    expect(loader).toHaveBeenCalledTimes(2);
    await flush();
    expect(container.querySelector('[data-softn-lazy-error]')).toBeNull();
    expect(container.querySelector('[data-hello]')?.textContent).toBe('x');
    expect(registry.getLoadState('Flaky')).toBe('loaded');
  });

  it('reads a missing chunk as an update and offers Reload beside Retry', async () => {
    const registry = new ComponentRegistry();
    registry.registerLazy('Gone', () =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module: /assets/scene3d-old.js')
      )
    );
    const Gone = registry.get('Gone')!;
    render(<Gone />);
    await flush();
    const message = container.querySelector('[data-softn-lazy-error="Gone"]');
    expect(message?.textContent).toContain('updated');
    expect(message?.textContent).not.toContain('offline');
    expect(buttonsOf(message)).toEqual(['Retry', 'Reload']);
    expect(
      errorSpy.mock.calls.some((call: unknown[]) => /failed to load/.test(String(call[0])))
    ).toBe(true);
  });

  it('reads the same missing chunk offline as a feature not fetched, with Retry alone', async () => {
    const restore = goOffline();
    try {
      const registry = new ComponentRegistry();
      registry.registerLazy('Gone', () =>
        Promise.reject(
          new TypeError('Failed to fetch dynamically imported module: /assets/scene3d-old.js')
        )
      );
      const Gone = registry.get('Gone')!;
      render(<Gone />);
      await flush();
      const message = container.querySelector('[data-softn-lazy-error="Gone"]');
      expect(message?.textContent).toContain('<Gone>');
      expect(message?.textContent).toContain('not available offline');
      expect(message?.textContent).not.toContain('updated');
      expect(buttonsOf(message)).toEqual(['Retry']);
    } finally {
      restore();
    }
    expect(navigator.onLine).toBe(true);
  });

  it('calls a loader that fails for an ordinary reason an ordinary failure, offline too', async () => {
    const restore = goOffline();
    try {
      const registry = new ComponentRegistry();
      registry.registerLazy('Flaky', () => Promise.reject(new Error('boom')));
      const Flaky = registry.get('Flaky')!;
      render(<Flaky />);
      await flush();
      const message = container.querySelector('[data-softn-lazy-error="Flaky"]');
      expect(message?.textContent).toContain('could not load: boom');
      expect(buttonsOf(message)).toEqual(['Retry']);
    } finally {
      restore();
    }
  });

  // The heuristic that recognises a missing chunk matches ordinary messages
  // too — "not found", "fetch", a TypeError naming `.module` — so it is only
  // asked about the loader's own rejection. A component that loaded and then
  // threw in render has an app error, which reloading would reproduce; the
  // boundary names it as such and offers Retry alone. And it does so on both
  // paths: with a warm cache the preload settles before first render and the
  // component renders directly, which used to skip the boundary altogether
  // and hand the error to the document's, taking the whole app down.
  it.each([
    ['preloaded', true],
    ['not preloaded', false],
  ])('keeps a render error local to the region when %s', async (_label, preloaded) => {
    const registry = new ComponentRegistry();
    const loader = vi.fn(() => Promise.resolve(Broken));
    registry.registerLazy('Broken', loader, { feature: 'broken' });
    if (preloaded) {
      await registry.preload(['Broken']);
      expect(registry.getLoadState('Broken')).toBe('loaded');
    }
    const doc = parse('<div><p id="sibling">still here</p><Broken /></div>');

    render(<>{renderDocument(doc, context, registry)}</>);
    if (preloaded) expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    await flush();

    expect(container.querySelector('#sibling')?.textContent).toBe('still here');
    const message = container.querySelector('[data-softn-lazy-error="Broken"]');
    expect(message).not.toBeNull();
    expect(message?.textContent).toContain('<Broken>');
    expect(message?.textContent).toContain('failed to render: Texture file not found: x.png');
    expect(message?.textContent).not.toContain('updated');
    expect(message?.textContent).not.toContain('could not load');
    expect(buttonsOf(message)).toEqual(['Retry']);
    expect(
      errorSpy.mock.calls.some((call: unknown[]) => /failed to render/.test(String(call[0])))
    ).toBe(true);
    // The load itself succeeded, and the entry says so.
    expect(registry.getLoadState('Broken')).toBe('loaded');

    // Retry runs the loader again under a fresh boundary; the same component
    // fails the same way, and the failure is still the region's alone.
    click('[data-softn-lazy-error="Broken"] button');
    expect(loader).toHaveBeenCalledTimes(2);
    await flush();
    expect(container.querySelector('#sibling')).not.toBeNull();
    expect(container.querySelector('[data-softn-lazy-error="Broken"]')?.textContent).toContain(
      'failed to render'
    );
  });

  it('tells a render error that looks like a fetch failure from a real one', async () => {
    const Fetchy: SoftNComponent = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'module')");
    };
    const registry = new ComponentRegistry();
    registry.registerLazy('Fetchy', () => Promise.resolve(Fetchy));
    await registry.preload(['Fetchy']);
    const Late = registry.get('Fetchy')!;
    render(<Late />);
    await flush();
    const message = container.querySelector('[data-softn-lazy-error="Fetchy"]');
    expect(message?.textContent).toContain('failed to render: Cannot read properties of undefined');
    expect(buttonsOf(message)).toEqual(['Retry']);
  });

  it('tells a missing chunk from an ordinary failure', () => {
    expect(isMissingChunkError(new TypeError('error loading dynamically imported module'))).toBe(
      true
    );
    expect(isMissingChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isMissingChunkError(new Error('404 Not Found'))).toBe(true);
    expect(isMissingChunkError(new Error('Loading chunk 12 failed'))).toBe(true);
    expect(isMissingChunkError(new Error('boom'))).toBe(false);
    expect(isMissingChunkError(new TypeError('x is not a function'))).toBe(false);
    expect(isMissingChunkError(null)).toBe(false);
  });

  it('is what the document renderer reaches through the registry', async () => {
    const registry = new ComponentRegistry();
    const load = deferred<SoftNComponent>();
    registry.registerLazy('Late', () => load.promise);
    const doc = parse('<div><Late label="from-doc" /></div>');

    render(<>{renderDocument(doc, context, registry)}</>);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    load.resolve(Hello);
    await flush();
    expect(container.querySelector('[data-hello]')?.textContent).toBe('from-doc');
  });
});
