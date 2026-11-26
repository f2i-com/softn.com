/**
 * ThreeWorkerHost, the Worker's side of the native Three.js path, driven by the scene ops the
 * guest's renderer sends, against a small mock of Three.js (this test's page has none); and
 * the guest's renderer itself (GUEST_THREE_NATIVE_SOURCE, run in a context of its own) with it.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { ThreeWorkerHost } from '../src/three-worker-host';
import { GUEST_THREE_NATIVE_SOURCE } from '../src/guest-three-native';

const b64 = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

function mockThree() {
  class Vec2 { x = 0; y = 0; set(x: number, y: number) { this.x = x; this.y = y; return this; } }
  class Vec3 { x: number; y: number; z: number; constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; } normalize() { return this; } }
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
  class Attr { array: unknown; itemSize: number; constructor(array: unknown, itemSize: number) { this.array = array; this.itemSize = itemSize; } }
  class Geo {
    attributes: Record<string, unknown> = {}; index: unknown = null; boundingSphere: Sphere | null = null; disposed = false;
    setAttribute(n: string, a: unknown) { this.attributes[n] = a; } getAttribute(n: string) { return this.attributes[n]; }
    setIndex(i: unknown) { this.index = i; } setDrawRange() {} clearGroups() {} addGroup() {}
    computeBoundingSphere() { this.boundingSphere = new Sphere(new Vec3(), 1); } dispose() { this.disposed = true; }
  }
  class Material {
    color = new Color(); map: unknown = null; alphaMap: unknown = null; emissiveMap: unknown = null; opacity = 1; transparent = false; side = 0;
    vertexColors = false; wireframe = false; depthWrite = true; depthTest = true; toneMapped = true; blending = 1; fog = true; visible = true; needsUpdate = false;
    dispose() {}
  }
  class ShaderMaterial extends Material {
    isShaderMaterial = true; uniforms: Record<string, { value: unknown }> = {}; vertexShader = ''; fragmentShader = ''; defines: Record<string, unknown> = {}; extensions: Record<string, unknown> = {};
  }
  class Texture {
    isTexture = true; image: unknown; version = 0; colorSpace = ''; wrapS = 0; wrapT = 0; repeat = new Vec2(); offset = new Vec2();
    minFilter = 0; magFilter = 0; generateMipmaps = true; flipY = true; anisotropy = 1; disposed = 0;
    constructor(image: unknown = null) { this.image = image; }
    set needsUpdate(value: boolean) { if (value) this.version++; }
    dispose() { this.disposed++; }
  }
  class CanvasTexture extends Texture {}
  class DataTexture extends Texture {
    isDataTexture = true; format: unknown; type: unknown;
    constructor(data: unknown, width: number, height: number, format: unknown, type: unknown) { super({ data, width, height }); this.format = format; this.type = type; }
  }
  class Raycaster {
    static hits: unknown[] = [];
    ray = { origin: new Vec3(), direction: new Vec3() };
    near = 0; far = Infinity; camera: unknown = null;
    intersectObjects() { return Raycaster.hits; }
  }
  class PerspectiveCamera extends Obj3D {
    isCamera = true; isPerspectiveCamera = true; fov: number; aspect: number; near: number; far: number; zoom = 1;
    constructor(fov: number, aspect: number, near: number, far: number) { super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; }
    updateProjectionMatrix() {}
  }
  class WebGLRenderer {
    static drawn: Array<{ children: number }> = [];
    capabilities = { isWebGL2: true, maxTextureSize: 4096, getMaxAnisotropy: () => 16, maxVertexUniforms: 1024, precision: 'highp' };
    shadowMap = { enabled: false, type: 1 };
    setSize() {} setPixelRatio() {} setClearColor() {}
    render(scene: Obj3D) { WebGLRenderer.drawn.push({ children: scene.children.length }); }
    dispose() {}
    getContext() { return { getContextAttributes: () => ({}) }; }
  }
  return {
    Vector2: Vec2, Vector3: Vec3, Color, Sphere, Object3D: Obj3D, Scene, Group, Mesh, PerspectiveCamera, WebGLRenderer,
    BufferGeometry: Geo, InstancedBufferGeometry: Geo, BufferAttribute: Attr, InstancedBufferAttribute: Attr,
    MeshBasicMaterial: Material, MeshStandardMaterial: Material, ShaderMaterial, Texture, CanvasTexture, DataTexture, Raycaster,
    RGBAFormat: 1023, UnsignedByteType: 1009,
  };
}

/**
 * The guest's native renderer (GUEST_THREE_NATIVE_SOURCE) in a context of its own, as the
 * engine runs it, its host calls answered by a real ThreeWorkerHost drawing with the mock.
 */
function guestWithHost() {
  const THREE = mockThree();
  const host = new ThreeWorkerHost();
  (host as unknown as { THREE: unknown }).THREE = THREE;
  /** The ops of each frame the guest sent. */
  const frames: unknown[][][] = [];
  const bridge = {
    callSync(kind: string, sub: string, ...args: string[]) {
      if (kind !== 'three') return null;
      if (sub === 'init') return host.init(Number(args[0]), Number(args[1]), Number(args[2]), JSON.parse(args[3] || '{}'));
      if (sub === 'frame') {
        const ops = JSON.parse(args[1] || '[]') as unknown[][];
        frames.push(ops);
        return host.frame(Number(args[0]), ops, args[2] || '');
      }
      if (sub === 'dispose') { host.disposeRenderer(Number(args[0])); return true; }
      return null;
    },
  };
  const scope = globalThis as { OffscreenCanvas?: unknown };
  const had = scope.OffscreenCanvas;
  scope.OffscreenCanvas = class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } };
  const guest = vm.createContext({ host: bridge, console, btoa: (s: string) => globalThis.btoa(s) });
  vm.runInContext(GUEST_THREE_NATIVE_SOURCE, guest);
  /** Plain objects shaped as Three.js's own, made in the guest's context. */
  vm.runInContext(`
    var object3d = function (extra) {
      var o = { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, matrixAutoUpdate: true, visible: true,
        castShadow: false, receiveShadow: false, frustumCulled: true, renderOrder: 0, layers: { mask: 1 }, children: [] };
      for (var k in extra) o[k] = extra[k];
      return o;
    };
  `, guest);
  const restore = () => { scope.OffscreenCanvas = had; };
  return { host, THREE, frames, guest: guest as unknown as Record<string, unknown>, restore };
}

/** A host with one renderer (id 1) whose renderer only counts what it is asked to draw. */
function hostWithRenderer() {
  const THREE = mockThree();
  const host = new ThreeWorkerHost();
  (host as unknown as { THREE: unknown }).THREE = THREE;
  const entry = {
    rendererId: 1,
    canvasId: 42,
    canvas: { width: 8, height: 8 },
    renderer: { render: () => {}, setPixelRatio: () => {}, setSize: () => {}, setClearColor: () => {}, shadowMap: { enabled: false, type: 1 }, dispose: () => {}, getContext: () => ({}) },
    objects: new Map<number, unknown>(),
    geometries: new Map<number, unknown>(),
    materials: new Map<number, Record<string, unknown>>(),
    textures: new Map<number, Record<string, unknown>>(),
    resourceBytes: new Map<string, number>(),
    allocatedBytes: 0,
    dirty: false,
  };
  (host as unknown as { renderers: Map<number, unknown> }).renderers.set(1, entry);
  return { host, entry, THREE };
}

describe('ThreeWorkerHost textures', () => {
  it('binds a material to a texture whose picture was not decoded yet when both were first sent', () => {
    // TextureLoader hands the app a texture at once and its picture later: the first frame
    // sent the texture before the Worker had its picture, and the material with it. No texture
    // was made then, the material's map was null, and when the picture came the texture was
    // made but the material, unchanged in the app, was never sent again: never textured.
    const { host, entry } = hostWithRenderer();
    let bitmap: unknown = null;
    const resolvers = { getImageBitmap: () => bitmap as ImageBitmap | null };
    host.frame(1, [
      ['tex', 1, { kind: 'img', ref: 'cors:tex.png' }],
      ['mat', 1, { type: 'MeshBasicMaterial', map: 1 }],
    ], '', resolvers);
    bitmap = { width: 2, height: 2, close() {} };
    host.frame(1, [['tex', 1, { kind: 'img', ref: 'cors:tex.png' }]], '', resolvers);
    const map = entry.materials.get(1)?.map as { image: unknown; version: number } | null;
    expect(map?.image).toBe(bitmap);
    // Uploaded once it has its picture.
    expect(map?.version).toBeGreaterThan(0);
  });

  it('updates a DataTexture in place, so the materials and the background drawn with it show the new data', () => {
    // Each update made a new DataTexture under the same id, and the material (and a scene's
    // background) kept the first one, disposed: what the app wrote into its texture after the
    // first frame was never seen.
    const { host, entry } = hostWithRenderer();
    host.frame(1, [
      ['tex', 1, { kind: 'data', w: 1, h: 1, tc: 'u8', b64: b64([1, 2, 3, 4]) }],
      ['mat', 1, { type: 'MeshBasicMaterial', map: 1 }],
      ['obj', 5, 'Scene', {}],
      ['scene', 5, { bg: { t: 'tex', v: 1 } }],
    ], '');
    host.frame(1, [['tex', 1, { kind: 'data', w: 1, h: 1, tc: 'u8', b64: b64([9, 8, 7, 6]) }]], '');
    const shown = entry.materials.get(1)?.map as { image: { data: Uint8Array } };
    expect([...shown.image.data]).toEqual([9, 8, 7, 6]);
    expect((entry.objects.get(5) as { background: unknown }).background).toBe(shown);
    expect(entry.textures.get(1)).toBe(shown);
    // A new size: the same texture, its storage made again at the new size.
    host.frame(1, [['tex', 1, { kind: 'data', w: 2, h: 1, tc: 'u8', b64: b64([1, 1, 1, 1, 2, 2, 2, 2]) }]], '');
    const resized = entry.materials.get(1)?.map as { image: { data: Uint8Array; width: number; height: number }; disposed: number };
    expect(resized).toBe(shown);
    expect([resized.image.width, resized.image.height, [...resized.image.data]]).toEqual([2, 1, [1, 1, 1, 1, 2, 2, 2, 2]]);
    expect(resized.disposed).toBe(1);
    expect(entry.resourceBytes.get('tex:1')).toBe(8);
  });
});

describe('ThreeWorkerHost raycasting', () => {
  it('reports a hit on a model loaded with loadGLTF as a hit on the object the app holds', () => {
    // The meshes of a loaded model are the Worker's own, not the app's, and carry no id of
    // the app's: every hit on a model was dropped, and a model could never be picked.
    const { host, entry, THREE } = hostWithRenderer();
    host.frame(1, [['obj', 7, 'Group', {}]], '');
    const holder = entry.objects.get(7) as InstanceType<typeof THREE.Group>;
    const inner = new THREE.Mesh(null, null);
    const node = new THREE.Group();
    node.add(inner);
    holder.add(node);
    THREE.Raycaster.hits = [{ object: inner, distance: 3, point: new THREE.Vector3(1, 2, 3), faceIndex: 4 }];
    const hits = host.raycast(1, [0, 0, 5], [0, 0, -1], 0, Infinity, [7], true);
    expect(hits).toEqual([{ id: 7, d: 3, p: [1, 2, 3], fi: 4 }]);
  });
});

describe('the objects a native renderer keeps', () => {
  it('lets go of objects the app no longer draws, so a game that keeps making them still shows the new ones', () => {
    // Every object the app ever drew was kept by the guest's renderer (by id, for raycasting)
    // and by the Worker, though nothing drew it again: a game making a bullet, a particle or an
    // enemy at a time as a new Mesh had its 65,537th refused by the Worker, and after that the
    // new ones were never drawn (and the guest held all of them, and what they held).
    const { host, THREE, guest, restore } = guestWithHost();
    try {
      const { r, scene, cam } = vm.runInContext(`
        var r = __softnTryNativeWebGLRenderer({ canvas: { __softnNode: 9, width: 8, height: 8, style: {} } });
        var geo = { attributes: {}, drawRange: { start: 0, count: Infinity }, groups: [], index: null };
        var mat = { isMeshBasicMaterial: true, color: { r: 1, g: 1, b: 1 }, version: 0, opacity: 1, side: 0, blending: 1, visible: true };
        var scene = object3d({ isScene: true, background: null, fog: null });
        var cam = object3d({ isPerspectiveCamera: true, fov: 50, aspect: 1, near: 0.1, far: 100, zoom: 1 });
        ({ r: r, scene: scene, cam: cam });
      `, guest) as { r: Record<string, unknown> & { render: (s: unknown, c: unknown) => void }; scene: { children: unknown[] }; cam: unknown };
      expect(r && r._rid).toBeTruthy();
      const spawn = vm.runInContext('(function () { return object3d({ isMesh: true, geometry: geo, material: mat }); })', guest) as () => unknown;
      const drawn = (THREE.WebGLRenderer as unknown as { drawn: Array<{ children: number }> }).drawn;
      for (let i = 0; i < 66_000; i++) {
        // One bullet at a time: the last one gone, a new one in the scene.
        scene.children = [spawn()];
        r.render(scene, cam);
      }
      // The newest is drawn.
      expect(drawn[drawn.length - 1]).toEqual({ children: 1 });
      const entry = (host as unknown as { renderers: Map<number, { objects: Map<number, unknown> }> }).renderers.get(Number(r._rid))!;
      expect(entry.objects.size).toBeLessThan(1000);
      expect(Object.keys(r._objById as object).length).toBeLessThan(1000);
    } finally {
      restore();
    }
  });
});

describe('the objects a native renderer lets go of', () => {
  it('sends again an object the app puts back, and keeps the objects of every scene it still draws', () => {
    const { host, THREE, guest, restore } = guestWithHost();
    try {
      const made = vm.runInContext(`
        var r = __softnTryNativeWebGLRenderer({ canvas: { __softnNode: 9, width: 8, height: 8, style: {} } });
        var geo = { attributes: {}, drawRange: { start: 0, count: Infinity }, groups: [], index: null };
        var mat = { isMeshBasicMaterial: true, color: { r: 1, g: 1, b: 1 }, version: 0, opacity: 1, side: 0, blending: 1, visible: true };
        var a = object3d({ isMesh: true, geometry: geo, material: mat });
        var b = object3d({ isMesh: true, geometry: geo, material: mat });
        var main = object3d({ isScene: true, background: null, fog: null, children: [a] });
        var overlay = object3d({ isScene: true, background: null, fog: null, children: [b] });
        var cam = object3d({ isPerspectiveCamera: true, fov: 50, aspect: 1, near: 0.1, far: 100, zoom: 1 });
        ({ r: r, a: a, b: b, main: main, overlay: overlay, cam: cam });
      `, guest) as Record<string, { children: unknown[]; _snThreeId?: number } & Record<string, unknown>> & { r: { render: (s: unknown, c: unknown) => void; _rid: number; _objById: Record<string, unknown> } };
      const { r, a, b, main, overlay, cam } = made;
      const drawn = (THREE.WebGLRenderer as unknown as { drawn: Array<{ children: number }> }).drawn;
      const entry = (host as unknown as { renderers: Map<number, { objects: Map<number, { children: unknown[] }> }> }).renderers.get(Number(r._rid))!;
      // Two scenes drawn in turn, as an app draws a scene and an overlay: neither is let go of.
      for (let i = 0; i < 600; i++) r.render(i % 2 ? overlay : main, cam);
      const mainOnHost = entry.objects.get(Number(main._snThreeId));
      const overlayOnHost = entry.objects.get(Number(overlay._snThreeId));
      expect(mainOnHost?.children.length).toBe(1);
      expect(overlayOnHost?.children.length).toBe(1);
      expect(entry.objects.get(Number(a._snThreeId))).toBe(mainOnHost?.children[0]);
      expect(entry.objects.get(Number(b._snThreeId))).toBe(overlayOnHost?.children[0]);
      // Taken out of the scene for long enough, let go of by both sides...
      main.children = [];
      for (let i = 0; i < 400; i++) r.render(main, cam);
      expect(a._snThreeId).toBeFalsy();
      expect(Object.values(r._objById)).not.toContain(a);
      // ...and drawn again when it is put back.
      main.children = [a];
      r.render(main, cam);
      expect(drawn[drawn.length - 1]).toEqual({ children: 1 });
      const again = entry.objects.get(Number(a._snThreeId));
      expect(again).toBeDefined();
      expect(entry.objects.get(Number(main._snThreeId))?.children[0]).toBe(again);
      expect(r._objById[String(a._snThreeId)]).toBe(a);
    } finally {
      restore();
    }
  });
});

describe('what ThreeWorkerHost counts of a geometry', () => {
  it('lets go of exactly the deleted geometry’s parts, whatever else is counted', () => {
    const { host, entry } = hostWithRenderer();
    const f = b64(new Uint8Array(new Float32Array([0, 0, 0, 1, 1, 1]).buffer));
    const index = b64(new Uint8Array(new Uint16Array([0, 1, 1, 0]).buffer));
    host.frame(1, [
      ['geo', 1, { attrs: { position: { tc: 'f32', b64: f, s: 3 }, uv: { tc: 'f32', b64: f, s: 2 } }, index: { tc: 'u16', b64: index } }],
      ['geo', 12, { attrs: { position: { tc: 'f32', b64: f, s: 3 } } }],
      ['tex', 1, { kind: 'data', w: 1, h: 1, tc: 'u8', b64: b64([1, 2, 3, 4]) }],
    ], '');
    expect(entry.allocatedBytes).toBe(24 + 24 + 8 + 24 + 4);
    // Geometry 1 (its id a prefix of geometry 12's): its parts only.
    host.frame(1, [['del', 'geo', 1]], '');
    expect([...entry.resourceBytes.keys()].sort()).toEqual(['geo:12:attr:position', 'tex:1']);
    expect(entry.allocatedBytes).toBe(24 + 4);
    // Its index taken away before: not counted twice.
    host.frame(1, [['geo', 12, { index: null }], ['del', 'geo', 12]], '');
    expect([...entry.resourceBytes.keys()]).toEqual(['tex:1']);
    expect(entry.allocatedBytes).toBe(4);
  });
});

describe('a material or geometry many meshes share', () => {
  it('is sent once a render, and again when it changes', () => {
    const { host, frames, guest, restore } = guestWithHost();
    try {
      const made = vm.runInContext(`
        var r = __softnTryNativeWebGLRenderer({ canvas: { __softnNode: 9, width: 8, height: 8, style: {} } });
        var geo = { attributes: {}, drawRange: { start: 0, count: Infinity }, groups: [], index: null };
        var mat = { isMeshBasicMaterial: true, color: { r: 1, g: 1, b: 1 }, version: 0, opacity: 1, side: 0, blending: 1, visible: true };
        var shader = { isShaderMaterial: true, version: 0, opacity: 1, side: 0, blending: 1, visible: true, vertexShader: 'v', fragmentShader: 'f', uniforms: { t: { value: 0 } } };
        var kids = [];
        for (var i = 0; i < 50; i++) kids.push(object3d({ isMesh: true, geometry: geo, material: i % 2 ? mat : shader }));
        var scene = object3d({ isScene: true, background: null, fog: null, children: kids });
        var cam = object3d({ isPerspectiveCamera: true, fov: 50, aspect: 1, near: 0.1, far: 100, zoom: 1 });
        ({ r: r, mat: mat, shader: shader, geo: geo, scene: scene, cam: cam });
      `, guest) as Record<string, Record<string, unknown>> & { r: { render: (s: unknown, c: unknown) => void; _rid: number } };
      const { r, mat, shader, scene, cam } = made;
      const count = (ops: unknown[][], code: string) => ops.filter((op) => op[0] === code).length;
      r.render(scene, cam);
      expect([count(frames[0], 'mat'), count(frames[0], 'geo'), count(frames[0], 'obj')]).toEqual([2, 1, 52]);
      r.render(scene, cam);
      expect([count(frames[1], 'mat'), count(frames[1], 'mu'), count(frames[1], 'geo')]).toEqual([0, 0, 0]);
      // Changed between renders: sent, once.
      (mat.color as { r: number }).r = 0.25;
      (shader.uniforms as { t: { value: number } }).t.value = 2;
      r.render(scene, cam);
      expect([count(frames[2], 'mat'), count(frames[2], 'mu')]).toEqual([1, 1]);
      const entry = (host as unknown as { renderers: Map<number, { materials: Map<number, { color: { r: number }; uniforms?: Record<string, { value: unknown }> }> }> }).renderers.get(Number(r._rid))!;
      const colors = [...entry.materials.values()].map((m) => m.color?.r);
      expect(colors).toContain(0.25);
      expect([...entry.materials.values()].some((m) => m.uniforms?.t?.value === 2)).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('the children of a model loaded with loadGLTF', () => {
  it('keeps the model’s own meshes when the app adds to it, takes away from it, or orders what it added', () => {
    // The app's list of a group's children was made the group's whole list on the Worker:
    // the meshes of a model the Worker loaded into its group are none of the app's, and an app
    // that added a label (or anything) to a loaded model saw the model vanish.
    const { host, entry, THREE } = hostWithRenderer();
    host.frame(1, [['obj', 7, 'Group', {}], ['obj', 8, 'Group', {}], ['obj', 9, 'Group', {}]], '');
    const holder = entry.objects.get(7) as InstanceType<typeof THREE.Group>;
    // What loadGltfIntoHolder adds when the model has loaded.
    const model = new THREE.Group();
    holder.add(model);
    const label = entry.objects.get(8);
    const marker = entry.objects.get(9);
    host.frame(1, [['ch', 7, [8, 9]]], '');
    expect(holder.children).toEqual([model, label, marker]);
    host.frame(1, [['ch', 7, [9, 8]]], '');
    expect(holder.children).toEqual([model, marker, label]);
    host.frame(1, [['ch', 7, [9]]], '');
    expect(holder.children).toEqual([model, marker]);
    expect((label as { parent: unknown }).parent).toBeNull();
    // A group of the app's own is the app's list exactly, as before.
    host.frame(1, [['ch', 8, [9]]], '');
    expect((label as { children: unknown[] }).children).toEqual([marker]);
  });
});

describe('a geometry or texture the app disposes and goes on drawing', () => {
  it('is sent again as new, so what the app changes after is drawn', () => {
    // three.js lets an app dispose a geometry or a texture and use it again (it is uploaded
    // again): how a DataTexture is given a new size. The Worker let go of it under its id and
    // the next change made a new one under the same id, which the mesh and the material did not
    // draw with: everything the app changed after the first frame was lost.
    const { host, guest, restore } = guestWithHost();
    try {
      const made = vm.runInContext(`
        var r = __softnTryNativeWebGLRenderer({ canvas: { __softnNode: 9, width: 8, height: 8, style: {} } });
        function disposable(o) {
          var listeners = [];
          o.addEventListener = function (type, fn) { if (type === 'dispose') listeners.push(fn); };
          o.dispose = function () { for (var i = 0; i < listeners.length; i++) listeners[i]({ type: 'dispose', target: o }); };
          return o;
        }
        function attr(values) { return { array: new Float32Array(values), itemSize: 3, count: values.length / 3, version: 0 }; }
        var geo = disposable({ attributes: { position: attr([0, 0, 0]) }, drawRange: { start: 0, count: Infinity }, groups: [], index: null });
        var tex = disposable({ isTexture: true, isDataTexture: true, image: { data: new Uint8Array([1, 1, 1, 1]), width: 1, height: 1 }, version: 1, format: 1023, type: 1009,
          colorSpace: '', wrapS: 1001, wrapT: 1001, repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 }, minFilter: 1006, magFilter: 1006, generateMipmaps: false, flipY: false, anisotropy: 1 });
        var mat = { isMeshBasicMaterial: true, map: tex, color: { r: 1, g: 1, b: 1 }, version: 0, opacity: 1, side: 0, blending: 1, visible: true };
        var mesh = object3d({ isMesh: true, geometry: geo, material: mat });
        var scene = object3d({ isScene: true, background: null, fog: null, children: [mesh] });
        var cam = object3d({ isPerspectiveCamera: true, fov: 50, aspect: 1, near: 0.1, far: 100, zoom: 1 });
        var step = function (n) {
          // Disposed, and given new data (a new size), as three.js has an app do it.
          geo.dispose();
          geo.attributes.position = attr(new Array(3 * (n + 1)).fill(n));
          tex.dispose();
          tex.image = { data: new Uint8Array(4 * (n + 1)).fill(n), width: n + 1, height: 1 };
          tex.version++;
        };
        ({ r: r, mesh: mesh, scene: scene, cam: cam, step: step });
      `, guest) as { r: { render: (s: unknown, c: unknown) => void; _rid: number }; mesh: { _snThreeId: number }; scene: unknown; cam: unknown; step: (n: number) => void };
      const { r, mesh, scene, cam, step } = made;
      const entry = (host as unknown as { renderers: Map<number, { objects: Map<number, { geometry: { attributes: Record<string, { array: Float32Array }> }; material: { map: { image: { data: Uint8Array; width: number } } } }> }> }).renderers.get(Number(r._rid))!;
      r.render(scene, cam);
      for (let n = 1; n <= 3; n++) {
        step(n);
        r.render(scene, cam);
        const drawn = entry.objects.get(Number(mesh._snThreeId))!;
        expect([...drawn.geometry.attributes.position.array]).toEqual(new Array(3 * (n + 1)).fill(n));
        expect([drawn.material.map.image.width, ...drawn.material.map.image.data]).toEqual([n + 1, ...new Array(4 * (n + 1)).fill(n)]);
      }
    } finally {
      restore();
    }
  });
});
