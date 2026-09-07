// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@softn/core', async (original) => ({
  ...(await original<object>()),
  SoftNWithXDB: ({
    permissionConfig,
  }: {
    permissionConfig: { permissions: { net?: { enabled: boolean } } };
  }) => {
    const [clicks, setClicks] = useState(0);
    return (
      <button
        data-app="true"
        data-net={String(!!permissionConfig.permissions.net?.enabled)}
        onClick={() => setClicks(clicks + 1)}
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
function mount() {
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
    config: { title: 'Example', theme: 'dark' },
    declared: { permissions: { net: { enabled: true, allowed_hosts: ['example.test'] } } },
    grantKey: 'test-grant',
    textFiles: new Map(),
    assets: () => '',
    source: '',
  } as unknown as LoadedApplication;
  act(() => root.render(<Application app={app} />));
}
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
