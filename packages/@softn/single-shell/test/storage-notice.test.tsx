// @vitest-environment jsdom
/**
 * The play page says when an app's records are not being kept.
 *
 * The state was worked out in XDBService and only the desktop loader and
 * FormLogic's frame showed it, so on /play/<slug> a browser that refuses site
 * data, or a full record budget, looked like saving and lost the record. The
 * store here is the real one; only the engine is left out.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@softn/core', async (original) => ({
  ...(await original<object>()),
  SoftNWithXDB: () => <p data-app="true">The app</p>,
}));
vi.mock('@softn/components', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@softn/brand', async (importOriginal) => ({ ...(await importOriginal<object>()), Mark: () => null }));
import { getXDB, type XDBService } from '@softn/core';
import { Application } from '../src/SingleApp';
import type { LoadedApplication } from '../src/load';

const element = document.createElement('div');
document.body.append(element);
let root: ReturnType<typeof createRoot>;
let appId: string;
let made = 0;

beforeEach(() => {
  appId = `notice-test-${++made}`;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount() {
  root = createRoot(element);
  const app = {
    appId,
    config: { title: 'Example', theme: 'dark', permissionMode: 'preapproved' },
    declared: { permissions: {} },
    grantKey: 'test-grant',
    textFiles: new Map(),
    assets: () => '',
    source: '<App />',
  } as unknown as LoadedApplication;
  act(() => root.render(<Application app={app} />));
}

const notice = () => element.querySelector('[data-xdb-storage]');

it('says nothing on an app that is saving normally, whatever it writes', () => {
  mount();
  const xdb: XDBService = getXDB(appId);
  act(() => {
    xdb.create('notes', { title: 'kept' });
  });
  expect(element.querySelector('[data-app]')).not.toBeNull();
  expect(notice()).toBeNull();
});

it('says that nothing is being saved where the browser refuses site data', () => {
  // As Firefox refuses it with cookies blocked: the property itself throws.
  const refused = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', { configurable: true, get: refused });
  try {
    mount();
    expect(notice()?.getAttribute('data-xdb-storage')).toBe('memory-only');
    expect(notice()?.textContent).toContain('Records are not being saved');
    // In the bar above the app, measured with it, and outside what the app draws.
    expect(element.querySelector('.application-chrome')?.contains(notice())).toBe(true);
    expect(element.querySelector('.application-content')?.contains(notice())).toBe(false);
  } finally {
    act(() => root.unmount());
    if (own) Object.defineProperty(window, 'localStorage', own);
    else delete (window as { localStorage?: unknown }).localStorage;
  }
});

it('says that a record was refused when the app has used its budget', () => {
  mount();
  const xdb = getXDB(appId);
  const page = 'x'.repeat(16_000);
  let refused: unknown;
  act(() => {
    try {
      for (let i = 0; i < 400; i++) xdb.create('pages', { page });
    } catch (error) {
      refused = error;
    }
  });
  expect(refused).toBeDefined();
  expect(notice()?.textContent).toContain('Storage is full');
});
