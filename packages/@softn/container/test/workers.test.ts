/**
 * A Worker of the app's own: `new Worker(url)` in the app's script.
 *
 * There was none. A library that offloads work to a Worker (a PDF reader, an editor's
 * language service, Comlink, a bundler's `?worker` import) stopped, or ran nothing. An app's
 * Worker runs in an engine of its own in the container's Worker, from one of the app's script
 * files or a blob of script it made, in a worker's global scope (no document, no window);
 * messages are copied as structured clone copies them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

/** A comment that takes a script past what the engine compiles at once while an app runs. */
const BULK = `/* ${'a library of some size, as libraries are. '.repeat(1800)} */`;

/** The containers a test opened: closed after it, passed or not (one left running upset the next). */
const opened: Array<{ dispose(): void }> = [];

async function open(files: Record<string, string>, script: string, permissionMode: 'deny' | 'preapproved' = 'deny') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode,
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source: {
      ...files,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script>
        var out = {};
        var report = function () { document.getElementById('out').textContent = JSON.stringify(out); };
        ${script}
      </script></body></html>`,
    },
  });
  opened.push(handle);
  const result = async (keys: string[]): Promise<Record<string, unknown>> => {
    const read = () => {
      try {
        return JSON.parse(handle.shadowRoot.querySelector('#out')?.textContent ?? '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    await expect
      .poll(() => keys.every((key) => key in read()), { timeout: 15_000 })
      .toBe(true)
      .catch(() => {
        throw new Error(`not all of ${keys.join(', ')} came: ${handle.shadowRoot.querySelector('#out')?.textContent}; said: ${said.join(' | ')}`);
      });
    return read();
  };
  return { handle, said, result };
}

describe('a Worker of the app’s own', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  it('runs one of the app’s script files in a worker’s scope, and passes messages both ways as structured clone copies them', async () => {
    const { handle, said, result } = await open(
      {
        'worker.js': `var count = 0;
          self.onmessage = function (e) {
            count++;
            var got = e.data;
            postMessage({
              count: count,
              name: self.name,
              scope: [typeof document, typeof window, typeof importScripts, self instanceof DedicatedWorkerGlobalScope, self === globalThis].join(','),
              kinds: [got.when instanceof Date, got.bytes instanceof Uint8Array, got.bytes.length, got.map instanceof Map, got.map.get('k'), got.list.join('+')].join(','),
              path: location.pathname,
            });
          };`,
      },
      `var w = new Worker('worker.js', { name: 'calc' });
      w.onmessage = function (e) { out.first = e.data; report(); };
      w.postMessage({ when: new Date(0), bytes: new Uint8Array([1, 2, 3]), map: new Map([['k', 'v']]), list: [1, 2] });`
    );
    const reported = await result(['first']);
    expect(reported.first).toEqual({ count: 1, name: 'calc', scope: 'undefined,undefined,function,true,true', kinds: 'true,true,3,true,v,1+2', path: '/worker.js' });
    expect(said.filter((line) => !line.startsWith('log'))).toEqual([]);
    handle.dispose();
  });

  it('runs a blob of script the app made, and a module with what it imports', async () => {
    const { handle, said, result } = await open(
      {
        'math.js': `export function double(n) { return n * 2; }`,
        'module-worker.js': `import { double } from './math.js';
          self.addEventListener('message', function (e) { self.postMessage(double(e.data)); });`,
      },
      `var inline = new Worker(URL.createObjectURL(new Blob(['onmessage = function (e) { postMessage(e.data + 1); };'], { type: 'text/javascript' })));
      inline.onmessage = function (e) { out.inline = e.data; report(); };
      inline.postMessage(41);
      var modular = new Worker('module-worker.js', { type: 'module' });
      modular.addEventListener('message', function (e) { out.module = e.data; report(); });
      modular.postMessage(21);`
    );
    expect(await result(['inline', 'module'])).toMatchObject({ inline: 42, module: 42 });
    expect(said.filter((line) => !line.startsWith('log'))).toEqual([]);
    handle.dispose();
  });

  it('imports a library of any size it names, fetches the app’s files, and keeps its own timers', async () => {
    const { handle, said, result } = await open(
      {
        'lib.js': `${BULK}\nvar shout = function (s) { return s.toUpperCase(); };`,
        'data.json': JSON.stringify({ items: [1, 2, 3] }),
        'busy.js': `importScripts('lib.js');
          onmessage = function (e) {
            fetch('data.json').then(function (r) { return r.json(); }).then(function (data) {
              setTimeout(function () { postMessage(shout(e.data) + ' ' + data.items.length); }, 20);
            });
          };`,
      },
      `var w = new Worker('busy.js');
      w.onmessage = function (e) { out.busy = e.data; report(); };
      w.postMessage('hi');`
    );
    expect(BULK.length).toBeGreaterThan(64 * 1024);
    expect(await result(['busy'])).toMatchObject({ busy: 'HI 3' });
    expect(said.filter((line) => !line.startsWith('log'))).toEqual([]);
    handle.dispose();
  });

  it('passes two thousand messages back and forth, each in a turn of its own, the app’s own calls in their order', async () => {
    // Handed over at once, inside the turn that sent it, each message and its answer went
    // deeper: about a thousand round trips in, the stack ran out and the app stopped. And a
    // timer the app set before it heard an answer ran after one set in the answer.
    const { handle, said, result } = await open(
      { 'echo.js': 'onmessage = function (e) { postMessage(e.data + 1); };' },
      `var w = new Worker('echo.js');
      var order = [];
      w.onmessage = function (e) {
        if (e.data === 1) setTimeout(function () { order.push('inner'); }, 0);
        if (e.data < 2000) { w.postMessage(e.data); return; }
        out.last = e.data;
        out.order = order.join(',');
        report();
      };
      w.postMessage(0);
      setTimeout(function () { order.push('outer'); }, 0);`
    );
    expect(await result(['last'])).toEqual({ last: 2000, order: 'outer,inner' });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  }, 60_000);

  it('keeps every message posted before it started, and hands over messages in the order they were posted, a refused request’s handler’s after', async () => {
    // Past 1,024 messages posted before it had started, the rest were dropped without a word;
    // and a message posted in a request's refusal went out before one posted before it.
    const { handle, said, result } = await open(
      {
        'count.js': 'var n = 0; onmessage = function (e) { if (e.data === "end") postMessage(n); else n++; };',
        'order.js': `onmessage = function () {
          fetch('https://api.softn.test/x').catch(function () { postMessage('second'); });
          postMessage('first');
        };`,
      },
      `var counter = new Worker('count.js');
      for (var i = 0; i < 2000; i++) counter.postMessage(i);
      counter.postMessage('end');
      counter.onmessage = function (e) { out.count = e.data; report(); };
      var heard = [];
      var ordered = new Worker('order.js');
      ordered.onmessage = function (e) { heard.push(e.data); if (heard.length === 2) { out.order = heard.join(','); report(); } };
      ordered.postMessage('go');`
    );
    expect(await result(['count', 'order'])).toMatchObject({ count: 2000, order: 'first,second' });
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  }, 60_000);

  it('compiles with a Worker the module over 64 KB it names in import(), as the page’s are', async () => {
    const big = `${BULK}\nexport const big = 'a big module';`;
    const { handle, result } = await open(
      {
        'big.js': big,
        'loads-big.js': `onmessage = function () { import('./big.js').then(function (m) { postMessage(m.big); }, function (e) { postMessage('failed: ' + e.message); }); };`,
      },
      `var w = new Worker('loads-big.js');
      w.onmessage = function (e) { out.big = e.data; report(); };
      w.postMessage('go');`
    );
    expect(await result(['big'])).toEqual({ big: 'a big module' });
    handle.dispose();
  });

  it('imports a module on demand inside a module Worker, a built-in one too; refuses one there is none of; says why a script address with a stray % is not there', async () => {
    // import() in a Worker was refused outright; a built-in module asked for there (its engine
    // defines it, as the app's does) and one no engine defines waited for good.
    const { handle, result } = await open(
      {
        'lazy.js': 'export const lazy = "loaded later";',
        'lazy-worker.js': `onmessage = function () {
          var none = import('softn:nothing').then(function () { return 'loaded'; }, function (e) { return e.message; });
          Promise.all([import('./lazy.js'), import('softn:storage'), none]).then(function (m) { postMessage(m[0].lazy + ' ' + typeof m[1] + ' | ' + m[2]); }, function (e) { postMessage('failed: ' + e.message); });
        };`,
      },
      `var w = new Worker('lazy-worker.js', { type: 'module' });
      w.onmessage = function (e) { out.lazy = e.data; report(); };
      w.postMessage('go');
      var odd = new Worker('100%.js');
      odd.onerror = function (e) { out.odd = e.message; report(); };`
    );
    const reported = await result(['lazy', 'odd']);
    expect(reported.lazy).toBe('loaded later object | There is no module softn:nothing here');
    expect(String(reported.odd)).toContain('100%.js');
    handle.dispose();
  });

  describe('with the network', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends a large upload from a Worker, its body found by the name its request gives', async () => {
      // A Worker's request named its body by the Worker's own name for it, and the pieces were
      // kept under another: an upload past 2.4 million characters failed every time.
      const sizes: number[] = [];
      vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body;
        sizes.push(body instanceof Blob ? body.size : typeof body === 'string' ? body.length : 0);
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
      });
      const { handle, said, result } = await open(
        {
          'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.softn.test'] } } }),
          'upload.js': `onmessage = function () {
            fetch('https://api.softn.test/up', { method: 'POST', body: new Array(3000001).join('u') }).then(function (r) { return r.text(); }).then(function (t) { postMessage(t); }, function (e) { postMessage('failed: ' + e.message); });
          };`,
        },
        `var w = new Worker('upload.js');
        w.onmessage = function (e) { out.upload = e.data; report(); };
        w.postMessage('go');`,
        'preapproved'
      );
      expect(await result(['upload'])).toEqual({ upload: 'ok' });
      expect(sizes).toEqual([3_000_000]);
      expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
      handle.dispose();
    });
  });

  it('tells the app of an error in its Worker, and of one that cannot start; ends at terminate() and at close()', async () => {
    const { handle, result } = await open(
      {
        'throws.js': `onmessage = function (e) { if (e.data === 'boom') throw new Error('it went wrong'); postMessage('fine ' + e.data); };`,
        'closes.js': `onmessage = function (e) { postMessage('heard ' + e.data); close(); };`,
      },
      `var errors = [];
      var heard = [];
      // Once each has answered (not after a while: two engines may take that long to start on a busy machine).
      var answered = function () {
        if (errors.length < 1 || heard.length < 2) return;
        answered = function () {};
        c.postMessage('second');
        t.terminate();
        t.postMessage('after');
        setTimeout(function () { out.errors = errors; out.heard = heard.sort(); report(); }, 200);
      };
      var t = new Worker('throws.js');
      t.onerror = function (e) { errors.push(e.message); answered(); };
      t.onmessage = function (e) { heard.push(e.data); answered(); };
      t.postMessage('boom');
      t.postMessage('one');
      var missing = new Worker('nowhere.js');
      missing.onerror = function (e) { out.missing = e.message; report(); };
      var c = new Worker('closes.js');
      c.onmessage = function (e) { heard.push(e.data); answered(); };
      c.postMessage('first');`
    );
    const reported = await result(['missing', 'errors', 'heard']);
    expect(String(reported.missing)).toContain('nowhere.js');
    expect(reported.errors).toEqual(['it went wrong']);
    expect(reported.heard).toEqual(['fine one', 'heard first']);
    handle.dispose();
  });
});
