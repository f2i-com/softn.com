/**
 * Host-Side Split-Realm WebGL2 3D Scene Renderer.
 *
 * When a sandboxed app runs `import * as THREE from 'three'`, the Worker loads
 * a ~4 KB guest scene-graph proxy that batches compact `ThreeSceneOp` tuples
 * per animation frame. On the host, this module lazily imports the externally
 * hosted Three.js engine (`/runtime/vendor/three.js` or dynamic `three`) ONLY
 * when an app actually renders a 3D scene — keeping startup JS at 0 KB of 3D code.
 */

import type { ContainerArchive } from '../archive';
import type { ThreeSceneOp } from '../types';

interface HostedSceneState {
  renderer: import('three').WebGLRenderer;
  objects: Map<number, import('three').Object3D>;
}

/** The most segments one side of a shape is built with. */
const MAX_SEGMENTS = 256;

const MAX_DRAWING_SIDE = 8192;
const MAX_SCENES = 8;
const MAX_SCENE_OBJECTS = 4096;
const MAX_PENDING_OPS_PER_CANVAS = 4096;

/** A drawing surface's side in pixels: at least one, and no more than a page can hold. */
const clampDrawingSize = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(MAX_DRAWING_SIDE, Math.floor(value))) : 1;

let threeModulePromise: Promise<typeof import('three')> | null = null;

/**
 * Three.js for the page's side of a 3D scene, loaded once.
 *
 * The host's own when it has one (`hostThree`): an app that bundles Three.js draws its own
 * 3D with it, so a second copy from the runtime folder was 680 KB of the same library, and
 * the two were mixed: the model loader below is compiled against the bundled one, and the
 * scene it made was added to a scene of the folder's. Otherwise the copy in the runtime
 * folder, which is what a page with no Three.js of its own has.
 */
function loadHostThree(runtimeUrl?: string, hostThree?: () => Promise<unknown>): Promise<typeof import('three')> {
  if (!threeModulePromise) {
    const base = (runtimeUrl ?? '/runtime/').replace(/\/?$/, '/');
    const fromFolder = (): Promise<typeof import('three')> =>
      (import(/* @vite-ignore */ `${base}vendor/three.js`) as Promise<typeof import('three')>).catch(() => import('three'));
    threeModulePromise = hostThree ? (hostThree() as Promise<typeof import('three')>).catch(fromFolder) : fromFolder();
    // A load that failed is tried again by the next scene, not remembered.
    threeModulePromise.catch(() => {
      threeModulePromise = null;
    });
  }
  return threeModulePromise;
}

export class SplitRealmSceneHost {
  private readonly scenes = new Map<number, HostedSceneState>();
  private readonly pendingQueues = new Map<number, { canvas: HTMLCanvasElement; ops: ThreeSceneOp[] }>();
  private readonly archive: ContainerArchive;
  private readonly runtimeUrl?: string;
  private readonly hostThree?: () => Promise<unknown>;
  private loading = false;
  private disposed = false;
  private inflightGltf = 0;
  /** Three.js could not be loaded for this mount; a later mount asks again. */
  private unavailable = false;

  constructor(archive: ContainerArchive, runtimeUrl?: string, hostThree?: () => Promise<unknown>) {
    this.archive = archive;
    this.runtimeUrl = runtimeUrl;
    this.hostThree = hostThree;
  }

  enqueue(canvas: HTMLCanvasElement, canvasId: number, ops: ThreeSceneOp[]): void {
    if (this.disposed || this.unavailable) return;
    let q = this.pendingQueues.get(canvasId);
    if (!q) {
      // Each canvas counted once: one with a scene and a frame waiting was counted twice, and
      // while four scenes drew, a fifth's first frame (the one that makes it) was dropped.
      let waitingNew = 0;
      for (const id of this.pendingQueues.keys()) if (!this.scenes.has(id)) waitingNew++;
      if (!this.scenes.has(canvasId) && this.scenes.size + waitingNew >= MAX_SCENES) return;
      q = { canvas, ops: [] };
      this.pendingQueues.set(canvasId, q);
    }
    const room = MAX_PENDING_OPS_PER_CANVAS - q.ops.length;
    if (room > 0) {
      q.ops.push(...(ops.length > room ? ops.slice(0, room) : ops));
    }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      let THREE: typeof import('three');
      try {
        THREE = await loadHostThree(this.runtimeUrl, this.hostThree);
      } catch (err) {
        // Three.js did not arrive (offline, a file missing): this mount draws no 3D. What
        // was queued is dropped and nothing more is taken. The queue used to be kept and
        // the load asked for again at once, which failed again at once, without end and
        // without the page's thread ever being given back: the embedding page stopped.
        this.unavailable = true;
        this.pendingQueues.clear();
        console.warn('[SoftN] Hosted 3D scene renderer unavailable:', err);
        return;
      }
      if (this.disposed) return;

      for (const [canvasId, entry] of [...this.pendingQueues]) {
        const ops = entry.ops.splice(0, entry.ops.length);
        if (entry.ops.length === 0) this.pendingQueues.delete(canvasId);
        if (ops.length === 0) continue;
        this.applyCanvasOps(THREE, entry.canvas, canvasId, ops);
      }
    } catch (err) {
      // An operation the renderer refused: that batch is gone, the scene carries on.
      console.warn('[SoftN] A 3D scene operation failed:', err);
    } finally {
      this.loading = false;
      for (const entry of this.pendingQueues.values()) {
        if (entry.ops.length > 0 && !this.disposed) {
          void this.flush();
          break;
        }
      }
    }
  }

  private disposeMaterialResources(mat: unknown): void {
    if (!mat || typeof mat !== 'object') return;
    for (const val of Object.values(mat as Record<string, unknown>)) {
      if (val && typeof val === 'object' && (val as { isTexture?: boolean; dispose?: () => void }).isTexture) {
        try { (val as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
      }
    }
    try { (mat as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
  }

  private disposeObjectResources(obj: import('three').Object3D): void {
    obj.traverse((node) => {
      const m = node as {
        geometry?: { dispose?: () => void };
        material?: unknown | unknown[];
      };
      try { m.geometry?.dispose?.(); } catch { /* ignore */ }
      if (Array.isArray(m.material)) {
        for (const mat of m.material) {
          this.disposeMaterialResources(mat);
        }
      } else if (m.material) {
        this.disposeMaterialResources(m.material);
      }
    });
  }

  private isAncestor(candidate: import('three').Object3D, node: import('three').Object3D): boolean {
    let cur: import('three').Object3D | null = node;
    for (let depth = 0; cur && depth < MAX_SCENE_OBJECTS; depth++) {
      if (cur === candidate) return true;
      cur = cur.parent;
    }
    return false;
  }

  private disposeSceneState(state: HostedSceneState): void {
    for (const obj of state.objects.values()) {
      this.disposeObjectResources(obj);
    }
    state.objects.clear();
    try { state.renderer.dispose(); } catch { /* ignore */ }
    try { state.renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
  }

  private applyCanvasOps(
    THREE: typeof import('three'),
    canvas: HTMLCanvasElement,
    canvasId: number,
    ops: ThreeSceneOp[]
  ): void {
    let state = this.scenes.get(canvasId);
    const putObj = (s: HostedSceneState, id: number, obj: import('three').Object3D): boolean => {
      const existing = s.objects.get(id);
      if (existing === undefined && s.objects.size >= MAX_SCENE_OBJECTS) return false;
      if (existing && existing !== obj) {
        existing.parent?.remove(existing);
        this.disposeObjectResources(existing);
      }
      s.objects.set(id, obj);
      return true;
    };

    for (const op of ops) {
      if (!Array.isArray(op) || (op as readonly unknown[]).length === 0) continue;
      try {
      switch (op[0]) {
        case 'init': {
          if (!state) {
            if (this.scenes.size >= MAX_SCENES) return;
            if (typeof WebGLRenderingContext === 'undefined' && typeof WebGL2RenderingContext === 'undefined') {
              return;
            }
            const renderer = new THREE.WebGLRenderer({
              canvas,
              antialias: op[1].antialias !== false,
              alpha: Boolean(op[1].alpha),
            });
            if (op[1].clearColor !== undefined) {
              renderer.setClearColor(
                new THREE.Color(op[1].clearColor as number),
                op[1].clearAlpha ?? 1
              );
            }
            state = { renderer, objects: new Map() };
            this.scenes.set(canvasId, state);
          }
          break;
        }
        case 'clearColor': {
          if (state) {
            state.renderer.setClearColor(new THREE.Color(op[1] as number), op[2]);
          }
          break;
        }
        case 'lookAt': {
          const obj = state?.objects.get(op[1]);
          if (obj) {
            obj.lookAt(op[2][0], op[2][1], op[2][2]);
          }
          break;
        }
        case 'resize': {
          if (state) {
            const dpr = Math.max(0.5, Math.min(2, Number(op[3]) || 1));
            const maxCssSide = Math.floor(4096 / dpr);
            const w = Math.min(maxCssSide, clampDrawingSize(op[1]));
            const h = Math.min(maxCssSide, clampDrawingSize(op[2]));
            state.renderer.setPixelRatio(dpr);
            state.renderer.setSize(w, h, false);
          }
          break;
        }
        case 'group': {
          if (!state) break;
          const obj = op[1] === 1 ? new THREE.Scene() : new THREE.Group();
          putObj(state, op[1], obj);
          break;
        }
        case 'camera': {
          if (!state) break;
          const [, id, kind, p] = op;
          const cam =
            kind === 'orthographic'
              ? new THREE.OrthographicCamera(p[0], p[1], p[2], p[3], p[4] ?? 0.1, p[5] ?? 1000)
              : new THREE.PerspectiveCamera(p[0] ?? 60, p[1] ?? 1, p[2] ?? 0.1, p[3] ?? 1000);
          putObj(state, id, cam);
          break;
        }
        case 'mesh': {
          if (!state) break;
          if (!state.objects.has(op[1]) && state.objects.size >= MAX_SCENE_OBJECTS) break;
          const [, id, spec] = op;
          const [gKind, ...rawGp] = spec.geo;
          // The shape's numbers are the app's. A size is any finite number; a count of
          // segments is held to what a page can build without stopping (a sphere of a
          // million by a million segments was built here, on the embedding page's thread).
          const gp = rawGp.map((value, index) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
            const isCount = gKind === 'sphere' ? index >= 1 : gKind === 'plane' ? index >= 2 : gKind === 'cylinder' ? index >= 3 : gKind === 'torus' ? index >= 2 : false;
            return isCount ? Math.max(1, Math.min(MAX_SEGMENTS, Math.floor(value))) : value;
          });
          let geometry: import('three').BufferGeometry;
          switch (gKind) {
            case 'sphere':
              geometry = new THREE.SphereGeometry(gp[0] ?? 1, gp[1] ?? 24, gp[2] ?? 16);
              break;
            case 'plane':
              geometry = new THREE.PlaneGeometry(gp[0] ?? 1, gp[1] ?? 1, gp[2] ?? 1, gp[3] ?? 1);
              break;
            case 'cylinder':
              geometry = new THREE.CylinderGeometry(gp[0] ?? 1, gp[1] ?? 1, gp[2] ?? 1, gp[3] ?? 24);
              break;
            case 'torus':
              geometry = new THREE.TorusGeometry(gp[0] ?? 1, gp[1] ?? 0.4, gp[2] ?? 16, gp[3] ?? 32);
              break;
            default:
              geometry = new THREE.BoxGeometry(gp[0] ?? 1, gp[1] ?? 1, gp[2] ?? 1);
              break;
          }
          const mOpts = spec.mat;
          const color = mOpts.color !== undefined ? new THREE.Color(mOpts.color as number) : new THREE.Color(0x3b82f6);
          const material =
            mOpts.kind === 'basic'
              ? new THREE.MeshBasicMaterial({ color, wireframe: Boolean(mOpts.wireframe) })
              : new THREE.MeshStandardMaterial({
                  color,
                  roughness: typeof mOpts.roughness === 'number' ? mOpts.roughness : 0.45,
                  metalness: typeof mOpts.metalness === 'number' ? mOpts.metalness : 0.1,
                  wireframe: Boolean(mOpts.wireframe),
                });
          putObj(state, id, new THREE.Mesh(geometry, material));
          break;
        }
        case 'light': {
          if (!state) break;
          if (!state.objects.has(op[1]) && state.objects.size >= MAX_SCENE_OBJECTS) break;
          const [, id, lKind, cfg] = op;
          const color = cfg.color !== undefined ? new THREE.Color(cfg.color as number) : new THREE.Color(0xffffff);
          const intensity = cfg.intensity ?? 1;
          let light: import('three').Light;
          if (lKind === 'ambient') light = new THREE.AmbientLight(color, intensity);
          else if (lKind === 'point') light = new THREE.PointLight(color, intensity);
          else light = new THREE.DirectionalLight(color, intensity);
          if (cfg.pos) light.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
          putObj(state, id, light);
          break;
        }
        case 'gltf': {
          if (!state) break;
          const [, id, path] = op;
          const holder = new THREE.Group();
          if (!putObj(state, id, holder)) break;
          const blobUrl = typeof path === 'string' ? this.archive.getBlobUrl(path) : null;
          if (blobUrl && this.inflightGltf < 8) {
            this.inflightGltf++;
            const baseRuntimeUrl = (this.runtimeUrl ?? '/runtime/').replace(/\/?$/, '/');
            const loadGltfModule = (): Promise<{ GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader }> =>
              this.hostThree
                ? import('three/examples/jsm/loaders/GLTFLoader.js').catch(
                    () => import(/* @vite-ignore */ `${baseRuntimeUrl}vendor/gltf-loader.js`)
                  )
                : (
                    import(/* @vite-ignore */ `${baseRuntimeUrl}vendor/gltf-loader.js`) as Promise<{
                      GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader;
                    }>
                  ).catch(() => import('three/examples/jsm/loaders/GLTFLoader.js'));
            void loadGltfModule()
              .then(({ GLTFLoader }) => {
                // A model names its buffers and textures by address, and the loader fetches
                // whatever it names: a `.gltf` whose texture was `https://elsewhere/t.png`
                // reached that origin from an app granted no network. Every address the
                // loader asks for is the model itself, a `data:` address, a file of the
                // app's beside the model, or nothing.
                const base = blobUrl.slice(0, blobUrl.lastIndexOf('/') + 1);
                const manager = new THREE.LoadingManager();
                manager.setURLModifier((url) => {
                  if (url === blobUrl || /^data:/i.test(url)) return url;
                  if (url.startsWith(base)) {
                    try {
                      const beside = this.archive.getBlobUrl(decodeURIComponent(url.slice(base.length)), path);
                      if (beside) return beside;
                    } catch {
                      // Malformed percent-encoding -> block
                    }
                  }
                  return 'data:,';
                });
                const loader = new GLTFLoader(manager);
                loader.load(
                  blobUrl,
                  (gltf) => {
                    this.inflightGltf = Math.max(0, this.inflightGltf - 1);
                    if (!this.disposed && state?.objects.get(id) === holder) {
                      holder.add(gltf.scene);
                    } else {
                      this.disposeObjectResources(gltf.scene);
                    }
                  },
                  undefined,
                  () => {
                    this.inflightGltf = Math.max(0, this.inflightGltf - 1);
                  }
                );
              })
              .catch(() => {
                this.inflightGltf = Math.max(0, this.inflightGltf - 1);
              });
          }
          break;
        }
        case 'add': {
          const parent = state?.objects.get(op[1]);
          const child = state?.objects.get(op[2]);
          if (parent && child && parent !== child && !this.isAncestor(child, parent)) {
            parent.add(child);
          }
          break;
        }
        case 'remove': {
          const parent = state?.objects.get(op[1]);
          const child = state?.objects.get(op[2]);
          if (parent && child) parent.remove(child);
          break;
        }
        case 'xform': {
          const obj = state?.objects.get(op[1]);
          if (obj) {
            obj.position.set(op[2][0], op[2][1], op[2][2]);
            obj.rotation.set(op[3][0], op[3][1], op[3][2]);
            obj.scale.set(op[4][0], op[4][1], op[4][2]);
            if ('updateProjectionMatrix' in obj && typeof obj.updateProjectionMatrix === 'function') {
              obj.updateProjectionMatrix();
            }
          }
          break;
        }
        case 'mat': {
          const obj = state?.objects.get(op[1]);
          if (obj && 'material' in obj) {
            const mat = (obj as import('three').Mesh).material as import('three').MeshStandardMaterial;
            if (op[2].color !== undefined && mat.color) mat.color.set(op[2].color as number);
          }
          break;
        }
        case 'render': {
          const scene = state?.objects.get(op[1]);
          const cam = state?.objects.get(op[2]);
          if (state && scene && cam) {
            state.renderer.render(scene, cam as import('three').Camera);
          }
          break;
        }
        case 'dispose': {
          if (state) {
            this.disposeSceneState(state);
            this.scenes.delete(canvasId);
            state = undefined;
          }
          this.pendingQueues.delete(canvasId);
          break;
        }
      }
      } catch {
        // Isolate malformed per-op failures so other scenes/ops in flush() continue cleanly
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.scenes.values()) {
      this.disposeSceneState(s);
    }
    this.scenes.clear();
    this.pendingQueues.clear();
  }
}
