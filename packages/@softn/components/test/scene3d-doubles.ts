/**
 * What the Scene3D suites share: a renderer that needs no GPU, a fetch that
 * answers from a table, a requestAnimationFrame the test drives by hand, and
 * a glTF small enough to write inline.
 *
 * Kept free of any `three` import so a `vi.mock('three')` factory can load
 * it without recursing into itself.
 */

import { expect, vi } from 'vitest';

export class TestWebGLRenderer {
  domElement = document.createElement('canvas');
  shadowMap = { enabled: false, type: 0 };
  toneMapping = 0;
  toneMappingExposure = 1;
  outputColorSpace = '';
  capabilities = { getMaxAnisotropy: () => 4 };
  renders = 0;
  /** Every size and pixel ratio it was given, in order. */
  sizes: Array<[number, number]> = [];
  pixelRatios: number[] = [];
  setSize(width: number, height: number) {
    this.sizes.push([width, height]);
  }
  setPixelRatio(ratio: number) {
    this.pixelRatios.push(ratio);
  }
  getPixelRatio() {
    return this.pixelRatios.at(-1) ?? 1;
  }
  // The effects composer asks the renderer how big it is before it decides
  // whether there is anything to build.
  getSize(target: { set(x: number, y: number): unknown }) {
    target.set(300, 150);
    return target;
  }
  /** The camera the last frame was drawn with. */
  lastCamera: unknown = null;
  /**
   * The counters a real renderer keeps of what it drew, as the scene's
   * readout reads them: cleared before each draw unless `autoReset` is off,
   * and then only when asked. `drawn` is what one draw adds to them.
   */
  drawn = { calls: 0, triangles: 0 };
  info = {
    autoReset: true,
    resets: 0,
    render: { calls: 0, triangles: 0 },
    reset(this: { resets: number; render: { calls: number; triangles: number } }) {
      this.resets++;
      this.render.calls = 0;
      this.render.triangles = 0;
    },
  };
  render(_scene?: unknown, camera?: unknown) {
    this.renders++;
    this.lastCamera = camera ?? null;
    if (this.info.autoReset) this.info.reset();
    this.info.render.calls += this.drawn.calls;
    this.info.render.triangles += this.drawn.triangles;
  }
  dispose() {}
  forceContextLoss() {}
}

/** Poll until `ready`, for work that crosses a dynamic import or a fetch. */
export async function waitFor(ready: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 600 && !ready(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(ready(), `timed out waiting for ${label}`).toBe(true);
}

/** A few turns of the event loop, for work that is already on its way. */
export async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export type FetchBody = string | ArrayBuffer | Uint8Array<ArrayBuffer> | null;
export type FetchRoute = (url: string) => FetchBody | Promise<FetchBody>;

export interface FetchStub {
  /** Every URL asked for, in order, including `data:` ones. */
  calls: string[];
}

/**
 * Replace `fetch` with a table. A URL with no route gets a 404, which
 * three's FileLoader turns into a rejection; `data:` URLs get an empty body,
 * which is what a real fetch of `data:,` returns.
 */
export function stubFetch(routes: Record<string, FetchRoute>): FetchStub {
  const stub: FetchStub = { calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      stub.calls.push(url);
      if (url.startsWith('data:')) return new Response(new ArrayBuffer(0), { status: 200 });
      const route = routes[url];
      if (!route) return new Response('not found', { status: 404 });
      const body = await route(url);
      return new Response(body, { status: 200 });
    })
  );
  return stub;
}

export interface FrameStub {
  frames: FrameRequestCallback[];
  raf: ReturnType<typeof vi.fn>;
  caf: ReturnType<typeof vi.fn>;
  /** Run the oldest scheduled frame, as the browser would. */
  runFrame(now?: number): void;
}

/** requestAnimationFrame the test runs by hand, and its cancel. */
export function stubFrames(): FrameStub {
  const frames: FrameRequestCallback[] = [];
  let handle = 0;
  const raf = vi.fn((cb: FrameRequestCallback) => {
    frames.push(cb);
    return ++handle;
  });
  const caf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);
  return {
    frames,
    raf,
    caf,
    runFrame: (now = performance.now()) => {
      const cb = frames.shift();
      if (cb) cb(now);
    },
  };
}

/** A pointer event jsdom can dispatch: a mouse event given the pointer's id. */
export function pointerEvent(type: string, pointerId: number, clientX = 0, clientY = 0, button = 0): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event as PointerEvent;
}

/**
 * Give a scene's canvas a place on the page, which jsdom does not: a
 * rectangle for the pointer to be measured against, and pointer capture that
 * does nothing. The default is 300 by 150 at the page's corner, so the
 * middle of the view is (150, 75).
 */
export function placeCanvas(canvas: HTMLCanvasElement, width = 300, height = 150, left = 0, top = 0): HTMLCanvasElement {
  canvas.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
  canvas.setPointerCapture = vi.fn();
  canvas.releasePointerCapture = vi.fn();
  canvas.hasPointerCapture = () => false;
  return canvas;
}

/** Three vertices, as float32 x/y/z: 36 bytes. */
export function triangleBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(36);
  bytes.set(new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer));
  return bytes;
}

/**
 * A glTF whose one mesh reads its positions from `bufferUri`, so the loader
 * has to fetch that buffer to build anything. `extras` is merged in at the
 * top level, for extension declarations.
 */
export function gltfNeeding(bufferUri: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ uri: bufferUri, byteLength: 36 }],
    ...extras,
  });
}

/** A glTF with no geometry: enough for a mocked loader, and for the codec peek. */
export function emptyGltf(extras: Record<string, unknown> = {}): string {
  return JSON.stringify({ asset: { version: '2.0' }, ...extras });
}
