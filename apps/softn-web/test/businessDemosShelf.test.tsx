/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessDemosShelf } from '../src/components/BusinessDemosShelf';

let root: Root;
let container: HTMLDivElement;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const SAMPLE_CATALOG = {
  format: 1,
  runtime: 'PHP 8.4 (Slim 4.15.3) + XDB SQLite (WASM)',
  count: 2,
  demos: [
    {
      slug: 'brewdesk-cafe-ops',
      id: 'formlogic.pack.brewdesk-cafe-ops',
      name: 'BrewDesk',
      version: '1.0.0',
      category: 'Hospitality',
      description: 'Cafe and barista operations desk.',
      file: 'BrewDesk-1.0.0.softn',
      bytes: 242500,
      icon: 'icons/brewdesk-cafe-ops.svg',
    },
    {
      slug: 'finance-os-au',
      id: 'formlogic.pack.finance-os-au',
      name: 'Finance OS (AU)',
      version: '1.0.0',
      category: 'Finance & Compliance',
      description: 'Australian AFSL advisory workbench.',
      file: 'Finance-OS-AU-1.0.0.softn',
      bytes: 272000,
      icon: 'icons/finance-os-au.svg',
    },
  ],
};

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

describe('BusinessDemosShelf', () => {
  it('renders hosted PHP Slim 4 + SQLite business demos, filters by category, and opens bundle URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => SAMPLE_CATALOG,
      }))
    );
    const onOpen = vi.fn();
    act(() => root.render(<BusinessDemosShelf onOpen={onOpen} />));
    await settle();

    expect(container.textContent).toContain('BrewDesk');
    expect(container.textContent).toContain('Finance OS (AU)');

    const hospitalityTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (btn) => btn.textContent === 'Hospitality'
    )!;
    act(() => hospitalityTab.click());
    expect(container.textContent).toContain('BrewDesk');
    expect(container.textContent).not.toContain('Finance OS (AU)');

    const runBtn = container.querySelector<HTMLButtonElement>('[aria-label="Run BrewDesk"]')!;
    act(() => runBtn.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatch(/business-demos\/BrewDesk-1\.0\.0\.softn$/);
  });

  it('rejects unsafe path traversal filenames from catalogue entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          demos: [
            {
              slug: 'bad',
              name: 'Bad',
              file: '../evil.softn',
              category: 'Operations',
              description: 'bad',
              bytes: 10,
            },
          ],
        }),
      }))
    );
    act(() => root.render(<BusinessDemosShelf onOpen={vi.fn()} />));
    await settle();
    expect(container.querySelector('.softn-demo-card')).toBeNull();
  });
});
