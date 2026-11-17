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
  const result = async (): Promise<Record<string, unknown>> => {
    await expect.poll(() => text('#out'), { timeout: 5_000, interval: 10 }).not.toBe('…');
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

describe('a request, as the web sends one', () => {
  it('carries a form, a query, a blob and bytes as what they are, and takes a Request', async () => {
    const sent: Array<{ url: string; method: string; type: string | null; body: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      const body = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : typeof raw === 'string' ? raw : '';
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

  it('says load to an image that is on no page, with its size, and error to one that cannot be loaded', async () => {
    FakeImage.asked = [];
    vi.stubGlobal('Image', FakeImage);
    const { handle, result } = await open({
      'sprite.png': PNG,
      'index.html': page(
        '',
        `var sprite = new Image();
        out.before = [sprite instanceof HTMLImageElement, sprite.complete, sprite.naturalWidth].join('|');
        sprite.onload = function () {
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
        out.shadow = typeof first.attachShadow;
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
      shadow: 'undefined',
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
