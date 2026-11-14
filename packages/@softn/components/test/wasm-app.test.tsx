/**
 * <WasmApp>: the program it starts and what it hands it. The program itself
 * (core's runtime/wasm/) is stood in for here; core's own tests run real
 * modules. What is pinned: the file is read where the app's markup finds it,
 * keys go as USB HID codes only while the program has the focus and never
 * the browser's own chords, frames wait for each other, a program with no
 * frame shows what it printed, and the program stops with the component.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppScopeProvider, startWasmProgram, type WasmProgram, type WasmProgramOptions } from '@softn/core';
import { WasmApp, WASM_KEY_CODES } from '../src/utility/WasmApp';

vi.mock('@softn/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@softn/core')>();
  return { ...actual, startWasmProgram: vi.fn() };
});

const started = vi.mocked(startWasmProgram);
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let root: Root;
let host: HTMLDivElement;

function program(overrides: Partial<WasmProgram> = {}): WasmProgram {
  return {
    handle: 'wasmapp-0123',
    name: 'game.wasm',
    exports: [
      { name: 'frame', kind: 'function' },
      { name: 'key', kind: 'function' },
      { name: 'pointer', kind: 'function' },
      { name: 'memory', kind: 'memory' },
    ],
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
  // The file's fetch and the program's start.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Runs the frames the component asked for, as the browser would at a refresh. */
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

const box = () => host.querySelector('[data-softn-wasm-app]') as HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url === 'blob:test/game.wasm' ? new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) : new Response('', { status: 404 })))
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(console, 'log').mockImplementation(() => {});
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

describe('<WasmApp>', () => {
  it('starts the program from the app’s own file, and says it has started', async () => {
    const running = program();
    started.mockResolvedValue(running);
    const onReady = vi.fn();
    await render({ onReady, args: ['--level', '2'], env: { MODE: 'demo' }, files: { 'save.txt': 'hi', 'raw.bin': { base64: 'AAEC' } }, memory: 64 });
    expect(fetch).toHaveBeenCalledWith('blob:test/game.wasm', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const options = started.mock.calls[0][0] as WasmProgramOptions;
    expect([...options.bytes]).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
    expect(options).toMatchObject({ name: 'game.wasm', appId: 'app-1', args: ['--level', '2'], env: { MODE: 'demo' }, memoryMB: 64, audioRate: 48000 });
    expect(options.files?.map((f) => [f.path, [...f.bytes]])).toEqual([
      ['save.txt', [104, 105]],
      ['raw.bin', [0, 1, 2]],
    ]);
    expect(onReady).toHaveBeenCalledWith({ handle: 'wasmapp-0123', exports: ['frame', 'key', 'pointer'], missing: [] });
    expect(box().getAttribute('role')).toBe('application');
  });

  it('asks for a frame at each refresh, one at a time, and not while paused', async () => {
    let finish: () => void = () => {};
    const frame = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    started.mockResolvedValue(program({ frame }));
    await render();
    await refresh();
    expect(frame).toHaveBeenCalledTimes(1);
    await refresh(3);
    expect(frame).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await refresh();
    expect(frame).toHaveBeenCalledTimes(2);
    await render({ running: false });
    await act(async () => finish());
    await refresh(3);
    expect(frame).toHaveBeenCalledTimes(2);
  });

  it('hands the program keys as USB HID codes while it has the focus, and keeps the browser’s chords', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame }));
    await render();
    const target = box();
    target.focus();
    const press = (init: KeyboardEventInit, type = 'keydown') => {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };
    const right = press({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(right.defaultPrevented).toBe(true);
    press({ key: 'a', code: 'KeyA' });
    press({ key: 'a', code: 'KeyA', repeat: true });
    const copy = press({ key: 'c', code: 'KeyC', ctrlKey: true });
    expect(copy.defaultPrevented).toBe(false);
    const tab = press({ key: 'Tab', code: 'Tab' });
    expect(tab.defaultPrevented).toBe(false);
    press({ key: 'ArrowRight', code: 'ArrowRight' }, 'keyup');
    await refresh();
    const events = (frame.mock.calls[0] as unknown[])[1];
    expect(events).toEqual([
      { kind: 'key', code: 79, down: true },
      { kind: 'key', code: 4, down: true },
      { kind: 'text', codepoint: 97 },
      { kind: 'text', codepoint: 97 },
      { kind: 'key', code: 79, down: false },
    ]);
    // Leaving lets go of every key still held.
    act(() => target.blur());
    await refresh();
    expect((frame.mock.calls[1] as unknown[])[1]).toEqual([{ kind: 'key', code: 4, down: false }]);
  });

  it('hands over Shift, Ctrl and Alt pressed alone, and the characters AltGr types, and leaves the function keys working', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame, exports: [{ name: 'frame', kind: 'function' }, { name: 'key', kind: 'function' }, { name: 'text', kind: 'function' }] }));
    await render();
    const target = box();
    target.focus();
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };
    const shift = press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    // A modifier on its own is heard, and stays the browser's too.
    expect(shift.defaultPrevented).toBe(false);
    press({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
    press({ key: 'Alt', code: 'AltLeft', altKey: true });
    // AltGr+Q on a German keyboard: Ctrl and Alt both set, and the AltGraph state.
    const at = press({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
    expect(at.defaultPrevented).toBe(true);
    const reload = press({ key: 'F5', code: 'F5' });
    expect(reload.defaultPrevented).toBe(false);
    press({ key: '😀', code: '' });
    await refresh();
    expect((frame.mock.calls[0] as unknown[])[1]).toEqual([
      { kind: 'key', code: 225, down: true },
      { kind: 'key', code: 224, down: true },
      { kind: 'key', code: 226, down: true },
      { kind: 'key', code: 20, down: true },
      { kind: 'text', codepoint: 64 },
      { kind: 'key', code: 62, down: true },
      { kind: 'text', codepoint: 0x1f600 },
    ]);
  });

  it('keeps every key the browser’s for a program that takes none', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame, exports: [{ name: 'frame', kind: 'function' }, { name: 'pointer', kind: 'function' }] }));
    await render();
    const target = box();
    target.focus();
    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(space);
    });
    expect(space.defaultPrevented).toBe(false);
    await refresh();
    expect((frame.mock.calls[0] as unknown[])[1]).toEqual([]);
  });

  it('reads gamepads only while the program has the focus', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame, exports: [{ name: 'frame', kind: 'function' }, { name: 'gamepad', kind: 'function' }] }));
    const pad = { index: 0, connected: true, buttons: [{ pressed: true }, { pressed: false }], axes: [0.5, 0, 0, 0] };
    vi.stubGlobal('navigator', { ...navigator, getGamepads: () => [pad] });
    await render();
    await refresh();
    expect((frame.mock.calls[0] as unknown[])[1]).toEqual([]);
    act(() => box().focus());
    await refresh();
    expect((frame.mock.calls[1] as unknown[])[1]).toEqual([{ kind: 'gamepad', index: 0, buttons: 1, axes: [0.5, 0, 0, 0] }]);
  });

  it('refuses a program file larger than a program may be, as it downloads', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(8 << 20));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(endless)));
    const onError = vi.fn();
    await render({ onError });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onError).toHaveBeenCalledWith('assets/game.wasm is larger than the 64 MB a program may be');
    expect(started).not.toHaveBeenCalled();
    expect(pulled).toBeLessThan(12);
  });

  it('fetches a program from an address with no redirect, no referrer and no cookies', async () => {
    started.mockResolvedValue(program());
    const fetched = vi.fn(async () => new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
    vi.stubGlobal('fetch', fetched);
    // No capability list is published here, so the address is the app's to reach.
    await render({ src: 'https://cdn.example/game.wasm' });
    expect(fetched).toHaveBeenCalledWith('https://cdn.example/game.wasm', expect.objectContaining({ redirect: 'error', referrerPolicy: 'no-referrer', credentials: 'omit' }));
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('fetches an address spelled without its scheme as another origin’s too', async () => {
    started.mockResolvedValue(program());
    const fetched = vi.fn(async () => new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
    vi.stubGlobal('fetch', fetched);
    await render({ src: '//cdn.example/game.wasm' });
    expect(fetched).toHaveBeenCalledWith('//cdn.example/game.wasm', expect.objectContaining({ redirect: 'error', referrerPolicy: 'no-referrer', credentials: 'omit' }));
  });

  it('lets go of a gamepad when the focus leaves, as of a key', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame, exports: [{ name: 'frame', kind: 'function' }, { name: 'gamepad', kind: 'function' }] }));
    const pad = { index: 1, connected: true, buttons: [{ pressed: true }], axes: [0, -1, 0, 0] };
    vi.stubGlobal('navigator', { ...navigator, getGamepads: () => [null, pad] });
    await render();
    act(() => box().focus());
    await refresh();
    expect((frame.mock.calls[0] as unknown[])[1]).toEqual([{ kind: 'gamepad', index: 1, buttons: 1, axes: [0, -1, 0, 0] }]);
    act(() => box().blur());
    await refresh();
    expect((frame.mock.calls[1] as unknown[])[1]).toEqual([{ kind: 'gamepad', index: 1, buttons: 0, axes: [0, 0, 0, 0] }]);
  });

  it('hands over what Option types on a Mac, and keeps Alt chords elsewhere', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame, exports: [{ name: 'frame', kind: 'function' }, { name: 'text', kind: 'function' }] }));
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      act(() => {
        box().dispatchEvent(event);
      });
      return event;
    };
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' });
    await render();
    act(() => box().focus());
    // Option+L on a German Mac layout.
    expect(press({ key: '@', code: 'KeyL', altKey: true }).defaultPrevented).toBe(true);
    await refresh();
    expect((frame.mock.calls[0] as unknown[])[1]).toEqual([
      { kind: 'key', code: 15, down: true },
      { kind: 'text', codepoint: 64 },
    ]);
    vi.stubGlobal('navigator', { ...navigator, platform: 'Win32' });
    // Alt+F on Windows: the browser's menu, not an f.
    expect(press({ key: 'f', code: 'KeyF', altKey: true }).defaultPrevented).toBe(false);
    await refresh();
    expect((frame.mock.calls[1] as unknown[])[1]).toEqual([]);
  });

  it('lets go of a key when the focus leaves even with the queue full', async () => {
    const frame = vi.fn(async () => {});
    started.mockResolvedValue(program({ frame, exports: [{ name: 'frame', kind: 'function' }, { name: 'key', kind: 'function' }, { name: 'text', kind: 'function' }] }));
    await render({ running: false });
    const target = box();
    act(() => target.focus());
    // Paused, a key held down repeats into a queue nothing drains.
    for (let i = 0; i < 600; i++) {
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', repeat: i > 0, bubbles: true, cancelable: true }));
      });
    }
    act(() => target.blur());
    await render({ running: true });
    await refresh();
    const events = (frame.mock.calls[0] as unknown[])[1] as unknown[];
    expect(events.at(-1)).toEqual({ kind: 'key', code: 4, down: false });
  });

  it('asks no more frames of a program that has exited', async () => {
    const frame = vi.fn(async () => {});
    let exit: (code: number) => void = () => {};
    started.mockImplementation(async (options) => {
      exit = (code) => options.onExit?.(code);
      return program({ frame });
    });
    const onExit = vi.fn();
    await render({ onExit });
    await refresh();
    expect(frame).toHaveBeenCalledTimes(1);
    act(() => exit(0));
    await refresh(3);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('stops a program still starting when it is taken off the page', async () => {
    let signal: AbortSignal | undefined;
    started.mockImplementation((options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    await render();
    expect(signal?.aborted).toBe(false);
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    root = createRoot(host);
  });

  it('knows the keys a game reads by the codes SDL gives them', () => {
    expect(WASM_KEY_CODES).toMatchObject({ KeyA: 4, KeyZ: 29, Digit1: 30, Digit0: 39, Enter: 40, Escape: 41, Space: 44, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, F1: 58, ShiftLeft: 225 });
  });

  it('passes what the program posts to the app', async () => {
    const onMessage = vi.fn();
    started.mockImplementation(async (options) => {
      setTimeout(() => options.onPost?.('level done'), 0);
      return program();
    });
    await render({ onMessage });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(onMessage).toHaveBeenCalledWith('level done');
  });

  it('shows what a program with no frame printed, and its exit code', async () => {
    const onExit = vi.fn();
    started.mockImplementation(async (options) => {
      options.onConsole?.('out', 'hello from a command');
      options.onConsole?.('err', 'a warning');
      return program({ drawsFrames: false, exitCode: 3 });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render({ onExit });
    expect(host.querySelector('pre')?.textContent).toBe('hello from a command\na warning\n(exited with code 3)');
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it('says why a program could not start', async () => {
    started.mockRejectedValue(new Error('The module is not valid WebAssembly: bad magic'));
    const onError = vi.fn();
    await render({ onError });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The module is not valid WebAssembly: bad magic');
    expect(onError).toHaveBeenCalledWith('The module is not valid WebAssembly: bad magic');
  });

  it('says so for a file the app does not have', async () => {
    const onError = vi.fn();
    await render({ src: 'assets/none.wasm', onError });
    expect(started).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/assets\/none\.wasm/));
  });

  it('stops the program with the component, and starts it again for another file', async () => {
    const first = program();
    const second = program({ handle: 'wasmapp-4567' });
    started.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await render();
    await render({ args: ['again'] });
    expect(first.stop).toHaveBeenCalled();
    expect(started).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    expect(second.stop).toHaveBeenCalled();
    root = createRoot(host);
  });
});
