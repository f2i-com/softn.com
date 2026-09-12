/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryShelf } from '../src/components/DirectoryShelf';
import { Launcher } from '../src/components/Launcher';

let root: Root;
let container: HTMLDivElement;
const card = (slug = 'fieldnotes') => ({
  slug,
  name: slug === 'fieldnotes' ? 'Fieldnotes' : slug,
  description: 'A small workspace',
  urls: { bundle: `/api/apps/${slug}/bundle.softn` },
  external: null,
  thumbnail: '',
});
const reply = (apps: unknown[]) => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({ ok: true, apps, total: apps.length, pages: 1, page: 1, perPage: 6 }),
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('runtime directory integration', () => {
  it('opens a listed bundle through the runtime callback without navigation', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply([card()]));
    vi.stubGlobal('fetch', fetch);
    const onOpen = vi.fn();
    const location = window.location.href;
    act(() => root.render(<DirectoryShelf onOpen={onOpen} />));
    await settle();
    const run = container.querySelector<HTMLButtonElement>('[aria-label="Run Fieldnotes"]')!;
    expect(run).toBeTruthy();
    act(() => run.click());
    expect(onOpen).toHaveBeenCalledWith(
      `${window.location.origin}/api/apps/fieldnotes/bundle.softn`
    );
    expect(window.location.href).toBe(location);
    expect(fetch.mock.calls[0][0]).toContain('/api/apps?');
    expect(container.querySelector('[aria-label="About Fieldnotes"]')?.getAttribute('href')).toBe(
      '/app/fieldnotes'
    );
  });

  it('keeps linked apps as native external links and refuses unsafe destinations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply([
          {
            ...card('linked'),
            external: { url: 'https://example.com/app' },
            urls: { bundle: null },
          },
          { ...card('unsafe'), external: { url: 'javascript:alert(1)' } },
          { ...card('offsite'), urls: { bundle: 'https://example.com/private.softn' } },
        ])
      )
    );
    const onOpen = vi.fn();
    act(() => root.render(<DirectoryShelf onOpen={onOpen} />));
    await settle();
    const link = container.querySelector<HTMLAnchorElement>(
      '[aria-label="Open linked in a new tab"]'
    )!;
    expect(link.href).toBe('https://example.com/app');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(container.querySelector('[aria-label="Run unsafe"]')).toBeNull();
    expect(container.querySelector('[aria-label="Run offsite"]')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('keeps file and running-app controls usable when the directory fails, then retries', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(reply([card()]));
    vi.stubGlobal('fetch', fetch);
    const onResume = vi.fn();
    act(() =>
      root.render(
        <Launcher
          apps={[]}
          running={[{ id: 'running', name: 'Notes' }]}
          onResume={onResume}
          onOpenFile={vi.fn()}
          onOpenCached={vi.fn()}
          onRemove={vi.fn()}
          onExportData={vi.fn()}
          onImportData={vi.fn()}
          onAdoptData={vi.fn()}
          onOpenUrl={vi.fn()}
        />
      )
    );
    await settle();
    expect(container.textContent).toContain('The directory is unavailable');
    expect(container.querySelector('.softn-launcher-open')).toBeTruthy();
    act(() => container.querySelector<HTMLButtonElement>('[title="Back to Notes"]')!.click());
    expect(onResume).toHaveBeenCalledWith('running');
    act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry directory')!
        .click()
    );
    await settle();
    expect(container.querySelector('[aria-label="Run Fieldnotes"]')).toBeTruthy();
    expect(container.textContent).not.toContain('The directory is unavailable');
  });

  it('keeps an empty catalogue distinct from a failed request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply([]))
    );
    act(() => root.render(<DirectoryShelf onOpen={vi.fn()} />));
    await settle();
    expect(container.textContent).toContain('No published apps yet');
    expect(container.textContent).not.toContain('Retry directory');
    expect(container.querySelector('a[href="/studio/"]')).toBeTruthy();
    expect(container.querySelector('a[href="/builder/"]')).toBeTruthy();
  });

  it('aborts disposed shelves and ignores late replies after a fresh mount', async () => {
    let finishOld!: (value: ReturnType<typeof reply>) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockResolvedValue(reply([card()]));
    vi.stubGlobal('fetch', fetch);
    act(() => root.render(<DirectoryShelf key="old" onOpen={vi.fn()} />));
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    act(() => root.render(<DirectoryShelf key="new" onOpen={vi.fn()} />));
    await settle();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finishOld(reply([card('stale')]));
    });
    expect(container.querySelector('[aria-label="Run Fieldnotes"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Run stale"]')).toBeNull();
  });
});
