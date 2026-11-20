/**
 * A canvas read back at once: `canvas.toDataURL()` and `context.getImageData()`.
 *
 * The canvas an app draws on is on the page, a thread away from its script, and answers
 * nothing at once. For an app whose own code names one of the two, the Worker keeps a
 * canvas of its own beside each of the app's (an OffscreenCanvas), draws on it what the app
 * draws, and answers from it. The picture as a `data:` address is a PNG the Worker writes
 * itself (deflate.test.ts), because the browser's own encoder answers later.
 *
 * This test's page has no OffscreenCanvas: a stand-in that keeps real pixels is given to
 * it. The real one is driven in e2e/tests/web-container.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { encodePng } from '../src/canvas-replay';
import { HostDomPatcher } from '../src/dom-patcher';
import type { ShellOp } from '../src/types';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

/** A PNG's size and pixels, read by a decoder that shares nothing with the encoder. */
function readPng(bytes: Uint8Array): { width: number; height: number; pixels: number[][] } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  const kinds: string[] = [];
  while (at < bytes.length) {
    const size = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + size);
    // Each chunk's check is over its kind and its body.
    expect(view.getUint32(at + 8 + size), kind).toBe(zlib.crc32(bytes.subarray(at + 4, at + 8 + size)));
    kinds.push(kind);
    if (kind === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([body[8], body[9], body[10], body[11], body[12]]).toEqual([8, 6, 0, 0, 0]);
    } else if (kind === 'IDAT') data.push(body);
    at += 12 + size;
  }
  expect(kinds).toEqual(['IHDR', 'IDAT', 'IEND']);
  const joined = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of data) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = zlib.inflateSync(joined);
  expect(raw.length).toBe((width * 4 + 1) * height);
  const pixels: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    expect(raw[row]).toBe(0);
    for (let x = 0; x < width; x++) pixels.push([...raw.subarray(row + 1 + x * 4, row + 5 + x * 4)]);
  }
  return { width, height, pixels };
}

/** A canvas that keeps pixels: rectangles filled with a colour, another canvas drawn in, and the pixels read back. */
class StandInCanvas {
  pixels: Uint8ClampedArray;
  private w: number;
  private h: number;
  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }
  get width() { return this.w; }
  set width(value: number) { this.w = value; this.pixels = new Uint8ClampedArray(this.w * this.h * 4); }
  get height() { return this.h; }
  set height(value: number) { this.h = value; this.pixels = new Uint8ClampedArray(this.w * this.h * 4); }
  getContext(kind: string) {
    return kind === '2d' ? standInContext(this) : null;
  }
}

function standInContext(canvas: StandInCanvas) {
  const colour = (style: string): number[] => {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(style);
    return hex ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 255] : [0, 0, 0, 255];
  };
  const at = (x: number, y: number) => (y * canvas.width + x) * 4;
  const put = (x: number, y: number, rgba: ArrayLike<number>) => {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    canvas.pixels.set([rgba[0], rgba[1], rgba[2], rgba[3]], at(x, y));
  };
  const drawn: Record<string, unknown> = {
    canvas,
    fillStyle: '#000000',
    fillRect: (x: number, y: number, w: number, h: number) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(i, j, colour(String(drawn.fillStyle))); },
    clearRect: (x: number, y: number, w: number, h: number) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(i, j, [0, 0, 0, 0]); },
    drawImage: (source: StandInCanvas, dx: number, dy: number) => {
      for (let j = 0; j < source.height; j++) for (let i = 0; i < source.width; i++) put(dx + i, dy + j, source.pixels.subarray((j * source.width + i) * 4, (j * source.width + i) * 4 + 4));
    },
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const sx = x + i;
        const sy = y + j;
        if (sx >= 0 && sy >= 0 && sx < canvas.width && sy < canvas.height) data.set(canvas.pixels.subarray(at(sx, sy), at(sx, sy) + 4), (j * w + i) * 4);
      }
      return { data, width: w, height: h };
    },
  };
  // Whatever else the app draws with is taken and draws nothing here.
  return new Proxy(drawn, { get: (target, name) => (name in target ? target[name as string] : () => undefined) });
}
/** createImageBitmap for this test's page, which has none: a PNG read into a stand-in canvas, after `delay` ms. */
function standInImageBitmap(delay: number) {
  return (blob: Blob) =>
    new Promise<StandInCanvas & { close(): void }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('unreadable'));
      reader.onload = () => {
        const { width, height, pixels } = readPng(new Uint8Array(reader.result as ArrayBuffer));
        const bitmap = Object.assign(new StandInCanvas(width, height), { close: () => undefined });
        pixels.forEach((rgba, i) => bitmap.pixels.set(rgba, i * 4));
        setTimeout(() => resolve(bitmap), delay);
      };
      reader.readAsArrayBuffer(blob);
    });
}

async function open(source: Record<string, string | Uint8Array>, permissionMode: 'deny' | 'preapproved' = 'deny') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode,
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source,
  });
  const result = async (): Promise<Record<string, string>> => {
    await expect.poll(() => handle.shadowRoot.querySelector('#out')?.textContent, { timeout: 10_000 }).not.toBe('waiting');
    return JSON.parse(handle.shadowRoot.querySelector('#out')?.textContent ?? '{}') as Record<string, string>;
  };
  return { handle, said, result };
}

const dataUrlBytes = (url: string) => Uint8Array.from(atob(url.slice('data:image/png;base64,'.length)), (c) => c.charCodeAt(0));

describe('a picture as a PNG, made at once', () => {
  it('is one any decoder reads: its size, its pixels, its checks', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const png = readPng(encodePng(3, 2, rgba));
    expect([png.width, png.height]).toEqual([3, 2]);
    expect(png.pixels).toEqual([[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0], [1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
    // Past one stored block (65,535 bytes), where the data goes on in the next.
    const wide = new Uint8Array(200 * 100 * 4);
    for (let i = 0; i < wide.length; i++) wide[i] = (i * 7) % 256;
    const large = readPng(encodePng(200, 100, wide));
    expect(large.pixels.length).toBe(20_000);
    expect(large.pixels[19_999]).toEqual([...wide.subarray(wide.length - 4)]);
    expect(readPng(encodePng(1, 1, new Uint8Array([9, 8, 7, 6]))).pixels).toEqual([[9, 8, 7, 6]]);
  });
});

describe('a canvas read back at once', () => {
  const scope = globalThis as { OffscreenCanvas?: unknown };
  const had = scope.OffscreenCanvas;
  beforeEach(() => {
    document.body.innerHTML = '';
    scope.OffscreenCanvas = StandInCanvas;
  });
  afterEach(() => {
    scope.OffscreenCanvas = had;
  });

  it('answers toDataURL and getImageData with what the app has drawn, the turn it drew it, on a canvas that is on the page or on none', async () => {
    const { handle, said, result } = await open({
      'index.html': `<!doctype html><html><body><canvas id="c" width="4" height="3"></canvas><img id="copy"><p id="out">waiting</p><script>
        var out = {};
        var c = document.getElementById('c');
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 2, 3);
        // Read back in the turn it was drawn in.
        out.url = c.toDataURL();
        out.red = Array.prototype.join.call(ctx.getImageData(1, 1, 1, 1).data, ',');
        out.clear = Array.prototype.join.call(ctx.getImageData(3, 0, 1, 1).data, ',');
        var block = ctx.getImageData(1, 0, 2, 1);
        out.block = [block instanceof ImageData, block.width, block.height, Array.prototype.join.call(block.data, ',')].join('|');
        // A canvas that is on no page: a buffer, drawn on and read back, and drawn into the other.
        var off = document.createElement('canvas');
        off.width = 2; off.height = 2;
        var offCtx = off.getContext('2d');
        offCtx.fillStyle = '#0000ff';
        offCtx.fillRect(0, 0, 2, 1);
        out.offUrl = off.toDataURL('image/jpeg', 0.5);
        ctx.drawImage(off, 2, 1);
        out.drawnIn = Array.prototype.join.call(ctx.getImageData(2, 1, 1, 1).data, ',');
        // And what is drawn after is in the next answer.
        ctx.clearRect(0, 0, 1, 1);
        out.after = c.toDataURL();
        document.getElementById('copy').src = out.url;
        document.getElementById('out').textContent = JSON.stringify(out);
      </script></body></html>`,
    });
    const out = await result();
    expect(out.red).toBe('255,0,0,255');
    expect(out.clear).toBe('0,0,0,0');
    expect(out.block).toBe('true|2|1|255,0,0,255,0,0,0,0');
    expect(out.drawnIn).toBe('0,0,255,255');
    const first = readPng(dataUrlBytes(out.url));
    expect([first.width, first.height]).toEqual([4, 3]);
    expect(first.pixels.map((p) => p.join(',')).join(' ')).toBe(['255,0,0,255', '255,0,0,255', '0,0,0,0', '0,0,0,0'].join(' ').concat(' ', ['255,0,0,255', '255,0,0,255', '0,0,0,0', '0,0,0,0'].join(' '), ' ', ['255,0,0,255', '255,0,0,255', '0,0,0,0', '0,0,0,0'].join(' ')));
    // A PNG whatever kind was asked for, as a browser answers with the kind it has.
    const buffer = readPng(dataUrlBytes(out.offUrl));
    expect([buffer.width, buffer.height, buffer.pixels[0].join(','), buffer.pixels[2].join(',')]).toEqual([2, 2, '0,0,255,255', '0,0,0,0']);
    const after = readPng(dataUrlBytes(out.after));
    expect([after.pixels[0].join(','), after.pixels[1].join(','), after.pixels[6].join(',')]).toEqual(['0,0,0,0', '255,0,0,255', '0,0,255,255']);
    // The picture is one the page shows: an image with it as its address.
    await expect.poll(() => handle.shadowRoot.querySelector('#copy')?.getAttribute('src') ?? '').toMatch(/^data:image\/png;base64,/);
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('keeps no canvas beside the app’s for an app whose code names neither', async () => {
    const made: unknown[] = [];
    scope.OffscreenCanvas = class extends StandInCanvas {
      constructor(width: number, height: number) {
        super(width, height);
        made.push(this);
      }
    };
    const { handle, said, result } = await open({
      'index.html': `<!doctype html><html><body><canvas id="c" width="4" height="3"></canvas><p id="out">waiting</p><script>
        var c = document.getElementById('c');
        c.getContext('2d').fillRect(0, 0, 2, 2);
        setTimeout(function () { var first = c['toData' + 'URL'](); c['toData' + 'URL'](); document.getElementById('out').textContent = JSON.stringify({ url: first }); }, 30);
      </script></body></html>`,
    });
    expect(await result()).toEqual({ url: 'data:,' });
    expect(made).toEqual([]);
    // The app is told, once, and why.
    expect(said.filter((line) => line.includes('cannot be read back at once'))).toEqual([
      "warn: [SoftN] A canvas cannot be read back at once here (the app’s code was not seen to name toDataURL or getImageData): toDataURL() answers 'data:,' and getImageData() a transparent picture. canvas.toBlob() asks the page for its picture, and works.",
    ]);
    handle.dispose();
  });

  it('says so in a browser with no OffscreenCanvas for the app’s Worker', async () => {
    scope.OffscreenCanvas = undefined;
    const { handle, said, result } = await open({
      'index.html': `<!doctype html><html><body><canvas id="c" width="4" height="3"></canvas><p id="out">waiting</p><script>
        var c = document.getElementById('c');
        var ctx = c.getContext('2d');
        ctx.fillRect(0, 0, 2, 2);
        document.getElementById('out').textContent = JSON.stringify({ url: c.toDataURL(), pixel: Array.prototype.join.call(ctx.getImageData(0, 0, 1, 1).data, ',') });
      </script></body></html>`,
    });
    expect(await result()).toEqual({ url: 'data:,', pixel: '0,0,0,0' });
    expect(said.filter((line) => line.includes('this browser has no OffscreenCanvas')).length).toBe(1);
    handle.dispose();
  });

  it('draws across canvases in the order the app drew, and is cleared when the app sets its size, even to the one it has', async () => {
    // Each canvas's drawing went to the copies at the end of the turn, one canvas after
    // another: the canvas drawn on first got its drawing first, though it was drawn into from
    // another canvas drawn on after it. And a read brought only the canvas read up to now.
    const { handle, said, result } = await open({
      'index.html': `<!doctype html><html><body><canvas id="c" width="4" height="3"></canvas><p id="out">waiting</p><script>
        var out = {};
        var c = document.getElementById('c');
        var ctx = c.getContext('2d');
        ctx.clearRect(0, 0, 4, 3);
        var tmp = document.createElement('canvas');
        tmp.width = 2; tmp.height = 2;
        var t = tmp.getContext('2d');
        t.fillStyle = '#00ff00';
        t.fillRect(0, 0, 2, 2);
        ctx.drawImage(tmp, 1, 1);
        out.composite = Array.prototype.join.call(ctx.getImageData(1, 1, 1, 1).data, ',');
        // Set to the size it has: cleared, as a browser clears it.
        c.width = c.width;
        out.cleared = Array.prototype.join.call(ctx.getImageData(1, 1, 1, 1).data, ',');
        out.state = ctx.fillStyle;
        ctx.fillStyle = '#0000ff';
        ctx.fillRect(0, 0, 1, 1);
        out.after = Array.prototype.join.call(ctx.getImageData(0, 0, 1, 1).data, ',');
        document.getElementById('out').textContent = JSON.stringify(out);
      </script></body></html>`,
    });
    expect(await result()).toEqual({ composite: '0,255,0,255', cleared: '0,0,0,0', state: '#000000', after: '0,0,255,255' });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error') || line.startsWith('warn'))).toEqual([]);
    handle.dispose();
  });

  it('has a picture the app draws in its own load handler, read back in that handler', async () => {
    // The picture was decoded for the copies when it was first drawn, and drawn before it
    // was: what the app read back in its load handler lacked it. It is decoded when its
    // address is set now, and the load waits for that.
    const scopeBitmap = globalThis as { createImageBitmap?: unknown };
    const hadBitmap = scopeBitmap.createImageBitmap;
    scopeBitmap.createImageBitmap = standInImageBitmap(150);
    const sprite = encodePng(2, 2, new Uint8Array([255, 128, 0, 255, 255, 128, 0, 255, 255, 128, 0, 255, 255, 128, 0, 255]));
    try {
      const { handle, said, result } = await open({
        'sprite.png': sprite,
        'index.html': `<!doctype html><html><body><canvas id="c" width="4" height="4"></canvas><img id="sprite"><p id="out">waiting</p><script>
          var c = document.getElementById('c');
          var ctx = c.getContext('2d');
          var sprite = document.getElementById('sprite');
          sprite.onload = function () {
            ctx.drawImage(sprite, 1, 1);
            document.getElementById('out').textContent = JSON.stringify({ pixel: Array.prototype.join.call(ctx.getImageData(2, 2, 1, 1).data, ','), size: sprite.naturalWidth });
          };
          sprite.src = 'sprite.png';
        </script></body></html>`,
      });
      // The page's own image loads it: this test's page loads nothing, so it is said here.
      await expect.poll(() => handle.shadowRoot.querySelector('#sprite')?.getAttribute('src') ?? '').not.toBe('');
      const img = handle.shadowRoot.querySelector('#sprite') as HTMLImageElement;
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 2 });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 2 });
      img.dispatchEvent(new Event('load'));
      expect(await result()).toEqual({ pixel: '255,128,0,255', size: 2 });
      expect(said.filter((line) => line.includes('lacks it'))).toEqual([]);
      handle.dispose();
    } finally {
      scopeBitmap.createImageBitmap = hadBitmap;
    }
  });

  it('reads back a canvas drawn with a picture from another site asked for with CORS, fetched without cookies, and not one asked for without', async () => {
    // A picture from another site made every canvas it was drawn into unreadable here, even
    // one the app asked for with crossorigin from a site that allows it, which a browser reads.
    const scopeBitmap = globalThis as { createImageBitmap?: unknown };
    const hadBitmap = scopeBitmap.createImageBitmap;
    scopeBitmap.createImageBitmap = standInImageBitmap(0);
    const red = encodePng(1, 1, new Uint8Array([255, 0, 0, 255]));
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${String(input)} ${init?.mode} ${init?.credentials}`);
      if (String(input) === 'https://pics.softn.test/red.png' && init?.mode === 'cors' && init.credentials === 'omit') {
        return new Response(new Uint8Array(red), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new TypeError('Failed to fetch');
    });
    try {
      const { handle, said, result } = await open(
        {
          'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['pics.softn.test'] } } }),
          'index.html': `<!doctype html><html><body><canvas id="c" width="2" height="2"></canvas><canvas id="d" width="2" height="2"></canvas>
            <img id="a" crossorigin="use-credentials" src="https://pics.softn.test/red.png"><img id="b" src="https://pics.softn.test/red.png"><p id="out">waiting</p><script>
            var a = document.getElementById('a'), b = document.getElementById('b');
            var c = document.getElementById('c'), d = document.getElementById('d');
            var loaded = 0;
            function both() {
              if (++loaded < 2) return;
              c.getContext('2d').drawImage(a, 0, 0);
              d.getContext('2d').drawImage(b, 0, 0);
              setTimeout(function () {
                var taint;
                try { d.toDataURL(); taint = 'read'; } catch (e) { taint = e.name; }
                document.getElementById('out').textContent = JSON.stringify({ pixel: Array.prototype.join.call(c.getContext('2d').getImageData(0, 0, 1, 1).data, ','), crossOrigin: a.crossOrigin + '|' + b.crossOrigin, taint: taint });
              }, 50);
            }
            a.onload = both;
            b.onload = both;
          </script></body></html>`,
        },
        'preapproved'
      );
      // The page's own images load them: this test's page loads nothing, so it is said here.
      await expect.poll(() => handle.shadowRoot.querySelectorAll('img[src]').length).toBe(2);
      const shown = [...handle.shadowRoot.querySelectorAll('img')];
      // Asked for with CORS on the page too, and never with the person's cookies.
      expect(shown.map((img) => img.getAttribute('crossorigin'))).toEqual(['anonymous', null]);
      for (const img of shown) {
        Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1 });
        Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1 });
        img.dispatchEvent(new Event('load'));
      }
      expect(await result()).toEqual({ pixel: '255,0,0,255', crossOrigin: 'use-credentials|null', taint: 'SecurityError' });
      // Fetched by the page (which shows it from a blob of what came, so its own canvas is read
      // back too) and by the Worker for its copy: each time with CORS, and without cookies.
      expect(asked).toEqual(['https://pics.softn.test/red.png cors omit', 'https://pics.softn.test/red.png cors omit']);
      expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
      handle.dispose();
    } finally {
      scopeBitmap.createImageBitmap = hadBitmap;
      vi.unstubAllGlobals();
    }
  });

  it('reads a large part in as many answers as it takes, and says so past what it reads at all', async () => {
    const { handle, said, result } = await open({
      'index.html': `<!doctype html><html><body><canvas id="c" width="1200" height="1000"></canvas><canvas id="huge" width="8000" height="5000"></canvas><p id="out">waiting</p><script>
        var c = document.getElementById('c');
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 1200, 1000);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(0, 999, 1200, 1);
        var all = ctx.getImageData(0, 0, 1200, 1000);
        var at = function (x, y) { var i = (y * 1200 + x) * 4; return [all.data[i], all.data[i + 1], all.data[i + 2], all.data[i + 3]].join(','); };
        var huge = document.getElementById('huge');
        huge.getContext('2d').fillRect(0, 0, 10, 10);
        document.getElementById('out').textContent = JSON.stringify({
          size: all.data.length,
          first: at(0, 0),
          band: at(1199, 749) + ' ' + at(0, 750),
          last: at(600, 999),
          huge: huge.toDataURL(),
          hugePixel: Array.prototype.join.call(huge.getContext('2d').getImageData(0, 0, 1, 1).data, ','),
        });
      </script></body></html>`,
    });
    expect(await result()).toEqual({
      size: 1200 * 1000 * 4,
      first: '255,0,0,255',
      band: '255,0,0,255 255,0,0,255',
      last: '0,255,0,255',
      huge: 'data:,',
      hugePixel: '0,0,0,0',
    });
    // The canvas past what the Worker keeps a copy of is said, once.
    expect(said.filter((line) => line.includes('larger than the Worker keeps a copy of')).length).toBe(1);
    handle.dispose();
  }, 60_000);

  it('tells the page and the Worker of a canvas the app can no longer reach', async () => {
    // A canvas made for a moment (a thumbnail, a measure) was kept on the page, and in the
    // Worker, for as long as the app ran.
    const ops: ShellOp[] = [];
    const real = HostDomPatcher.prototype.applyOps;
    const seen = vi.spyOn(HostDomPatcher.prototype, 'applyOps').mockImplementation(function (this: HostDomPatcher, batch: readonly ShellOp[]) {
      ops.push(...batch);
      return real.call(this, batch);
    });
    try {
      const { handle, result } = await open({
        'index.html': `<!doctype html><html><body><canvas id="c" width="4" height="4"></canvas><p id="out">waiting</p><script>
          var shown = document.getElementById('c').getContext('2d');
          var made = 0;
          function thumbnail() {
            var temp = document.createElement('canvas');
            temp.width = 8; temp.height = 8;
            temp.getContext('2d').fillRect(0, 0, 8, 8);
            shown.drawImage(temp, 0, 0, 4, 4);
            made++;
          }
          for (var i = 0; i < 50; i++) thumbnail();
          var rounds = 0;
          (function churn() {
            var junk = [];
            for (var k = 0; k < 20000; k++) junk.push({ k: k });
            if (++rounds < 40) setTimeout(churn, 5);
            else setTimeout(function () { document.getElementById('out').textContent = JSON.stringify({ made: made, data: shown.getImageData(0, 0, 1, 1).data.length }); }, 20);
          })();
        </script></body></html>`,
      });
      expect(await result()).toEqual({ made: 50, data: 4 });
      const gone = ops.filter((op) => op[0] === 'k2dgone').map((op) => op[1]);
      const drawn = new Set(ops.filter((op) => op[0] === 'k2d').map((op) => op[1]));
      // Each canvas made for a moment is said to be gone, after it was drawn with; the one shown is not.
      expect(gone.length).toBeGreaterThanOrEqual(45);
      expect(gone.every((id) => drawn.has(id))).toBe(true);
      const shownId = Number(handle.shadowRoot.querySelector('#c')?.getAttribute('data-softn-id'));
      expect(gone).not.toContain(shownId);
      for (const id of gone) expect(ops.findIndex((op) => op[0] === 'k2dgone' && op[1] === id)).toBeGreaterThan(ops.findIndex((op) => op[0] === 'k2d' && JSON.stringify(op[4]).includes(`node:${id}`)));
      handle.dispose();
    } finally {
      seen.mockRestore();
    }
  });
});