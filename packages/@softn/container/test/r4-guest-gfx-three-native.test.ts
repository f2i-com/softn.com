/**
 * The native Three.js path, end to end: an app whose own script bundles Three.js (so the
 * Worker instruments its WebGLRenderer), run by the real engine, drawn by ThreeWorkerHost.
 *
 * This test's page has no OffscreenCanvas, no createImageBitmap and no Three.js for the
 * Worker: stand-ins are given for the first two, and the host's Three.js is a small mock
 * that records what it is asked to make (the real one is driven in e2e).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { encodePng } from '../src/canvas-replay';
import { ThreeWorkerHost } from '../src/three-worker-host';
import { HostDomPatcher } from '../src/dom-patcher';
import type { ShellOp } from '../src/types';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

/** A PNG's pixels (RGBA, row after row). */
function pngPixels(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  const parts: Uint8Array[] = [];
  while (at < bytes.length) {
    const size = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (kind === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
    } else if (kind === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => { joined.set(part, at); return at + part.length; }, 0);
  const raw = zlib.inflateSync(joined);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  return { width, height, rgba };
}

/** A canvas that keeps what it is told: its 2D context records each call made on it. */
class StandInCanvas {
  width: number;
  height: number;
  calls: unknown[][] = [];
  pixels: Uint8Array;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
  }
  getContext(kind: string) {
    if (kind !== '2d') return null;
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
        calls.push(['set', name, value]);
        t[name as string] = value;
        return true;
      },
    });
  }
}

/** createImageBitmap for this test's page, which has none: a PNG read into a stand-in canvas. */
function standInImageBitmap(blob: Blob): Promise<StandInCanvas & { close(): void }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('unreadable'));
    reader.onload = () => {
      const { width, height, rgba } = pngPixels(new Uint8Array(reader.result as ArrayBuffer));
      const bitmap = Object.assign(new StandInCanvas(width, height), { close: () => undefined });
      bitmap.pixels.set(rgba);
      resolve(bitmap);
    };
    reader.readAsArrayBuffer(blob);
  });
}

interface ThreeLog {
  textures: Array<{ image: unknown; kind: string }>;
  renders: number;
  materials: Array<Record<string, unknown>>;
}

/** The host's Three.js: just what ThreeWorkerHost asks of it here, recording what it makes. */
function mockThree(log: ThreeLog) {
  class Vec2 { x = 0; y = 0; set(x: number, y: number) { this.x = x; this.y = y; return this; } }
  class Vec3 { x: number; y: number; z: number; constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; } }
  class Quat { x = 0; y = 0; z = 0; w = 1; set(x: number, y: number, z: number, w: number) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } }
  class Color { r = 1; g = 1; b = 1; isColor = true; setRGB(r: number, g: number, b: number) { this.r = r; this.g = g; this.b = b; return this; } }
  class Sphere { center: Vec3; radius: number; constructor(c = new Vec3(), r = 0) { this.center = c; this.radius = r; } }
  class Obj3D {
    position = new Vec3(); quaternion = new Quat(); scale = new Vec3(1, 1, 1);
    matrix = { elements: new Float32Array(16), fromArray() {} };
    matrixAutoUpdate = true; visible = true; castShadow = false; receiveShadow = false; frustumCulled = true; renderOrder = 0;
    layers = { mask: 1 }; children: Obj3D[] = []; parent: Obj3D | null = null; userData: Record<string, unknown> = {};
    add(c: Obj3D) { if (c.parent) c.parent.remove(c); c.parent = this; this.children.push(c); return this; }
    remove(c: Obj3D) { c.parent = null; this.children = this.children.filter((x) => x !== c); return this; }
    traverse(fn: (o: Obj3D) => void) { fn(this); for (const c of this.children) c.traverse(fn); }
    updateMatrixWorld() {}
  }
  class Scene extends Obj3D { isScene = true; background: unknown = null; fog: unknown = null; }
  class Group extends Obj3D { isGroup = true; }
  class Mesh extends Obj3D { isMesh = true; geometry: unknown; material: unknown; constructor(g: unknown, m: unknown) { super(); this.geometry = g; this.material = m; } }
  class PerspectiveCamera extends Obj3D {
    isCamera = true; isPerspectiveCamera = true; fov: number; aspect: number; near: number; far: number; zoom = 1;
    constructor(fov: number, aspect: number, near: number, far: number) { super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; }
    updateProjectionMatrix() {}
  }
  class Attr { array: unknown; itemSize: number; constructor(array: unknown, itemSize: number) { this.array = array; this.itemSize = itemSize; } }
  class Geo {
    attributes: Record<string, unknown> = {}; index: unknown = null; boundingSphere: Sphere | null = null;
    setAttribute(n: string, a: unknown) { this.attributes[n] = a; } getAttribute(n: string) { return this.attributes[n]; }
    setIndex(i: unknown) { this.index = i; } setDrawRange() {} clearGroups() {} addGroup() {}
    computeBoundingSphere() { this.boundingSphere = new Sphere(new Vec3(), 1); } dispose() {}
  }
  class Material {
    color = new Color(); map: unknown = null; alphaMap: unknown = null; emissiveMap: unknown = null; opacity = 1; transparent = false; side = 0;
    vertexColors = false; wireframe = false; depthWrite = true; depthTest = true; toneMapped = true; blending = 1; fog = true; visible = true; needsUpdate = false;
    constructor() { log.materials.push(this as unknown as Record<string, unknown>); }
    dispose() {}
  }
  class Texture {
    isTexture = true; image: unknown; needsUpdate = false; colorSpace = ''; wrapS = 0; wrapT = 0; repeat = new Vec2(); offset = new Vec2();
    minFilter = 0; magFilter = 0; generateMipmaps = true; flipY = true; anisotropy = 1; disposed = false;
    constructor(image: unknown, kind = 'Texture') { this.image = image; log.textures.push({ image, kind }); }
    dispose() { this.disposed = true; }
  }
  class CanvasTexture extends Texture { constructor(image: unknown) { super(image, 'CanvasTexture'); } }
  class DataTexture extends Texture {
    isDataTexture = true; format: unknown; type: unknown;
    constructor(data: unknown, width: number, height: number, format: unknown, type: unknown) { super({ data, width, height }, 'DataTexture'); this.format = format; this.type = type; }
  }
  class WebGLRenderer {
    capabilities = { isWebGL2: true, maxTextureSize: 4096, getMaxAnisotropy: () => 16, maxVertexUniforms: 1024, precision: 'highp' };
    shadowMap = { enabled: false, type: 1 };
    setSize() {} setPixelRatio() {} setClearColor() {}
    render() { log.renders++; }
    dispose() {}
    getContext() { return { getContextAttributes: () => ({}) }; }
  }
  return {
    Vector2: Vec2, Vector3: Vec3, Color, Sphere, Object3D: Obj3D, Scene, Group, Mesh, PerspectiveCamera,
    BufferGeometry: Geo, InstancedBufferGeometry: Geo, BufferAttribute: Attr, InstancedBufferAttribute: Attr,
    MeshBasicMaterial: Material, MeshStandardMaterial: Material, Texture, CanvasTexture, DataTexture, WebGLRenderer,
    RGBAFormat: 1023, UnsignedByteType: 1009,
  };
}

/**
 * An app's script with Three.js bundled in it, as far as the Worker looks for one: a
 * WebGLRenderer class, which the Worker makes the native one. Then plain objects shaped as
 * Three.js's own (what the native renderer reads of a scene).
 */
const BUNDLED_THREE_PRELUDE = `
  function Renderer(e) { this.isWebGLRenderer = true; this.fallback = 'THREE.WebGLRenderer'; }
  function v3(x, y, z) { return { x: x, y: y, z: z }; }
  function object3d(extra) {
    var o = { position: v3(0, 0, 0), quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: v3(1, 1, 1), matrixAutoUpdate: true, visible: true,
      castShadow: false, receiveShadow: false, frustumCulled: true, renderOrder: 0, layers: { mask: 1 }, children: [] };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function texture(image) {
    return { isTexture: true, image: image, version: 0, colorSpace: 'srgb', wrapS: 1001, wrapT: 1001, repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 },
      minFilter: 1008, magFilter: 1006, generateMipmaps: true, flipY: true, anisotropy: 1 };
  }
  function basicMaterial(map) {
    return { isMeshBasicMaterial: true, map: map, color: { r: 1, g: 1, b: 1 }, version: 0, opacity: 1, transparent: false, side: 0, vertexColors: false,
      wireframe: false, depthWrite: true, depthTest: true, toneMapped: true, blending: 1, fog: true, visible: true };
  }
  function geometry() { return { attributes: {}, drawRange: { start: 0, count: Infinity }, groups: [], index: null }; }
`;

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

describe('the native Three.js path, end to end', () => {
  const scope = globalThis as { OffscreenCanvas?: unknown; createImageBitmap?: unknown };
  const hadCanvas = scope.OffscreenCanvas;
  const hadBitmap = scope.createImageBitmap;
  let log: ThreeLog;
  beforeEach(() => {
    document.body.innerHTML = '';
    scope.OffscreenCanvas = StandInCanvas;
    scope.createImageBitmap = standInImageBitmap;
    log = { textures: [], renders: 0, materials: [] };
    const THREE = mockThree(log);
    vi.spyOn(ThreeWorkerHost.prototype, 'ensureLoaded').mockImplementation(async function (this: ThreeWorkerHost) {
      (this as unknown as { THREE: unknown }).THREE = THREE;
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    scope.OffscreenCanvas = hadCanvas;
    scope.createImageBitmap = hadBitmap;
  });

  it.each([
    // three.js's TextureLoader asks for every picture with crossOrigin = 'anonymous' and never
    // puts the image on the page. Its picture was decoded for the Worker by the name such an
    // image is drawn by ('cors:' and its address), and asked for by its address alone: the
    // texture never had a picture.
    ['made as TextureLoader makes it (crossOrigin, on no page)', "img.crossOrigin = 'anonymous';"],
    ['made without crossOrigin, on no page', ''],
  ])('gives a texture the picture of an image %s', async (_name, crossOrigin) => {
    const red = encodePng(2, 2, new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]));
    const { handle, said, result } = await open({
      'tex.png': red,
      'index.html': `<!doctype html><html><body><canvas id="gl" width="8" height="8"></canvas><p id="out">waiting</p><script>
        ${BUNDLED_THREE_PRELUDE}
        var r = new Renderer({ canvas: document.getElementById('gl') });
        var img = new Image();
        ${crossOrigin}
        img.src = 'tex.png';
        var tex = texture(img);
        var mesh = object3d({ isMesh: true, geometry: geometry(), material: basicMaterial(tex) });
        var scene = object3d({ isScene: true, children: [mesh], background: null, fog: null });
        var cam = object3d({ isPerspectiveCamera: true, fov: 50, aspect: 1, near: 0.1, far: 100, zoom: 1 });
        var frames = 0;
        (function frame() {
          // As three.js does when the picture has come: the texture is told to upload again.
          tex.version++;
          r.render(scene, cam);
          if (++frames < 15) setTimeout(frame, 20);
          else document.getElementById('out').textContent = JSON.stringify({ native: !r.fallback, frames: frames });
        })();
      </script></body></html>`,
    });
    expect(await result()).toEqual({ native: true, frames: 15 });
    // The material drawn with the texture has it, and the texture has the picture.
    expect(log.materials.length).toBe(1);
    const picture = (log.materials[0].map as { image?: unknown } | null)?.image;
    expect(picture).toBeInstanceOf(StandInCanvas);
    expect([...(picture as StandInCanvas).pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  }, 30_000);

  it('draws a canvas used as a texture on the page as well, and once on the Worker’s copy', async () => {
    // What the app drew on a canvas it then used as a CanvasTexture was taken from that
    // canvas's drawing for the texture: the page's canvas never had it (a HUD or a minimap the
    // app also shows was blank there).
    const ops: ShellOp[] = [];
    const real = HostDomPatcher.prototype.applyOps;
    vi.spyOn(HostDomPatcher.prototype, 'applyOps').mockImplementation(function (this: HostDomPatcher, batch: readonly ShellOp[]) {
      ops.push(...batch);
      return real.call(this, batch);
    });
    const { handle, said, result } = await open({
      'index.html': `<!doctype html><html><body><canvas id="gl" width="8" height="8"></canvas><canvas id="hud" width="4" height="4"></canvas><p id="out">waiting</p><script>
        ${BUNDLED_THREE_PRELUDE}
        var r = new Renderer({ canvas: document.getElementById('gl') });
        var hud = document.getElementById('hud');
        var h = hud.getContext('2d');
        h.translate(1, 0);
        h.fillStyle = '#00ff00';
        h.fillRect(0, 0, 1, 1);
        var tex = texture(hud);
        var mesh = object3d({ isMesh: true, geometry: geometry(), material: basicMaterial(tex) });
        var scene = object3d({ isScene: true, children: [mesh], background: null, fog: null });
        var cam = object3d({ isPerspectiveCamera: true, fov: 50, aspect: 1, near: 0.1, far: 100, zoom: 1 });
        r.render(scene, cam);
        setTimeout(function () {
          h.fillRect(0, 1, 1, 1);
          tex.version++;
          r.render(scene, cam);
          setTimeout(function () { document.getElementById('out').textContent = JSON.stringify({ native: !r.fallback }); }, 30);
        }, 30);
      </script></body></html>`,
    });
    expect(await result()).toEqual({ native: true });
    const hudId = Number(handle.shadowRoot.querySelector('#hud')?.getAttribute('data-softn-id'));
    const onPage = ops.filter((op) => op[0] === 'k2d' && op[1] === hudId).flatMap((op) => op[4] as unknown[][]).filter((c) => c[0] === 'fillRect' || c[0] === 'translate');
    expect(onPage).toEqual([['translate', 1, 0], ['fillRect', 0, 0, 1, 1], ['fillRect', 0, 1, 1, 1]]);
    // The Worker's copy, which the texture is made from, has each of them once.
    const copy = log.textures.find((t) => t.kind === 'CanvasTexture')?.image as StandInCanvas | undefined;
    expect(copy).toBeInstanceOf(StandInCanvas);
    expect(copy!.calls.filter((c) => c[0] === 'fillRect' || c[0] === 'translate')).toEqual([['translate', 1, 0], ['fillRect', 0, 0, 1, 1], ['fillRect', 0, 1, 1, 1]]);
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  }, 30_000);
});
