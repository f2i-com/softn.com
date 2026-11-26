/**
 * Round three, WasmApp: what its frame loop does while the program is
 * paused. Kept apart from r3-media-canvas.test.tsx because the program is
 * stood in for by mocking `startWasmProgram` in @softn/core, as
 * wasm-app.test.tsx does, and that mock is the whole file's.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppScopeProvider, startWasmProgram, type WasmProgram } from '@softn/core';
import { WasmApp } from '../src/utility/WasmApp';

vi.mock('@softn/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@softn/core')>();
  return { ...actual, startWasmProgram: vi.fn() };
});

const started = vi.mocked(startWasmProgram);
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
/** Every requestAnimationFrame the component made. */
let requested = 0;
let root: Root;
let host: HTMLDivElement;

function program(overrides: Partial<WasmProgram> = {}): WasmProgram {
  return {
    handle: 'wasmapp-0123',
    name: 'game.wasm',
    exports: [{ name: 'frame', kind: 'function' }],
    missing: [],
    drawsFrames: true,
    makesSound: false,
    exitCode: null,
    frame: vi.fn(async () => {}),
    call: vi.fn(async () => null),
    stop: vi.fn(),
    ...overrides,
  };
}

const scope = {
  appId: 'app-1',
  xdb: {} as never,
  active: true,
  assets: (path: string) => (path === 'assets/game.wasm' ? 'blob:test/game.wasm' : ''),
};

async function render(props: Partial<React.ComponentProps<typeof WasmApp>> = {}) {
  await act(async () => {
    root.render(
      <AppScopeProvider value={scope}>
        <WasmApp src="assets/game.wasm" {...props} />
      </AppScopeProvider>
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The browser's refresh: every frame callback waiting runs. */
async function refresh(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      const waiting = [...frames.values()];
      frames.clear();
      for (const callback of waiting) callback(performance.now());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  frames = new Map();
  requested = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    requested += 1;
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])))
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  started.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<WasmApp> while paused', () => {
  // `running={false}` paused the program's frames, but the loop went on
  // asking for a requestAnimationFrame at every refresh to find it still
  // paused: sixty callbacks a second for as long as a game sat in its menu,
  // and a page the browser could never let go idle.
  it('asks nothing of the screen while paused, and starts again when it runs', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame }));
    await render({ running: false });
    await refresh(); // the loop's first frame finds it paused
    const asked = requested;
    await refresh(10);
    expect(requested - asked).toBe(0);
    expect(frame).not.toHaveBeenCalled();

    await render({ running: true });
    await refresh(3);
    expect(frame).toHaveBeenCalledTimes(3);
    // And paused again, once more nothing.
    await render({ running: false });
    await refresh(); // the frame already asked for finds it paused
    const again = requested;
    await refresh(10);
    expect(requested - again).toBe(0);
    expect(frame).toHaveBeenCalledTimes(3);
  });
});
