/** @vitest-environment jsdom */
/**
 * SoftN Web says when an app's records are not being kept.
 *
 * The state was worked out in XDBService and nothing here read it, so a
 * browser that refuses site data, or a full record budget, looked like saving
 * and lost the record. The runner and the store here are the real ones.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getXDB } from '@softn/core';
import { AppRunner } from '../src/components/AppRunner';

let root: Root;
let container: HTMLDivElement;
let appId: string;
let made = 0;
/** What each ResizeObserver watches, to report a height jsdom has no layout for. */
let observed: Array<{ element: Element; report: () => void }> = [];

beforeEach(() => {
  appId = `web-notice-test-${++made}`;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observed = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element): void {
        observed.push({ element, report: () => this.callback([], this as unknown as ResizeObserver) });
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<AppRunner source="<div>The app</div>" appName="Notes" appId={appId} active />);
  });
}

const notice = () => container.querySelector('[data-xdb-storage]');

describe('the storage notice', () => {
  it('says nothing on an app that is saving normally', async () => {
    await mount();
    act(() => {
      getXDB(appId).create('notes', { title: 'kept' });
    });
    expect(notice()).toBeNull();
  });

  it('says a refused save, above the app and outside its box', async () => {
    await mount();
    const page = 'x'.repeat(16_000);
    let refused: unknown;
    act(() => {
      try {
        for (let i = 0; i < 400; i++) getXDB(appId).create('pages', { page });
      } catch (error) {
        refused = error;
      }
    });
    expect(refused).toBeDefined();
    expect(notice()?.textContent).toContain('Storage is full');
    const box = container.querySelector('.softn-runner-app')!;
    expect(box.contains(notice())).toBe(false);
    expect(notice()!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // An app's root is sized off the viewport (calc(100vh - --softn-tab-bar-height)), so
  // a bar that is not counted in that variable pushes the app's own footer below the fold.
  it('takes its height out of what the app is sized to', async () => {
    await mount();
    expect(notice()).toBeNull();
    act(() => {
      getXDB(appId)._noteIssue({ kind: 'quota', collection: 'notes', message: 'Could not save "notes".' });
    });
    const wrapper = notice()!.parentElement!;
    Object.defineProperty(wrapper, 'offsetHeight', { configurable: true, value: 52 });
    act(() => observed.find((entry) => entry.element === wrapper)?.report());
    const host = container.querySelector<HTMLElement>('[data-softn-tab], .softn-runner-host')!;
    expect(host.classList.contains('softn-runner-host--barred')).toBe(true);
    expect(host.style.getPropertyValue('--softn-runner-bars-height')).toBe('52px');
  });
});
