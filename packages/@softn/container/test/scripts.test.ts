/**
 * Scripts in the app's document: those the app adds while it runs, and the page's own.
 *
 * A `<script>` the app added did nothing at all: its code never ran and neither `load` nor
 * `error` came, so a webpack build waited for good for each part it loads that way, a loader
 * for each library it adds, and jQuery's DOMEval ran nothing. The page's own scripts were not
 * in its document: `document.currentScript` was null while each ran (webpack finds where its
 * parts are from it, and stopped), an analytics snippet found no first script to put its own
 * beside, and a template kept in a `<script>` could not be read. And every script type but a
 * few was run as JavaScript (a template, a shader), as was a `nomodule` script.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');
/** Enough of nothing to take a script past what the engine compiles at once while the app runs. */
const PADDING = `/* ${'a part of a build, as parts are. '.repeat(3000)} */`;

const opened: Array<{ dispose(): void }> = [];

async function open(source: Record<string, string>) {
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
  });
  opened.push(handle);
  const result = async (): Promise<Record<string, unknown>> => {
    await expect
      .poll(() => handle.shadowRoot.querySelector('#out')?.textContent ?? 'waiting', { timeout: 15_000 })
      .not.toBe('waiting')
      .catch(() => {
        throw new Error(`no result: ${said.join(' | ')}`);
      });
    return JSON.parse(handle.shadowRoot.querySelector('#out')!.textContent!) as Record<string, unknown>;
  };
  return { handle, said, result };
}

/** A page whose script reports `out` once `ready()` is called. */
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body><p id="out">waiting</p>
  <script>
    var out = {};
    var ready = function () { document.getElementById('out').textContent = JSON.stringify(out); };
  </script>${body}</body></html>`;

describe('scripts in the app’s document', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  it('runs a script the app adds by its address, then says load; one that is not there says error; those it set async false run in the order added', async () => {
    const { said, result } = await open({
      'js/a.js': 'window.order.push("a:" + (document.currentScript && document.currentScript.getAttribute("src")));',
      'js/b.js': 'window.order.push("b");',
      'index.html': page(`<script>
        window.order = [];
        var events = [];
        var add = function (src, ordered) {
          var s = document.createElement('script');
          events.push(src + ' async ' + s.async);
          if (ordered) s.async = false;
          s.src = src;
          s.onload = function () { events.push('load ' + src); check(); };
          s.onerror = function () { events.push('error ' + src); check(); };
          document.head.appendChild(s);
          return s;
        };
        var check = function () {
          if (events.length < 6) return;
          out.events = events;
          out.order = window.order;
          out.src = document.querySelector('script[src="js/a.js"]').src;
          ready();
        };
        add('js/a.js', true);
        add('js/missing.js', true);
        add('js/b.js', true);
      </script>`),
    });
    const got = await result();
    expect(got.order).toEqual(['a:js/a.js', 'b']);
    expect(got.events).toEqual(['js/a.js async true', 'js/missing.js async true', 'js/b.js async true', 'load js/a.js', 'error js/missing.js', 'load js/b.js']);
    expect(got.src).toBe('https://app.softn.local/js/a.js');
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
  });

  it('runs a script of text as it joins the document, as jQuery’s DOMEval needs (added and taken out at once)', async () => {
    const { result } = await open({
      'index.html': page(`<script>
        var s = document.createElement('script');
        s.text = 'window.ranAt = document.currentScript === s ? "self" : "other"; const madeHere = 7;';
        document.head.appendChild(s).parentNode.removeChild(s);
        out.atOnce = window.ranAt;
        out.declared = typeof madeHere === 'number' ? madeHere : 'none';
        // Never put in the document: not run.
        var never = document.createElement('script');
        never.text = 'window.notRun = true;';
        out.notRun = String(window.notRun);
        // Put in the document empty, then given its text: run then, as in a browser.
        var empty = document.createElement('script');
        document.body.appendChild(empty);
        empty.text = 'window.givenText = "ran";';
        out.givenText = window.givenText;
        ready();
      </script>`),
    });
    expect(await result()).toEqual({ atOnce: 'self', declared: 7, notRun: 'undefined', givenText: 'ran' });
  });

  it('starts a webpack build that finds where its parts are by document.currentScript, and loads a part over 64 KB by a script it adds', async () => {
    const chunk = `${PADDING}\n(self.webpackChunkapp = self.webpackChunkapp || []).push([["lazy"], { lazy: function () { return "lazy part"; } }]);`;
    expect(chunk.length).toBeGreaterThan(64 * 1024);
    const { said, result } = await open({
      'static/js/lazy.chunk.js': chunk,
      'static/js/main.js': `
        var scriptUrl = document.currentScript && document.currentScript.tagName.toUpperCase() === 'SCRIPT' ? document.currentScript.src : '';
        if (!scriptUrl) throw new Error('Automatic publicPath is not supported in this browser');
        var publicPath = scriptUrl.replace(/#.*$/, '').replace(/\\?.*$/, '').replace(/\\/[^\\/]+$/, '/');
        var queue = self.webpackChunkapp = self.webpackChunkapp || [];
        queue.push = function (entry) { out.part = entry[1].lazy(); ready(); };
        var s = document.createElement('script');
        s.src = publicPath + 'lazy.chunk.js';
        s.onerror = function () { out.part = 'error'; ready(); };
        document.head.appendChild(s);
        out.publicPath = publicPath;`,
      'index.html': page('', '<script defer src="static/js/main.js"></script>'),
    });
    const got = await result();
    expect(got).toEqual({ publicPath: 'https://app.softn.local/static/js/', part: 'lazy part' });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
  });

  it('has the page’s scripts in its document: a snippet finds the first, a template is read by its id, and neither it nor a nomodule script runs', async () => {
    const { said, result } = await open({
      'js/a.js': 'window.snippetLoaded = true;',
      'index.html': page(`
        <script type="text/x-template" id="row"><li class="row">{{ name }}</li></script>
        <script nomodule>window.legacy = true;</script>
        <script type="x-shader/x-vertex" id="vertex">void main() { gl_Position = vec4(0.0); }</script>
        <section id="after"></section>
        <script>
          (function (d, s) {
            var first = d.getElementsByTagName(s)[0];
            var added = d.createElement(s);
            added.async = 1;
            added.src = 'js/a.js';
            added.onload = function () {
              out.snippet = window.snippetLoaded === true;
              out.template = d.getElementById('row').textContent;
              out.shader = d.getElementById('vertex').text.slice(0, 9);
              out.legacy = String(window.legacy);
              out.scripts = d.scripts.length;
              out.beforeSection = d.getElementById('vertex').nextElementSibling.id;
              ready();
            };
            first.parentNode.insertBefore(added, first);
          })(document, 'script');
        </script>`),
    });
    const got = await result();
    expect(got).toEqual({ snippet: true, template: '<li class="row">{{ name }}</li>', shader: 'void main', legacy: 'undefined', scripts: 6, beforeSection: 'after' });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
  });

  it('keeps two scripts side by side in their order, runs the text of a long file of its own read and handed back ($.getScript), and says why a long file that did not compile is not run', async () => {
    const long = `${PADDING}\nwindow.fromLong = 'long file';`;
    const broken = `${PADDING}\nvar view = <div>not JavaScript</div>;`;
    const { said, result } = await open({
      'lib/long.js': long,
      'lib/broken.js': broken,
      'index.html': `<!doctype html><html><head></head><body><p id="out">waiting</p><p id="first"></p><script id="s1">var out = {};</script><script id="s2">var ready = function () { document.getElementById('out').textContent = JSON.stringify(out); };</script><p id="last"></p>
        <script>
          out.order = [document.getElementById('s1').nextElementSibling.id, document.getElementById('s2').nextElementSibling.id].join(',');
          fetch('lib/long.js').then(function (r) { return r.text(); }).then(function (code) {
            var s = document.createElement('script');
            s.text = code;
            document.head.appendChild(s).parentNode.removeChild(s);
            out.getScript = window.fromLong;
            var b = document.createElement('script');
            b.src = 'lib/broken.js';
            b.onerror = function () { out.broken = 'error'; ready(); };
            b.onload = function () { out.broken = 'load'; ready(); };
            document.head.appendChild(b);
          });
        </script></body></html>`,
    });
    // One that did not compile is run as a browser runs one that does not parse: why is said, and then load.
    expect(await result()).toEqual({ order: 's2,last', getScript: 'long file', broken: 'load' });
    expect(said.some((line) => line.includes('lib/broken.js'))).toBe(true);
  });

  it('runs a module script the app adds, by its address and of text', async () => {
    const { said, result } = await open({
      'js/value.js': 'export const value = 21;',
      'js/mod.js': 'import { value } from "./value.js"; window.byAddress = value * 2;',
      'index.html': page(`<script>
        var byAddress = document.createElement('script');
        byAddress.type = 'module';
        byAddress.src = 'js/mod.js';
        byAddress.onload = function () {
          out.byAddress = window.byAddress;
          var inline = document.createElement('script');
          inline.type = 'module';
          inline.textContent = 'import { value } from "./js/value.js"; window.ofText = value + 1; window.reportOfText();';
          document.body.appendChild(inline);
        };
        window.reportOfText = function () { out.ofText = window.ofText; ready(); };
        document.head.appendChild(byAddress);
      </script>`),
    });
    expect(await result()).toEqual({ byAddress: 42, ofText: 22 });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
  });

  it('runs a blob of script the app made and a data: one, and refuses a script from the network it was not granted', async () => {
    const { result } = await open({
      'index.html': page(`<script>
        var count = 0;
        var done = function () { if (++count === 3) ready(); };
        var blob = document.createElement('script');
        blob.src = URL.createObjectURL(new Blob(['window.fromBlob = "blob";'], { type: 'text/javascript' }));
        blob.onload = function () { out.blob = window.fromBlob; done(); };
        document.head.appendChild(blob);
        var data = document.createElement('script');
        data.src = 'data:text/javascript,window.fromData%20%3D%20%22data%22%3B';
        data.onload = function () { out.data = window.fromData; done(); };
        document.head.appendChild(data);
        var remote = document.createElement('script');
        remote.src = 'https://cdn.example.test/library.js';
        remote.onload = function () { out.remote = 'load'; done(); };
        remote.onerror = function () { out.remote = 'error'; done(); };
        document.head.appendChild(remote);
      </script>`),
    });
    expect(await result()).toEqual({ blob: 'blob', data: 'data', remote: 'error' });
  });
});
