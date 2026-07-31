/**
 * softn.audio — sound from a .logic script.
 *
 * These drive the real VM, so what they pin is the whole path a bundle takes:
 * script calls the bridge, the bridge calls the host, the host makes a noise.
 * The interesting cases are the ones an author cannot see going wrong — a
 * bundle path that never resolved, a browser that quietly refused, and a
 * looping track still playing after the app that started it has gone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createScriptRuntime,
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

/** Every Audio element the runtime has constructed this test. */
let built: FakeAudio[];
/** What the next play() should do. */
let playBehaviour: () => Promise<void>;

class FakeAudio {
  src: string;
  volume = 1;
  loop = false;
  playbackRate = 1;
  currentTime = 0;
  paused = true;
  plays = 0;
  private listeners = new Map<string, Array<() => void>>();

  constructor(src?: string) {
    this.src = src ?? '';
    built.push(this);
  }
  play(): Promise<void> {
    this.plays++;
    return playBehaviour().then(() => { this.paused = false; });
  }
  pause(): void { this.paused = true; }
  addEventListener(name: string, fn: () => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  removeEventListener(): void { /* not needed */ }
  emit(name: string): void { for (const fn of this.listeners.get(name) ?? []) fn(); }
}

function notAllowed(): Promise<void> {
  const err = new Error('play() failed because the user did not interact with the document first');
  (err as Error & { name: string }).name = 'NotAllowedError';
  return Promise.reject(err);
}

beforeEach(() => {
  built = [];
  playBehaviour = () => Promise.resolve();
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function script(code: string): ScriptBlock {
  return { type: 'ScriptBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } };
}

/** The runtime plus the state object its script writes into, so callbacks
 *  that set a variable can be asserted on. */
function makeRuntime(externalFunctions?: Record<string, (...args: unknown[]) => unknown>) {
  const state: Record<string, unknown> = {};
  const context: ScriptContext = {
    state,
    setState: (path: string, value: unknown) => { state[path] = value; },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(
    context, undefined, undefined, undefined, undefined, undefined, undefined, externalFunctions
  );
  return Object.assign(runtime, { state });
}

describe('softn.audio.play', () => {
  it('plays a sound and hands the script a handle to stop it by', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      let outcome = ""
      let handle = ""
      function ring() {
        softn.audio.play("https://example.test/ping.wav", {}, function(r) {
          outcome = r.played ? "played" : "silent"
          handle = r.handle || ""
        })
      }
    `));

    await result.functions.ring();
    expect(built).toHaveLength(1);
    expect(built[0].src).toBe('https://example.test/ping.wav');
    expect(built[0].plays).toBe(1);
    expect(runtime.state.outcome).toBe('played');
    expect(String(runtime.state.handle)).toMatch(/^snd-\d+$/);
  });

  it('resolves a path inside the bundle the same way a template does', async () => {
    // A script says "assets/blip.wav"; only the host knows that is a blob URL.
    // Without this the element would be handed a relative path, the browser
    // would resolve it against the page, and the sound would silently 404.
    const asset = vi.fn((path: unknown) => `blob:resolved/${String(path)}`);
    const runtime = makeRuntime({ asset });
    const result = await runtime.loadScript(script(`
      function ring() { softn.audio.play("assets/blip.wav") }
    `));

    await result.functions.ring();
    expect(asset).toHaveBeenCalledWith('assets/blip.wav');
    expect(built[0].src).toBe('blob:resolved/assets/blip.wav');
  });

  it('leaves an already-resolved URL alone', async () => {
    const asset = vi.fn(() => 'blob:should-not-be-used');
    const runtime = makeRuntime({ asset });
    const result = await runtime.loadScript(script(`
      function ring() { softn.audio.play("blob:already-a-url") }
    `));

    await result.functions.ring();
    expect(asset).not.toHaveBeenCalled();
    expect(built[0].src).toBe('blob:already-a-url');
  });

  it('applies volume, looping and rate', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      function music() {
        softn.audio.play("https://example.test/theme.mp3", { volume: 0.4, loop: true, rate: 0.9 })
      }
    `));

    await result.functions.music();
    expect(built[0].volume).toBeCloseTo(0.4);
    expect(built[0].loop).toBe(true);
    expect(built[0].playbackRate).toBeCloseTo(0.9);
  });
});

describe('softn.audio when the browser refuses', () => {
  it('reports a blocked one-shot rather than throwing', async () => {
    // Nothing may make noise before the user has touched the page. That is the
    // policy working; an app should be able to tell, and carry on.
    playBehaviour = notAllowed;
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      let blocked = false
      let played = true
      let why = ""
      function ring() {
        softn.audio.play("https://example.test/ping.wav", {}, function(r) {
          blocked = r.blocked === true
          played = r.played === true
          why = r.reason || ""
        })
      }
    `));

    await result.functions.ring();

    expect(runtime.state.blocked).toBe(true);
    expect(runtime.state.played).toBe(false);
    expect(String(runtime.state.why)).toContain('interacted');
  });

  it('starts a refused soundtrack on the first thing the user does', async () => {
    // A one-shot that was blocked is gone — playing it later would be noise at
    // the wrong moment. A loop is a soundtrack, and it is still wanted.
    playBehaviour = notAllowed;
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      function music() { softn.audio.play("https://example.test/theme.mp3", { loop: true }) }
    `));

    await result.functions.music();
    expect(built[0].plays).toBe(1);

    playBehaviour = () => Promise.resolve();
    window.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();

    expect(built[0].plays, 'the soundtrack should start once it is allowed to').toBe(2);
    runtime.cleanup();
  });

  it('does not wait around for a one-shot that was refused', async () => {
    playBehaviour = notAllowed;
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      function ring() { softn.audio.play("https://example.test/ping.wav") }
    `));

    await result.functions.ring();
    playBehaviour = () => Promise.resolve();
    window.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();

    expect(built[0].plays, 'a missed sound effect belongs in the past').toBe(1);
    runtime.cleanup();
  });
});

describe('softn.audio.stop', () => {
  it('stops one sound by handle and leaves the rest alone', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      let first = ""
      function two() {
        softn.audio.play("https://example.test/a.wav", {}, function(r) { first = r.handle })
        softn.audio.play("https://example.test/b.wav")
      }
      function hush() { softn.audio.stop(first) }
    `));

    await result.functions.two();
    expect(built).toHaveLength(2);
    await result.functions.hush();

    expect(built[0].paused).toBe(true);
    expect(built[1].paused).toBe(false);
  });

  it('stopAll silences everything', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      function noise() {
        softn.audio.play("https://example.test/a.wav")
        softn.audio.play("https://example.test/b.wav")
      }
      function hush() { softn.audio.stopAll() }
    `));

    await result.functions.noise();
    await result.functions.hush();
    expect(built.every((a) => a.paused)).toBe(true);
  });
});

describe('softn.audio.setVolume', () => {
  it('scales what is playing now as well as what comes next', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      function music() { softn.audio.play("https://example.test/theme.mp3", { volume: 0.8, loop: true }) }
      function quieter() { softn.audio.setVolume(0.5) }
      function ping() { softn.audio.play("https://example.test/ping.wav", { volume: 1 }) }
    `));

    await result.functions.music();
    await result.functions.quieter();
    // The track keeps its own level; master scales it, rather than replacing it.
    expect(built[0].volume).toBeCloseTo(0.4);

    await result.functions.ping();
    expect(built[1].volume).toBeCloseTo(0.5);
    runtime.cleanup();
  });
});

describe('softn.audio and the app closing', () => {
  it('stops a looping track when the runtime is torn down', async () => {
    // Nothing stops a loop on its own. Closing the tab on an app playing music
    // would leave it playing for the rest of the session, with nothing on
    // screen left to turn it off.
    const runtime = makeRuntime();
    const result = await runtime.loadScript(script(`
      function music() { softn.audio.play("https://example.test/theme.mp3", { loop: true }) }
    `));

    await result.functions.music();
    expect(built[0].paused).toBe(false);

    runtime.cleanup();
    expect(built[0].paused).toBe(true);
  });
});
