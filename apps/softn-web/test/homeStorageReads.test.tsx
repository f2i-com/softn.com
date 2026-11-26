/** @vitest-environment jsdom */
/**
 * Home asks of every build on every card whether it holds data, as it draws.
 * Each question walked every key in storage, and an older build was asked up
 * to six times: with 36 builds and 488 keys a drawing made 64,416 reads of a
 * key's name (about 130 ms here). Every key's name is read once a drawing now,
 * and each build is asked once; what the cards say is as it was.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Launcher } from '../src/components/Launcher';
import type { CachedApp } from '../src/lib/appCache';

vi.mock('../src/components/DirectoryShelf', () => ({ DirectoryShelf: () => null }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});

const origin = (app: number, build: number): string => `${app}${build}`.padStart(64, 'a');

/** Builds of four apps, three each: the newest of each used, the two before it used too. */
function library(): CachedApp[] {
  const apps: CachedApp[] = [];
  let opened = 1_000_000;
  for (let app = 0; app < 4; app++) {
    for (let build = 0; build < 3; build++) {
      const id = origin(app, build);
      apps.push({ id: `id-${app}-${build}`, name: `App ${app}`, version: `1.0.${build}`, origin: id, bundleData: new Uint8Array(1), cachedAt: opened, lastOpened: opened-- } as CachedApp);
      localStorage.setItem(`xdb:${id}:notes`, JSON.stringify([{ id: 'n1', text: 'mine' }]));
      localStorage.setItem(`xdb:${id}::collections`, '["notes"]');
      localStorage.setItem(`softn:${id}:save`, '1');
    }
  }
  for (let i = 0; i < 40; i++) localStorage.setItem(`unrelated-${i}`, 'v');
  return apps;
}

describe('Home, drawing a card for each saved app', () => {
  it('reads each stored key once a drawing, and says the same of each build', () => {
    const apps = library();
    const noop = () => {};
    const draw = () =>
      root.render(
        <Launcher apps={apps} installing={new Set()} running={[]} onOpenFile={noop} onOpenFolder={noop} onOpenCached={noop} onRemove={noop} onExportData={noop} onImportData={noop} onAdoptData={noop} />
      );
    act(() => draw());
    const names = vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, 'key');
    act(() => draw());
    expect(names.mock.calls.length).toBeLessThanOrEqual(localStorage.length);

    // What the cards say: every build here holds data of its own, so each has
    // its export, each older build says so, and nothing offers to bring data forward.
    expect(container.querySelectorAll('.softn-launcher-card')).toHaveLength(4);
    expect([...container.querySelectorAll('.softn-launcher-data-btn')].filter((b) => b.textContent === 'Export data')).toHaveLength(4);
    expect([...container.querySelectorAll('.softn-launcher-chip > button:first-child')].map((b) => b.textContent?.endsWith(' · has data'))).toEqual(Array(8).fill(true));
    expect(container.querySelector('.softn-launcher-adopt')).toBeNull();
  });

  it('still offers an older build’s data to a newer one that holds nothing of its own', () => {
    const apps = library();
    // The newest build of App 0 was opened and never used.
    for (const key of Object.keys(localStorage)) if (key.includes(origin(0, 0))) localStorage.removeItem(key);
    const noop = () => {};
    act(() =>
      root.render(
        <Launcher apps={apps} installing={new Set()} running={[]} onOpenFile={noop} onOpenFolder={noop} onOpenCached={noop} onRemove={noop} onExportData={noop} onImportData={noop} onAdoptData={noop} />
      )
    );
    const offers = [...container.querySelectorAll('.softn-launcher-adopt')].map((b) => b.textContent);
    expect(offers).toEqual(['Bring my data forward from v1.0.1']);
  });
});
