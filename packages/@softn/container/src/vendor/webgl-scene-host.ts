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

let threeModulePromise: Promise<typeof import('three')> | null = null;

function loadHostThree(runtimeUrl?: string): Promise<typeof import('three')> {
  if (!threeModulePromise) {
    const base = (runtimeUrl ?? '/runtime/').replace(/\/?$/, '/');
    threeModulePromise = (
      import(/* @vite-ignore */ `${base}vendor/three.js`) as Promise<typeof import('three')>
    ).catch(() => import('three'));
  }
  return threeModulePromise;
}

export class SplitRealmSceneHost {
  private readonly scenes = new Map<number, HostedSceneState>();
  private readonly pendingQueues = new Map<number, { canvas: HTMLCanvasElement; ops: ThreeSceneOp[] }>();
  private readonly archive: ContainerArchive;
  private readonly runtimeUrl?: string;
  private loading = false;
  private disposed = false;

  constructor(archive: ContainerArchive, runtimeUrl?: string) {
    this.archive = archive;
    this.runtimeUrl = runtimeUrl;
  }

  enqueue(canvas: HTMLCanvasElement, canvasId: number, ops: ThreeSceneOp[]): void {
    if (this.disposed) return;
    let q = this.pendingQueues.get(canvasId);
    if (!q) {
      q = { canvas, ops: [] };
      this.pendingQueues.set(canvasId, q);
    }
    q.ops.push(...ops);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const THREE = await loadHostThree(this.runtimeUrl);
      if (this.disposed) return;

      for (const [canvasId, entry] of this.pendingQueues) {
        const ops = entry.ops.splice(0, entry.ops.length);
        if (ops.length === 0) continue;
        this.applyCanvasOps(THREE, entry.canvas, canvasId, ops);
      }
    } catch (err) {
      console.warn('[SoftN] Hosted 3D scene renderer unavailable:', err);
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

  private applyCanvasOps(
    THREE: typeof import('three'),
    canvas: HTMLCanvasElement,
    canvasId: number,
    ops: ThreeSceneOp[]
  ): void {
    let state = this.scenes.get(canvasId);

    for (const op of ops) {
      switch (op[0]) {
        case 'init': {
          if (!state) {
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
            state.renderer.setPixelRatio(Math.min(op[3] || 1, 2));
            state.renderer.setSize(op[1], op[2], false);
          }
          break;
        }
        case 'group': {
          if (!state) break;
          const obj = op[1] === 1 ? new THREE.Scene() : new THREE.Group();
          state.objects.set(op[1], obj);
          break;
        }
        case 'camera': {
          if (!state) break;
          const [, id, kind, p] = op;
          const cam =
            kind === 'orthographic'
              ? new THREE.OrthographicCamera(p[0], p[1], p[2], p[3], p[4] ?? 0.1, p[5] ?? 1000)
              : new THREE.PerspectiveCamera(p[0] ?? 60, p[1] ?? 1, p[2] ?? 0.1, p[3] ?? 1000);
          state.objects.set(id, cam);
          break;
        }
        case 'mesh': {
          if (!state) break;
          const [, id, spec] = op;
          const [gKind, ...gp] = spec.geo;
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
          state.objects.set(id, new THREE.Mesh(geometry, material));
          break;
        }
        case 'light': {
          if (!state) break;
          const [, id, lKind, cfg] = op;
          const color = cfg.color !== undefined ? new THREE.Color(cfg.color as number) : new THREE.Color(0xffffff);
          const intensity = cfg.intensity ?? 1;
          let light: import('three').Light;
          if (lKind === 'ambient') light = new THREE.AmbientLight(color, intensity);
          else if (lKind === 'point') light = new THREE.PointLight(color, intensity);
          else light = new THREE.DirectionalLight(color, intensity);
          if (cfg.pos) light.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
          state.objects.set(id, light);
          break;
        }
        case 'gltf': {
          if (!state) break;
          const [, id, path] = op;
          const holder = new THREE.Group();
          state.objects.set(id, holder);
          const blobUrl = this.archive.getBlobUrl(path);
          if (blobUrl) {
            void import('three/examples/jsm/loaders/GLTFLoader.js')
              .then(({ GLTFLoader }) => {
                const loader = new GLTFLoader();
                loader.load(blobUrl, (gltf) => {
                  if (!this.disposed) holder.add(gltf.scene);
                });
              })
              .catch(() => undefined);
          }
          break;
        }
        case 'add': {
          const parent = state?.objects.get(op[1]);
          const child = state?.objects.get(op[2]);
          if (parent && child) parent.add(child);
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
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.scenes.values()) {
      s.renderer.dispose();
    }
    this.scenes.clear();
    this.pendingQueues.clear();
  }
}
