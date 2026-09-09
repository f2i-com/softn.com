/**
 * The `window.__*` bridge between a script and the page.
 *
 * A script's `__` globals sync both ways: the games declare their input
 * latches that way and a component or the demo driver flips them on the real
 * window. What must not follow is the host's own globals — `__TAURI__`,
 * `__softnAsset` — which a script could otherwise replace from inside the VM.
 * And a handler that reached the host through `softn.*` has to have its call
 * carried out, not left in the engine's queue for the next function call.
 *
 * A key is discovered after the call that declared it and written back from
 * the next call on — the same shape as a game's `_init` followed by its tick
 * — so each test settles with a second call before it looks at the window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type PermissionConfig,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

const realWin = window as unknown as Record<string, unknown>;

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeRuntime(permissionConfig?: PermissionConfig) {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context, undefined, 'window-sync-test');
  if (permissionConfig) {
    (runtime as unknown as { setPermissionConfig(c: PermissionConfig): void }).setPermissionConfig(
      permissionConfig
    );
  }
  return Object.assign(runtime, { state });
}

const OWN_KEYS = ['__hostThing', '__lateFn', '__mine', '__latch'];

beforeEach(() => {
  for (const key of OWN_KEYS) delete realWin[key];
});

afterEach(() => {
  for (const key of OWN_KEYS) delete realWin[key];
  vi.unstubAllGlobals();
});

describe('window.__ sync and the host page', () => {
  it('never writes back a global the host page already had', async () => {
    const hostThing = { invoke: 'native' };
    realWin.__hostThing = hostThing;

    const runtime = makeRuntime();
    // Installed after the runtime was made, as a bundle's asset resolver is;
    // a function is the host's whatever the timing.
    const lateFn = () => 'asset';
    realWin.__lateFn = lateFn;

    const result = await runtime.loadScript(
      script(`
        function init() {
          window.__hostThing = "pwned"
          window.__lateFn = "pwned"
          window.__mine = 1
        }
        function tick() {}
      `)
    );
    await result.functions.init();
    await result.functions.tick();
    await result.functions.tick();

    expect(realWin.__hostThing).toBe(hostThing);
    expect(realWin.__lateFn).toBe(lateFn);
    // The app's own global still crosses.
    expect(realWin.__mine).toBe(1);

    runtime.cleanup();
  });

  it('keeps an app-declared latch flowing both ways', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let seen = 0
        function init() { window.__latch = false }
        function poll() {
          seen = window.__latch ? 1 : 0
          if (window.__latch) { window.__latch = false }
        }
      `)
    );
    await result.functions.init();
    await result.functions.poll();
    expect(realWin.__latch).toBe(false);
    expect(runtime.state.seen).toBe(0);

    // What Scene3D or the demo driver does: set it on the real window.
    realWin.__latch = true;
    await result.functions.poll();
    expect(runtime.state.seen).toBe(1);
    // And the script's reset came back out.
    expect(realWin.__latch).toBe(false);

    runtime.cleanup();
  });

  it('takes its own globals with it at cleanup and leaves the host alone', async () => {
    const hostThing = { invoke: 'native' };
    realWin.__hostThing = hostThing;

    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        function init() { window.__mine = 1; window.__hostThing = 2 }
        function tick() {}
      `)
    );
    await result.functions.init();
    await result.functions.tick();
    expect(realWin.__mine).toBe(1);

    runtime.cleanup();
    expect('__mine' in realWin).toBe(false);
    expect(realWin.__hostThing).toBe(hostThing);

    // A second runtime on the same page — a reload — sees the latch as its
    // own again, not as the host's.
    const again = makeRuntime();
    const result2 = await again.loadScript(
      script(`
        function init() { window.__mine = 7 }
        function tick() {}
      `)
    );
    await result2.functions.init();
    await result2.functions.tick();
    expect(realWin.__mine).toBe(7);
    again.cleanup();
  });
});

describe('host calls made from a window event handler', () => {
  class FakeAudio {
    static built: FakeAudio[] = [];
    src: string;
    volume = 1;
    loop = false;
    playbackRate = 1;
    paused = true;
    constructor(src?: string) {
      this.src = src ?? '';
      FakeAudio.built.push(this);
    }
    play(): Promise<void> {
      this.paused = false;
      return Promise.resolve();
    }
    pause(): void {
      this.paused = true;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  beforeEach(() => {
    FakeAudio.built = [];
    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  });

  it('are carried out after the dispatch, without waiting for another call', async () => {
    const runtime = makeRuntime({ permissions: { net: { enabled: true } } } as PermissionConfig);
    const result = await runtime.loadScript(
      script(`
        let outcome = ""
        function init() {
          window.addEventListener("keydown", function(e) {
            softn.audio.play("https://example.test/ping.wav", {}, function(r) {
              outcome = r.played ? "played" : "silent"
            })
          })
        }
      `)
    );
    // Registers the listener; the runtime bridges it to the real window.
    await result.functions.init();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    await tick();
    await tick();

    expect(FakeAudio.built).toHaveLength(1);
    expect(FakeAudio.built[0].src).toBe('https://example.test/ping.wav');
    expect(runtime.state.outcome).toBe('played');

    runtime.cleanup();
  });
});
