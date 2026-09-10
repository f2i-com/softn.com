// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@softn/core', async (original) => ({
  ...(await original<object>()),
  SoftNWithXDB: ({
    permissionConfig,
    storageEndpoint,
    onLoad,
  }: {
    permissionConfig: { permissions: { net?: { enabled: boolean } } };
    storageEndpoint?: string;
    onLoad?: () => void;
  }) => {
    const [clicks, setClicks] = useState(0);
    return (
      <button
        data-app="true"
        data-net={String(!!permissionConfig.permissions.net?.enabled)}
        data-storage={storageEndpoint ?? ''}
        onClick={() => {
          setClicks(clicks + 1);
          onLoad?.();
        }}
      >
        App clicks {clicks}
      </button>
    );
  },
}));
vi.mock('@softn/components', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
import { Application } from '../src/SingleApp';
import type { LoadedApplication } from '../src/load';
const element = document.createElement('div');
document.body.append(element);
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root?.unmount());
  localStorage.clear();
  vi.unstubAllGlobals();
});
function mount(config: Record<string, unknown> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  root = createRoot(element);
  const app = {
    config: { title: 'Example', theme: 'dark', permissionMode: 'prompt', ...config },
    declared: { permissions: { net: { enabled: true, allowed_hosts: ['example.test'] } } },
    grantKey: 'test-grant',
    textFiles: new Map(),
    assets: () => '',
    source: '',
  } as unknown as LoadedApplication;
  act(() => root.render(<Application app={app} />));
}
it('uses operator-preapproved declared access without a banner or a stored visitor grant', () => {
  mount({ permissionMode: 'preapproved' });
  expect(element.querySelector('.permission-bar')).toBeNull();
  expect(element.querySelector('[data-app]')?.getAttribute('data-net')).toBe('true');
  expect(localStorage.getItem('test-grant')).toBeNull();
});
function click(text: string) {
  const button = [...element.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}
it('runs the app before consent while withholding capabilities, then enables only declared access', () => {
  mount();
  expect(element.querySelector('[role="dialog"]')).toBeNull();
  expect(element.querySelector('.permission-bar')).not.toBeNull();
  expect(element.querySelector('[data-app]')?.getAttribute('data-net')).toBe('false');
  click('App clicks 0');
  click('Allow');
  expect(element.querySelector('.permission-bar')).toBeNull();
  expect(element.querySelector('[data-app]')?.getAttribute('data-net')).toBe('true');
  expect(localStorage.getItem('test-grant')).toBe('allowed');
});
it('dismisses and reopens the bar without unmounting the app or granting access', () => {
  mount();
  click('App clicks 0');
  click('Not now');
  expect(element.querySelector('[data-app]')?.textContent).toBe('App clicks 1');
  expect(element.querySelector('[data-app]')?.getAttribute('data-net')).toBe('false');
  click('Review permissions');
  expect(element.querySelector('.permission-bar')).not.toBeNull();
  expect(element.querySelector('[data-app]')?.textContent).toBe('App clicks 1');
  expect(localStorage.getItem('test-grant')).toBeNull();
});
it('passes the directory storage endpoint through and counts the run once, when the app is up', () => {
  const posts: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    posts.push([url, init]);
    return new Response(null, { status: 204 });
  });
  mount({
    directory: {
      runs: 'https://example.test/api/apps/example/runs',
      storage: 'https://example.test/api/apps/example/storage',
    },
  });
  expect(element.querySelector('[data-app]')?.getAttribute('data-storage')).toBe(
    'https://example.test/api/apps/example/storage'
  );
  // The mocked runtime reports onLoad on every click; the shell counts once.
  click('App clicks 0');
  click('App clicks 1');
  expect(posts.map(([url]) => url)).toEqual(['https://example.test/api/apps/example/runs']);
  expect(posts[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ stage: 'open' }) });
});
it('a standalone deployment reports to nothing', () => {
  const request = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', request);
  mount();
  click('Allow');
  click('App clicks 0');
  expect(request).not.toHaveBeenCalled();
  expect(element.querySelector('[data-app]')?.getAttribute('data-storage')).toBe('');
});
