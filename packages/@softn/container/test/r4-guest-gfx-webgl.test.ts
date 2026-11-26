/**
 * The guest's WebGL (guest-webgl.ts) and the Worker's (webgl-worker-host.ts), end to end and
 * as units: a 2D canvas uploaded as a texture, and the objects an extension makes.
 *
 * This test's page has no OffscreenCanvas and no WebGL: a stand-in canvas records what is
 * drawn on its 2D context, and its WebGL context is a fake that records the uploads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { GUEST_WEBGL_SOURCE } from '../src/guest-webgl';
import { WebGLWorkerHost } from '../src/webgl-worker-host';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

const DRAWING = new Set(['translate', 'fillRect', 'clearRect', 'rotate', 'scale']);

/** What a 2D context was asked to draw, in order: its transforms and its rectangles. */
const drawn = (canvas: StandInCanvas) => canvas.calls.filter((call) => DRAWING.has(String(call[0])));

class StandInCanvas {
  static made: StandInCanvas[] = [];
  width: number;
  height: number;
  calls: unknown[][] = [];
  uploads: unknown[][][] = [];
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    StandInCanvas.made.push(this);
  }
  getContext(kind: string) {
    if (kind === '2d') {
      const calls = this.calls;
      const target: Record<string, unknown> = { canvas: this };
      return new Proxy(target, {
        get: (t, name) => {
          if (name in t) return t[name as string];
          if (name === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
          return (...args: unknown[]) => {
            calls.push([name, ...args]);
          };
        },
        set: (t, name, value) => {
          t[name as string] = value;
          return true;
        },
      });
    }
    if (kind !== 'webgl2' && kind !== 'webgl') return null;
    const uploads = this.uploads;
    return {
      TEXTURE_2D: 3553, RGBA: 6408, UNSIGNED_BYTE: 5121, COLOR_BUFFER_BIT: 16384,
      VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, LOW_FLOAT: 36336, MEDIUM_FLOAT: 36337, HIGH_FLOAT: 36338, LOW_INT: 36339, MEDIUM_INT: 36340, HIGH_INT: 36341,
      getParameter: () => 0,
      getSupportedExtensions: () => [],
      getContextAttributes: () => ({ alpha: true }),
      getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
      getExtension: () => null,
      createTexture: () => ({ texture: true }),
      bindTexture: () => {},
      clear: () => {},
      // What the source canvas had been drawn with when it was uploaded.
      texImage2D: (...args: unknown[]) => {
        const source = args[args.length - 1];
        uploads.push(source instanceof StandInCanvas ? drawn(source) : []);
      },
    };
  }
}

async function open(source: Record<string, string | Uint8Array>) {
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
  const result = async (): Promise<Record<string, unknown>> => {
    await expect.poll(() => handle.shadowRoot.querySelector('#out')?.textContent, { timeout: 15_000 }).not.toBe('waiting');
    return JSON.parse(handle.shadowRoot.querySelector('#out')?.textContent ?? '{}') as Record<string, unknown>;
  };
  return { handle, said, result };
}

describe('a 2D canvas uploaded as a WebGL texture', () => {
  const scope = globalThis as { OffscreenCanvas?: unknown };
  const had = scope.OffscreenCanvas;
  beforeEach(() => {
    document.body.innerHTML = '';
    StandInCanvas.made = [];
    scope.OffscreenCanvas = StandInCanvas;
  });
  afterEach(() => {
    scope.OffscreenCanvas = had;
  });

  it('is drawn once on the Worker’s copy of the canvas, so the next upload is what the app drew', async () => {
    // What the app drew on the canvas before uploading it was drawn on the Worker's copy when
    // the upload ran, and again at the end of the turn: a translate the app made once was
    // made twice there, and everything drawn after it, uploaded later, was in the wrong place.
    const { handle, said, result } = await open({
      'index.html': `<!doctype html><html><body><canvas id="gl" width="4" height="4"></canvas><p id="out">waiting</p><script>
        var label = document.createElement('canvas');
        label.width = 4; label.height = 4;
        var x = label.getContext('2d');
        x.translate(1, 0);
        x.fillStyle = '#ff0000';
        x.fillRect(0, 0, 1, 1);
        var gl = document.getElementById('gl').getContext('webgl2');
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, label);
        gl.clear(gl.COLOR_BUFFER_BIT);
        setTimeout(function () {
          x.fillRect(0, 1, 1, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, label);
          gl.clear(gl.COLOR_BUFFER_BIT);
          setTimeout(function () { document.getElementById('out').textContent = JSON.stringify({ gl: !!gl }); }, 30);
        }, 30);
      </script></body></html>`,
    });
    expect(await result()).toEqual({ gl: true });
    const glCanvas = StandInCanvas.made.find((c) => c.uploads.length > 0);
    expect(glCanvas?.uploads).toEqual([
      [['translate', 1, 0], ['fillRect', 0, 0, 1, 1]],
      [['translate', 1, 0], ['fillRect', 0, 0, 1, 1], ['fillRect', 0, 1, 1, 1]],
    ]);
    const copy = StandInCanvas.made.find((c) => drawn(c).length > 0);
    expect(drawn(copy!)).toEqual([['translate', 1, 0], ['fillRect', 0, 0, 1, 1], ['fillRect', 0, 1, 1, 1]]);
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  }, 30_000);
});

/**
 * The guest's WebGL in a context of its own (as the engine runs it), its host calls answered
 * by a real WebGLWorkerHost whose canvas is a fake one.
 */
function guestWithHost(gl: Record<string, unknown>) {
  const scope = globalThis as { OffscreenCanvas?: unknown };
  const had = scope.OffscreenCanvas;
  scope.OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return gl; }
  };
  const host = new WebGLWorkerHost();
  const bridge = {
    callSync(kind: string, sub: string, ...args: string[]) {
      if (kind !== 'webgl') return null;
      if (sub === 'init') return host.init(Number(args[0]), args[1], Number(args[2]), Number(args[3]), {});
      if (sub === 'ext') return host.getExtension(Number(args[0]), args[1]);
      if (sub === 'exec') return host.exec(Number(args[0]), args[1] ? JSON.parse(args[1]) : [], args[2] ? JSON.parse(args[2]) : null);
      return null;
    },
  };
  const guest = vm.createContext({ host: bridge, console });
  vm.runInContext(GUEST_WEBGL_SOURCE, guest);
  const restore = () => { scope.OffscreenCanvas = had; };
  return { host, guest: guest as unknown as Record<string, unknown> & { __softnCreateWebGLContext: (c: unknown, k: string, a: unknown) => Record<string, unknown> }, restore };
}

describe('objects a WebGL extension makes', () => {
  it('are let go of when the app deletes them, on both sides, so objects can still be made after many', () => {
    // A vertex array of OES_vertex_array_object (WebGL 1's, which three.js, PixiJS and regl
    // make and delete as geometry comes and goes) was kept by both sides after the app deleted
    // it. After 32,768 of them the Worker's table was full: no object of any kind was made
    // again, and the app drew nothing.
    let made = 0;
    let deleted = 0;
    let buffers = 0;
    const ext = {
      createVertexArrayOES: () => ({ vao: ++made }),
      deleteVertexArrayOES: () => { deleted++; },
      bindVertexArrayOES: () => {},
    };
    const gl = {
      VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, LOW_FLOAT: 36336, MEDIUM_FLOAT: 36337, HIGH_FLOAT: 36338, LOW_INT: 36339, MEDIUM_INT: 36340, HIGH_INT: 36341,
      getParameter: () => 0,
      getSupportedExtensions: () => ['OES_vertex_array_object'],
      getContextAttributes: () => ({}),
      getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
      getExtension: (name: string) => (name === 'OES_vertex_array_object' ? ext : null),
      createBuffer: () => { buffers++; return { buffer: buffers }; },
    };
    const { host, guest, restore } = guestWithHost(gl);
    try {
      const ctx = guest.__softnCreateWebGLContext({ __softnNode: 3, width: 4, height: 4 }, 'webgl', {}) as Record<string, (...a: unknown[]) => unknown> & { _handles: Record<string, unknown>; _flush: () => unknown };
      const oes = ctx.getExtension('OES_vertex_array_object') as Record<string, (...a: unknown[]) => unknown>;
      let refused = 0;
      for (let i = 0; i < 40_000; i++) {
        const vao = oes.createVertexArrayOES();
        if (!vao) refused++;
        else oes.deleteVertexArrayOES(vao);
        if (i % 1000 === 0) ctx._flush();
      }
      ctx._flush();
      expect(refused).toBe(0);
      expect(deleted).toBe(40_000);
      expect(Object.keys(ctx._handles).length).toBeLessThan(10);
      const entry = (host as unknown as { contexts: Map<number, { handles: Map<number, unknown> }> }).contexts.values().next().value!;
      expect(entry.handles.size).toBeLessThan(10);
      // And the app's own objects are made.
      ctx.createBuffer();
      ctx._flush();
      expect(buffers).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('the WebGL contexts the Worker keeps', () => {
  it('makes room for a new context by letting go of one the app lost on purpose', () => {
    // A renderer destroyed the way libraries destroy one (WEBGL_lose_context's loseContext) kept
    // its context counted among the sixteen the Worker keeps until its canvas was collected: an
    // app that made a new canvas each time had no context at all after sixteen.
    const scope = globalThis as { OffscreenCanvas?: unknown };
    const had = scope.OffscreenCanvas;
    const contexts: Array<{ lost: boolean }> = [];
    scope.OffscreenCanvas = class {
      width: number;
      height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() {
        const state = { lost: false };
        contexts.push(state);
        return {
          COLOR_BUFFER_BIT: 16384,
          getParameter: () => 0,
          getSupportedExtensions: () => ['WEBGL_lose_context'],
          getContextAttributes: () => ({}),
          getShaderPrecisionFormat: () => null,
          getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => { state.lost = true; }, restoreContext: () => { state.lost = false; } } : null),
          isContextLost: () => state.lost,
          clear: () => {},
        };
      }
    };
    try {
      const host = new WebGLWorkerHost();
      const ids: number[] = [];
      for (let i = 0; i < 16; i++) {
        const info = host.init(100 + i, 'webgl', 4, 4);
        expect(info).not.toBeNull();
        ids.push(Number(info!.ctxId));
        host.exec(ids[i], [['v', 'clear', 16384]], null);
      }
      // The full sixteen, each drawn on: none to spare.
      expect(host.init(200, 'webgl', 4, 4)).toBeNull();
      // One destroyed by its app.
      host.getExtension(ids[3], 'WEBGL_lose_context');
      host.exec(ids[3], [['x', 'WEBGL_lose_context', 'loseContext']], null);
      expect(contexts[3].lost).toBe(true);
      const next = host.init(201, 'webgl', 4, 4);
      expect(next).not.toBeNull();
      // It was the lost one that was let go of; the others are there still.
      expect(host.exec(ids[3], [], null)).toBeNull();
      for (const id of ids.filter((_, i) => i !== 3)) expect(host.exec(id, [], null)).toBe(true);
      host.disposeAll();
    } finally {
      scope.OffscreenCanvas = had;
    }
  });
});

describe('what the Worker counts of a WebGL object', () => {
  it('lets go of exactly the deleted object’s allocations, whatever else is counted', () => {
    const scope = globalThis as { OffscreenCanvas?: unknown };
    const had = scope.OffscreenCanvas;
    scope.OffscreenCanvas = class {
      width: number;
      height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() {
        return {
          ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, TEXTURE_2D: 0x0de1,
          getParameter: () => 0, getSupportedExtensions: () => [], getContextAttributes: () => ({}), getShaderPrecisionFormat: () => null, getExtension: () => null,
          createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, deleteBuffer() {},
          createTexture: () => ({}), bindTexture() {}, texImage2D() {}, deleteTexture() {},
        };
      }
    };
    try {
      const host = new WebGLWorkerHost();
      const ctxId = Number(host.init(1, 'webgl2', 4, 4)!.ctxId);
      host.exec(ctxId, [
        ['c', 'createBuffer', 1], ['v', 'bindBuffer', 0x8892, ['$h', 1]], ['v', 'bufferData', 0x8892, 100, 0x88e4],
        ['c', 'createBuffer', 11], ['v', 'bindBuffer', 0x8892, ['$h', 11]], ['v', 'bufferData', 0x8892, 1000, 0x88e4],
        ['c', 'createTexture', 2], ['v', 'bindTexture', 0x0de1, ['$h', 2]], ['v', 'texImage2D', 0x0de1, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, null],
      ], null);
      const entry = (host as unknown as { contexts: Map<number, { handleBytes: Map<string, number>; allocatedBytes: number }> }).contexts.get(ctxId)!;
      expect(entry.allocatedBytes).toBe(100 + 1000 + 64);
      // Buffer 1 (its id a prefix of buffer 11's): its allocation only.
      host.exec(ctxId, [['d', 'deleteBuffer', 1]], null);
      expect([...entry.handleBytes.keys()].sort()).toEqual(['11:buf', '2:t2:3553:0']);
      expect(entry.allocatedBytes).toBe(1000 + 64);
      host.exec(ctxId, [['d', 'deleteTexture', 2], ['d', 'deleteBuffer', 11]], null);
      expect(entry.handleBytes.size).toBe(0);
      expect(entry.allocatedBytes).toBe(0);
      host.disposeAll();
    } finally {
      scope.OffscreenCanvas = had;
    }
  });
});
