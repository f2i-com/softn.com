/**
 * Round 4: the container's Worker session (src/worker-runtime.ts): each call of the app's
 * answered once, and nothing of the app's kept after it is over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { ContainerWorkerSession } from '../src/worker-runtime';
import { loadZippEngine } from '../src/zipp-loader';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

const page = (script: string) => `<!doctype html><html><head><title>t</title></head><body><p id="out">…</p><script>
  var out = {};
  var done = function () { document.getElementById('out').textContent = JSON.stringify(out); };
  var fail = function (e) { out.failed = String(e && e.name) + ': ' + String(e && e.message); done(); };
  ${script}
</script></body></html>`;

async function open(source: Record<string, string | Uint8Array>, extra: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source,
    ...extra,
  });
  const text = (selector: string): string => handle.shadowRoot.querySelector(selector)?.textContent ?? '(not on the page)';
  const result = async (timeout = 5_000): Promise<Record<string, unknown>> => {
    await expect.poll(() => text('#out'), { timeout, interval: 10 }).not.toBe('…');
    return JSON.parse(text('#out')) as Record<string, unknown>;
  };
  return { handle, said, text, result };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type SessionInternals = {
  fulfillHostCall: (callId: number, kind: string, args: string[]) => Promise<void>;
  resolveCallbackAndFlush: (callId: number, result: unknown) => void;
};

describe('what the page tells the Worker while the app is still starting', () => {
  it('is told to the app once its program is there, and is not reported as an error of the app’s', async () => {
    // The app's module imports a hosted library the Worker fetches as it starts: while it
    // waits, the page is resized and another tab writes the app's localStorage.
    let fetched: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => { fetched = resolve; });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).includes('vendor/gltf-loader')) {
        fetched();
        await held;
        return new Response('export default function load() { return "loaded"; }', { status: 200, headers: { 'content-type': 'text/javascript' } });
      }
      throw new TypeError('Failed to fetch');
    });
    const sessions: ContainerWorkerSession[] = [];
    const proto = ContainerWorkerSession.prototype as unknown as { handleMessage: (msg: unknown) => Promise<void> };
    const handle0 = proto.handleMessage;
    vi.spyOn(proto, 'handleMessage').mockImplementation(function (this: ContainerWorkerSession, msg: unknown) {
      if (!sessions.includes(this)) sessions.push(this);
      return handle0.call(this, msg);
    });
    const mounting = open({
      'index.html': `<!doctype html><html><body><p id="out">…</p><script type="module">
        import load from 'gltf-loader';
        document.getElementById('out').textContent = JSON.stringify({ load: load(), width: window.innerWidth, height: window.innerHeight, kept: localStorage.getItem('other-tab') });
      </script></body></html>`,
    });
    await asked;
    const session = sessions[0] as unknown as { handleMessage: (msg: unknown) => Promise<void> };
    await session.handleMessage({ type: 'sync', changes: [['W', [777, 333, false, false, 1, false]]] });
    await session.handleMessage({ type: 'storage-changed', area: 'ls', key: 'other-tab', value: 'written there' });
    release();
    const { handle, said, result } = await mounting;
    expect(await result()).toEqual({ load: 'loaded', width: 777, height: 333, kept: 'written there' });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });
});

describe('the engine’s synchronous calls', () => {
  it('are named within what the engine takes (32 kinds; one more and no app started)', async () => {
    const bindings = await loadZippEngine({
      tier: 'lite',
      explicitSource: LITE_WASM,
      fallbackGlueFactory: async () => (await import('../../core/wasm-zipp/zipp_wasm.js')) as unknown as Record<string, unknown>,
    });
    const proto = bindings.Engine.prototype as { setSyncHostCapabilities: (ops: string[]) => void };
    const named: number[] = [];
    const plain = proto.setSyncHostCapabilities;
    const spy = vi.spyOn(proto, 'setSyncHostCapabilities').mockImplementation(function (this: unknown, ops: string[]) {
      named.push(ops.length);
      return plain.call(this, ops);
    });
    try {
      const { handle, result } = await open({
        'work.js': `self.onmessage = function (e) { self.postMessage(e.data + 1); };`,
        'index.html': page(`
          localStorage.setItem('k', 'v');
          var w = new Worker('work.js');
          w.onmessage = function (e) { out.worker = e.data; out.keys = localStorage.length; done(); };
          w.postMessage(1);
        `),
      });
      expect(await result()).toEqual({ worker: 2, keys: 1 });
      expect(named.length).toBeGreaterThan(0);
      expect(Math.max(...named)).toBeLessThanOrEqual(32);
      handle.dispose();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('what a turn changes on the page', () => {
  it('reaches the page whole when it is more than a batch holds (the rest of the page past the bound was dropped)', async () => {
    const { handle, result, said } = await open(
      {
        'index.html': page(`
          var rows = [];
          for (var i = 0; i < 12000; i++) rows.push('<tr><td>' + i + '</td><td>row ' + i + '</td></tr>');
          var table = document.createElement('table');
          table.innerHTML = '<tbody>' + rows.join('') + '</tbody>';
          document.body.appendChild(table);
          out.rows = table.querySelectorAll('tr').length;
          done();
        `),
      },
      { limits: { instructionsPerTurn: 2_000_000_000 } }
    );
    // The page's #out is changed last, in the part of the batch that never came.
    expect(await result(20_000)).toEqual({ rows: 12000 });
    const shown = () => handle.shadowRoot.querySelectorAll('tr').length;
    await expect.poll(shown, { timeout: 20_000, interval: 50 }).toBe(12000);
    const last = handle.shadowRoot.querySelectorAll('tr')[11999];
    expect(last?.textContent).toBe('11999row 11999');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  }, 60_000);
});

describe('modules the app asks for while it runs', () => {
  it('are each handed over before a load that needs them is answered (two at once that share one failed)', async () => {
    const { handle, result, said } = await open({
      'shared.js': `export const shared = 'shared';`,
      'x.js': `import { shared } from './shared.js'; export const x = 'x+' + shared;`,
      'a.js': `import { x } from './x.js'; export const a = 'a+' + x;`,
      'b.js': `import { shared } from './shared.js'; export const b = 'b+' + shared;`,
      'c.js': `import { b } from './b.js'; import { x } from './x.js'; export const c = 'c+' + b + '+' + x;`,
      'index.html': `<!doctype html><html><body><p id="out">…</p><script type="module">
        // Two routes of an app loaded at once, as a router and its prefetch load them.
        Promise.all([import('./a.js'), import('./b.js'), import('./c.js'), import('./b.js')]).then(function (all) {
          document.getElementById('out').textContent = JSON.stringify({ a: all[0].a, b: all[1].b, c: all[2].c, same: all[1] === all[3] });
        }, function (e) { document.getElementById('out').textContent = JSON.stringify({ failed: String(e && e.message) }); });
      </script></body></html>`,
    });
    expect(await result()).toEqual({ a: 'a+x+shared', b: 'b+shared', c: 'c+b+shared+x+shared', same: true });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('name the module that did not compile, not the one beside it', async () => {
    const { handle, result } = await open({
      'util.js': `export const util = 'util';`,
      'broken.jsx': `export default function Broken() { return <div><span>open; }`,
      'page.js': `import { util } from './util.js'; import Broken from './broken.jsx'; export const page = util + Broken;`,
      'index.html': `<!doctype html><html><body><p id="out">…</p><script type="module">
        var out = {};
        import('./page.js').then(function () { out.page = 'loaded'; }, function (e) { out.page = String(e && e.message); })
          .then(function () { return import('./util.js'); })
          .then(function (m) { out.util = m.util; }, function (e) { out.util = String(e && e.message); })
          .then(function () { document.getElementById('out').textContent = JSON.stringify(out); });
      </script></body></html>`,
    });
    const got = await result();
    expect(String(got.page)).toMatch(/^https:\/\/app\.softn\.local\/broken\.jsx: /);
    expect(got.util).toBe('util');
    handle.dispose();
  });
});

describe('a Worker of the app’s own', () => {
  it('answers its start when the app ends it at once (the start was left waiting in the app’s engine for good)', async () => {
    const proto = ContainerWorkerSession.prototype as unknown as SessionInternals;
    const starts: number[] = [];
    const answered: number[] = [];
    const fulfil = proto.fulfillHostCall;
    const resolve = proto.resolveCallbackAndFlush;
    vi.spyOn(proto, 'fulfillHostCall').mockImplementation(function (this: SessionInternals, callId, kind, args) {
      if (kind === 'worker.start') starts.push(callId);
      return fulfil.call(this, callId, kind, args);
    });
    vi.spyOn(proto, 'resolveCallbackAndFlush').mockImplementation(function (this: SessionInternals, callId, result) {
      answered.push(callId);
      return resolve.call(this, callId, result);
    });
    const { handle, result, said } = await open({
      'work.js': `self.onmessage = function (e) { self.postMessage(e.data * 2); };`,
      'index.html': page(`
        var errors = 0;
        // Made and ended in a turn, as a component mounted and unmounted at once does.
        for (var i = 0; i < 3; i++) {
          var gone = new Worker('work.js');
          gone.onerror = function () { errors++; };
          gone.terminate();
        }
        var kept = new Worker('work.js');
        kept.onmessage = function (e) { out.answer = e.data; setTimeout(function () { out.errors = errors; done(); }, 50); };
        kept.postMessage(21);
      `),
    });
    expect(await result()).toEqual({ answer: 42, errors: 0 });
    expect(starts.length).toBe(4);
    expect(starts.filter((id) => !answered.includes(id))).toEqual([]);
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });
});
