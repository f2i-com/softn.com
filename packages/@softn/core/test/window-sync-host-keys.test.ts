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

function makeRuntime(permissionConfig?: PermissionConfig, appId = 'window-sync-test') {
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
  const runtime = createScriptRuntime(context, undefined, appId);
  if (permissionConfig) {
    (runtime as unknown as { setPermissionConfig(c: PermissionConfig): void }).setPermissionConfig(
      permissionConfig
    );
  }
  return Object.assign(runtime, { state });
}

const OWN_KEYS = ['__hostThing', '__lateFn', '__mine', '__latch', '__shared', '__component'];

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

  it('never writes a name the host or SoftN may give a value later, however late', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        function init() {
          window.__TAURI__ = { core: { invoke: 1 } }
          window.__softnKeys = { w: true }
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = 1
          window.__mine = 1
        }
        function tick() {}
      `)
    );
    await result.functions.init();
    await result.functions.tick();
    await result.functions.tick();
    expect('__TAURI__' in realWin).toBe(false);
    expect('__softnKeys' in realWin).toBe(false);
    expect('__REACT_DEVTOOLS_GLOBAL_HOOK__' in realWin).toBe(false);
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

describe('two apps open on one page', () => {
  // SoftN Web keeps every open app mounted; the page has one window.
  const app = async (appId: string, code: string) => {
    const runtime = makeRuntime(undefined, appId);
    const result = await runtime.loadScript(script(code));
    return { runtime, result };
  };
  // Declares the key, then writes or reads it from the second call on.
  const writer = (value: string) => `
    function init() { window.__shared = "" }
    function tick() { window.__shared = "${value}" }
  `;
  const reader = `
    let seen = "nothing"
    function init() { window.__shared = "" }
    function tick() { seen = String(window.__shared) }
  `;

  it('do not read or write what the other\'s script wrote onto the window', async () => {
    const a = await app('app-a', writer('the records of A'));
    await a.result.functions.init();
    await a.result.functions.tick();
    await a.result.functions.tick();
    expect(realWin.__shared).toBe('the records of A');

    const b = await app('app-b', reader);
    await b.result.functions.init();
    await b.result.functions.tick();
    await b.result.functions.tick();
    expect(b.runtime.state.seen).not.toBe('the records of A');

    const c = await app('app-c', writer('written over by C'));
    await c.result.functions.init();
    await c.result.functions.tick();
    await c.result.functions.tick();
    expect(realWin.__shared).toBe('the records of A');

    // A closes: the key is no one's, and C's script may have it.
    a.runtime.cleanup();
    expect('__shared' in realWin).toBe(false);
    await c.result.functions.tick();
    await c.result.functions.tick();
    expect(realWin.__shared).toBe('written over by C');
    b.runtime.cleanup();
    c.runtime.cleanup();
  });

  it('share a key as two views of one app, which keeps it while either is open', async () => {
    const one = await app('app-a', writer('from the first view'));
    await one.result.functions.init();
    await one.result.functions.tick();
    await one.result.functions.tick();
    const two = await app('app-a', writer('from the second view'));
    await two.result.functions.init();
    await two.result.functions.tick();
    await two.result.functions.tick();
    expect(realWin.__shared).toBe('from the second view');

    one.runtime.cleanup();
    expect(realWin.__shared).toBe('from the second view');
    two.runtime.cleanup();
    expect('__shared' in realWin).toBe(false);
  });

  // Scene3D keeps the window's yaw when a scene mounts and puts it back when
  // the last one goes, so a component's write can be another app's value. A
  // claim that lapsed whenever the window held something its app had not
  // just written handed that value to the next app that read the key.
  it("never read another app's value that a component put back on the window", async () => {
    const b = await app('app-b', `
      function init() { window.__scene3dYaw = 0 }
      function tick() { window.__scene3dYaw = { records: ["B1", "B2"] } }
    `);
    const a = await app('app-a', `
      let seen = "nothing"
      function init() { window.__scene3dYaw = 0 }
      function tick() { seen = JSON.stringify(window.__scene3dYaw) }
    `);
    await b.result.functions.init();
    await a.result.functions.init();
    realWin.__scene3dYaw = 0;
    await b.result.functions.tick();
    await b.result.functions.tick();
    expect(realWin.__scene3dYaw).toEqual({ records: ['B1', 'B2'] });

    // A's scene mounts: the component keeps B's value and writes A's yaw.
    const kept = realWin.__scene3dYaw;
    realWin.__scene3dYaw = 0.5;
    await a.result.functions.tick();
    // A's scene goes: the component puts back what it kept.
    realWin.__scene3dYaw = kept;
    await a.result.functions.tick();
    expect(a.runtime.state.seen).not.toContain('B1');

    a.runtime.cleanup();
    b.runtime.cleanup();
    delete realWin.__scene3dYaw;
  });

  it('both hear a key only a component sets', async () => {
    const code = `
      let seen = "nothing"
      function init() { window.__component = "" }
      function tick() { seen = String(window.__component) }
    `;
    const a = await app('app-a', code);
    const b = await app('app-b', code);
    await a.result.functions.init();
    await b.result.functions.init();
    // What Scene3D does: set it on the real window.
    realWin.__component = 'locked';
    await a.result.functions.tick();
    await b.result.functions.tick();
    expect(a.runtime.state.seen).toBe('locked');
    expect(b.runtime.state.seen).toBe('locked');
    a.runtime.cleanup();
    b.runtime.cleanup();
  });
});

describe('a name the logic only reads', () => {
  const SCENE = ['__softnKeys', '__scene3dLocked', '__scene3dYaw', '__scene3dPitch', '__scene3dWantLock', '__scene3dReleaseLock', '__viteThing'];
  const clear = () => {
    for (const key of SCENE) delete realWin[key];
  };
  beforeEach(clear);
  afterEach(clear);

  // A name was shared only once the script had written it, so a game began
  // by assigning every name it meant to read; one that did not read
  // `undefined` for ever, with nothing to say why.
  it('is seen without being written first: the keys a scene holds, and its pointer lock', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let sawKeys = "not read"
        let sawLock = "not read"
        function step() {
          sawKeys = window.__softnKeys ? "w=" + window.__softnKeys.w : "undefined"
          sawLock = String(window.__scene3dLocked)
        }
      `)
    );
    // What the component does on the real window, after the script has loaded.
    realWin.__softnKeys = { w: true, space: false };
    realWin.__scene3dLocked = true;
    await result.functions.step();
    expect(runtime.state.sawKeys).toBe('w=true');
    expect(runtime.state.sawLock).toBe('true');

    // And as they change, at each call.
    (realWin.__softnKeys as Record<string, boolean>).w = false;
    realWin.__scene3dLocked = false;
    await result.functions.step();
    expect(runtime.state.sawKeys).toBe('w=false');
    expect(runtime.state.sawLock).toBe('false');
    runtime.cleanup();
  });

  // Reading a name earlier changes nothing about when a write to it reaches
  // the page: found on the script's window after the call that wrote it,
  // and written from the next, as the head of this file says.
  it('is written to the page as it always was once the logic does write it: from the next call', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        function start() { window.__scene3dWantLock = true }
        function idle() {}
      `)
    );
    await result.functions.start();
    expect('__scene3dWantLock' in realWin).toBe(false);
    await result.functions.idle();
    expect(realWin.__scene3dWantLock).toBe(true);
    runtime.cleanup();
    expect('__scene3dWantLock' in realWin).toBe(false);
  });

  it('is not one of the host’s or a framework’s, which are shared as they were: once written', async () => {
    realWin.__viteThing = { secret: 1 };
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let seen = "not read"
        function look() { seen = typeof window.__viteThing }
      `)
    );
    await result.functions.look();
    await result.functions.look();
    expect(runtime.state.seen).toBe('undefined');
    runtime.cleanup();
  });

  it('is not taken from a comment or a string', async () => {
    const { windowNamesIn } = await import('../src/runtime/window-bridge');
    expect(windowNamesIn('// window.__scene3dYaw\nlet s = "window.__softnKeys"; let t = window.__scene3dLocked + window . __scene3dPitch')).toEqual({ read: ['__scene3dLocked', '__scene3dPitch'], shared: [] });
    expect(windowNamesIn('let n = 1')).toEqual({ read: [], shared: [] });
    // Only SoftN's own names: any other is shared as it always was, once the script has written it.
    expect(windowNamesIn('let t = window.__c + window . __d; f(window.__hostConfig)')).toEqual({ read: [], shared: [] });
    expect(windowNamesIn('if (softn.input.down("w")) go()')).toEqual({ read: ['__softnKeys'], shared: [] });
    expect(windowNamesIn('softn.input.captureKeys(["a"])')).toEqual({ read: [], shared: [] });
    expect(windowNamesIn('yaw = softn.scene.yaw')).toEqual({
      read: [],
      shared: ['__scene3dYaw', '__scene3dPitch', '__scene3dLocked', '__scene3dWantLock', '__scene3dReleaseLock'],
    });
    expect(windowNamesIn('let k = window.__softnKeys; let t = window.__TAURI__')).toEqual({ read: ['__softnKeys'], shared: [] });
    // A name the text assigns anywhere is the script's own, shared as it always was.
    expect(windowNamesIn('if (!window.__on) { window.__on = true }')).toEqual({ read: [], shared: [] });
    for (const written of ['window.__n++', '++window.__n', 'window.__n += 1', 'window.__n ||= 1', 'window.__n ??= {}', 'delete window.__n', 'window . __n=2']) {
      const own = written.replace('__n', '__scene3dYaw');
      expect(windowNamesIn(`let a = window.__scene3dYaw; ${own}`), own).toEqual({ read: [], shared: [] });
    }
    // Comparing it, or writing into what it holds, is reading it.
    for (const read of ['window.__n == 1', 'window.__n === 1', 'window.__n <= 1', 'window.__n >= 1', 'window.__n != 1', 'window.__n.w = true', 'window.__n[0] = 1', 'f(window.__n)']) {
      const own = read.replace('__n', '__softnKeys');
      expect(windowNamesIn(own), own).toEqual({ read: ['__softnKeys'], shared: [] });
    }
    // `softn.input` and `softn.scene` are reached by more than their own spelling. Found by
    // review, 2026-11-13: `const input = softn.input; input.down("w")` answered false for ever.
    const ALL = ['__scene3dYaw', '__scene3dPitch', '__scene3dLocked', '__scene3dWantLock', '__scene3dReleaseLock'];
    expect(windowNamesIn('const input = softn.input; if (input.down("w")) go()')).toEqual({ read: ['__softnKeys'], shared: [] });
    expect(windowNamesIn('const { scene } = softn; yaw = scene.yaw')).toEqual({ read: [], shared: ALL });
    expect(windowNamesIn('const { input: pad, scene } = softn')).toEqual({ read: ['__softnKeys'], shared: ALL });
    expect(windowNamesIn('const s = softn\nfunction f() { return s.scene.locked }')).toEqual({ read: ['__softnKeys'], shared: ALL });
    expect(windowNamesIn('start(softn)')).toEqual({ read: ['__softnKeys'], shared: ALL });
    expect(windowNamesIn('const look = softn?.scene')).toEqual({ read: [], shared: ALL });
    // Other parts of `softn` reach neither.
    expect(windowNamesIn('const db = softn.db; softn.nav.go("home"); const { net } = softn')).toEqual({ read: [], shared: [] });
    // The old way round the bug, writing the keys' name first, is left as it worked.
    expect(windowNamesIn('window.__softnKeys = {}; let w = window.__softnKeys.w')).toEqual({ read: [], shared: [] });
    expect(windowNamesIn('window.__softnKeys = {}; let w = softn.input.down("w")')).toEqual({ read: ['__softnKeys'], shared: [] });
  });

  // Snake starts with `if (!window.__snakeKeyListenerAdded) { … = true; listen }`.
  // A name the text also writes is not handed over before the script has
  // written it, so a second view of the same app, whose first view has put
  // the name on the page, still finds it unset on its own first call.
  it('leaves a name the logic also writes as it was: a second view of the app starts as the first did', async () => {
    const GUARD = `
      let listening = "no"
      function _init() {
        if (!window.__listening) { window.__listening = true; listening = "yes" }
      }
      function idle() {}
    `;
    const first = makeRuntime(undefined, 'guarded-app');
    const one = await first.loadScript(script(GUARD));
    await one.functions._init();
    await one.functions.idle();
    expect(first.state.listening).toBe('yes');
    expect(realWin.__listening).toBe(true);

    const second = makeRuntime(undefined, 'guarded-app');
    const two = await second.loadScript(script(GUARD));
    await two.functions._init();
    expect(second.state.listening).toBe('yes');
    first.cleanup();
    second.cleanup();
    delete realWin.__listening;
  });

  // What a scene keeps on the window as a record it changes in place (the keys
  // it holds) is read by the logic, never replaced by the logic's copy of it,
  // and never claimed: another app reads it too.
  it('reads the record a scene keeps on the window without taking it over', async () => {
    const kept: Record<string, unknown> = { w: false };
    const READER = `
      let seen = "nothing"
      function look() { seen = window.__softnKeys ? "w=" + window.__softnKeys.w : "undefined" }
    `;
    const a = makeRuntime(undefined, 'reader-a');
    const b = makeRuntime(undefined, 'reader-b');
    const one = await a.loadScript(script(READER));
    const two = await b.loadScript(script(READER));
    realWin.__softnKeys = kept;
    await one.functions.look();
    await one.functions.look();
    expect(a.state.seen).toBe('w=false');
    // Still the component's own object, so what it changes in place is seen.
    expect(realWin.__softnKeys).toBe(kept);
    kept.w = true;
    await one.functions.look();
    await two.functions.look();
    expect(a.state.seen).toBe('w=true');
    expect(b.state.seen).toBe('w=true');
    a.cleanup();
    b.cleanup();
    // Not the logic's to take away either.
    expect(realWin.__softnKeys).toBe(kept);
  });

  // Found by review, 2026-11-13. Handing over whatever the page holds under a
  // name, for the naming of it, let an app read what the page it is embedded
  // in keeps on its window: the probe read `window.__hostConfig.token`.
  it('is one of SoftN’s own, and no other: what the page keeps on its window is not handed over for the asking', async () => {
    realWin.__hostConfig = { token: 'the page’s own' };
    realWin.__viewState = { a: 1 };
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let token = "not read"
        let view = "not read"
        function look() {
          token = window.__hostConfig ? String(window.__hostConfig.token) : "undefined"
          view = window.__viewState ? "a=" + window.__viewState.a : "undefined"
        }
      `)
    );
    for (let call = 0; call < 3; call++) await result.functions.look();
    expect(runtime.state.token).toBe('undefined');
    expect(runtime.state.view).toBe('undefined');
    runtime.cleanup();
    expect(realWin.__hostConfig).toEqual({ token: 'the page’s own' });
    delete realWin.__hostConfig;
    delete realWin.__viewState;
  });

  // Found by review, 2026-11-13: a latch read by its name and set some other
  // way was taken for one the logic only reads, so a second view of the app
  // was handed the first view's on its first call and never started.
  it('a latch of the app’s own set some way its text does not show is still the app’s own: a second view starts', async () => {
    for (const set of ['window["__listening"] = true', 'const w = window; w.__listening = true', 'Object.assign(window, { __listening: true })']) {
      const GUARD = `
        let listening = "no"
        function _init() {
          if (!window.__listening) { ${set}; listening = "yes" }
        }
        function idle() {}
      `;
      const first = makeRuntime(undefined, 'guarded-app');
      const one = await first.loadScript(script(GUARD));
      await one.functions._init();
      await one.functions.idle();
      expect(first.state.listening, set).toBe('yes');

      const second = makeRuntime(undefined, 'guarded-app');
      const two = await second.loadScript(script(GUARD));
      await two.functions._init();
      expect(second.state.listening, set).toBe('yes');
      first.cleanup();
      second.cleanup();
      delete realWin.__listening;
    }
  });

  // Found by review, 2026-11-13: `softn.scene.locked` went on saying the
  // pointer was held after the scene that held it had gone.
  it('is taken from the logic when the page takes it away', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let locked = "not read"
        let direct = "not read"
        function look() {
          locked = String(softn.scene.locked)
          direct = String(window.__scene3dLocked)
        }
      `)
    );
    realWin.__scene3dLocked = true;
    await result.functions.look();
    expect(runtime.state.locked).toBe('true');
    // The scene unmounts.
    delete realWin.__scene3dLocked;
    await result.functions.look();
    expect(runtime.state.locked).toBe('false');
    expect(runtime.state.direct).toBe('undefined');
    // And another mounts.
    realWin.__scene3dLocked = true;
    await result.functions.look();
    expect(runtime.state.locked).toBe('true');
    runtime.cleanup();
  });
});

describe('softn.input and softn.scene: names for what the page and the logic share', () => {
  const SCENE = ['__softnKeys', '__scene3dLocked', '__scene3dYaw', '__scene3dPitch', '__scene3dWantLock', '__scene3dReleaseLock'];
  const clear = () => {
    for (const key of SCENE) delete realWin[key];
  };
  beforeEach(clear);
  afterEach(clear);

  it('softn.input.keys and softn.input.down read the keys a scene holds', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let forward = "?"
        let jump = "?"
        let held = "?"
        function step() {
          forward = softn.input.down("w")
          jump = softn.input.down("space")
          held = Object.keys(softn.input.keys).filter(k => softn.input.keys[k]).join(",")
        }
        function press() { softn.input.keys.a = true; window.__softnKeys = { a: true } }
      `)
    );
    // No scene with gameControls is drawn: nothing is held, and nothing fails.
    await result.functions.step();
    expect([runtime.state.forward, runtime.state.jump, runtime.state.held]).toEqual([false, false, '']);

    realWin.__softnKeys = { w: true, a: false, space: true };
    await result.functions.step();
    expect([runtime.state.forward, runtime.state.jump, runtime.state.held]).toEqual([true, true, 'w,space']);

    // Logic cannot press a key for the page: the name is SoftN's own.
    await result.functions.press();
    await result.functions.press();
    expect((realWin.__softnKeys as Record<string, boolean>).a).toBe(false);
    runtime.cleanup();
  });

  it('softn.scene reads where the scene looks and whether it holds the pointer', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let yaw = -1, pitch = -1, locked = "?"
        function step() { yaw = softn.scene.yaw; pitch = softn.scene.pitch; locked = softn.scene.locked }
      `)
    );
    // No scene yet: zero and not locked, never undefined.
    await result.functions.step();
    expect([runtime.state.yaw, runtime.state.pitch, runtime.state.locked]).toEqual([0, 0, false]);

    // What a pointerLock scene writes as the mouse moves.
    realWin.__scene3dYaw = 1.25;
    realWin.__scene3dPitch = -0.5;
    realWin.__scene3dLocked = true;
    await result.functions.step();
    expect([runtime.state.yaw, runtime.state.pitch, runtime.state.locked]).toEqual([1.25, -0.5, true]);
    // Reading changed nothing on the page.
    expect([realWin.__scene3dYaw, realWin.__scene3dPitch, realWin.__scene3dLocked]).toEqual([1.25, -0.5, true]);
    runtime.cleanup();
  });

  it('softn.scene.lock() and unlock() ask the scene, and setting yaw turns it, by the end of the same call', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        function start() { softn.scene.yaw = 3; softn.scene.pitch = 0.25; softn.scene.lock() }
        function menu() { softn.scene.unlock() }
        function idle() {}
      `)
    );
    await result.functions.start();
    expect(realWin.__scene3dWantLock).toBe(true);
    expect([realWin.__scene3dYaw, realWin.__scene3dPitch]).toEqual([3, 0.25]);

    // The scene takes the request and clears it; logic that does not ask again does not ask again.
    realWin.__scene3dWantLock = false;
    realWin.__scene3dYaw = 3.5;
    await result.functions.idle();
    expect(realWin.__scene3dWantLock).toBe(false);
    // Nor is the look the mouse has moved since put back to what logic last set.
    expect(realWin.__scene3dYaw).toBe(3.5);

    await result.functions.menu();
    expect(realWin.__scene3dReleaseLock).toBe(true);
    runtime.cleanup();
  });

  // Found by review, 2026-11-13. A scene puts where it looks on the window as
  // it mounts. Logic started after that (a newer version of the app handed over
  // in place, an editor's preview drawn again) took the names for the host's
  // own and could never write them: `softn.scene.yaw = 0` did nothing.
  it('setting yaw, and asking for the pointer, work for logic started after a scene is already there', async () => {
    realWin.__scene3dYaw = 1.2;
    realWin.__scene3dPitch = 0.3;
    realWin.__scene3dLocked = false;
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let yaw = -1
        function look() { yaw = softn.scene.yaw }
        function start() { softn.scene.yaw = 0; softn.scene.pitch = 0; softn.scene.lock() }
      `)
    );
    await result.functions.look();
    expect(runtime.state.yaw).toBe(1.2);
    await result.functions.start();
    expect([realWin.__scene3dYaw, realWin.__scene3dPitch, realWin.__scene3dWantLock]).toEqual([0, 0, true]);
    runtime.cleanup();
  });

  // The same by the window names an older game writes.
  it('the window names are written too by logic started after a scene is already there', async () => {
    realWin.__scene3dYaw = 1.2;
    realWin.__scene3dWantLock = false;
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        function init() { window.__scene3dYaw = 0; window.__scene3dWantLock = false }
        function start() { window.__scene3dYaw = 2; window.__scene3dWantLock = true }
        function idle() {}
      `)
    );
    await result.functions.init();
    await result.functions.start();
    await result.functions.idle();
    expect([realWin.__scene3dYaw, realWin.__scene3dWantLock]).toEqual([2, true]);
    runtime.cleanup();
  });

  it('the window names still work beside them, in one app', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadScript(
      script(`
        let locked = "?"
        function init() { window.__scene3dLocked = false; window.__scene3dWantLock = false }
        function start() { window.__scene3dWantLock = true }
        function step() { locked = softn.scene.locked }
      `)
    );
    await result.functions.init();
    await result.functions.start();
    expect(realWin.__scene3dWantLock).toBe(true);
    realWin.__scene3dLocked = true;
    await result.functions.step();
    expect(runtime.state.locked).toBe(true);
    runtime.cleanup();
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
