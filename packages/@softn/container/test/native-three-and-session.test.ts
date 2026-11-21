/**
 * Tests for:
 * 1. VirtualCookieJar serialize/hydrate persistence across reloads
 * 2. IndexedDB container session store (urlPath, sessionStorage, localStorage)
 * 3. Canvas + nested R3F-style wrapper div non-zero clientWidth/clientHeight on frame 0
 * 4. ThreeWorkerHost safety (NaN transform guard, perspective depth precision clamping,
 *    InstancedBufferGeometry bounding sphere preservation, material needsUpdate)
 * 5. Rust VFS binary `File::write_all` + `exportRustOverlayJson()` bit-exact round-trip
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mountSoftNContainer,
  VirtualCookieJar,
  loadContainerSession,
  saveContainerSession,
  clearContainerSession,
} from '../src/index';
import { ThreeWorkerHost } from '../src/three-worker-host';
import { loadZippEngine } from '../src/zipp-loader';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');
const RUST_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-rust.wasm');

function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('VirtualCookieJar persistence', () => {
  it('serializes and hydrates HttpOnly and path-scoped cookies while dropping expired ones', () => {
    const jar = new VirtualCookieJar();
    expect(
      jar.ingestResponseHeaders([
        ['Set-Cookie', 'pit_refresh=tok123; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=3600'],
        ['Set-Cookie', 'pit_csrf=abc; Path=/; Max-Age=3600'],
        ['Set-Cookie', 'expired=old; Path=/; Max-Age=0'],
      ])
    ).toBe(true);
    expect(jar.ingestResponseHeaders([['Content-Type', 'application/json']])).toBe(false);

    const snapshot = jar.serialize();
    const restored = new VirtualCookieJar();
    restored.hydrate(snapshot);

    expect(restored.getCookieHeader('/api/v1/auth/refresh', true)).toBe('pit_refresh=tok123; pit_csrf=abc');
    expect(restored.getCookieHeader('/api/v1/auth/refresh', false)).toBe('pit_csrf=abc');
    expect(restored.getCookieHeader('/other', true)).toBe('pit_csrf=abc');

    // Malformed payloads are ignored safely
    restored.hydrate('not-json');
    expect(restored.getCookieHeader('/other', true)).toBe('pit_csrf=abc');
  });
});

describe('IndexedDB container session store', () => {
  const origIdb = (globalThis as { indexedDB?: unknown }).indexedDB;

  afterEach(() => {
    if (origIdb === undefined) {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    } else {
      (globalThis as { indexedDB?: unknown }).indexedDB = origIdb;
    }
  });

  it('degrades gracefully when indexedDB is unavailable and round-trips when present', async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    expect(await loadContainerSession('app:1:')).toBeNull();
    expect(
      await saveContainerSession('app:1:', {
        urlPath: '/map',
        sessionStorage: { a: '1' },
        localStorage: { theme: 'light' },
        updatedAt: Date.now(),
      })
    ).toBe(false);

    // Install lightweight in-memory IndexedDB mock
    const backing = new Map<string, unknown>();
    const makeReq = <T,>(run: () => T) => {
      const req: { result?: T; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = {};
      queueMicrotask(() => {
        req.result = run();
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () =>
        makeReq(() => ({
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          close: () => {},
          transaction: () => {
            const tx: {
              oncomplete?: () => void;
              onerror?: () => void;
              objectStore: () => {
                get: (k: string) => unknown;
                put: (v: unknown, k: string) => unknown;
                delete: (k: string) => unknown;
              };
            } = {
              objectStore: () => ({
                get: (k: string) => makeReq(() => backing.get(k)),
                put: (v: unknown, k: string) => {
                  backing.set(k, structuredClone(v));
                  queueMicrotask(() => tx.oncomplete?.());
                  return {};
                },
                delete: (k: string) => {
                  backing.delete(k);
                  queueMicrotask(() => tx.oncomplete?.());
                  return {};
                },
              }),
            };
            return tx;
          },
        })),
    };

    const saved = await saveContainerSession('app:pit:', {
      urlPath: '/map?layer=ore',
      sessionStorage: { view: '3d' },
      localStorage: { 'pit.theme': 'light' },
      updatedAt: 12345,
    });
    expect(saved).toBe(true);

    const loaded = await loadContainerSession('app:pit:');
    expect(loaded).toEqual({
      urlPath: '/map?layer=ore',
      sessionStorage: { view: '3d' },
      localStorage: { 'pit.theme': 'light' },
      updatedAt: 12345,
    });

    await clearContainerSession('app:pit:');
    expect(await loadContainerSession('app:pit:')).toBeNull();
  });
});

describe('Canvas & nested wrapper box sizing on frame 0', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('reports positive clientWidth/clientHeight for canvas and R3F-style wrapper divs immediately', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      source: {
        'index.html': `<!doctype html><html><body>
          <div id="events-root"><div id="measure-wrap"><canvas id="gl" width="800" height="600" style="width: 800px; height: 600px;"></canvas></div></div>
          <pre id="out"></pre>
          <script>
            var c = document.getElementById('gl');
            var m = document.getElementById('measure-wrap');
            var e = document.getElementById('events-root');
            document.getElementById('out').textContent = JSON.stringify({
              c: [c.clientWidth, c.clientHeight],
              m: [m.clientWidth, m.clientHeight],
              e: [e.clientWidth, e.clientHeight],
            });
          </script>
        </body></html>`,
      },
    });
    await settle(100);
    const parsed = JSON.parse(handle.shadowRoot.querySelector('#out')?.textContent || '{}');
    expect(parsed).toEqual({
      c: [800, 600],
      m: [800, 600],
      e: [800, 600],
    });
    handle.dispose();
  });
});

describe('ThreeWorkerHost safety, depth precision, bounding spheres & material invalidation', () => {
  function makeMockThreeHost() {
    class MockVec3 {
      x = 0; y = 0; z = 0;
      constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
      set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    }
    class MockQuat {
      x = 0; y = 0; z = 0; w = 1;
      set(x: number, y: number, z: number, w: number) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
    }
    class MockSphere {
      center: MockVec3; radius: number;
      constructor(c = new MockVec3(), r = 0) { this.center = c; this.radius = r; }
    }
    class MockColor {
      r = 1; g = 1; b = 1; isColor = true;
      setRGB(r: number, g: number, b: number) { this.r = r; this.g = g; this.b = b; return this; }
    }
    class MockAttr {
      array: Float32Array; itemSize: number; needsUpdate = false;
      constructor(arr: Float32Array, itemSize: number) { this.array = arr; this.itemSize = itemSize; }
    }
    class MockGeo {
      attrs = new Map<string, unknown>();
      boundingSphere: MockSphere | null = null;
      isInstancedBufferGeometry = false;
      setAttribute(n: string, a: unknown) { this.attrs.set(n, a); }
      getAttribute(n: string) { return this.attrs.get(n); }
      setIndex() {}
      setDrawRange() {}
      clearGroups() {}
      addGroup() {}
      computeBoundingSphere() { this.boundingSphere = new MockSphere(new MockVec3(0, 0, 0), 1); }
      dispose() {}
    }
    class MockInstancedGeo extends MockGeo {
      isInstancedBufferGeometry = true;
      instanceCount = Infinity;
    }
    class MockMaterial {
      color = new MockColor();
      emissive = new MockColor();
      transparent = false;
      opacity = 1;
      side = 0;
      vertexColors = false;
      flatShading = false;
      fog = true;
      depthWrite = true;
      depthTest = true;
      toneMapped = true;
      blending = 1;
      visible = true;
      wireframe = false;
      needsUpdate = false;
      dispose() {}
    }
    class MockObj {
      position = new MockVec3();
      quaternion = new MockQuat();
      scale = new MockVec3(1, 1, 1);
      matrix = { elements: new Float32Array(16), fromArray(a: Float32Array, off: number) { this.elements.set(a.subarray(off, off + 16)); } };
      matrixAutoUpdate = true;
      matrixWorldNeedsUpdate = false;
      visible = true;
      castShadow = false;
      receiveShadow = false;
      frustumCulled = true;
      renderOrder = 0;
      layers = { mask: 1 };
      children: MockObj[] = [];
      parent: MockObj | null = null;
      userData: Record<string, unknown> = {};
      add(c: MockObj) { c.parent = this; this.children.push(c); }
      remove(c: MockObj) { c.parent = null; this.children = this.children.filter((x) => x !== c); }
    }
    class MockPerspectiveCamera extends MockObj {
      isPerspectiveCamera = true;
      fov: number; aspect: number; near: number; far: number; zoom = 1;
      projUpdates = 0;
      constructor(fov: number, aspect: number, near: number, far: number) {
        super();
        this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
      }
      updateProjectionMatrix() { this.projUpdates++; }
    }
    class MockInstancedMesh extends MockObj {
      isInstancedMesh = true;
      geometry: MockGeo;
      material: MockMaterial;
      count: number;
      instanceMatrix: MockAttr;
      instanceColor: MockAttr | null = null;
      constructor(geo: MockGeo, mat: MockMaterial, cap: number) {
        super();
        this.geometry = geo; this.material = mat; this.count = cap;
        this.instanceMatrix = new MockAttr(new Float32Array(cap * 16), 16);
      }
      computeBoundingSphere() {}
    }
    const mockThree = {
      Vector3: MockVec3,
      Sphere: MockSphere,
      Color: MockColor,
      BufferAttribute: MockAttr,
      InstancedBufferAttribute: MockAttr,
      BufferGeometry: MockGeo,
      InstancedBufferGeometry: MockInstancedGeo,
      MeshStandardMaterial: MockMaterial,
      MeshBasicMaterial: MockMaterial,
      Object3D: MockObj,
      Scene: class extends MockObj { isScene = true; background: unknown = null; fog: unknown = null; },
      Group: class extends MockObj {},
      Mesh: class extends MockObj { geometry: MockGeo; material: MockMaterial; constructor(g: MockGeo, m: MockMaterial) { super(); this.geometry = g; this.material = m; } },
      InstancedMesh: MockInstancedMesh,
      PerspectiveCamera: MockPerspectiveCamera,
    };

    const host = new ThreeWorkerHost();
    (host as unknown as { THREE: unknown }).THREE = mockThree;
    const entry = {
      rendererId: 1,
      canvasId: 42,
      canvas: { width: 800, height: 600 },
      renderer: {
        render: () => {},
        setPixelRatio: () => {},
        setSize: () => {},
        setClearColor: () => {},
        shadowMap: { enabled: false, type: 1 },
        dispose: () => {},
        getContext: () => ({}),
      },
      objects: new Map<number, unknown>(),
      geometries: new Map<number, unknown>(),
      materials: new Map<number, unknown>(),
      textures: new Map<number, unknown>(),
      dirty: false,
    };
    (host as unknown as { renderers: Map<number, unknown> }).renderers.set(1, entry);
    return { host, entry };
  }

  it('clamps extreme perspective near/far ratios, rejects NaN transforms, preserves LineGeometry bs, and sets material needsUpdate', () => {
    const { host, entry } = makeMockThreeHost();

    // 1. Extreme far/near ratio (12000 / 0.1 = 120,000:1) is safely clamped to far / 4000 = 3.0
    host.frame(1, [
      ['obj', 10, 'PerspectiveCamera', { fov: 50, aspect: 1.5, near: 0.1, far: 12000 }],
      // Normal ratio (1000 / 0.1 = 10,000:1) stays untouched at 0.1
      ['obj', 11, 'PerspectiveCamera', { fov: 50, aspect: 1.5, near: 0.1, far: 1000 }],
    ], '');
    const camExtreme = entry.objects.get(10) as { near: number; far: number };
    const camNormal = entry.objects.get(11) as { near: number; far: number };
    expect(camExtreme.near).toBeCloseTo(3.0, 5);
    expect(camNormal.near).toBeCloseTo(0.1, 5);

    // 2. Finite transforms apply cleanly; NaN transforms are rejected without corrupting camera position
    const valid = new Float32Array([10, 20, 30, 0, 0, 0, 1, 1, 1, 1]);
    const validB64 = Buffer.from(valid.buffer).toString('base64');
    host.frame(1, [['xf', 10, 0, 0, 1]], validB64);
    const camPos = (entry.objects.get(10) as { position: { x: number; y: number; z: number } }).position;
    expect([camPos.x, camPos.y, camPos.z]).toEqual([10, 20, 30]);

    const nanXf = new Float32Array([NaN, NaN, NaN, NaN, NaN, NaN, NaN, 1, 1, 1]);
    const nanB64 = Buffer.from(nanXf.buffer).toString('base64');
    host.frame(1, [['xf', 10, 0, 0, 1]], nanB64);
    expect([camPos.x, camPos.y, camPos.z]).toEqual([10, 20, 30]);

    // 3. InstancedBufferGeometry (e.g. LineGeometry) preserves explicit guest bs and falls back to Infinity (never origin r=1)
    host.frame(1, [
      ['geo', 1, { instanced: true, bs: [500, -10, 400, 250] }],
      ['geo', 2, { instanced: true }],
    ], '');
    const g1 = entry.geometries.get(1) as { boundingSphere: { center: { x: number; y: number; z: number }; radius: number } };
    const g2 = entry.geometries.get(2) as { boundingSphere: { radius: number } };
    expect(g1.boundingSphere.center).toEqual({ x: 500, y: -10, z: 400 });
    expect(g1.boundingSphere.radius).toBe(250);
    expect(g2.boundingSphere.radius).toBe(Infinity);

    // 4. Updating shader-affecting props on an existing material triggers mat.needsUpdate = true
    host.frame(1, [['mat', 1, { type: 'MeshBasicMaterial', transparent: false, side: 0 }]], '');
    const mat1 = entry.materials.get(1) as { transparent: boolean; needsUpdate: boolean };
    mat1.needsUpdate = false;
    host.frame(1, [['mat', 1, { type: 'MeshBasicMaterial', transparent: true, side: 2 }]], '');
    expect(mat1.transparent).toBe(true);
    expect(mat1.needsUpdate).toBe(true);

    // 5. Creating instanceColor on InstancedMesh marks its material needsUpdate = true
    mat1.needsUpdate = false;
    const colF32 = new Float32Array([0, 1, 0.5]);
    const colB64 = Buffer.from(colF32.buffer).toString('base64');
    host.frame(1, [
      ['obj', 20, 'InstancedMesh', { geo: 1, mat: 1, cap: 1, count: 1 }],
      ['im', 20, 1, '', colB64],
    ], '');
    expect(mat1.needsUpdate).toBe(true);
  });
});

describe('Rust VFS binary File::write_all overlay round-trip', () => {
  it('preserves arbitrary non-UTF8 binary bytes bit-for-bit across exportRustOverlayJson', async () => {
    const bindings = await loadZippEngine({ tier: 'rust', explicitSource: RUST_WASM });
    const engine = new bindings.Engine();
    engine.setSyncHostCapabilities([]);
    engine.setInstructionBudget(5_000_000);

    const files = {
      'Cargo.toml': '[package]\nname = "binsecret"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/main.rs': `
use std::io::Write;
fn main() {
    let raw: Vec<u8> = vec![0x00, 0x7f, 0x80, 0xfe, 0xff, 0xc3, 0x28, 0xa0, 0xa1, 0x99];
    let mut f = std::fs::OpenOptions::new().create(true).write(true).open("data/.secret").unwrap();
    f.write_all(&raw).unwrap();
    let back = std::fs::read("data/.secret").unwrap();
    assert_eq!(back, raw);
}
`,
    };
    engine.initRustProject!(files, 'src/main.rs', { writableVfs: true });
    const overlayJson = engine.exportRustOverlayJson!();
    const overlay = JSON.parse(overlayJson) as { writes: Record<string, string>; deleted: string[] };
    const b64 = overlay.writes['data/.secret'];
    expect(typeof b64).toBe('string');
    const decoded = Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    expect(decoded).toEqual([0x00, 0x7f, 0x80, 0xfe, 0xff, 0xc3, 0x28, 0xa0, 0xa1, 0x99]);
  });
});
