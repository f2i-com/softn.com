import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveAppPreview } from '../src/components/LiveAppPreview';

let host: HTMLDivElement;
let root: Root;
let resize: () => void;
const disconnect = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  disconnect.mockClear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<LiveAppPreview />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function announce(type: string, source: MessageEventSource | null, origin: string) {
  act(() => window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type, app: 'Fieldnotes' } })));
}

it('scales the real app to its container and offers a full-runtime link', () => {
  const stage = host.querySelector<HTMLElement>('.workspace-live-stage')!;
  Object.defineProperty(stage, 'clientWidth', { value: 600, configurable: true });
  act(() => resize());
  const frame = host.querySelector('iframe')!;
  expect(new URL(frame.src).searchParams.get('preview')).toBe('fieldnotes');
  expect(frame.style.transform).toBe('scale(0.5)');
  expect(frame.tabIndex).toBe(0);
  expect(frame.closest('[inert][aria-hidden="true"]')).not.toBeNull();
  const link = host.querySelector('a')!;
  const destination = new URL(link.href);
  expect(destination.searchParams.get('open')).toBe('/examples/Fieldnotes.softn');
  expect(destination.searchParams.has('preview')).toBe(false);
  expect(link.getAttribute('aria-label')).toBe('Open live Fieldnotes app in the runtime');
});

it('announces readiness only for the actual frame and its expected origin', () => {
  const frame = host.querySelector('iframe')!;
  const origin = new URL(frame.src).origin;
  const state = () => host.querySelector('[data-state]')?.getAttribute('data-state');
  announce('softn:app-ready', window, origin);
  expect(state()).toBe('loading');
  announce('softn:app-ready', frame.contentWindow, 'https://unrelated.example');
  expect(state()).toBe('loading');
  announce('softn:app-ready', frame.contentWindow, origin);
  expect(state()).toBe('ready');
  expect(host.textContent).toContain('Live · try it here');
  expect(frame.closest('[inert]')).toBeNull();
  expect(frame.closest('[aria-hidden="true"]')).toBeNull();
});

it('uses a readable phone layout without reloading the app when the card narrows or hides', () => {
  const stage = host.querySelector<HTMLElement>('.workspace-live-stage')!;
  const frame = host.querySelector('iframe')!;
  Object.defineProperty(stage, 'clientWidth', { value: 300, configurable: true });
  act(() => resize());
  expect(frame.style.width).toBe('360px');
  expect(frame.style.height).toBe('640px');
  expect(frame.style.transform).toBe(`scale(${300 / 360})`);
  Object.defineProperty(stage, 'clientWidth', { value: 0, configurable: true });
  act(() => resize());
  expect(frame.style.width).toBe('360px');
  expect(host.querySelector('iframe')).toBe(frame);
});

it('keeps the runtime link useful on failure and recovers from a slow start', () => {
  vi.useFakeTimers();
  const frame = host.querySelector('iframe')!;
  act(() => frame.dispatchEvent(new Event('load')));
  act(() => vi.advanceTimersByTime(30_000));
  expect(host.querySelector('[data-state]')?.getAttribute('data-state')).toBe('error');
  expect(host.querySelector('a')?.href).toContain('open=');
  announce('softn:app-ready', frame.contentWindow, new URL(frame.src).origin);
  expect(host.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready');
  act(() => root.render(null));
  expect(disconnect).toHaveBeenCalledOnce();
});
