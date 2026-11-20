/**
 * The web's own APIs beyond the document, in a container (src/guest-web-apis.ts): bytes with
 * a type, an address for them, a request's body as the web sends it, XMLHttpRequest and
 * WebSocket under the grant a `fetch` is under, an image that says when it has loaded, a
 * range, and elements of the app's own making.
 *
 * Each was not there at all, and an app that named one stopped where it did. What matters
 * here beyond "it exists" is what the page is handed: an address the host minted and never
 * the app's word for one, nothing over the network that was not granted, and no file
 * written to the person's disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { sameSite } from '../src/sanitize';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const page = (body: string, script: string) => `<!doctype html><html><head><title>t</title></head><body>${body}<p id="out">…</p><script>
  var out = {};
  var done = function () { document.getElementById('out').textContent = JSON.stringify(out); };
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
  /** What the page's script reported, once it has. */
  const result = async (timeout = 5_000): Promise<Record<string, unknown>> => {
    await expect.poll(() => text('#out'), { timeout, interval: 10 }).not.toBe('…');
    return JSON.parse(text('#out')) as Record<string, unknown>;
  };
  return { handle, root, said, text, result };
}

/** A network the app was granted one host of. */
const GRANTED = {
  'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.softn.test'] } } }),
};
const granted = { permissionMode: 'preapproved' };

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bytes with a type: Blob, File, FileReader', () => {
  it('are made, sliced and read as the web has them', async () => {
    const { handle, result } = await open({
      'index.html': page(
        '',
        `var blob = new Blob(['hello ', new Uint8Array([119, 111, 114, 108, 100]), new Blob(['!'])], { type: 'Text/Plain' });
        var file = new File(['a,b\\n1,2'], 'table.csv', { type: 'text/csv', lastModified: 5 });
        out.blob = [blob.size, blob.type, blob instanceof Blob, Object.prototype.toString.call(blob)].join('|');
        out.file = [file.name, file.size, file.type, file.lastModified, file instanceof Blob, file instanceof File, Object.prototype.toString.call(file)].join('|');
        out.empty = new Blob().size + '|' + new Blob([], { type: 'x/y' }).type;
        var reader = new FileReader();
        var seen = [];
        reader.addEventListener('loadstart', function () { seen.push('loadstart:' + reader.readyState); });
        reader.onload = function (e) { seen.push('load:' + reader.readyState + ':' + e.loaded); };
        reader.onloadend = function () {
          out.reader = seen.join(',') + ' -> ' + reader.result;
          var url = new FileReader();
          url.onload = function () {
            out.dataUrl = url.result;
            var bytes = new FileReader();
            bytes.onload = function () {
              out.buffer = bytes.result instanceof ArrayBuffer ? Array.prototype.slice.call(new Uint8Array(bytes.result)).join(',') : 'no';
              Promise.all([blob.text(), blob.slice(6, 11).text(), blob.slice(-1).text(), blob.arrayBuffer(), file.text()]).then(function (all) {
                out.read = [all[0], all[1], all[2], all[3].byteLength, all[4].length].join('|');
                done();
              });
            };
            bytes.readAsArrayBuffer(new Blob([new Uint8Array([1, 2, 3])]));
          };
          url.readAsDataURL(new Blob(['hi'], { type: 'text/plain' }));
        };
        reader.readAsText(blob);
        out.reading = reader.readyState;`
      ),
    });
    expect(await result()).toEqual({
      blob: '12|text/plain|true|[object Blob]',
      file: 'table.csv|7|text/csv|5|true|true|[object File]',
      empty: '0|x/y',
      reading: 1,
      reader: 'loadstart:1,load:2:12 -> hello world!',
      dataUrl: 'data:text/plain;base64,aGk=',
      buffer: '1,2,3',
      read: 'hello world!|world|!|12|7',
    });
    handle.dispose();
  });

  it('a response gives its body as a Blob, with the type the file has', async () => {
    const { handle, result } = await open({
      'pic.png': PNG,
      'index.html': page(
        '',
        `fetch('./pic.png').then(function (r) { return r.blob(); }).then(function (blob) {
          out.kind = [blob instanceof Blob, blob.size, blob.type].join('|');
          return blob.arrayBuffer();
        }).then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          out.magic = bytes[1] + ',' + bytes[2] + ',' + bytes[3];
          done();
        });`
      ),
    });
    expect(await result()).toEqual({ kind: `true|${PNG.length}|image/png`, magic: '80,78,71' });
    handle.dispose();
  });
});

describe('an address for a blob (URL.createObjectURL)', () => {
  it('is one the page draws from and the app fetches, minted by the host and never followed as a link', async () => {
    const { handle, root, result } = await open({
      'pic.png': PNG,
      'index.html': page(
        '<img id="shown" alt=""><img id="drawing" alt=""><img id="gone" alt=""><a id="link">save</a><p id="styled">p</p>',
        `fetch('./pic.png').then(function (r) { return r.blob(); }).then(function (blob) {
          var address = URL.createObjectURL(blob);
          out.address = /^blob:https:\\/\\/app\\.softn\\.local\\/[\\w-]+$/.test(address);
          document.getElementById('shown').src = address;
          // A drawing: the page is handed it as a picture, by the rule for the app's own files.
          var svg = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>top.__HOST_PWNED__ = 1</scr' + 'ipt></svg>'], { type: 'image/svg+xml' }));
          document.getElementById('drawing').src = svg;
          // A page of markup, as a blob: an address for it is not one a browser opens as a document.
          var markup = URL.createObjectURL(new Blob(['<script>top.__HOST_PWNED__ = 2</scr' + 'ipt>'], { type: 'text/html' }));
          var frame = document.createElement('img'); frame.id = 'markup'; frame.src = markup; document.body.appendChild(frame);
          // A link to a blob is a file to save or a document to open: neither is done.
          var link = document.getElementById('link'); link.href = address; link.setAttribute('download', 'pic.png');
          document.getElementById('styled').style.backgroundImage = 'url(' + address + ')';
          // Let go, and it names nothing from then on.
          var dropped = URL.createObjectURL(new Blob(['x'], { type: 'image/png' }));
          URL.revokeObjectURL(dropped);
          setTimeout(function () { document.getElementById('gone').src = dropped; }, 10);
          // An address that was never made.
          var made = document.createElement('img'); made.id = 'forged'; made.src = 'blob:https://app.softn.local/nothing'; document.body.appendChild(made);
          return fetch(address).then(function (r) { out.fetched = r.ok + '|' + r.headers.get('content-type'); return r.arrayBuffer(); }).then(function (buffer) {
            out.bytes = buffer.byteLength;
            return fetch(dropped).then(function () { return 'answered'; }, function (e) { return e.name; });
          }).then(function (after) { out.dropped = after; setTimeout(done, 40); });
        });`
      ),
    });
    expect(await result()).toEqual({ address: true, fetched: 'true|image/png', bytes: PNG.length, dropped: 'TypeError' });
    await settle();
    const src = (selector: string) => root.querySelector(selector)?.getAttribute('src') ?? null;
    // An address of the host's own making: never the app's word for one.
    expect(src('#shown')).toMatch(/^blob:/);
    expect(src('#shown')).not.toContain('app.softn.local');
    expect(src('#drawing')).toMatch(/^data:image\/svg\+xml;base64,/);
    // Markup is plain text at its address: drawn as a picture it is nothing, opened it runs nothing.
    expect(src('#markup')).toMatch(/^blob:/);
    const markup = await (await fetch(src('#markup')!)).blob();
    expect(markup.type).toBe('text/plain;charset=utf-8');
    expect(root.querySelector('#link')?.hasAttribute('href')).toBe(false);
    expect(root.querySelector('#styled')?.getAttribute('style')).toMatch(/url\(["']?blob:/);
    expect(src('#gone')).toBeNull();
    expect(src('#forged')).toBeNull();
    expect((globalThis as Record<string, unknown>).__HOST_PWNED__).toBeUndefined();
    handle.dispose();
  });
});

/** A blob's bytes, as this test's page reads them. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('a request, as the web sends one', () => {
  it('carries a form, a query, a blob and bytes as what they are, and takes a Request', async () => {
    const sent: Array<{ url: string; method: string; type: string | null; body: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      // A body with a file in it is put together by the Worker from its parts, and comes as a blob.
      const body = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : typeof raw === 'string' ? raw : raw instanceof Blob ? new TextDecoder().decode(await blobBytes(raw)) : '';
      sent.push({ url: String(input), method: init?.method ?? 'GET', type: headers.get('content-type'), body });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { handle, result } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '',
          `var api = 'https://api.softn.test/';
          var form = new FormData(); form.append('name', 'Ada'); form.append('file', new File(['a,b'], 'table.csv', { type: 'text/csv' }));
          var request = new Request(api + 'request', { method: 'put', headers: { 'X-Kind': 'r' }, body: 'from a request' });
          out.request = [request.url, request.method, request.headers.get('x-kind'), request instanceof Request].join('|');
          fetch(api + 'form', { method: 'POST', body: form })
            .then(function () { return fetch(api + 'query', { method: 'POST', body: new URLSearchParams({ q: 'a b', n: '1' }) }); })
            .then(function () { return fetch(api + 'blob', { method: 'POST', body: new Blob(['{"a":1}'], { type: 'application/json' }) }); })
            .then(function () { return fetch(api + 'bytes', { method: 'POST', headers: { 'Content-Type': 'application/x-thing' }, body: new Uint8Array([104, 105]).buffer }); })
            .then(function () { return fetch(api + 'text', { method: 'POST', body: 'plain' }); })
            .then(function () { return fetch(request); })
            .then(function (r) { return r.json(); })
            .then(function (json) { out.answer = json.ok; done(); }, function (e) { out.failed = String(e); done(); });`
        ),
      },
      granted
    );
    expect(await result()).toEqual({ request: 'https://api.softn.test/request|PUT|r|true', answer: true });
    const by = (name: string) => sent.find((entry) => entry.url.endsWith(name))!;
    const form = by('form');
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(form.type ?? '')?.[1];
    expect(boundary).toBeTruthy();
    expect(form.body).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nAda\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="table.csv"\r\nContent-Type: text/csv\r\n\r\na,b\r\n--${boundary}--\r\n`
    );
    expect(by('query')).toMatchObject({ type: 'application/x-www-form-urlencoded;charset=UTF-8', body: 'q=a+b&n=1' });
    expect(by('blob')).toMatchObject({ type: 'application/json', body: '{"a":1}' });
    expect(by('bytes')).toMatchObject({ type: 'application/x-thing', body: 'hi' });
    expect(by('text')).toMatchObject({ type: 'text/plain;charset=UTF-8', body: 'plain' });
    expect(by('request')).toMatchObject({ method: 'PUT', body: 'from a request' });
    handle.dispose();
  });

  it('ends the wait when the app’s signal says so', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    const { handle, result } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '',
          `var stop = new AbortController();
          fetch('https://api.softn.test/slow', { signal: stop.signal }).then(function () { out.slow = 'answered'; }, function (e) { out.slow = e.name; })
            .then(function () { return fetch('https://api.softn.test/never', { signal: stop.signal }); })
            .then(function () { out.already = 'answered'; done(); }, function (e) { out.already = e.name; done(); });
          setTimeout(function () { stop.abort(); }, 20);`
        ),
      },
      granted
    );
    expect(await result()).toEqual({ slow: 'AbortError', already: 'AbortError' });
    handle.dispose();
  });
});

describe('an answer read as it arrives', () => {
  /** A network whose answer the test writes a piece at a time. */
  function slowNetwork(type = 'text/plain') {
    const asked: Array<{ url: string; headers: Record<string, string>; signal: AbortSignal | null }> = [];
    const writers: Array<{ write: (text: string | Uint8Array) => void; end: () => void }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), signal: init?.signal ?? null });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let ended = false;
      const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
      // A request let go is one the network stops writing to.
      init?.signal?.addEventListener('abort', () => {
        if (!ended) controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        ended = true;
      });
      writers.push({
        write: (text) => { if (!ended) controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text); },
        end: () => { if (!ended) controller.close(); ended = true; },
      });
      return new Response(body, { status: 200, headers: { 'content-type': type } });
    });
    return { asked, writers };
  }

  it('hands the app each piece of an answer as it comes, through response.body', async () => {
    const { writers } = slowNetwork();
    const { handle, text } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '<p id="seen"></p>',
          `var seen = [];
          var say = function (what) { seen.push(what); document.getElementById('seen').textContent = seen.join(' '); };
          fetch('https://api.softn.test/words').then(function (response) {
            say('head:' + response.status + ':' + (response.body instanceof ReadableStream) + ':' + response.body.locked);
            var reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
            var read = function () {
              return reader.read().then(function (step) {
                if (step.done) { say('end'); return; }
                say('[' + step.value + ']');
                return read();
              });
            };
            return read();
          });`
        ),
      },
      granted
    );
    await expect.poll(() => writers.length).toBe(1);
    await expect.poll(() => text('#seen')).toBe('head:200:true:false');
    // Each piece is the app's before the next is written.
    writers[0].write('Hel');
    await expect.poll(() => text('#seen')).toBe('head:200:true:false [Hel]');
    // A character cut in two by the network arrives whole.
    const o = new TextEncoder().encode('lo wörld');
    writers[0].write(o.subarray(0, 5));
    await expect.poll(() => text('#seen')).toBe('head:200:true:false [Hel] [lo w]');
    writers[0].write(o.subarray(5));
    await expect.poll(() => text('#seen')).toBe('head:200:true:false [Hel] [lo w] [örld]');
    writers[0].end();
    await expect.poll(() => text('#seen')).toBe('head:200:true:false [Hel] [lo w] [örld] end');
    handle.dispose();
  });

  it('still gives the whole of it to code that asks for the whole, and walks it with for await', async () => {
    const { writers } = slowNetwork('application/json');
    const { handle, result } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '',
          `fetch('https://api.softn.test/whole').then(function (response) { return response.json(); }).then(function (json) {
            out.whole = json.n;
            return fetch('https://api.softn.test/walk');
          }).then(async function (response) {
            var sizes = [];
            for await (var piece of response.body) sizes.push(piece.length);
            out.walked = sizes.join('+');
            try { await response.text(); out.again = 'read'; } catch (e) { out.again = e.name; }
            done();
          });`
        ),
      },
      granted
    );
    await expect.poll(() => writers.length).toBe(1);
    writers[0].write('{"n":');
    writers[0].write('42}');
    writers[0].end();
    await expect.poll(() => writers.length).toBe(2);
    writers[1].write('abc');
    await settle(40);
    writers[1].write('de');
    writers[1].end();
    // A body walked piece by piece has been read: asked for again whole, it says so, as on the web.
    expect(await result()).toEqual({ whole: 42, walked: '3+2', again: 'TypeError' });
    handle.dispose();
  });

  it('gives a copy its own reading of the answer, and a file of the app’s own a body to read too', async () => {
    const { writers } = slowNetwork('application/json');
    const { handle, result } = await open(
      {
        ...GRANTED,
        'notes.txt': 'kept in the app',
        'index.html': page(
          '',
          `fetch('https://api.softn.test/copied').then(function (response) {
            var copy = response.clone();
            out.before = [response.bodyUsed, copy.bodyUsed, copy.status, copy.headers.get('content-type')].join('|');
            return Promise.all([response.text(), copy.json()]).then(function (both) {
              out.both = both[0] + '|' + both[1].n;
              out.after = [response.bodyUsed, copy.bodyUsed].join('|');
              try { response.clone(); out.late = 'copied'; } catch (e) { out.late = e.name; }
            });
          }).then(function () { return fetch('notes.txt'); }).then(function (response) {
            return response.body.pipeThrough(new TextDecoderStream()).getReader().read();
          }).then(function (step) { out.own = step.value; done(); });`
        ),
      },
      granted
    );
    await expect.poll(() => writers.length).toBe(1);
    // Half before the copy is read and half after: each has all of it.
    writers[0].write('{"n":');
    await settle(60);
    writers[0].write('7}');
    writers[0].end();
    expect(await result()).toEqual({ before: 'false|false|200|application/json', both: '{"n":7}|7', after: 'true|true', late: 'TypeError', own: 'kept in the app' });
    handle.dispose();
  });

  it('lets the network go when the app says stop, or stops reading', async () => {
    const { asked, writers } = slowNetwork();
    const { handle, result } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '',
          `var stopper = new AbortController();
          fetch('https://api.softn.test/stopped', { signal: stopper.signal }).then(function (response) {
            var reader = response.body.getReader();
            return reader.read().then(function (step) {
              out.first = new TextDecoder().decode(step.value);
              stopper.abort();
              return reader.read();
            });
          }).then(function () { out.stopped = 'read on'; }, function (e) { out.stopped = e.name; }).then(function () {
            return fetch('https://api.softn.test/dropped');
          }).then(function (response) {
            var reader = response.body.getReader();
            return reader.read().then(function () { return reader.cancel(); });
          }).then(function () { out.dropped = 'let go'; done(); });`
        ),
      },
      granted
    );
    await expect.poll(() => writers.length).toBe(1);
    writers[0].write('abc');
    await expect.poll(() => writers.length).toBe(2);
    expect(asked[0].signal?.aborted, 'a request the app stopped is ended on the network').toBe(true);
    writers[1].write('xyz');
    expect(await result()).toEqual({ first: 'abc', stopped: 'AbortError', dropped: 'let go' });
    await expect.poll(() => asked[1].signal?.aborted, { message: 'a body the app let go of is ended on the network' }).toBe(true);
    handle.dispose();
  });

  it('asks the network for twelve at a time until each is answered, and a feed that stays open keeps no request waiting', async () => {
    // A network that answers when the test says so, with a body that stays open.
    const answers: Array<() => void> = [];
    const bodies: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    vi.stubGlobal('fetch', async () => {
      await new Promise<void>((resolve) => answers.push(resolve));
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => { bodies.push(c); } }), { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const { handle, result } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '',
          `var heads = 0;
          for (var i = 0; i < 15; i++) {
            fetch('https://api.softn.test/' + i).then(function () {
              heads++;
              if (heads === 15) { out.heads = heads; done(); }
            });
          }`
        ),
      },
      granted
    );
    await expect.poll(() => answers.length).toBe(12);
    await settle(150);
    expect(answers.length, 'the thirteenth waits for one of the twelve to be answered').toBe(12);
    // Three are answered, and stay open as a feed does: three more are asked.
    for (const answer of answers.slice(0, 3)) answer();
    await expect.poll(() => answers.length).toBe(15);
    // All fifteen answered and all fifteen open: none of them kept another waiting.
    for (const answer of answers) answer();
    expect(await result()).toEqual({ heads: 15 });
    expect(bodies.length).toBe(15);
    handle.dispose();
  });

  it('finishes a request that is under way while the app is not shown', async () => {
    const { writers } = slowNetwork();
    const { handle, result } = await open(
      {
        ...GRANTED,
        'index.html': page('', `fetch('https://api.softn.test/behind').then(function (response) { return response.text(); }).then(function (text) { out.text = text; done(); });`),
      },
      granted
    );
    await expect.poll(() => writers.length).toBe(1);
    // A tab behind another: its timers wait, the answer it asked for does not.
    handle.setActive(false);
    writers[0].write('answered ');
    writers[0].write('while hidden');
    writers[0].end();
    expect(await result()).toEqual({ text: 'answered while hidden' });
    handle.dispose();
  });

  it('does not read the network further ahead than a reader keeps up', async () => {
    // A network that writes for as long as it is read: what stops it is nobody reading.
    const PIECE = 128 * 1024;
    let written = 0;
    vi.stubGlobal('fetch', async () => {
      const body = new ReadableStream<Uint8Array>({ pull: (controller) => { written++; controller.enqueue(new Uint8Array(PIECE).fill(97)); } }, { highWaterMark: 0 });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
    const { handle, root, text } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '<p id="seen">…</p><button id="more" type="button">more</button>',
          `fetch('https://api.softn.test/endless').then(function (response) {
            var reader = response.body.getReader();
            var taken = 0;
            reader.read().then(function (step) {
              taken += step.value.length;
              document.getElementById('seen').textContent = 'took ' + taken;
            });
            document.getElementById('more').addEventListener('click', function () {
              var again = function (left) {
                if (!left) { document.getElementById('seen').textContent = 'took ' + taken; return reader.cancel(); }
                return reader.read().then(function (step) { taken += step.value.length; return again(left - 1); });
              };
              again(40);
            });
          });`
        ),
      },
      granted
    );
    await expect.poll(() => text('#seen'), { timeout: 15_000 }).toBe(`took ${PIECE}`);
    // The reader stops; so, a few megabytes on, does the reading of the network.
    let before = -1;
    await expect
      .poll(
        async () => {
          const was = before;
          before = written;
          await settle(400);
          return written === was;
        },
        { timeout: 30_000, interval: 50 }
      )
      .toBe(true);
    const held = written;
    expect(held * PIECE, 'what waits unread is a few megabytes, not all the network has').toBeLessThan(8 * 1024 * 1024);
    // The reader reads on: the network is read again.
    (root.querySelector('#more') as HTMLElement).click();
    await expect.poll(() => text('#seen'), { timeout: 30_000 }).toBe(`took ${41 * PIECE}`);
    expect(written).toBeGreaterThan(held);
    handle.dispose();
  }, 90_000);

  it('reads a feed the server keeps open a message at a time, and asks for it again from where it left off', async () => {
    const { asked, writers } = slowNetwork('text/event-stream');
    const { handle, text } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '<p id="seen"></p><button id="stop" type="button">stop</button>',
          `var seen = [];
          var say = function (what) { seen.push(what); document.getElementById('seen').textContent = seen.join(' '); };
          var feed = new EventSource('https://api.softn.test/feed');
          say('state:' + feed.readyState);
          feed.onopen = function () { say('open:' + feed.readyState); };
          feed.onmessage = function (e) { say('message:' + e.data.replace(/\\n/g, '/') + ':' + e.lastEventId); };
          feed.addEventListener('tick', function (e) { say('tick:' + JSON.parse(e.data).n + ':' + (e instanceof MessageEvent)); });
          feed.onerror = function () { say('error:' + feed.readyState); };
          document.getElementById('stop').addEventListener('click', function () { feed.close(); say('closed:' + feed.readyState); });`
        ),
      },
      granted
    );
    await expect.poll(() => writers.length).toBe(1);
    expect(asked[0].headers.accept).toBe('text/event-stream');
    await expect.poll(() => text('#seen')).toBe('state:0 open:1');
    // A message of two lines, cut by the network in the middle of a line; a comment; a named event with an id; the wait before asking again.
    writers[0].write(': hello\n\ndata: one\ndata: tw');
    writers[0].write('o\n\nevent: tick\nid: 7\nretry: 100\ndata: {"n":2}\n\n');
    await expect.poll(() => text('#seen')).toBe('state:0 open:1 message:one/two: tick:2:true');
    // The feed ends: said, and asked for again after the wait, from the last message it had.
    writers[0].end();
    await expect.poll(() => writers.length, { timeout: 5_000 }).toBe(2);
    expect(asked[1].headers['last-event-id']).toBe('7');
    await expect.poll(() => text('#seen')).toBe('state:0 open:1 message:one/two: tick:2:true error:0 open:1');
    writers[1].write('data: three\n\n');
    await expect.poll(() => text('#seen')).toContain('message:three:7');
    (handle.shadowRoot.querySelector('#stop') as HTMLElement).click();
    await expect.poll(() => text('#seen')).toContain('closed:2');
    // Closed: the end of the feed is not followed by another.
    writers[1].end();
    await settle(300);
    expect(writers.length).toBe(2);
    handle.dispose();
  });

  it('asks for a feed as a browser does, and again without its place of a server that will not hear of it', async () => {
    // A server on another site is asked first about a request that names what a plain one
    // does not. The feed's first asking names nothing of the kind; the place it left off
    // does, and a server that answers no to that question is one the request never reaches.
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      asked.push(`${Object.keys(headers).sort().join(',')}|${headers['last-event-id'] ?? '-'}|${init?.cache}|${init?.credentials}|${init?.redirect}`);
      if (headers['last-event-id']) throw new TypeError('Failed to fetch');
      const first = asked.length === 1;
      const words = new TextEncoder().encode(first ? 'retry: 100\nid: 9\ndata: one\n\n' : 'data: two\n\n');
      // The first answer ends; the second stays open.
      const body = new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(words); if (first) c.close(); } });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const { handle, text } = await open(
      {
        ...GRANTED,
        'index.html': page(
          '<p id="seen"></p>',
          `var seen = [];
          var feed = new EventSource('https://api.softn.test/feed');
          feed.onmessage = function (e) { seen.push(e.data + ':' + e.lastEventId); document.getElementById('seen').textContent = seen.join(' '); };`
        ),
      },
      granted
    );
    await expect.poll(() => text('#seen'), { timeout: 10_000 }).toBe('one:9 two:9');
    expect(asked).toEqual(['accept|-|no-store|omit|error', 'accept,last-event-id|9|no-store|omit|error', 'accept|-|no-store|omit|error']);
    handle.dispose();
  });

  it('does not use the browser’s copy of an answer for the site the app is embedded in, and elsewhere only as the app says', async () => {
    // The browser keeps one copy of an answer whoever asked for it and however. The page
    // the app is embedded in asks its own site with the person's cookies; a copy it was
    // given that way would answer the app's request, which goes without them.
    expect(sameSite('api.example.com', 'example.com')).toBe(true);
    expect(sameSite('example.com', 'EXAMPLE.com.')).toBe(true);
    expect(sameSite('example.com', 'example.org')).toBe(false);
    expect(sameSite('localhost', 'intranet')).toBe(false);
    expect(sameSite('10.0.0.1', '10.0.0.2')).toBe(false);
    expect(sameSite('10.0.0.1', '10.0.0.1')).toBe(true);
    expect(sameSite('', '')).toBe(false);
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${new URL(String(input)).pathname}:${init?.cache}:${init?.credentials}`);
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const here = window.location.origin;
    const { handle, result } = await open(
      {
        'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allow_http: true, allowed_hosts: [window.location.hostname, 'api.softn.test'] } } }),
        'index.html': page(
          '',
          `var ask = function (address, init) { return fetch(address, init).then(function (response) { return response.text(); }); };
          ask('${here}/own').then(function () { return ask('${here}/own-kept', { cache: 'force-cache' }); })
            .then(function () { return ask('https://api.softn.test/plain'); })
            .then(function () { return ask('https://api.softn.test/kept', { cache: 'force-cache' }); })
            .then(function () { return ask('https://api.softn.test/fresh', { cache: 'no-store' }); })
            .then(function () { return ask('https://api.softn.test/again', { cache: 'no-cache' }); })
            .then(function () { out.done = true; done(); });`
        ),
      },
      granted
    );
    expect(await result()).toEqual({ done: true });
    expect(asked).toEqual(['/own:no-store:omit', '/own-kept:no-store:omit', '/plain:undefined:omit', '/kept:undefined:omit', '/fresh:no-store:omit', '/again:reload:omit']);
    handle.dispose();
  });

  it('is refused for a site the app was not granted, like any request', async () => {
    const { asked } = slowNetwork();
    const { handle, result } = await open(
      {
        ...GRANTED,
        'index.html': page('', `fetch('https://elsewhere.example/x').then(function () { out.elsewhere = 'answered'; done(); }, function (e) { out.elsewhere = e.name + ': ' + /not permitted/.test(e.message); done(); });`),
      },
      granted
    );
    expect(await result()).toEqual({ elsewhere: 'TypeError: true' });
    expect(asked).toEqual([]);
    handle.dispose();
  });
});

describe('a canvas’s picture, as a file', () => {
  it('is read back from the page after the turn’s drawing, and can be saved like any file the app made', async () => {
    const drawn: string[] = [];
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const getContext = HTMLCanvasElement.prototype.getContext;
    // This test's page draws nothing: it keeps what it was asked to draw, and hands back a picture of that.
    const context = (canvas: HTMLCanvasElement) =>
      new Proxy({}, { get: (_t, name) => (name === 'canvas' ? canvas : (...args: unknown[]) => { if (name === 'fillRect') drawn.push(`rect:${args.join(',')}`); }), set: () => true });
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return context(this);
    } as unknown as typeof getContext;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string) {
      callback(new Blob([`picture of ${drawn.join(';')}`], { type: type ?? 'image/png' }));
    };
    const asked: Array<{ name: string; type: string; text: string }> = [];
    try {
      const { handle, root, result } = await open(
        {
          'index.html': page(
            '<canvas id="c" width="20" height="10"></canvas><button id="export" type="button">export</button>',
            `var canvas = document.getElementById('c');
            document.getElementById('export').addEventListener('click', function () {
              canvas.getContext('2d').fillRect(1, 2, 3, 4);
              canvas.toBlob(function (blob) {
                out.blob = [blob instanceof Blob, blob.type, blob.size > 0].join('|');
                var link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'drawing.png';
                link.click();
                document.createElement('canvas').toBlob(function (none) { out.apart = String(none); done(); });
              });
            });`
          ),
        },
        {
          onSaveRequest: (file: { name: string; type: string; bytes: Uint8Array }) => {
            asked.push({ name: file.name, type: file.type, text: new TextDecoder().decode(file.bytes) });
            return false;
          },
        }
      );
      (root.querySelector('#export') as HTMLElement).click();
      expect(await result()).toEqual({ blob: 'true|image/png|true', apart: 'null' });
      // The picture is of what was drawn in the same turn it was asked for.
      await expect.poll(() => asked).toEqual([{ name: 'drawing.png', type: 'image/png', text: 'picture of rect:1,2,3,4' }]);
      handle.dispose();
    } finally {
      HTMLCanvasElement.prototype.toBlob = toBlob;
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });

  it('is not read back once a picture from the network has been drawn into it', async () => {
    // The browser fetches a picture on the page with the person's cookies for its site. An
    // app may show one from a site it was granted; it may not read one back, and from the
    // embedding page's own site the browser's own rule would not stop it.
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      const canvas = () => this;
      return new Proxy({}, { get: (_t, name) => (name === 'canvas' ? canvas() : () => undefined), set: () => true });
    } as unknown as typeof getContext;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
      callback(new Blob(['picture'], { type: 'image/png' }));
    };
    // The pictures have loaded by the time they are drawn, as in a browser (this test's page loads none: a picture not loaded draws nothing, and taints nothing).
    const loaded = { natural: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth'), complete: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete') };
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 1 });
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    try {
      const { handle, result } = await open(
        {
          ...GRANTED,
          'dot.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
          'index.html': page(
            '<img id="pic" src="https://api.softn.test/account.png"><img id="own" src="dot.png"><canvas id="net"></canvas><canvas id="mine"></canvas><canvas id="copy"></canvas>',
            `var net = document.getElementById('net'), mine = document.getElementById('mine'), copy = document.getElementById('copy');
            net.getContext('2d').drawImage(document.getElementById('pic'), 0, 0);
            mine.getContext('2d').drawImage(document.getElementById('own'), 0, 0);
            setTimeout(function () {
              // A canvas drawn from one that is not the app's to read is not either.
              copy.getContext('2d').drawImage(net, 0, 0);
              net.toBlob(function (a) { mine.toBlob(function (b) { copy.toBlob(function (c) {
                out.read = [String(a), b instanceof Blob, String(c)].join('|');
                done();
              }); }); });
            }, 30);`
          ),
        },
        granted
      );
      expect(await result()).toEqual({ read: 'null|true|null' });
      handle.dispose();
    } finally {
      HTMLCanvasElement.prototype.toBlob = toBlob;
      HTMLCanvasElement.prototype.getContext = getContext;
      if (loaded.natural) Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', loaded.natural);
      if (loaded.complete) Object.defineProperty(HTMLImageElement.prototype, 'complete', loaded.complete);
    }
  });
});

describe('XMLHttpRequest', () => {
  it('reads a file of the app’s and a site it was granted, and says each step as a browser’s does', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input)} ${new Headers(init?.headers).get('x-token')} ${typeof init?.body === 'string' ? init.body : ''}`);
      return new Response('{"n":7}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json', 'x-served': 'yes' } });
    });
    const { handle, result } = await open(
      {
        ...GRANTED,
        'data.json': '{"greeting":"hello"}',
        'index.html': page(
          '',
          `var steps = [];
          var local = new XMLHttpRequest();
          local.onreadystatechange = function () { steps.push(local.readyState); };
          local.addEventListener('loadend', function () {
            out.local = [steps.join(''), local.status, JSON.parse(local.responseText).greeting, local.getResponseHeader('content-type')].join('|');
            var remote = new XMLHttpRequest();
            remote.responseType = 'json';
            remote.open('POST', 'https://api.softn.test/items');
            remote.setRequestHeader('X-Token', 'abc');
            remote.onload = function (e) {
              out.remote = [remote.status, remote.statusText, remote.response.n, remote.getResponseHeader('x-served'), /x-served: yes/.test(remote.getAllResponseHeaders()), e.type, e.lengthComputable].join('|');
              var refused = new XMLHttpRequest();
              refused.open('GET', 'https://elsewhere.example/');
              refused.onload = function () { out.refused = 'loaded'; done(); };
              refused.onerror = function () { out.refused = 'error:' + refused.status + ':' + refused.readyState; done(); };
              refused.send();
            };
            remote.send('{"name":"x"}');
          });
          local.open('GET', './data.json');
          local.send();
          try { new XMLHttpRequest().open('GET', './data.json', false); out.held = 'opened'; } catch (e) { out.held = e.name; }
          out.constants = XMLHttpRequest.DONE + '' + new XMLHttpRequest().UNSENT;`
        ),
      },
      granted
    );
    expect(await result()).toEqual({
      held: 'NotSupportedError',
      constants: '40',
      local: '1234|200|hello|application/json; charset=utf-8',
      remote: '201|Created|7|yes|true|load|true',
      refused: 'error:0:4',
    });
    // The granted site was asked, as written; the other never was.
    expect(asked).toEqual(['POST https://api.softn.test/items abc {"name":"x"}']);
    handle.dispose();
  });
});

describe('WebSocket', () => {
  class FakeSocket {
    static made: FakeSocket[] = [];
    readyState = 0;
    binaryType = 'blob';
    protocol = '';
    extensions = '';
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    constructor(
      readonly url: string,
      readonly protocols?: string[]
    ) {
      FakeSocket.made.push(this);
    }
    send(data: unknown) {
      this.sent.push(data instanceof Uint8Array ? `bytes:${[...data].join(',')}` : data);
    }
    close(code?: number, reason?: string) {
      this.readyState = 3;
      this.onclose?.({ code: code ?? 1005, reason: reason ?? '', wasClean: true });
    }
    open(protocol = '') {
      this.readyState = 1;
      this.protocol = protocol;
      this.onopen?.();
    }
  }

  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  const CHAT = `var socket = new WebSocket('wss://api.softn.test/chat', ['v1']);
    var seen = [];
    var say = function (what) { seen.push(what); document.getElementById('seen').textContent = seen.join(' '); };
    say('state:' + socket.readyState);
    socket.binaryType = 'arraybuffer';
    socket.onopen = function () { say('open:' + socket.readyState + ':' + socket.protocol); socket.send('hello'); socket.send(new Uint8Array([1, 2]).buffer); };
    socket.addEventListener('message', function (e) {
      say(typeof e.data === 'string' ? 'text:' + e.data : 'bytes:' + Array.prototype.slice.call(new Uint8Array(e.data)).join(','));
      if (e.data === 'bye') socket.close(1000, 'done');
    });
    socket.onclose = function (e) { say('close:' + e.code + ':' + e.reason + ':' + e.wasClean + ':' + socket.readyState); };`;

  it('is opened by the Worker for a host the app was granted, and carries text and bytes both ways', async () => {
    const { handle, text } = await open({ ...GRANTED, 'index.html': page('<p id="seen"></p>', CHAT) }, granted);
    await expect.poll(() => FakeSocket.made.length).toBe(1);
    const socket = FakeSocket.made[0];
    expect(socket.url).toBe('wss://api.softn.test/chat');
    expect(socket.protocols).toEqual(['v1']);
    expect(text('#seen')).toBe('state:0');
    socket.open('v1');
    await expect.poll(() => text('#seen')).toBe('state:0 open:1:v1');
    await expect.poll(() => socket.sent).toEqual(['hello', 'bytes:1,2']);
    socket.onmessage?.({ data: 'one' });
    socket.onmessage?.({ data: new Uint8Array([7, 8, 9]).buffer });
    await expect.poll(() => text('#seen')).toBe('state:0 open:1:v1 text:one bytes:7,8,9');
    socket.onmessage?.({ data: 'bye' });
    await expect.poll(() => text('#seen')).toBe('state:0 open:1:v1 text:one bytes:7,8,9 text:bye close:1000:done:true:3');
    handle.dispose();
  });

  it('is refused for a host the app was not granted, for an app granted nothing, and closed with the app', async () => {
    const elsewhere = CHAT.replace('wss://api.softn.test/chat', 'wss://elsewhere.example/chat');
    const refused = await open({ ...GRANTED, 'index.html': page('<p id="seen"></p>', elsewhere) }, granted);
    await expect.poll(() => refused.text('#seen')).toBe('state:0 close:1006::false:3');
    refused.handle.dispose();
    // Declared, and not allowed by the person.
    const unasked = await open({ ...GRANTED, 'index.html': page('<p id="seen"></p>', CHAT) });
    await expect.poll(() => unasked.text('#seen')).toBe('state:0 close:1006::false:3');
    unasked.handle.dispose();
    // An unencrypted socket is plain http: not without the app having declared that.
    const plain = await open({ ...GRANTED, 'index.html': page('<p id="seen"></p>', CHAT.replace('wss://', 'ws://')) }, granted);
    await expect.poll(() => plain.text('#seen')).toBe('state:0 close:1006::false:3');
    plain.handle.dispose();
    expect(FakeSocket.made).toEqual([]);

    const live = await open({ ...GRANTED, 'index.html': page('<p id="seen"></p>', CHAT) }, granted);
    await expect.poll(() => FakeSocket.made.length).toBe(1);
    FakeSocket.made[0].open();
    await expect.poll(() => live.text('#seen')).toContain('open:1');
    live.handle.dispose();
    expect(FakeSocket.made[0].readyState).toBe(3);
  });
});

describe('an image, and when it has loaded', () => {
  /** An image as the page loads one: this test's jsdom loads none, so each says what its address deserves. */
  class FakeImage extends EventTarget {
    static asked: string[] = [];
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    private address = '';
    get src() {
      return this.address;
    }
    set src(value: string) {
      this.address = value;
      FakeImage.asked.push(value);
      setTimeout(() => {
        this.complete = true;
        const ok = !value.includes('broken');
        if (ok) {
          this.naturalWidth = 3;
          this.naturalHeight = 2;
        }
        this.dispatchEvent(new Event(ok ? 'load' : 'error'));
      }, 5);
    }
  }

  it('loads a picture of the app’s own, a blob and a data: address asked for with CORS, as three.js asks for every texture', async () => {
    // Every image asked for with CORS was fetched to be read back, which takes only http(s):
    // a texture from the app's own files never loaded.
    FakeImage.asked = [];
    vi.stubGlobal('Image', FakeImage);
    const { handle, result } = await open({
      'sprite.png': PNG,
      'index.html': page(
        '',
        `var loaded = [];
        var load = function (address, name) {
          var picture = new Image();
          picture.crossOrigin = 'anonymous';
          picture.onload = function () { loaded.push(name + ' load'); if (loaded.length === 3) { out.loaded = loaded.sort(); done(); } };
          picture.onerror = function () { loaded.push(name + ' error'); if (loaded.length === 3) { out.loaded = loaded.sort(); done(); } };
          picture.src = address;
        };
        load('./sprite.png', 'own');
        load(URL.createObjectURL(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })), 'blob');
        load('data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'data');`
      ),
    });
    expect(await result()).toEqual({ loaded: ['blob load', 'data load', 'own load'] });
    handle.dispose();
    vi.unstubAllGlobals();
  });

  it('says load to an image that is on no page, with its size, and error to one that cannot be loaded', async () => {
    FakeImage.asked = [];
    vi.stubGlobal('Image', FakeImage);
    const { handle, result } = await open({
      'sprite.png': PNG,
      'index.html': page(
        '',
        `var sprite = new Image();
        out.before = [sprite instanceof HTMLImageElement, sprite.complete, sprite.naturalWidth].join('|');
        // Once: it ran twice (a sprite drawn in it was drawn twice).
        out.loads = 0;
        sprite.onload = function () {
          out.loads++;
          if (out.loads > 1) return;
          out.sprite = [sprite.complete, sprite.naturalWidth, sprite.naturalHeight, sprite.width].join('|');
          var missing = new Image(10, 20);
          missing.addEventListener('error', function () {
            out.missing = [missing.complete, missing.naturalWidth, missing.width, missing.height].join('|');
            var elsewhere = document.createElement('img');
            elsewhere.onerror = function () { out.elsewhere = 'error'; sprite.decode().then(function () { out.decoded = 'yes'; done(); }); };
            elsewhere.onload = function () { out.elsewhere = 'loaded'; done(); };
            elsewhere.setAttribute('src', 'https://elsewhere.example/pixel.png');
          });
          missing.src = './not-there.png';
        };
        sprite.src = './sprite.png';
        out.loading = sprite.complete;
        out.empty = new Image().complete;`
      ),
    });
    expect(await result()).toEqual({
      before: 'true|true|0',
      loads: 1,
      loading: false,
      empty: true,
      sprite: 'true|3|2|3',
      missing: 'true|0|10|20',
      elsewhere: 'error',
      decoded: 'yes',
    });
    // Only the app's own file was ever asked of the page, at an address the host minted.
    expect(FakeImage.asked.length).toBe(1);
    expect(FakeImage.asked[0]).toMatch(/^blob:/);
    handle.dispose();
  });

  it('hears an image on the page load, once, and reads its size', async () => {
    const { handle, root, text } = await open({
      'pic.png': PNG,
      'index.html': page(
        '<img id="static" src="./pic.png" alt=""><p id="seen"></p>',
        `var seen = [];
        var say = function (what) { seen.push(what); document.getElementById('seen').textContent = seen.join(' '); };
        var made = document.createElement('img');
        made.id = 'made';
        made.onload = function () { say('made:' + made.complete + ':' + made.naturalWidth + 'x' + made.naturalHeight); };
        made.src = './pic.png';
        document.body.appendChild(made);
        say('complete:' + made.complete);
        document.getElementById('static').addEventListener('load', function (e) { say('static:' + e.target.naturalWidth); });`
      ),
    });
    await settle();
    expect(text('#seen')).toBe('complete:false');
    // The page's own image has loaded: said as the page says it.
    const made = root.querySelector('#made') as HTMLImageElement;
    Object.defineProperty(made, 'naturalWidth', { value: 4 });
    Object.defineProperty(made, 'naturalHeight', { value: 5 });
    made.dispatchEvent(new Event('load'));
    await expect.poll(() => text('#seen')).toBe('complete:false made:true:4x5');
    const fixed = root.querySelector('#static') as HTMLImageElement;
    Object.defineProperty(fixed, 'naturalWidth', { value: 9 });
    fixed.dispatchEvent(new Event('load'));
    await expect.poll(() => text('#seen')).toBe('complete:false made:true:4x5 static:9');
    handle.dispose();
  });
});

describe('MessageChannel, a range, and elements of the app’s own making', () => {
  it('passes a message between the two ports of a channel, a turn later', async () => {
    const { handle, result } = await open({
      'index.html': page(
        '',
        `var channel = new MessageChannel();
        var order = [];
        channel.port2.onmessage = function (e) {
          order.push('got:' + e.data.n + ':' + (e instanceof MessageEvent));
          channel.port2.postMessage('back');
        };
        channel.port1.addEventListener('message', function (e) { order.push('answer:' + e.data); out.order = order.join(','); done(); });
        channel.port1.start();
        var sent = { n: 1 };
        channel.port1.postMessage(sent);
        sent.n = 2;
        order.push('posted');`
      ),
    });
    expect(await result()).toEqual({ order: 'posted,got:1:true,answer:back' });
    handle.dispose();
  });

  it('marks a place in the page with a range, and parses markup through one', async () => {
    const { handle, root, result } = await open({
      'index.html': page(
        '<div id="box"><b>one</b><i>two</i><u>three</u></div><div id="into"></div>',
        `var box = document.getElementById('box');
        var range = document.createRange();
        out.kind = [range instanceof Range, range.collapsed].join('|');
        range.selectNodeContents(box);
        out.all = [range.startOffset, range.endOffset, range.toString(), range.commonAncestorContainer === box].join('|');
        range.setStartAfter(box.firstChild);
        range.setEndBefore(box.lastChild);
        out.middle = [range.startOffset, range.endOffset, range.toString(), range.collapsed].join('|');
        var copy = range.cloneRange();
        copy.collapse(true);
        out.copy = copy.collapsed + '|' + range.collapsed;
        range.deleteContents();
        out.after = box.textContent;
        var fragment = document.createRange().createContextualFragment('<p class="made">made <b>here</b></p><p class="made">too</p>');
        out.fragment = fragment.childNodes.length + '|' + fragment.firstChild.textContent;
        document.getElementById('into').appendChild(fragment);
        var mark = document.createElement('mark'); mark.textContent = '!';
        var at = document.createRange(); at.setStart(box, 1); at.insertNode(mark);
        out.inserted = box.textContent;
        done();`
      ),
    });
    expect(await result()).toEqual({ kind: 'true|true', all: '0|3|onetwothree|true', middle: '1|2|two|false', copy: 'true|false', after: 'onethree', fragment: '2|made here', inserted: 'one!three' });
    expect(root.querySelectorAll('#into .made').length).toBe(2);
    handle.dispose();
  });

  it('makes an element of the app’s own by its name: one in the markup, one the script makes, and one made with new', async () => {
    const { handle, root, result } = await open({
      'index.html': page(
        '<user-card id="first" name="Ada"></user-card><div id="list"></div>',
        `var log = [];
        class UserCard extends HTMLElement {
          static get observedAttributes() { return ['name']; }
          constructor() { super(); this.made = true; log.push('made:' + (this.id || '-')); }
          connectedCallback() { log.push('joined:' + this.id); this.render(); }
          disconnectedCallback() { log.push('left:' + this.id); }
          attributeChangedCallback(name, before, now) { log.push(name + ':' + before + '>' + now); if (this.isConnected) this.render(); }
          render() { this.innerHTML = '<b class="name">' + (this.getAttribute('name') || 'nobody') + '</b>'; }
          greet() { return 'hi ' + this.getAttribute('name'); }
        }
        out.before = [typeof customElements.get('user-card'), document.getElementById('first') instanceof UserCard].join('|');
        var ready = customElements.whenDefined('user-card');
        customElements.define('user-card', UserCard);
        var first = document.getElementById('first');
        out.upgraded = [first instanceof UserCard, first instanceof HTMLElement, first.made, first.greet(), customElements.get('user-card') === UserCard, customElements.getName(UserCard)].join('|');
        var second = document.createElement('user-card');
        second.id = 'second';
        out.created = [second instanceof UserCard, second.made].join('|');
        second.setAttribute('name', 'Grace');
        document.getElementById('list').appendChild(second);
        var third = new UserCard();
        third.id = 'third';
        out.constructed = [third.localName, third instanceof UserCard].join('|');
        document.getElementById('list').appendChild(third);
        document.getElementById('list').insertAdjacentHTML('beforeend', '<user-card id="fourth" name="Linus"></user-card>');
        var refused = [];
        [['nohyphen', class extends HTMLElement {}], ['user-card', class extends HTMLElement {}], ['other-card', UserCard], ['softn-chart', class extends HTMLElement {}]].forEach(function (pair) {
          try { customElements.define(pair[0], pair[1]); refused.push('taken'); } catch (e) { refused.push(e.name); }
        });
        out.refused = refused.join(',');
        try { new HTMLElement(); out.plain = 'made'; } catch (e) { out.plain = e.name; }
        out.shadow = typeof first.attachShadow + ':' + String(first.shadowRoot);
        ready.then(function (ctor) {
          out.ready = ctor === UserCard;
          setTimeout(function () {
            first.setAttribute('name', 'Ada L.');
            second.remove();
            setTimeout(function () { out.log = log.join(' '); done(); }, 30);
          }, 30);
        });`
      ),
    });
    const said = await result();
    expect(said).toMatchObject({
      before: 'undefined|false',
      upgraded: 'true|true|true|hi Ada|true|user-card',
      created: 'true|true',
      constructed: 'user-card|true',
      refused: 'SyntaxError,NotSupportedError,NotSupportedError,NotSupportedError',
      plain: 'TypeError',
      shadow: 'function:null',
      ready: true,
    });
    expect(said.log).toBe(
      'made:first name:null>Ada joined:first made:- name:null>Grace made:- joined:second joined:third made:fourth name:null>Linus joined:fourth name:Ada>Ada L. left:second'
    );
    expect(root.querySelector('#first .name')?.textContent).toBe('Ada L.');
    expect(root.querySelector('#fourth .name')?.textContent).toBe('Linus');
    expect(root.querySelector('#third .name')?.textContent).toBe('nobody');
    expect(root.querySelector('#second')).toBeNull();
    handle.dispose();
  });
});

describe('walking the tree, and a document read from text', () => {
  it('walks the page with a TreeWalker and a NodeIterator, by what is shown and what a filter says', async () => {
    const { handle, result } = await open({
      'index.html': page(
        '<div id="root"><p id="a">one<b id="b">two</b></p><ul id="c"><li id="d">three</li><li id="e" class="skip"><i id="f">four</i></li></ul></div>',
        `var root = document.getElementById('root');
        // A mark of the script's own making, as a template library leaves them.
        document.getElementById('a').insertBefore(document.createComment('mark'), document.getElementById('b'));
        var ids = function (walker) { var seen = []; for (var n = walker.nextNode(); n; n = walker.nextNode()) seen.push(n.id || n.nodeValue); return seen.join(','); };
        out.elements = ids(document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT));
        out.text = ids(document.createTreeWalker(root, NodeFilter.SHOW_TEXT));
        out.marks = ids(document.createTreeWalker(root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT));
        // Rejected: it and all inside it. Skipped: it alone.
        out.rejected = ids(document.createTreeWalker(root, 1, function (n) { return n.id === 'e' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }));
        out.skipped = ids(document.createTreeWalker(root, 1, { acceptNode: function (n) { return n.id === 'e' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT; } }));
        var walker = document.createTreeWalker(root, 1);
        walker.currentNode = document.getElementById('f');
        out.back = [walker.previousNode().id, walker.previousNode().id, walker.parentNode().id, walker.firstChild().id, walker.nextSibling().id, walker.lastChild().id, String(walker.previousSibling())].join(',');
        out.kinds = [walker instanceof TreeWalker, walker.root === root, walker.whatToShow].join('|');
        var each = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
        var list = [];
        for (var n = each.nextNode(); n; n = each.nextNode()) list.push(n.id);
        out.each = list.join(',') + ' <- ' + each.previousNode().id + ',' + each.previousNode().id;
        done();`
      ),
    });
    expect(await result()).toEqual({
      elements: 'a,b,c,d,e,f',
      text: 'one,two,three,four',
      marks: 'a,mark,b,c,d,e,f',
      rejected: 'a,b,c,d',
      skipped: 'a,b,c,d,f',
      // The last: an only child has no sibling, and its parent is shown, so there is none to go to.
      back: 'e,d,c,d,e,f,null',
      kinds: 'true|true|1',
      each: 'root,a,b,c,d,e,f <- f,e',
    });
    handle.dispose();
  });

  it('reads markup, a drawing and XML into a document of its own, which draws nothing on the page', async () => {
    const { handle, root, result } = await open({
      'index.html': page(
        '<div id="into"></div>',
        `var html = new DOMParser().parseFromString('<title>Read</title><p class="x">one</p><p class="x" id="two">two <b>bold</b></p><script>window.ran = 1</scr' + 'ipt>', 'text/html');
        out.html = [html.nodeType, html.title, html.body.children.length, html.querySelectorAll('.x').length, html.getElementById('two').textContent, html.documentElement.localName, html.head.firstChild.localName].join('|');
        out.ran = typeof window.ran;
        out.apart = [html.body.isConnected, document.querySelector('.x') === null].join('|');
        var svg = new DOMParser().parseFromString('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle r="1"/></svg>', 'image/svg+xml');
        out.svg = [svg.documentElement.localName, svg.documentElement.namespaceURI, svg.querySelector('circle').getAttribute('r'), svg.documentElement.getAttribute('viewBox')].join('|');
        var feed = new DOMParser().parseFromString('<?xml version="1.0"?><rss><channel><title>News</title><item><title>First</title><link href="a"/></item><item><title>Second</title></item></channel></rss>', 'application/xml');
        out.feed = [feed.documentElement.localName, feed.querySelectorAll('item').length, feed.querySelector('item title').textContent, feed.getElementsByTagName('link')[0].getAttribute('href'),
          Array.prototype.map.call(feed.querySelectorAll('item'), function (item) { return item.children.length; }).join('+')].join('|');
        out.empty = new DOMParser().parseFromString('just words', 'text/xml').documentElement.localName;
        try { new DOMParser().parseFromString('x', 'text/plain'); out.kind = 'read'; } catch (e) { out.kind = e.name; }
        var made = document.implementation.createHTMLDocument('Made');
        made.body.innerHTML = '<em>in a document of its own</em>';
        out.made = [made.title, made.body.firstChild.localName, made.querySelector('em').textContent].join('|');
        out.text = new XMLSerializer().serializeToString(html.getElementById('two'));
        // Put on the page by the app, it is the page's.
        document.getElementById('into').appendChild(document.importNode(html.getElementById('two'), true));
        done();`
      ),
    });
    expect(await result()).toEqual({
      // The script is in the document as an element, and ran nowhere.
      html: '9|Read|3|2|two bold|html|title',
      ran: 'undefined',
      apart: 'false|true',
      svg: 'svg|http://www.w3.org/2000/svg|1|0 0 2 2',
      feed: 'rss|2|First|a|2+1',
      empty: 'parsererror',
      kind: 'TypeError',
      made: 'Made|em|in a document of its own',
      text: '<p class="x" id="two">two <b>bold</b></p>',
    });
    expect(root.querySelector('#into #two')?.textContent).toBe('two bold');
    expect(root.querySelectorAll('.x').length).toBe(1);
    handle.dispose();
  });
});

describe('saving a file the app made', () => {
  /** What the page was asked to save, by the app's own name for it and as the page would save it. */
  const SAVER = `var kinds = {
      csv: function () {
        var link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(['a,b\\n1,2'], { type: 'text/csv' }));
        link.download = 'table.csv';
        link.click();
      },
      named: function () {
        var link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(['x']));
        link.setAttribute('download', '../../evil\\u202Efdp.exe');
        document.body.appendChild(link);
        link.click();
        link.remove();
      },
      twice: function () { kinds.csv(); kinds.csv(); },
      held: function () {
        var link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(['x']));
        link.download = 'held.txt';
        link.addEventListener('click', function (e) { e.preventDefault(); });
        link.click();
      },
    };
    Object.keys(kinds).forEach(function (kind) { document.getElementById(kind).addEventListener('click', kinds[kind]); });
    // By itself, as the page starts: nobody clicked anything.
    kinds.csv();`;
  const BUTTONS = '<button id="csv" type="button">csv</button><button id="named" type="button">named</button><button id="twice" type="button">twice</button><button id="held" type="button">held</button>' +
    '<a id="inline" href="data:text/plain;base64,aGVsbG8=" download="hello.txt">save hello</a><a id="plain" href="data:text/plain,not%20this">no download on it</a>';

  type Asked = { name: string; type: string; size: number; text: string };

  async function saver(extra: Record<string, unknown> = {}) {
    const asked: Asked[] = [];
    const opened = await open(
      { 'index.html': page(BUTTONS, SAVER) },
      {
        onSaveRequest: (file: { name: string; type: string; size: number; bytes: Uint8Array }) => {
          asked.push({ name: file.name, type: file.type, size: file.size, text: new TextDecoder().decode(file.bytes) });
          return false;
        },
        ...extra,
      }
    );
    const click = (selector: string) => (opened.root.querySelector(selector) as HTMLElement).click();
    return { ...opened, asked, click };
  }

  it('asks the host, just after the person’s click, for one file, by a name that is a file’s name', async () => {
    const { handle, asked, click } = await saver();
    await settle(120);
    // Nothing for the save the script made by itself as the page started.
    expect(asked).toEqual([]);
    click('#csv');
    await expect.poll(() => asked).toEqual([{ name: 'table.csv', type: 'text/csv', size: 7, text: 'a,b\n1,2' }]);
    // A click that comes with the one that asked (what is left of the same press) asks for nothing more.
    click('#named');
    await settle(150);
    expect(asked.length).toBe(1);
    // No folder, nothing a file system refuses, and no mark that turns the text around.
    await settle(500);
    click('#named');
    await expect.poll(() => asked.at(-1)?.name).toBe('_.._evilfdp.exe');
    // One click, one file.
    await settle(600);
    click('#twice');
    await settle(150);
    expect(asked.length).toBe(3);
    // A click the script cancelled saves nothing.
    await settle(500);
    click('#held');
    await settle(150);
    expect(asked.length).toBe(3);
    // A link in the page, with its data written into its address, clicked by the person.
    click('#inline');
    await expect.poll(() => asked.at(-1)).toEqual({ name: 'hello.txt', type: 'text/plain', size: 5, text: 'hello' });
    // Without download on it, a link to data is not a file to save.
    click('#plain');
    await settle(150);
    expect(asked.length).toBe(4);
    handle.dispose();
  });

  it('asks the person in a bar of its own, and saves at their word as a download of the page', async () => {
    // The bar is in a shadow root nothing on the page reaches: kept here as it is attached.
    const roots: ShadowRoot[] = [];
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const made = attach.call(this, init);
      roots.push(made);
      return made;
    };
    const saved: Array<{ name: string; href: string }> = [];
    const clickLink = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.hasAttribute('download') && this.ownerDocument === document && !this.getRootNode({ composed: false }).toString().includes('ShadowRoot')) saved.push({ name: this.download, href: this.href });
    };
    try {
      const { handle, root, click } = await saver({ onSaveRequest: undefined });
      const bar = () => roots.filter((r) => r.host.isConnected).map((r) => r.querySelector('[data-softn-save-bar]')).find(Boolean) ?? null;
      click('#csv');
      await expect.poll(() => bar()?.textContent ?? '').toContain('wants to save a file to this device: “table.csv” (7 bytes)');
      // Above the app's box, in the frame's root: not in the root the app's stylesheets are in.
      expect(handle.frameRoot.querySelector('[data-softn-container-save]')).not.toBeNull();
      expect(root.querySelector('[data-softn-container-save]')).toBeNull();
      expect(saved).toEqual([]);
      // Another file asked for while this one is unanswered takes no one's place: the bar
      // the person is reading does not change its file under them.
      await settle(600);
      click('#named');
      await settle(150);
      expect(bar()?.textContent).toContain('“table.csv”');
      // A click already on its way when the bar appeared is not a yes.
      const early = await saver({ onSaveRequest: undefined });
      early.click('#csv');
      await expect.poll(() => roots.map((r) => r.querySelectorAll('[data-softn-save-bar]').length).reduce((a, b) => a + b, 0)).toBe(2);
      for (const r of roots) for (const button of r.querySelectorAll('[data-softn-save-allow]')) if (r.host.isConnected && early.handle.frameRoot.contains(r.host)) (button as HTMLElement).click();
      expect(saved).toEqual([]);
      early.handle.dispose();
      // Not now: nothing is saved, and the bar goes.
      (bar()!.querySelector('[data-softn-save-deny]') as HTMLElement).click();
      expect(bar()).toBeNull();
      expect(saved).toEqual([]);
      // Asked again, and allowed.
      await settle(600);
      click('#csv');
      await expect.poll(() => bar() !== null).toBe(true);
      await settle(450);
      (bar()!.querySelector('[data-softn-save-allow]') as HTMLElement).click();
      expect(saved.length).toBe(1);
      expect(saved[0].name).toBe('table.csv');
      expect(saved[0].href).toMatch(/^blob:/);
      // As bytes of no kind: never a document the browser would open in place of saving it.
      const file = await fetch(saved[0].href);
      expect(file.headers.get('content-type')).toBe('application/octet-stream');
      expect(await file.text()).toBe('a,b\n1,2');
      expect(handle.frameRoot.querySelector('[data-softn-container-save]')).toBeNull();
      handle.dispose();

      // A host that saves nothing for its apps.
      const never = await saver({ onSaveRequest: undefined, downloads: 'deny' });
      never.click('#csv');
      await settle(150);
      expect(never.handle.frameRoot.querySelector('[data-softn-container-save]')).toBeNull();
      never.handle.dispose();
    } finally {
      Element.prototype.attachShadow = attach;
      HTMLAnchorElement.prototype.click = clickLink;
    }
  });
});

describe('a file the person picked in a file field', () => {
  const PICKER = page(
    '<form id="form"><input id="pick" type="file" name="upload" multiple><input name="note" value="hi"></form><p id="seen"></p>',
    `var pick = document.getElementById('pick');
    out.before = [pick.files instanceof FileList, pick.files.length, document.querySelector('[name=note]').files].join('|');
    pick.addEventListener('change', function () {
      var files = pick.files;
      var names = Array.prototype.map.call(files, function (file) { return file.name + ':' + file.type + ':' + file.size + ':' + (file instanceof File); });
      var form = new FormData(document.getElementById('form'));
      var sent = form.getAll('upload').map(function (file) { return file instanceof File ? file.name : typeof file; });
      Promise.all(Array.prototype.map.call(files, function (file) { return file.text(); })).then(function (texts) {
        out.picked = names.join(' ');
        out.texts = texts.join('|');
        out.form = sent.join(',') + '+' + form.get('note');
        done();
      });
    });`
  );
  const pickFiles = (root: ShadowRoot, more: File[] = []) => {
    const field = root.querySelector('#pick') as HTMLInputElement;
    const files = [new File(['a,b'], 'table.csv', { type: 'text/csv' }), ...more, new File(['hello'], 'note.txt', { type: 'text/plain' })];
    Object.defineProperty(field, 'files', { configurable: true, value: files });
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const FILES = { 'permission.json': JSON.stringify({ permissions: { files: { enabled: true } } }) };

  it('is read for an app that was allowed files, and is in the form’s data', async () => {
    const { handle, root, result } = await open({ ...FILES, 'index.html': PICKER }, granted);
    await settle();
    pickFiles(root);
    expect(await result()).toEqual({
      before: 'true|0|',
      picked: 'table.csv:text/csv:3:true note.txt:text/plain:5:true',
      texts: 'a,b|hello',
      form: 'table.csv,note.txt+hi',
    });
    handle.dispose();
  });

  it('is read whole through its address, and kept in IndexedDB and read back, at six megabytes', async () => {
    // Bytes were made from base64 a byte at a time on the app's side: fetch(URL.createObjectURL(file))
    // then arrayBuffer() of a 6 MB file, and get() of a stored file of a few megabytes, took
    // more than a turn has and stopped the app.
    const SIZE = 6 * 1024 * 1024;
    const bytes = new Uint8Array(SIZE).fill(7);
    bytes[5] = 42;
    bytes[SIZE - 1] = 9;
    const { handle, root, result } = await open(
      {
        ...FILES,
        'index.html': page(
          '<input id="pick" type="file">',
          `var pick = document.getElementById('pick');
          var req = function (r) { return new Promise(function (ok, no) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); };
          pick.addEventListener('change', async function () {
            var file = pick.files[0];
            var fetched = new Uint8Array(await (await fetch(URL.createObjectURL(file))).arrayBuffer());
            out.fetched = [fetched.length, fetched[5], fetched[fetched.length - 1]].join('|');
            var opening = indexedDB.open('files', 1);
            opening.onupgradeneeded = function () { opening.result.createObjectStore('f'); };
            var db = await req(opening);
            var tx = db.transaction('f', 'readwrite');
            tx.objectStore('f').put(file, 'one');
            await new Promise(function (ok, no) { tx.oncomplete = ok; tx.onabort = function () { no(tx.error); }; });
            var back = await req(db.transaction('f').objectStore('f').get('one'));
            out.stored = [back instanceof File, back.name, back.size].join('|');
            var read = new Uint8Array(await back.arrayBuffer());
            out.read = [read.length, read[5], read[read.length - 1]].join('|');
            done();
          });`
        ),
      },
      { ...granted, persistStorage: false, limits: { storageQuotaBytes: 64 * 1024 * 1024 } }
    );
    await settle();
    const field = root.querySelector('#pick') as HTMLInputElement;
    Object.defineProperty(field, 'files', { configurable: true, value: [new File([bytes], 'six.bin', { type: 'application/octet-stream' })] });
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await result()).toEqual({ fetched: `${SIZE}|42|9`, stored: `true|six.bin|${SIZE}`, read: `${SIZE}|42|9` });
    handle.dispose();
  });

  it('hears of a large file at once, and passes it on without making bytes of it: its address, a data: URL, a part of it, an upload', async () => {
    // Three megabytes, more than an app's script can make bytes of in a turn: the file is
    // kept as the text it crossed as. What only passes it on (a data: URL, an upload in a
    // form or by itself) makes no bytes; a part of it makes that part; reading the whole
    // takes its turns and arrives.
    const SIZE = 3 * 1024 * 1024;
    const bytes = new Uint8Array(SIZE).fill(120);
    bytes.set([104, 101, 97, 100], 0);
    bytes.set([116, 97, 105, 108], SIZE - 4);
    const uploads: Array<{ url: string; type: string; size: number; head: string; tail: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = init?.body;
      const sent = raw instanceof Blob ? await blobBytes(raw) : raw instanceof Uint8Array ? raw : new TextEncoder().encode(String(raw ?? ''));
      const text = (part: Uint8Array) => new TextDecoder().decode(part);
      uploads.push({ url: String(input), type: new Headers(init?.headers).get('content-type') ?? '', size: sent.length, head: text(sent.subarray(0, 400)), tail: text(sent.subarray(sent.length - 200)) });
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const { handle, root, result, said, text } = await open(
      {
        'permission.json': JSON.stringify({ permissions: { files: { enabled: true }, net: { enabled: true, allowed_hosts: ['api.softn.test'] } } }),
        'index.html': page(
          '<form id="form"><input id="pick" type="file" name="upload"><input name="note" value="hi"></form>',
          `var pick = document.getElementById('pick');
          pick.addEventListener('change', function () {
            var file = pick.files[0];
            var began = Date.now();
            out.heard = [file.name, file.size, file.type].join('|');
            var reader = new FileReader();
            reader.onload = function () {
              out.dataUrl = reader.result.slice(0, 41) + '|' + reader.result.length;
              out.quick = Date.now() - began < 1500;
              Promise.all([file.slice(0, 4).text(), file.slice(-4).text(), file.slice(1, 3, 'text/x-part').text()]).then(function (parts) {
                out.parts = parts.join('|');
                return fetch('https://api.softn.test/form', { method: 'POST', body: new FormData(document.getElementById('form')) });
              }).then(function () {
                return fetch('https://api.softn.test/raw', { method: 'PUT', body: file });
              }).then(function () {
                return file.arrayBuffer();
              }).then(function (buffer) {
                var all = new Uint8Array(buffer);
                out.whole = [all.length, all[0], all[all.length - 1], all[1000]].join('|');
                done();
              });
            };
            reader.readAsDataURL(file);
          });`
        ),
      },
      granted
    );
    await settle();
    const field = root.querySelector('#pick') as HTMLInputElement;
    Object.defineProperty(field, 'files', { configurable: true, value: [new File([bytes], 'film.bin', { type: 'video/x-test' })] });
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    const reported = await result(30_000).catch(() => { throw new Error('no report; the app said: ' + said.join(' | ') + '; uploads: ' + uploads.map((one) => one.url).join(',') + '; out: ' + text('#out')); });
    expect(reported).toEqual({
      heard: `film.bin|${SIZE}|video/x-test`,
      dataUrl: `data:video/x-test;base64,aGVhZHh4eHh4eHh4|${'data:video/x-test;base64,'.length + (SIZE / 3) * 4}`,
      quick: true,
      parts: 'head|tail|ea',
      whole: `${SIZE}|104|108|120`,
    });
    // The form went as a form, the file's bytes between its words; the file by itself as its bytes.
    expect(uploads.map((one) => one.url)).toEqual(['https://api.softn.test/form', 'https://api.softn.test/raw']);
    expect(uploads[0].type).toMatch(/^multipart\/form-data; boundary=----SoftNFormBoundary/);
    expect(uploads[0].head).toContain('name="note"\r\n\r\nhi\r\n');
    expect(uploads[0].head).toContain('name="upload"; filename="film.bin"\r\nContent-Type: video/x-test\r\n\r\nhead');
    expect(uploads[0].tail).toMatch(/xtail\r\n------SoftNFormBoundary[a-z0-9]+--\r\n$/);
    expect(uploads[0].size).toBeGreaterThan(SIZE);
    expect(uploads[1]).toMatchObject({ type: 'video/x-test', size: SIZE });
    expect(uploads[1].head.startsWith('head')).toBe(true);
    expect(uploads[1].tail.endsWith('tail')).toBe(true);
    handle.dispose();
  }, 60_000);

  it('makes a part of a large file, a Blob around it and a copy under another name without making its bytes', async () => {
    // Each made the file's bytes at once (a part of five megabytes, and the whole file for a
    // Blob or a File around it), which took more than a turn has. A part is now the same text
    // from other places, an upload hands that text on with the bytes of it to keep, and what
    // reads it reads it a part a turn.
    const SIZE = 6 * 1024 * 1024;
    const bytes = Uint8Array.from({ length: SIZE }, (_, i) => 65 + (i % 26));
    const uploads: Array<{ url: string; size: number; head: string; tail: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = init?.body;
      const sent = raw instanceof Blob ? await blobBytes(raw) : new TextEncoder().encode(String(raw ?? ''));
      uploads.push({ url: String(input), size: sent.length, head: new TextDecoder().decode(sent.subarray(0, 6)), tail: new TextDecoder().decode(sent.subarray(sent.length - 6)) });
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const { handle, root, result, said, text } = await open(
      {
        'permission.json': JSON.stringify({ permissions: { files: { enabled: true }, net: { enabled: true, allowed_hosts: ['api.softn.test'] } } }),
        'index.html': page(
          '<input id="pick" type="file">',
          `var pick = document.getElementById('pick');
          pick.addEventListener('change', function () {
            var file = pick.files[0];
            var began = Date.now();
            var part = file.slice(1, 5 * 1024 * 1024 + 1);
            var copy = new File([file], 'renamed.bin', { type: 'application/x-test' });
            var mixed = new Blob(['<', file.slice(0, 4), '|', file.slice(-4), '>']);
            out.quick = Date.now() - began < 500;
            out.sizes = [part.size, copy.size, copy.name, copy.type, mixed.size].join('|');
            mixed.text().then(function (words) {
              out.mixed = words;
              return fetch('https://api.softn.test/part', { method: 'PUT', body: part });
            }).then(function () {
              return fetch('https://api.softn.test/copy', { method: 'PUT', body: copy });
            }).then(function () {
              return part.slice(-3).text();
            }).then(function (end) {
              out.partEnd = end;
              done();
            }).catch(function (e) { out.failed = e.message; done(); });
          });`
        ),
      },
      granted
    );
    await settle();
    const field = root.querySelector('#pick') as HTMLInputElement;
    Object.defineProperty(field, 'files', { configurable: true, value: [new File([bytes], 'film.bin', { type: 'video/x-test' })] });
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    const reported = await result(60_000).catch(() => { throw new Error('no report; the app said: ' + said.join(' | ') + '; out: ' + text('#out')); });
    const letters = (from: number, to: number) => new TextDecoder().decode(bytes.subarray(from, to));
    expect(reported).toEqual({
      quick: true,
      sizes: `${5 * 1024 * 1024}|${SIZE}|renamed.bin|application/x-test|${1 + 4 + 1 + 4 + 1}`,
      mixed: `<${letters(0, 4)}|${letters(SIZE - 4, SIZE)}>`,
      partEnd: letters(5 * 1024 * 1024 - 2, 5 * 1024 * 1024 + 1),
    });
    expect(uploads).toEqual([
      { url: 'https://api.softn.test/part', size: 5 * 1024 * 1024, head: letters(1, 7), tail: letters(5 * 1024 * 1024 - 5, 5 * 1024 * 1024 + 1) },
      { url: 'https://api.softn.test/copy', size: SIZE, head: letters(0, 6), tail: letters(SIZE - 6, SIZE) },
    ]);
    handle.dispose();
  }, 90_000);

  it('reads a picked file as a stream, a part at a time, and a blob of bytes the same way', async () => {
    const SIZE = 600_000;
    const bytes = Uint8Array.from({ length: SIZE }, (_, i) => 65 + (i % 26));
    const { handle, root, result, said, text } = await open(
      {
        ...FILES,
        'index.html': page(
          '<input id="pick" type="file">',
          `var pick = document.getElementById('pick');
          var read = async function (blob) {
            var reader = blob.stream().getReader();
            var parts = 0, total = 0, first = -1, last = -1;
            for (;;) {
              var step = await reader.read();
              if (step.done) break;
              if (!(step.value instanceof Uint8Array)) throw new Error('not bytes');
              if (first < 0) first = step.value[0];
              last = step.value[step.value.length - 1];
              parts++;
              total += step.value.length;
            }
            return [parts > 1, total, first, last].join('|');
          };
          pick.addEventListener('change', async function () {
            try {
              out.file = await read(pick.files[0]);
              out.part = await read(pick.files[0].slice(1, 5));
              out.bytes = await read(new Blob([new Uint8Array([1, 2, 3])]));
            } catch (e) { out.failed = e.message; }
            done();
          });`
        ),
      },
      granted
    );
    await settle();
    const field = root.querySelector('#pick') as HTMLInputElement;
    Object.defineProperty(field, 'files', { configurable: true, value: [new File([bytes], 'big.txt', { type: 'text/plain' })] });
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    const reported = await result(60_000).catch(() => { throw new Error('no report; the app said: ' + said.join(' | ') + '; out: ' + text('#out')); });
    expect(reported).toEqual({ file: `true|${SIZE}|65|${65 + ((SIZE - 1) % 26)}`, part: 'false|4|66|69', bytes: 'false|3|1|3' });
    handle.dispose();
  }, 90_000);

  it('lets go of a large body whose request is refused, so later ones still go', async () => {
    // A body of more than crosses in one call goes ahead of its request, in pieces. A request
    // refused (a host the app did not declare) left its body behind; eight of them, and every
    // later large body was dropped, even to a host the app may reach.
    const sizes: number[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = init?.body;
      sizes.push(raw instanceof Blob ? raw.size : String(raw ?? '').length);
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const { handle, result, said, text } = await open(
      {
        'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.softn.test'] } } }),
        'index.html': page(
          '',
          `var body = new Array(2500001).join('x');
          var refused = 0;
          (async function () {
            for (var i = 0; i < 9; i++) {
              try { await fetch('https://elsewhere.softn.test/up', { method: 'POST', body: body }); } catch (e) { refused++; }
            }
            var answer = await fetch('https://api.softn.test/up', { method: 'POST', body: body });
            out.refused = refused;
            out.sent = answer.status;
            done();
          })().catch(function (e) { out.failed = e.message; done(); });`
        ),
      },
      granted
    );
    const reported = await result(60_000).catch(() => { throw new Error('no report; the app said: ' + said.join(' | ') + '; out: ' + text('#out')); });
    expect(reported).toEqual({ refused: 9, sent: 200 });
    expect(sizes).toEqual([2_500_000]);
    handle.dispose();
  }, 90_000);

  it('leaves out a file past what crosses to an app in one piece, and says so, with the others handed over', async () => {
    // Ten megabytes cross to the app in one piece: a file past that is left out in words, and the rest arrive.
    const { handle, root, said, result } = await open({ ...FILES, 'index.html': PICKER }, granted);
    await settle();
    pickFiles(root, [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'film.bin')]);
    expect(await result()).toMatchObject({ picked: 'table.csv:text/csv:3:true note.txt:text/plain:5:true', texts: 'a,b|hello' });
    expect(said.filter((line) => line.includes('1 of the files picked were left out')).length).toBe(1);
    handle.dispose();
  });

  it('is not read for an app that was not: one that never asked, and one the person has not answered', async () => {
    for (const source of [{ 'index.html': PICKER }, { ...FILES, 'index.html': PICKER }]) {
      const { handle, root, said, result } = await open(source);
      await settle();
      pickFiles(root);
      expect(await result()).toMatchObject({ picked: '', texts: '' });
      expect(said.filter((line) => line.includes('has not been allowed to read files')).length).toBe(1);
      handle.dispose();
    }
  });
});

describe('element.animate', () => {
  /** An animation as the page runs one: this test's jsdom has none, so the test ends each by hand. */
  class FakeAnimation extends EventTarget {
    static made: FakeAnimation[] = [];
    calls: string[] = [];
    constructor(
      readonly el: Element,
      readonly frames: unknown,
      readonly timing: Record<string, unknown>
    ) {
      super();
      FakeAnimation.made.push(this);
    }
    cancel() { this.calls.push('cancel'); }
    finish() { this.calls.push('finish'); }
    pause() { this.calls.push('pause'); }
    play() { this.calls.push('play'); }
    reverse() { this.calls.push('reverse'); }
  }
  const proto = Element.prototype as unknown as { animate?: unknown };

  afterEach(() => {
    delete proto.animate;
  });

  const SCRIPT = `var box = document.getElementById('box');
    var seen = [];
    var say = function (what) { seen.push(what); document.getElementById('seen').textContent = seen.join(' '); };
    var fade = box.animate([{ opacity: 1, backgroundImage: 'url(https://evil.example/a.png)' }, { opacity: 0.2, transform: 'translateX(10px)', offset: 1 }], { duration: 80, fill: 'forwards', easing: 'ease-in', iterations: Infinity, pseudoElement: '::before' });
    say([fade instanceof Animation, fade.playState, typeof fade.currentTime, box.getAnimations().length].join('|'));
    fade.onfinish = function () { say('finished:' + fade.playState); };
    fade.finished.then(function () { say('promise'); });
    var slide = box.animate({ opacity: [0, 1] }, 50);
    slide.finished.then(function () { say('slide-finished'); }, function (e) { say('slide:' + e.name); });
    slide.oncancel = function () { say('cancelled:' + slide.playState); };
    document.getElementById('stop').addEventListener('click', function () { slide.pause(); slide.play(); slide.cancel(); });
    // Not on the page: nothing to draw, and it ends.
    document.createElement('div').animate([{ opacity: 0 }], 10).finished.then(function () { say('apart'); });`;
  const BODY = '<div id="box">box</div><button id="stop" type="button">stop</button><p id="seen"></p>';

  it('is run by the page with its values held to the stylesheet’s rule, and tells the script when it ends', async () => {
    FakeAnimation.made = [];
    proto.animate = function (this: Element, frames: unknown, timing: Record<string, unknown>) {
      return new FakeAnimation(this, frames, timing);
    };
    const { handle, root, text } = await open({ 'index.html': page(BODY, SCRIPT) });
    await expect.poll(() => FakeAnimation.made.length).toBe(2);
    await expect.poll(() => text('#seen')).toBe('true|running|number|1 apart');
    const [fade, slide] = FakeAnimation.made;
    expect(fade.el).toBe(root.querySelector('#box'));
    // The picture from somewhere else is gone from the keyframe; the rest is as written.
    expect(JSON.stringify(fade.frames)).not.toContain('evil.example');
    expect(fade.frames).toMatchObject([{ opacity: 1 }, { opacity: 0.2, transform: 'translateX(10px)', offset: 1 }]);
    expect(fade.timing).toEqual({ duration: 80, fill: 'forwards', easing: 'ease-in', iterations: Infinity });
    expect(slide.frames).toEqual({ opacity: ['0', '1'] });
    expect(slide.timing).toEqual({ duration: 50 });
    // The page says the first has ended.
    fade.dispatchEvent(new Event('finish'));
    await expect.poll(() => text('#seen')).toBe('true|running|number|1 apart finished:finished promise');
    // The script pauses, plays and cancels the second: the page is asked each, and the wait on it ends.
    (root.querySelector('#stop') as HTMLElement).click();
    await expect.poll(() => slide.calls).toEqual(['pause', 'play', 'cancel']);
    await expect.poll(() => text('#seen')).toBe('true|running|number|1 apart finished:finished promise cancelled:idle slide:AbortError');
    handle.dispose();
  });

  it('ends at once on a page that runs no animations, so what waits on it goes on', async () => {
    const { handle, text } = await open({ 'index.html': page(BODY, SCRIPT) });
    await expect.poll(() => text('#seen')).toContain('finished:finished');
    expect(text('#seen')).toContain('promise');
    expect(text('#seen')).toContain('slide-finished');
    handle.dispose();
  });
});

describe('an element that scrolls, and what it holds', () => {
  it('goes to the end when the script sets scrollTop to what it holds, however much that is by now', async () => {
    const { handle, root, result } = await open({
      'index.html': page(
        '<div id="chat" style="height: 100px; overflow: auto"><p>one</p></div><button id="end" type="button">end</button><button id="place" type="button">place</button>',
        `var chat = document.getElementById('chat');
        document.getElementById('end').addEventListener('click', function () {
          out.held = chat.scrollHeight + '|' + chat.clientHeight;
          chat.scrollTop = chat.scrollHeight;
          out.read = chat.scrollTop;
          done();
        });
        document.getElementById('place').addEventListener('click', function () { chat.scrollTop = 40; });
        out.first = chat.scrollHeight;`
      ),
    });
    await settle(120);
    // As the page measures it: a box 100 tall that holds 900.
    const chat = root.querySelector('#chat') as HTMLElement;
    const writes: number[] = [];
    Object.defineProperty(chat, 'scrollTop', { configurable: true, get: () => writes.at(-1) ?? 0, set: (value: number) => writes.push(value) });
    Object.defineProperty(chat, 'scrollHeight', { configurable: true, get: () => 900 });
    Object.defineProperty(chat, 'scrollWidth', { configurable: true, get: () => 300 });
    chat.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100, x: 0, y: 0, toJSON: () => ({}) });
    // Anything the script does next has the page measure again.
    (root.querySelector('#place') as HTMLElement).click();
    await expect.poll(() => writes).toEqual([40]);
    await settle(120);
    (root.querySelector('#end') as HTMLElement).click();
    expect(await result()).toMatchObject({ held: '900|100', read: 800 });
    // To the end, whatever it holds by the time the page is told.
    await expect.poll(() => writes).toEqual([40, 1e9]);
    handle.dispose();
  });
});
