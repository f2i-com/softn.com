/**
 * A page's first draw waits for the light on-demand components its first
 * screen names (registered `beforeFirstDraw`), so none of them stands as a
 * placeholder, and a wrapper among them does not hide what it holds; a heavy
 * feature is drawn around, as before; a load that will not come is waited
 * for no longer than the renderer's limit; and a page with nothing to wait
 * for is drawn at once.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { getDefaultRegistry, recallFirstDraw, type SoftNComponent } from '../src/renderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const Panel: SoftNComponent = ({ children }) => <section data-panel="">{children as React.ReactNode}</section>;

let root: Root | null = null;
let container: HTMLElement;
const registered: string[] = [];

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  for (const name of registered.splice(0)) getDefaultRegistry().unregister(name);
});

function register(name: string, load: () => Promise<SoftNComponent>, beforeFirstDraw: boolean) {
  getDefaultRegistry().registerLazy(name, load, { feature: 'test', beforeFirstDraw });
  registered.push(name);
}

/** Mounts the page and records whether a busy placeholder was ever in it. */
async function mount(source: string, appId: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const seen = { busy: false };
  new MutationObserver(() => {
    if (container.querySelector('[aria-busy="true"]')) seen.busy = true;
  }).observe(container, { childList: true, subtree: true, attributes: true });
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId={appId} scriptExecutionMode="main" />);
  });
  return seen;
}

const page = (tag: string) => `<div>
  <p id="before">Before</p>
  <${tag}>
    <p id="inside">Inside</p>
  </${tag}>
</div>`;

describe('a page whose first screen names a light on-demand component', () => {
  it('is drawn once the component has arrived, never with a placeholder hiding what it wraps', async () => {
    const load = deferred<SoftNComponent>();
    register('WaitPanel', () => load.promise, true);
    const seen = await mount(page('WaitPanel'), 'first-draw-light');
    await act(async () => {
      await sleep(20);
    });
    expect(container.querySelector('#before')).toBeNull();

    await act(async () => {
      load.resolve(Panel);
      await sleep(20);
    });
    expect(container.querySelector('#before')?.textContent).toBe('Before');
    expect(container.querySelector('section[data-panel] #inside')?.textContent).toBe('Inside');
    expect(seen.busy).toBe(false);
    // Written down under the app's id, for its next open to start sooner.
    expect(recallFirstDraw('first-draw-light')).toEqual(['WaitPanel']);
  });

  it('is drawn as it stands once the wait is over, the component still on its way', async () => {
    register('NeverPanel', () => new Promise<SoftNComponent>(() => {}), true);
    await mount(page('NeverPanel'), 'first-draw-never');
    await act(async () => {
      await sleep(50);
    });
    expect(container.querySelector('#before')).toBeNull();
    await act(async () => {
      await sleep(400);
    });
    expect(container.querySelector('#before')?.textContent).toBe('Before');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe('a page whose first screen names a heavy feature', () => {
  it('is drawn at once, around the placeholder, as before', async () => {
    const load = deferred<SoftNComponent>();
    register('HeavyPanel', () => load.promise, false);
    const seen = await mount(page('HeavyPanel'), 'first-draw-heavy');
    expect(container.querySelector('#before')?.textContent).toBe('Before');
    expect(seen.busy).toBe(true);
    // Nothing a first draw waits for, so nothing to start early next time.
    expect(recallFirstDraw('first-draw-heavy')).toEqual([]);
    await act(async () => {
      load.resolve(Panel);
      await sleep(20);
    });
    expect(container.querySelector('section[data-panel] #inside')?.textContent).toBe('Inside');
  });
});

describe('a page with nothing on its way', () => {
  it('is drawn at once', async () => {
    register('ReadyPanel', () => Promise.resolve(Panel), true);
    await getDefaultRegistry().load('ReadyPanel');
    await mount(page('ReadyPanel'), 'first-draw-ready');
    expect(container.querySelector('#before')?.textContent).toBe('Before');
    expect(container.querySelector('section[data-panel] #inside')?.textContent).toBe('Inside');
  });
});
