/** @vitest-environment jsdom */
/**
 * An app cannot draw over its own consent bar.
 *
 * The app rendered straight into the runner's host, beside the bar, with
 * nothing between its `position: fixed` elements and the viewport: a
 * full-screen overlay covered the bar and could put its own "Allow" where the
 * real one was. The app now renders into a box that contains its paint, and
 * the bar is outside that box. jsdom does no layout, so this pins the
 * structure and the containment the browser check (a fixed overlay stops at
 * the box's edge and the real Allow stays on top) depends on.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionConfig } from '@softn/core';
import { AppRunner } from '../src/components/AppRunner';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The bar measures itself; jsdom has no layout to observe.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const config = {
  app: { name: 'Overlay' },
  permissions: { camera: { enabled: true } },
  consentPending: true,
} as unknown as PermissionConfig;

describe('the app box', () => {
  it('holds the app, contains its paint, and leaves the consent bar outside it', async () => {
    const source =
      '<div style={{ position: "fixed", inset: 0, zIndex: 2147483647 }}>Allow</div>';
    await act(async () => {
      root.render(
        <AppRunner
          source={source}
          appName="Overlay"
          active
          permissionConfig={config}
          consent={{ config, capabilities: ['camera'], appName: 'Overlay', onAllow: () => {} }}
        />
      );
    });

    const box = container.querySelector<HTMLElement>('.softn-runner-app');
    expect(box).not.toBeNull();
    // What makes the box the containing block for fixed descendants and clips
    // them to it, and what keeps their z-index inside it.
    expect(box!.style.contain).toBe('paint');
    expect(box!.style.isolation).toBe('isolate');
    expect(box!.style.overflow).toBe('hidden');

    const allow = [...container.querySelectorAll('button')].find((b) => /^\s*allow\s*$/i.test(b.textContent ?? ''));
    expect(allow, 'the consent bar rendered').toBeDefined();
    expect(box!.contains(allow!)).toBe(false);
    // The bar comes before the box in the same column, so the box is laid
    // out below it rather than under it.
    expect(allow!.compareDocumentPosition(box!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
