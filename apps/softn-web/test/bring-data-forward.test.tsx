/** @vitest-environment jsdom */
/**
 * "Bring my data forward" for an update that seeded sample records as it
 * opened. Seeding happens before the person reaches Home, and the offer was
 * shown only for a build with no stored data at all, so for every app that
 * seeds it never was: an update reached by a reload showed its samples and
 * no way to the person's records.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyAppData, holdsNothingOfItsOwn, removeAppData, type CachedApp } from '../src/lib/appCache';
import { Launcher } from '../src/components/Launcher';

const record = (id: string, extra: Record<string, unknown> = {}) => ({ id, collection: 'notes', data: { t: id }, created_at: 't', updated_at: 't', deleted: false, ...extra });

/** A build that opened once: the bundle's two seeds, their mark and the collections' list. */
function seedOnly(origin: string): void {
  localStorage.setItem(`xdb:${origin}:notes`, JSON.stringify([record('s1'), record('s2')]));
  localStorage.setItem(`xdb:${origin}::seeded:notes`, JSON.stringify(['s1', 's2']));
  localStorage.setItem(`xdb:${origin}::collections`, JSON.stringify(['notes']));
}

beforeEach(() => {
  localStorage.clear();
});

describe('holdsNothingOfItsOwn', () => {
  it('is true of a build with nothing, or only its seeds', () => {
    expect(holdsNothingOfItsOwn('A')).toBe(true);
    seedOnly('A');
    expect(holdsNothingOfItsOwn('A')).toBe(true);
  });

  it('is false once anything is the person\'s', () => {
    seedOnly('B');
    localStorage.setItem('xdb:B:notes', JSON.stringify([record('s1'), record('s2'), record('mine')]));
    expect(holdsNothingOfItsOwn('B')).toBe(false);

    seedOnly('C');
    localStorage.setItem('xdb:C:notes', JSON.stringify([record('s1'), record('s2', { deleted: true })]));
    expect(holdsNothingOfItsOwn('C')).toBe(false);

    seedOnly('D');
    localStorage.setItem('softn:D:highscore', '12');
    expect(holdsNothingOfItsOwn('D')).toBe(false);

    seedOnly('E');
    localStorage.setItem('xdb:E::sync-queue', '[]');
    expect(holdsNothingOfItsOwn('E')).toBe(false);

    localStorage.setItem('xdb:F:notes', 'not json');
    expect(holdsNothingOfItsOwn('F')).toBe(false);
  });
});

describe('bringing data forward into a build that holds only its seeds', () => {
  it('ends with the older build\'s records and seed marks', () => {
    localStorage.setItem('xdb:V1:notes', JSON.stringify([record('s1'), record('mine')]));
    localStorage.setItem('xdb:V1::seeded:notes', JSON.stringify(['s1', 's2']));
    seedOnly('V2');
    removeAppData('V2');
    expect(copyAppData('V1', 'V2')).toMatchObject({ ok: true, skipped: 0 });
    expect(JSON.parse(localStorage.getItem('xdb:V2:notes')!).map((r: { id: string }) => r.id)).toEqual(['s1', 'mine']);
    expect(JSON.parse(localStorage.getItem('xdb:V2::seeded:notes')!)).toEqual(['s1', 's2']);
  });
});

describe('the offer on Home', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, apps: [], total: 0, pages: 1, page: 1, perPage: 6 }) })));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const build = (version: string, origin: string, lastOpened: number): CachedApp =>
    ({ id: origin, name: 'Glamour', version, origin, bundleData: new Uint8Array(), cachedAt: 0, lastOpened }) as CachedApp;

  it('is made for a seeded update, from the build that holds the person\'s data', async () => {
    localStorage.setItem('xdb:V1:notes', JSON.stringify([record('s1'), record('appointment')]));
    localStorage.setItem('xdb:V1::seeded:notes', JSON.stringify(['s1']));
    seedOnly('V2');
    seedOnly('V3');
    const onAdoptData = vi.fn();
    const apps = [build('3', 'V3', 30), build('2', 'V2', 20), build('1', 'V1', 10)];
    act(() =>
      root.render(
        <Launcher
          apps={apps}
          running={[]}
          onResume={vi.fn()}
          onOpenFile={vi.fn()}
          onOpenCached={vi.fn()}
          onRemove={vi.fn()}
          onExportData={vi.fn()}
          onImportData={vi.fn()}
          onAdoptData={onAdoptData}
          onOpenUrl={vi.fn()}
        />
      )
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const offer = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Bring my data forward'));
    expect(offer?.textContent).toBe('Bring my data forward from v1');
    act(() => offer!.click());
    expect(onAdoptData.mock.calls[0].map((app: CachedApp) => app.version)).toEqual(['1', '3']);
    // An earlier version's data can be exported from its chip.
    expect(container.querySelector('[aria-label="Export the data of version 1"]')).not.toBeNull();
  });
});
