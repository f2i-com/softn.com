/**
 * Round 4: the guest's web APIs as a browser has them (src/guest-web-apis.ts,
 * src/guest-canvas-and-ext.ts, src/guest-browser-globals.ts), each where it was not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

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
  const root = handle.shadowRoot;
  const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '(not on the page)';
  const result = async (timeout = 5_000): Promise<Record<string, unknown>> => {
    await expect.poll(() => text('#out'), { timeout, interval: 10 }).not.toBe('…');
    return JSON.parse(text('#out')) as Record<string, unknown>;
  };
  return { handle, root, said, text, result };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('new Response(body, init), as the app makes one', () => {
  it('has the body, status, status text and headers it was given (it read as one the Worker handed over)', async () => {
    const { handle, result } = await open({
      'index.html': page(`
        var made = new Response('hello', { status: 201, statusText: 'Made', headers: { 'X-Kind': 'k' } });
        out.made = [made.status, made.statusText, made.ok, made.headers.get('x-kind'), made.headers.get('content-type')].join('|');
        try { out.none = new Response(null, { status: 204 }).status + '|' + new Response().status; } catch (e) { out.none = 'threw: ' + e.message; }
        try { new Response('x', { status: 99 }); out.range = 'made'; } catch (e) { out.range = e.name; }
        var form = new FormData();
        form.append('name', 'Ada');
        form.append('file', new Blob(['bytes'], { type: 'text/plain' }), 'a.txt');
        var formResponse = new Response(form);
        var stream = new ReadableStream({ start: function (c) { c.enqueue(new Uint8Array([104, 105])); c.enqueue(new Uint8Array([33])); c.close(); } });
        var streamed = new Response(stream);
        var copy = streamed.clone();
        Promise.all([
          made.text(),
          new Response(JSON.stringify({ a: 1 }), { headers: { 'content-type': 'application/json' } }).json(),
          new Response(new Uint8Array([111, 107])).text(),
          new Response(new Blob(['from a blob'], { type: 'text/csv' })).text(),
          new Response(new URLSearchParams({ q: 'a b' })).text(),
          formResponse.text(),
          streamed.text(),
          copy.text(),
          Response.json({ n: 2 }, { status: 202 }).json(),
        ]).then(function (all) {
          out.text = all[0];
          out.json = all[1];
          out.bytes = all[2];
          out.blob = all[3];
          out.params = all[4];
          out.form = /name="name"\\r\\n\\r\\nAda\\r\\n/.test(all[5]) && /filename="a.txt"\\r\\nContent-Type: text\\/plain\\r\\n\\r\\nbytes\\r\\n/.test(all[5]) && /^multipart\\/form-data; boundary=/.test(formResponse.headers.get('content-type'));
          out.stream = all[6] + '|' + all[7];
          out.staticJson = all[8].n + '|' + Response.json({}).headers.get('content-type');
          done();
        }).catch(fail);
      `),
    });
    expect(await result()).toEqual({
      made: '201|Made|true|k|text/plain;charset=UTF-8',
      none: '204|200',
      range: 'RangeError',
      text: 'hello',
      json: { a: 1 },
      bytes: 'ok',
      blob: 'from a blob',
      params: 'q=a+b',
      form: true,
      stream: 'hi!|hi!',
      staticJson: '2|application/json',
    });
    handle.dispose();
  });

  it('still answers a fetch of the app’s own file, and its clone, as before', async () => {
    const { handle, result } = await open({
      'data.json': '{"a":1}',
      'index.html': page(`
        fetch('data.json').then(function (r) {
          var copy = r.clone();
          return Promise.all([r.json(), copy.text(), r.status, r.ok, copy.headers.get('content-type'), r instanceof Response]);
        }).then(function (all) { out.got = all; done(); }).catch(fail);
      `),
    });
    expect(await result()).toEqual({ got: [{ a: 1 }, '{"a":1}', 200, true, 'application/json; charset=utf-8', true] });
    handle.dispose();
  });
});

describe('a fetch given a signal', () => {
  it('takes its listener off the signal once it is answered (one signal for every request held every answer)', async () => {
    const { handle, result } = await open({
      'data.json': '{"a":1}',
      'index.html': page(`
        var controller = new AbortController();
        var added = 0;
        var removed = 0;
        var add = controller.signal.addEventListener.bind(controller.signal);
        var remove = controller.signal.removeEventListener.bind(controller.signal);
        controller.signal.addEventListener = function (type, fn, options) { added++; return add(type, fn, options); };
        controller.signal.removeEventListener = function (type, fn, options) { removed++; return remove(type, fn, options); };
        var n = 0;
        var next = function () {
          fetch('data.json', { signal: controller.signal }).then(function (r) { return r.json(); }).then(function () {
            if (++n < 20) { next(); return; }
            out.added = added;
            out.removed = removed;
            // Still the signal's to end: a request it is given now is ended by it.
            var last = fetch('data.json', { signal: controller.signal });
            controller.abort();
            return last.then(function () { out.last = 'answered'; }, function (e) { out.last = e.name; });
          }).then(function () { if (n >= 20) done(); }).catch(fail);
        };
        next();
      `),
    });
    expect(await result()).toEqual({ added: 20, removed: 20, last: 'AbortError' });
    handle.dispose();
  });
});

describe('Blob.slice', () => {
  it('reads where it starts and ends as whole numbers, for a file kept as text as for bytes', async () => {
    const { handle, result } = await open({
      'index.html': page(`
        var kept = __softnKeptAsText(btoa('abcdef'), 'text/plain');
        var bytes = new Blob(['abcdef']);
        var cuts = [[0, 2.5], [0, 3.5], [0.4, 2.6], ['1', '3'], [NaN, 2], [-2.5, undefined]];
        var sizes = [];
        var reads = [];
        cuts.forEach(function (cut) {
          var a = kept.slice(cut[0], cut[1]);
          var b = bytes.slice(cut[0], cut[1]);
          sizes.push(a.size + '/' + b.size);
          reads.push(Promise.all([a.text(), b.text()]).then(function (t) { return t.join('/'); }));
        });
        Promise.all(reads).then(function (texts) { out.sizes = sizes.join(' '); out.texts = texts.join(' '); done(); }).catch(fail);
      `),
    });
    expect(await result()).toEqual({ sizes: '2/2 4/4 3/3 2/2 2/2 2/2', texts: 'ab/ab abcd/abcd abc/abc bc/bc ab/ab ef/ef' });
    handle.dispose();
  });
});

describe('EventSource', () => {
  it('reads a CRLF the network cut in two as one line end (the message was ended early and split in two)', async () => {
    vi.stubGlobal('fetch', async () => {
      const words = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(words.encode('data: a\r'));
          c.enqueue(words.encode('\ndata: b\r\n\r'));
          c.enqueue(words.encode('\ndata: c\r\rdata: d\n\n'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const { handle, text } = await open(
      {
        'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.softn.test'] } } }),
        'index.html': page(`var seen = [];
          var feed = new EventSource('https://api.softn.test/feed');
          feed.onmessage = function (e) { seen.push(JSON.stringify(e.data)); out.seen = seen.join(' '); done(); };`),
      },
      { permissionMode: 'preapproved' }
    );
    await expect.poll(() => text('#out'), { timeout: 5_000 }).toBe(JSON.stringify({ seen: '"a\\nb" "c" "d"' }));
    handle.dispose();
  });
});

describe('element.animate', () => {
  it('lets go of an animation once it is over, unless it holds its last frame (every one was kept, with its element)', async () => {
    const { handle, result } = await open({
      'index.html': page(`
        var box = document.createElement('div');
        document.body.appendChild(box);
        var all = [];
        for (var i = 0; i < 30; i++) all.push(box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10 }).finished);
        var held = box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10, fill: 'forwards' });
        all.push(held.finished);
        var running = box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10 });
        out.whileRunning = box.getAnimations().length;
        running.cancel();
        Promise.all(all).then(function () {
          setTimeout(function () {
            out.after = box.getAnimations().length;
            out.heldIsKept = box.getAnimations()[0] === held;
            done();
          }, 50);
        }).catch(fail);
      `),
    });
    expect(await result()).toEqual({ whileRunning: 32, after: 1, heldIsKept: true });
    handle.dispose();
  });
});

describe('localStorage', () => {
  it('is a Storage: its keys by number and its length, and each key a property of it (key and length were undefined)', async () => {
    localStorage.clear();
    const first = await open({
      'index.html': page(`
        localStorage.setItem('b', '2');
        localStorage.setItem('a', '1');
        localStorage.setItem('a', 'one');
        out.length = localStorage.length;
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
        out.keys = keys.join(',');
        out.past = localStorage.key(5);
        out.odd = localStorage.key('1') + '|' + localStorage.key(-1);
        // A value set and read as a property is kept as setItem keeps it.
        localStorage.token = 'tok';
        out.token = localStorage.getItem('token') + '|' + localStorage.token + '|' + ('token' in localStorage) + '|' + localStorage.missing;
        out.own = Object.keys(localStorage).join(',');
        delete localStorage.b;
        out.afterDelete = Object.keys(localStorage).join(',') + '|' + localStorage.length;
        out.methods = typeof localStorage.getItem + '|' + Object.prototype.toString.call(localStorage);
        done();
      `),
    }, { persistStorage: true, appId: 'r4-storage' });
    expect(await first.result()).toEqual({
      length: 2,
      keys: 'b,a',
      past: null,
      odd: 'a|null',
      token: 'tok|tok|true|undefined',
      own: 'b,a,token',
      afterDelete: 'a,token|2',
      methods: 'function|[object Storage]',
    });
    first.handle.dispose();
    // Kept as setItem keeps it: there when the app is opened again.
    document.body.innerHTML = '';
    const again = await open({
      'index.html': page(`out.kept = Object.keys(localStorage).map(function (k) { return k + '=' + localStorage[k]; }).join(','); done();`),
    }, { persistStorage: true, appId: 'r4-storage' });
    expect(await again.result()).toEqual({ kept: 'a=one,token=tok' });
    again.handle.dispose();
  });
});

describe('a canvas’s 2D context', () => {
  it('sends the page every drawing property, and reads its state back after restore() as a browser does', async () => {
    const set: string[] = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    // This test's page draws nothing: it keeps what the app's drawing set on its context.
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return new Proxy({}, {
        get: (_t, name) => (name === 'canvas' ? this : () => undefined),
        set: (_t, name, value) => { set.push(`${String(name)}=${String(value)}`); return true; },
      });
    } as unknown as typeof getContext;
    try {
      const { handle, result } = await open({
        'index.html': page(`
          var canvas = document.createElement('canvas');
          document.body.appendChild(canvas);
          var ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.lineDashOffset = 3;
          ctx.miterLimit = 4;
          ctx.font = '10px sans-serif';
          ctx.save();
          ctx.font = '30px serif';
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([4, 2, 1]);
          var inside = ctx.measureText('abc').width;
          out.inside = ctx.getLineDash().join(',');
          ctx.restore();
          out.font = ctx.font + '|' + ctx.globalAlpha + '|' + (ctx.measureText('abc').width < inside);
          out.dash = ctx.getLineDash().join(',');
          ctx.setLineDash([5]);
          ctx.setLineDash([1, -1]);
          out.dashAfter = ctx.getLineDash().join(',');
          out.smoothing = ctx.imageSmoothingEnabled;
          ctx.fillRect(0, 0, 1, 1);
          done();
        `),
      });
      expect(await result()).toEqual({ inside: '4,2,1,4,2,1', font: '10px sans-serif|1|true', dash: '', dashAfter: '5,5', smoothing: false });
      await expect.poll(() => set.filter((entry) => /^(imageSmoothingEnabled|lineDashOffset|miterLimit)=/.test(entry))).toEqual(['imageSmoothingEnabled=false', 'lineDashOffset=3', 'miterLimit=4']);
      handle.dispose();
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });
});

describe('putImageData with a dirty rectangle', () => {
  it('writes only that rectangle, where it is in the image (the whole image was written)', async () => {
    const puts: string[] = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return new Proxy({}, {
        get: (_t, name) => (name === 'canvas' ? this : (...args: unknown[]) => {
          if (name !== 'putImageData') return;
          const image = args[0] as { width: number; height: number; data: Uint8ClampedArray };
          puts.push(`${image.width}x${image.height}@${args[1]},${args[2]}:${Array.from(image.data.slice(0, 4)).join('.')}`);
        }),
        set: () => true,
      });
    } as unknown as typeof getContext;
    // The page this test runs on has no ImageData of its own.
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    try {
      const { handle, result } = await open({
        'index.html': page(`
          var canvas = document.createElement('canvas');
          document.body.appendChild(canvas);
          var ctx = canvas.getContext('2d');
          var image = ctx.createImageData(4, 4);
          for (var i = 0; i < 16; i++) { image.data[i * 4] = i; image.data[i * 4 + 3] = 255; }
          ctx.putImageData(image, 10, 20);
          ctx.putImageData(image, 10, 20, 1, 2, 2, 2);
          // Held to the image: a rectangle past its edge is cut there, one of no size writes nothing.
          ctx.putImageData(image, 0, 0, 3, -1, 5, 2);
          ctx.putImageData(image, 0, 0, 1, 1, 0, 3);
          done();
        `),
      });
      expect(await result()).toEqual({});
      await expect.poll(() => puts).toEqual(['4x4@10,20:0.0.0.255', '2x2@11,22:9.0.0.255', '1x1@3,0:3.0.0.255']);
      handle.dispose();
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });
});

describe('the hosted marked', () => {
  it('writes a link’s address into its attribute with its quotes escaped (a quote in it wrote an attribute of its own)', async () => {
    const { handle, result } = await open({
      'index.html': `<!doctype html><html><body><p id="out">…</p><div id="md"></div><script type="module">
        import { marked } from 'marked';
        var html = marked.parse('[x](https://site.test/"onclick="alert(1)) and "quoted" text');
        var holder = document.getElementById('md');
        holder.innerHTML = html;
        var link = holder.querySelector('a');
        document.getElementById('out').textContent = JSON.stringify({
          attributes: link ? link.getAttributeNames().sort().join(',') : 'no link',
          href: link ? link.getAttribute('href') : '',
          text: holder.textContent,
        });
      </script></body></html>`,
    });
    expect(await result()).toEqual({
      attributes: 'href,rel,target',
      href: 'https://site.test/"onclick="alert(1',
      text: 'x) and "quoted" text',
    });
    handle.dispose();
  });
});

describe('a stream reader’s closed', () => {
  it('settles as a browser settles it: once read to its end, when it errors, and when the reader lets go (it never settled)', async () => {
    const { handle, result } = await open({
      'index.html': page(`
        var whole = new ReadableStream({ start: function (c) { c.enqueue(new Uint8Array([1])); c.close(); } }).getReader();
        var seen = [];
        whole.closed.then(function () { seen.push('closed'); });
        var failing = new ReadableStream({ start: function (c) { c.error(new Error('boom')); } }).getReader();
        var open = new ReadableStream({}).getReader();
        var released = open.closed.then(function () { return 'resolved'; }, function (e) { return e.name; });
        open.releaseLock();
        // Closed with a piece still in it: not settled until that piece is read (then at once,
        // ahead of the read's own answer, as a browser settles it).
        new Promise(function (resolve) { setTimeout(resolve, 30); }).then(function () {
          seen.push('waited:' + seen.length);
          return whole.read();
        }).then(function (first) {
          seen.push('read:' + first.value.length);
          return whole.read();
        }).then(function (end) {
          seen.push('done:' + end.done);
          return Promise.all([whole.closed, failing.closed.then(function () { return 'resolved'; }, function (e) { return e.message; }), released]);
        }).then(function (all) {
          out.order = seen.join(',');
          out.failing = all[1];
          out.released = all[2];
          done();
        }).catch(fail);
      `),
    });
    expect(await result()).toEqual({ order: 'waited:0,closed,read:1,done:true', failing: 'boom', released: 'TypeError' });
    handle.dispose();
  });
});

describe('requestIdleCallback', () => {
  it('counts the idle time from when the callback is called, not from when it was asked for', async () => {
    const { handle, result } = await open({
      'index.html': page(`
        var asked = Date.now();
        requestIdleCallback(function (deadline) { out.left = deadline.timeRemaining() > 40; out.didTimeout = deadline.didTimeout; done(); });
        // A long turn after asking: the callback comes late.
        while (Date.now() - asked < 80) {}
      `),
    });
    expect(await result()).toEqual({ left: true, didTimeout: false });
    handle.dispose();
  });
});
