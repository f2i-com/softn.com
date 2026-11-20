/**
 * Code an app compiles while it runs: the parts of it loaded on demand (`import()`), and its
 * own `eval` and `new Function`.
 *
 * The engine compiles 64 KB of code at once while an app runs, and past that it stops the app
 * altogether. Before this, a part of an app loaded on demand that was larger than that (a
 * lazily loaded route with a library in it) froze the app without a word; a TypeScript part
 * loaded on demand was read as JavaScript and never loaded; and every part loaded on demand
 * was compiled through a path the engine allows 256 times in an app's life.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const ENGINE_FILES = {
  lite: path.join(ENGINES, 'zipp-javascript-lite.wasm'),
  typescript: path.join(ENGINES, 'zipp-typescript.wasm'),
};

/** A comment that takes a module past what the engine compiles at once while an app runs. */
const BULK = `/* ${'a part of some size, as parts with a library in them are. '.repeat(1300)} */`;

async function open(source: Record<string, string>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: ENGINE_FILES,
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source,
  });
  const text = (selector: string) => handle.shadowRoot.querySelector(selector)?.textContent ?? '';
  return { handle, host, said, text };
}

describe('a part of an app loaded on demand', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('loads whatever its size when its name is written in the import(), and a small one named any way', async () => {
    expect(BULK.length).toBeGreaterThan(64 * 1024);
    const { handle, said, text } = await open({
      'big.js': `${BULK}\nexport const answer = 42;\nexport default function shout(s) { return s.toUpperCase(); }`,
      'small.js': 'export const small = "small";',
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script type="module">
        var name = './sm' + 'all.js';
        setTimeout(function () {
          Promise.all([import('./big.js'), import(name)]).then(function (both) {
            document.getElementById('out').textContent = [both[0].answer, both[0].default('loud'), both[1].small].join('|');
          }, function (e) { document.getElementById('out').textContent = 'failed: ' + e.message; });
        }, 10);
      </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('42|LOUD|small');
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('is refused in words, and the app goes on, when one past what can be compiled while it runs is named some other way', async () => {
    const { handle, said, text } = await open({
      'big.js': `${BULK}\nexport const answer = 42;`,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><button id="still" type="button">still</button><script type="module">
        var name = './b' + 'ig.js';
        setTimeout(function () {
          import(name).then(function () { document.getElementById('out').textContent = 'loaded'; }, function (e) {
            document.getElementById('out').textContent = 'refused: ' + /more than the engine compiles at once/.test(e.message) + ' ' + /big\\.js/.test(e.message);
          });
        }, 10);
        document.getElementById('still').addEventListener('click', function () { document.getElementById('out').textContent += ' | still here'; });
      </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('refused: true true');
    (handle.shadowRoot.querySelector('#still') as HTMLElement).click();
    await expect.poll(() => text('#out')).toBe('refused: true true | still here');
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('loads in a TypeScript app, types and all, when its name is written in the import()', async () => {
    const { handle, said, text } = await open({
      'lazy.ts': 'export function twice(n: number): number { const out: number = n * 2; return out; }',
      'main.ts': `const out = document.getElementById('out') as HTMLElement;
        setTimeout(() => { import('./lazy.ts').then((m: { twice(n: number): number }) => { out.textContent = 'loaded:' + m.twice(21); }, (e: Error) => { out.textContent = 'failed:' + e.message; }); }, 10);`,
      'index.html': '<!doctype html><html><body><p id="out">waiting</p><script type="module" src="main.ts"></script></body></html>',
    });
    expect(handle.engineTier).toBe('typescript');
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('loaded:42');
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('that does not parse fails its import() and nothing else, whether compiled at the start or when asked for', async () => {
    // One compiled with the program at the start stopped the whole app from starting; one
    // compiled when asked for was kept as loaded, and asked for again, said nothing of why.
    const { handle, said, text } = await open({
      'big.js': `${BULK}\nexport const answer = ;`,
      'small.js': 'export const small = ;',
      'fine.js': 'export const fine = "fine";',
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script type="module">
        var small = './sm' + 'all.js';
        var why = function (e) { return e.name + (/big\\.js|small\\.js/.test(e.message) || e.name === 'SyntaxError' ? '' : ' (' + e.message + ')'); };
        Promise.all([
          import('./big.js').then(function () { return 'loaded'; }, why),
          import(small).then(function () { return 'loaded'; }, why),
          import('./fine.js').then(function (m) { return m.fine; }),
        ]).then(function (first) {
          return import(small).then(function () { return 'loaded'; }, why).then(function (again) {
            document.getElementById('out').textContent = first.concat(again).join('|');
          });
        });
      </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('SyntaxError|SyntaxError|fine|SyntaxError');
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('can be asked for hundreds of times in an app’s life', async () => {
    // The path these were compiled through allowed 256 compilations in an app's life.
    const source: Record<string, string> = {};
    for (let i = 0; i < 300; i++) source[`parts/p${i}.js`] = `export const n = ${i};`;
    source['index.html'] = `<!doctype html><html><body><p id="out">waiting</p><script type="module">
      var loads = [];
      for (var i = 0; i < 300; i++) loads.push(import('./parts/p' + String(i) + '.js'));
      Promise.all(loads).then(function (parts) {
        var sum = 0;
        for (var k = 0; k < parts.length; k++) sum += parts[k].n;
        document.getElementById('out').textContent = 'sum:' + sum;
      }, function (e) { document.getElementById('out').textContent = 'failed: ' + e.message; });
    </script></body></html>`;
    const { handle, said, text } = await open(source);
    await expect.poll(() => text('#out'), { timeout: 30_000 }).toBe(`sum:${(299 * 300) / 2}`);
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  }, 60_000);
});

describe('code an app compiles itself while it runs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is held to what the engine compiles at once when it is new Function, with an error the app can catch', async () => {
    const { handle, said, text } = await open({
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script>
        var parts = [];
        setTimeout(function () {
          try { new Function('/*' + new Array(70000).join('x') + '*/ return 1;'); parts.push('compiled'); } catch (e) { parts.push(e.name); }
          parts.push(new Function('a', 'b', 'return a + b')(2, 3));
          parts.push(Function('return 7')());
          parts.push((function () {}).constructor === Function);
          parts.push((function () {}).constructor('return 9')());
          parts.push(function () {} instanceof Function);
          parts.push(Object.getPrototypeOf(function () {}) === Function.prototype);
          parts.push(Function.name);
          document.getElementById('out').textContent = parts.join('|');
        }, 10);
      </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('RangeError|5|7|true|9|true|true|Function');
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('that stops the engine says so: the host hears why, and the page shows it with a way to start again', async () => {
    // A direct eval reads the scope it is in, so eval is not held as new Function is: past
    // the engine's limit it stops the app. That is said, not left a frozen page.
    const roots: ShadowRoot[] = [];
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const made = attach.call(this, init);
      roots.push(made);
      return made;
    };
    try {
      const { handle, said, text } = await open({
        'index.html': `<!doctype html><html><head><title>Big Eval</title></head><body><p id="out">started</p><button id="go" type="button">go</button><script>
          document.getElementById('go').addEventListener('click', function () { (0, eval)('/*' + new Array(70000).join('x') + '*/ 1'); });
        </script></body></html>`,
      });
      await expect.poll(() => text('#out')).toBe('started');
      (handle.shadowRoot.querySelector('#go') as HTMLElement).click();
      await expect.poll(() => said.find((line) => line.startsWith('failed')) ?? '', { timeout: 10_000 }).toMatch(/The app stopped: it compiled more code at once than the engine takes/);
      const bar = () => roots.map((r) => r.querySelector('[data-softn-stopped-bar]')).find(Boolean) ?? null;
      await expect.poll(() => bar()?.textContent ?? '').toContain('stopped: it compiled more code at once');
      expect(bar()?.getAttribute('role')).toBe('alert');
      // Started again: the app runs, and answers.
      (bar()!.querySelector('[data-softn-stopped-restart]') as HTMLElement).click();
      await expect.poll(() => bar()).toBeNull();
      await expect.poll(() => text('#out')).toBe('started');
      handle.dispose();
    } finally {
      Element.prototype.attachShadow = attach;
    }
  });
});

describe('Math.random in an app', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is not the same in two apps, nor in the same app started twice', async () => {
    // The engine's gave the same numbers in every app, every time it started: two tabs made
    // the same "random" ids, and the second's record took the first's place.
    const runs: string[] = [];
    for (let n = 0; n < 2; n++) {
      const { handle, text } = await open({
        'index.html': `<!doctype html><html><body><p id="out">waiting</p><script>
          var values = [];
          for (var i = 0; i < 1000; i++) values.push(Math.random());
          var inRange = values.every(function (v) { return v >= 0 && v < 1; });
          var mean = values.reduce(function (s, v) { return s + v; }, 0) / values.length;
          document.getElementById('out').textContent = JSON.stringify({ first: values.slice(0, 3).join(','), inRange: inRange, mean: Math.round(mean * 10) / 10, distinct: new Set(values).size, name: Math.random.name });
        </script></body></html>`,
      });
      await expect.poll(() => text('#out')).not.toBe('waiting');
      runs.push(text('#out'));
      handle.dispose();
    }
    const [one, two] = runs.map((run) => JSON.parse(run) as { first: string; inRange: boolean; mean: number; distinct: number; name: string });
    expect(one.first).not.toBe(two.first);
    for (const run of [one, two]) expect(run).toMatchObject({ inRange: true, mean: 0.5, distinct: 1000, name: 'random' });
  });
});

describe('a library asked for by its name', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a file of the runtime’s own folder, asked for without the person’s cookies, and a name that climbs out of it is refused', async () => {
    // A name becomes a path under the runtime's folder, on the embedding site: one with `..`
    // in it asked that site for any address, with the person's cookies.
    const asked: Array<{ url: string; credentials: string | undefined }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), credentials: init?.credentials });
      return new Response('export const named = "lib";', { status: 200, headers: { 'content-type': 'text/javascript' } });
    });
    const { handle, text } = await open({
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script type="module">
        var climb = 'x/../../../api/me#';
        var plain = 'some-lib';
        Promise.all([
          import(climb).then(function () { return 'loaded'; }, function () { return 'refused'; }),
          import(plain).then(function (m) { return m.named; }, function (e) { return 'failed ' + e.message; }),
        ]).then(function (both) { document.getElementById('out').textContent = both.join('|'); });
      </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('refused|lib');
    expect(asked.some((one) => one.url.includes('api/me'))).toBe(false);
    expect(asked.filter((one) => one.url.endsWith('vendor/some-lib.js')).map((one) => one.credentials)).toEqual(['omit']);
    handle.dispose();
  });
});