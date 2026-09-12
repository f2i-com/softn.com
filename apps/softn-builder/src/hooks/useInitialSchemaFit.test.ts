// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInitialSchemaFit } from './useInitialSchemaFit';

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
const fit = vi.fn();
const interacted = { current: false };
function Harness({ ready = true, width = 900, height = 500 }: { ready?: boolean; width?: number; height?: number }) {
  useInitialSchemaFit({ ready, width, height, fit, interacted }); return null;
}
function render(props: Parameters<typeof Harness>[0] = {}) { act(() => root.render(React.createElement(Harness, props))); }
function nextFrame() {
  const pending = [...frames.values()]; frames.clear();
  act(() => pending.forEach(callback => callback(0)));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; fit.mockReset(); interacted.current = false;
  frames = new Map(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('waits for measured nodes and a nonzero viewport', () => {
  render({ ready: false }); nextFrame(); nextFrame(); expect(fit).not.toHaveBeenCalled();
  render({ width: 0 }); nextFrame(); nextFrame(); expect(fit).not.toHaveBeenCalled();
  render(); nextFrame(); expect(fit).not.toHaveBeenCalled(); nextFrame(); expect(fit).toHaveBeenCalledOnce();
});

it('waits again when the seed table changes viewport size before fitting', () => {
  render(); nextFrame(); render({ height: 236 });
  nextFrame(); expect(fit).not.toHaveBeenCalled(); nextFrame(); expect(fit).toHaveBeenCalledOnce();
  render({ height: 400 }); nextFrame(); nextFrame(); expect(fit).toHaveBeenCalledOnce();
});

it('leaves a user pan or zoom untouched even if it happens during the pending fit', () => {
  render(); nextFrame(); interacted.current = true; nextFrame(); expect(fit).not.toHaveBeenCalled();
  render({ height: 236 }); nextFrame(); nextFrame(); expect(fit).not.toHaveBeenCalled();
});

it('cancels the pending fit when Data is closed', () => {
  render(); nextFrame(); act(() => root.render(null)); nextFrame(); expect(fit).not.toHaveBeenCalled();
});
