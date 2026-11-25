/**
 * Worker-Side Native V8 External Three.js Engine Host (`ThreeWorkerHost`).
 *
 * Lazily loads SoftN's external `/runtime/vendor/three.js` directly in Native V8
 * inside the isolated `container-worker.js` Web Worker (zero host DOM/cookie access),
 * renders onto a hardware-accelerated `OffscreenCanvas` WebGL2 context, and transfers
 * finished frames zero-copy via `OffscreenCanvas.transferToImageBitmap()` -> host
 * `ImageBitmapRenderingContext.transferFromImageBitmap()`.
 *
 * Also executes `THREE.Raycaster.intersectObjects()` natively in V8 against the live
 * mirrored scene graph, accelerating high-poly terrain picking by >200x vs the guest VM.
 */

import { base64ToBytes, bytesToBase64, canvasSide } from './worker-gpu-utils';
import type { WebGLExecResolvers, WebGLFramePayload } from './webgl-worker-host';

export interface ThreeFrameResolvers extends WebGLExecResolvers {
  /** Read a bundled file (e.g. `.glb`, `.gltf`, or sibling `.bin`/image) strictly from the sandboxed archive. */
  getArchiveBytes?: (relPath: string) => Uint8Array | null;
  /** Called when an async GLTF load finishes and produces a fresh rendered frame. */
  onAsyncDirty?: () => void;
}

type GltfLoaderModule = {
  GLTFLoader: new (manager?: import('three').LoadingManager) => {
    setMeshoptDecoder?: (decoder: unknown) => unknown;
    parse: (
      data: ArrayBuffer | string,
      path: string,
      onLoad: (gltf: { scene: import('three').Group }) => void,
      onError?: (err: unknown) => void
    ) => void;
  };
  MeshoptDecoder?: { ready?: Promise<void> };
};

type ThreeNamespace = typeof import('three');

const MAX_RENDERERS = 8;
const MAX_OBJECTS = 65_536;
const BLOCKED_THREE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_THREE_TEXTURE_SIDE = 4096;
const MAX_THREE_TEXTURE_BYTES = 32 * 1024 * 1024;
const MAX_INSTANCED_MESH_CAP = 1_000_000;
const ALLOWED_SHADER_EXTENSIONS = new Set([
  'clipCullDistance',
  'multiDraw',
  'derivatives',
  'fragDepth',
  'drawBuffers',
  'shaderTextureLOD',
]);
const MAX_RESOURCES = 16_384;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_GEO_GROUPS = 256;
const MAX_GLTF_TEMPLATES = 32;

/**
 * Guard against extreme `far / near` ratios (> 10,000:1) on perspective cameras,
 * which cause severe 24-bit linear Z-buffer quantization and visual clipping /
 * Z-fighting between closely layered terrain, roads, contours, and markers.
 */
function safePerspectiveNear(near: number, far: number): number {
  const n = Number.isFinite(near) && near > 0 ? near : 0.1;
  const f = Number.isFinite(far) && far > n ? far : 2000;
  if (f / n > 10_000) {
    return Math.max(n, f / 4000);
  }
  return n;
}

const SHADER_RECOMPILE_KEYS = new Set([
  'transparent', 'side', 'vertexColors', 'flatShading', 'fog', 'alphaTest',
  'wireframe', 'toneMapped', 'blending', 'depthWrite', 'depthTest',
  'polygonOffset', 'dithering', 'lights', 'clipping',
]);

const MAX_THREE_CUMULATIVE_BYTES = 256 * 1024 * 1024;

interface NativeThreeRendererEntry {
  rendererId: number;
  canvasId: number;
  canvas: OffscreenCanvas;
  renderer: import('three').WebGLRenderer;
  objects: Map<number, import('three').Object3D>;
  geometries: Map<number, import('three').BufferGeometry>;
  materials: Map<number, import('three').Material>;
  textures: Map<number, import('three').Texture>;
  resourceBytes: Map<string, number>;
  allocatedBytes: number;
  dirty: boolean;
  disposed?: boolean;
  lastRender?: { sceneId: number; cameraId: number };
}

function isObjectAncestor(candidate: import('three').Object3D, node: import('three').Object3D): boolean {
  let cur: import('three').Object3D | null = node;
  for (let depth = 0; cur && depth < MAX_OBJECTS; depth++) {
    if (cur === candidate) return true;
    cur = cur.parent;
  }
  return false;
}

function markSharedTemplateTree(root: import('three').Object3D): void {
  root.traverse((node) => {
    const m = node as {
      geometry?: { userData?: Record<string, unknown> };
      material?: unknown | unknown[];
    };
    if (m.geometry && typeof m.geometry === 'object') {
      m.geometry.userData = { ...(m.geometry.userData ?? {}), __softnSharedTemplate: true };
    }
    const markMat = (mat: unknown) => {
      if (!mat || typeof mat !== 'object') return;
      const rec = mat as { userData?: Record<string, unknown> } & Record<string, unknown>;
      rec.userData = { ...(rec.userData ?? {}), __softnSharedTemplate: true };
      for (const val of Object.values(rec)) {
        if (val && typeof val === 'object' && (val as { isTexture?: boolean }).isTexture) {
          const tex = val as { userData?: Record<string, unknown> };
          tex.userData = { ...(tex.userData ?? {}), __softnSharedTemplate: true };
        }
      }
    };
    if (Array.isArray(m.material)) {
      for (const mat of m.material) markMat(mat);
    } else if (m.material) {
      markMat(m.material);
    }
  });
}

function disposeMaterialWithTextures(mat: unknown, forceShared = false): void {
  if (!mat || typeof mat !== 'object') return;
  const matRec = mat as { userData?: Record<string, unknown>; dispose?: () => void } & Record<string, unknown>;
  for (const val of Object.values(matRec)) {
    if (val && typeof val === 'object' && (val as { isTexture?: boolean; dispose?: () => void }).isTexture) {
      const tex = val as { userData?: Record<string, unknown>; dispose?: () => void };
      if (!forceShared && tex.userData?.__softnSharedTemplate) continue;
      try { tex.dispose?.(); } catch { /* ignore */ }
    }
  }
  if (!forceShared && matRec.userData?.__softnSharedTemplate) return;
  try { matRec.dispose?.(); } catch { /* ignore */ }
}

function disposeObjectTree(root: import('three').Object3D, forceShared = false): void {
  root.traverse((node) => {
    const m = node as {
      geometry?: { userData?: Record<string, unknown>; dispose?: () => void };
      material?: unknown | unknown[];
    };
    if (m.geometry && (forceShared || !m.geometry.userData?.__softnSharedTemplate)) {
      try { m.geometry.dispose?.(); } catch { /* ignore */ }
    }
    if (Array.isArray(m.material)) {
      for (const mat of m.material) {
        disposeMaterialWithTextures(mat, forceShared);
      }
    } else if (m.material) {
      disposeMaterialWithTextures(m.material, forceShared);
    }
  });
}

function estimateBase64Bytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - pad);
}

function decodeTypedArray(typeCode: string, b64: string): Float32Array | Uint16Array | Uint32Array | Int32Array | Int16Array | Int8Array | Uint8Array | Uint8ClampedArray {
  if (Math.ceil((b64.length * 3) / 4) > MAX_UPLOAD_BYTES + 4) {
    throw new RangeError('Three.js buffer upload exceeds size limit');
  }
  const bytes = base64ToBytes(b64);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new RangeError('Three.js buffer upload exceeds size limit');
  }
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  switch (typeCode) {
    case 'f32': return new Float32Array(buf);
    case 'u16': return new Uint16Array(buf);
    case 'u32': return new Uint32Array(buf);
    case 'i32': return new Int32Array(buf);
    case 'i16': return new Int16Array(buf);
    case 'i8': return new Int8Array(buf);
    case 'u8c': return new Uint8ClampedArray(buf);
    default: return new Uint8Array(buf);
  }
}

function decodeUniformValue(
  THREE: ThreeNamespace,
  entry: NativeThreeRendererEntry,
  val: unknown,
  existing?: unknown
): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((item) => decodeUniformValue(THREE, entry, item));
  }
  const rec = val as Record<string, unknown>;
  const tag = rec.$t;
  if (typeof tag !== 'string') return val;
  switch (tag) {
    case 'v2': {
      const v = rec.v as number[];
      if (existing && (existing as import('three').Vector2).isVector2) {
        return (existing as import('three').Vector2).set(v[0] || 0, v[1] || 0);
      }
      return new THREE.Vector2(v[0] || 0, v[1] || 0);
    }
    case 'v3': {
      const v = rec.v as number[];
      if (existing && (existing as import('three').Vector3).isVector3) {
        return (existing as import('three').Vector3).set(v[0] || 0, v[1] || 0, v[2] || 0);
      }
      return new THREE.Vector3(v[0] || 0, v[1] || 0, v[2] || 0);
    }
    case 'v4': {
      const v = rec.v as number[];
      if (existing && (existing as import('three').Vector4).isVector4) {
        return (existing as import('three').Vector4).set(v[0] || 0, v[1] || 0, v[2] || 0, v[3] || 0);
      }
      return new THREE.Vector4(v[0] || 0, v[1] || 0, v[2] || 0, v[3] || 0);
    }
    case 'c': {
      const v = rec.v as number[];
      if (existing && (existing as import('three').Color).isColor) {
        return (existing as import('three').Color).setRGB(v[0] || 0, v[1] || 0, v[2] || 0);
      }
      return new THREE.Color().setRGB(v[0] || 0, v[1] || 0, v[2] || 0);
    }
    case 'm3': {
      const v = rec.v as number[];
      if (existing && (existing as import('three').Matrix3).isMatrix3) {
        return (existing as import('three').Matrix3).fromArray(v);
      }
      return new THREE.Matrix3().fromArray(v);
    }
    case 'm4': {
      const v = rec.v as number[];
      if (existing && (existing as import('three').Matrix4).isMatrix4) {
        return (existing as import('three').Matrix4).fromArray(v);
      }
      return new THREE.Matrix4().fromArray(v);
    }
    case 'tex': {
      const tid = Number(rec.v);
      return tid > 0 ? (entry.textures.get(tid) ?? null) : null;
    }
    case 'ta': {
      return decodeTypedArray(String(rec.tc || 'f32'), String(rec.v || ''));
    }
    default:
      return rec.v;
  }
}

export class ThreeWorkerHost {
  private THREE: ThreeNamespace | null = null;
  private loadPromise: Promise<ThreeNamespace | null> | null = null;
  private runtimeBase = '/runtime/';
  private gltfModulePromise: Promise<GltfLoaderModule | null> | null = null;
  private readonly gltfTemplateCache = new Map<string, Promise<import('three').Object3D | null>>();
  private readonly renderers = new Map<number, NativeThreeRendererEntry>();
  private nextRendererId = 1;

  isLoaded(): boolean {
    return this.THREE !== null;
  }

  hasActiveRenderers(): boolean {
    return this.renderers.size > 0;
  }

  async ensureLoaded(runtimeUrl: string): Promise<boolean> {
    if (this.THREE) return true;
    if (typeof OffscreenCanvas !== 'function') return false;
    if (!this.loadPromise) {
      const base = (runtimeUrl || '/runtime/').replace(/\/?$/, '/');
      this.runtimeBase = base;
      const url = `${base}vendor/three.js`;
      this.loadPromise = (import(/* @vite-ignore */ url) as Promise<ThreeNamespace>)
        .then((mod) => {
          this.THREE = mod;
          return mod;
        })
        .catch(() => {
          this.loadPromise = null;
          return null;
        });
    }
    const loaded = await this.loadPromise;
    return loaded !== null;
  }

  private ensureGltfLoader(): Promise<GltfLoaderModule | null> {
    if (!this.gltfModulePromise) {
      const url = `${this.runtimeBase}vendor/gltf-loader.js`;
      this.gltfModulePromise = (import(/* @vite-ignore */ url) as Promise<GltfLoaderModule>)
        .then(async (mod) => {
          if (mod?.MeshoptDecoder?.ready) {
            await mod.MeshoptDecoder.ready.catch(() => undefined);
          }
          return mod;
        })
        .catch(() => {
          this.gltfModulePromise = null;
          return null;
        });
    }
    return this.gltfModulePromise;
  }

  private loadGltfIntoHolder(
    THREE: ThreeNamespace,
    entry: NativeThreeRendererEntry,
    holder: import('three').Group,
    rawSrc: string,
    resolvers?: ThreeFrameResolvers
  ): void {
    const cleanSrc = rawSrc.replace(/^\.\/+/, '').replace(/^\/+/, '');
    if (!cleanSrc || !resolvers?.getArchiveBytes) return;

    let templatePromise = this.gltfTemplateCache.get(cleanSrc);
    if (!templatePromise) {
      const bytes = resolvers.getArchiveBytes(cleanSrc);
      if (!bytes || bytes.byteLength === 0) return;
      const copy = bytes.slice();
      const baseDir = cleanSrc.includes('/') ? cleanSrc.slice(0, cleanSrc.lastIndexOf('/') + 1) : '';
      const isGlb = copy.byteLength >= 4 && copy[0] === 0x67 && copy[1] === 0x6c && copy[2] === 0x54 && copy[3] === 0x46;

      templatePromise = this.ensureGltfLoader().then(async (mod) => {
        if (!mod?.GLTFLoader) return null;
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
          if (/^data:/i.test(url)) return url;
          const rel = url.replace(/^\.\/+/, '').replace(/^\/+/, '');
          const sideBytes = resolvers.getArchiveBytes?.(rel) ?? resolvers.getArchiveBytes?.(`${baseDir}${rel}`);
          if (sideBytes && sideBytes.byteLength > 0) {
            const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
            const mime =
              ext === 'png' ? 'image/png'
                : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                : ext === 'webp' ? 'image/webp'
                : 'application/octet-stream';
            return `data:${mime};base64,${bytesToBase64(sideBytes)}`;
          }
          return 'data:,';
        });
        const loader = new mod.GLTFLoader(manager);
        if (mod.MeshoptDecoder && typeof loader.setMeshoptDecoder === 'function') {
          loader.setMeshoptDecoder(mod.MeshoptDecoder);
        }
        return await new Promise<import('three').Object3D | null>((resolve) => {
          try {
            const payload = isGlb
              ? copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
              : new TextDecoder().decode(copy);
            loader.parse(
              payload,
              baseDir,
              (gltf) => {
                const scene = gltf?.scene ?? null;
                if (scene) markSharedTemplateTree(scene);
                resolve(scene);
              },
              () => resolve(null)
            );
          } catch {
            resolve(null);
          }
        });
      });
      if (this.gltfTemplateCache.size >= MAX_GLTF_TEMPLATES) {
        const oldestKey = this.gltfTemplateCache.keys().next().value;
        if (oldestKey !== undefined) {
          const evicted = this.gltfTemplateCache.get(oldestKey);
          this.gltfTemplateCache.delete(oldestKey);
          void evicted?.then((tpl) => { if (tpl) disposeObjectTree(tpl, true); }).catch(() => undefined);
        }
      }
      this.gltfTemplateCache.set(cleanSrc, templatePromise);
    }

    void templatePromise.then((template) => {
      if (!template || entry.disposed) return;
      try {
        holder.add(template.clone(true));
        if (entry.lastRender) {
          const sc = entry.objects.get(entry.lastRender.sceneId) as import('three').Scene | undefined;
          const cam = entry.objects.get(entry.lastRender.cameraId) as import('three').Camera | undefined;
          if (sc && cam) {
            entry.renderer.render(sc, cam);
            entry.dirty = true;
            resolvers.onAsyncDirty?.();
          }
        }
      } catch {
        // ignore clone/render errors on disposed entries
      }
    });
  }

  init(
    canvasId: number,
    width: number,
    height: number,
    opts?: Record<string, unknown>
  ): Record<string, unknown> | null {
    const THREE = this.THREE;
    if (!THREE || typeof OffscreenCanvas !== 'function') return null;
    if (this.renderers.size >= MAX_RENDERERS) return null;

    const w = Math.max(1, Math.min(4096, canvasSide(width) || 300));
    const h = Math.max(1, Math.min(4096, canvasSide(height) || 150));

    let canvas: OffscreenCanvas;
    let renderer: import('three').WebGLRenderer;
    try {
      canvas = new OffscreenCanvas(w, h);
      // Defensive stub for any Three.js path that inspects canvas.style
      if (!('style' in canvas)) {
        Object.defineProperty(canvas, 'style', { value: {}, writable: true, configurable: true });
      }
      renderer = new THREE.WebGLRenderer({
        canvas: canvas as unknown as HTMLCanvasElement,
        antialias: opts?.antialias !== undefined ? Boolean(opts.antialias) : true,
        alpha: opts?.alpha !== undefined ? Boolean(opts.alpha) : false,
        depth: opts?.depth !== undefined ? Boolean(opts.depth) : true,
        stencil: opts?.stencil !== undefined ? Boolean(opts.stencil) : false,
        premultipliedAlpha: opts?.premultipliedAlpha !== undefined ? Boolean(opts.premultipliedAlpha) : true,
        preserveDrawingBuffer: opts?.preserveDrawingBuffer !== undefined ? Boolean(opts.preserveDrawingBuffer) : false,
        powerPreference:
          opts?.powerPreference === 'high-performance' || opts?.powerPreference === 'low-power'
            ? opts.powerPreference
            : 'default',
      });
      renderer.setSize(w, h, false);
    } catch {
      return null;
    }

    const rendererId = this.nextRendererId++;
    const entry: NativeThreeRendererEntry = {
      rendererId,
      canvasId: Number.isInteger(canvasId) && canvasId > 0 ? canvasId : 0,
      canvas,
      renderer,
      objects: new Map(),
      geometries: new Map(),
      materials: new Map(),
      textures: new Map(),
      resourceBytes: new Map(),
      allocatedBytes: 0,
      dirty: false,
    };
    this.renderers.set(rendererId, entry);

    const gl = renderer.getContext();
    return {
      rendererId,
      isWebGL2: renderer.capabilities.isWebGL2,
      maxTextureSize: renderer.capabilities.maxTextureSize,
      maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      maxVertexUniforms: renderer.capabilities.maxVertexUniforms,
      precision: renderer.capabilities.precision,
      contextAttributes: gl.getContextAttributes?.() ?? {},
    };
  }

  frame(
    rendererId: number,
    ops: unknown[],
    f32B64: string,
    resolvers?: ThreeFrameResolvers
  ): boolean {
    const THREE = this.THREE;
    const entry = this.renderers.get(rendererId);
    if (!THREE || !entry) return false;

    let f32: Float32Array | null = null;
    if (f32B64 && f32B64.length > 0 && Math.ceil((f32B64.length * 3) / 4) <= MAX_UPLOAD_BYTES) {
      try {
        const bytes = base64ToBytes(f32B64);
        if (bytes.byteLength <= MAX_UPLOAD_BYTES) {
          f32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
        }
      } catch {
        f32 = null;
      }
    }

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!Array.isArray(op) || op.length === 0) continue;
      const code = op[0];
      try {
        switch (code) {
          case 'cid': {
            const cid = Number(op[1]);
            if (Number.isInteger(cid) && cid > 0) entry.canvasId = cid;
            break;
          }
          case 'rs': {
            const dpr = Math.max(0.5, Math.min(2, Number(op[3]) || 1));
            const maxCssSide = Math.floor(4096 / dpr);
            const w = Math.max(1, Math.min(maxCssSide, canvasSide(Number(op[1])) || 1));
            const h = Math.max(1, Math.min(maxCssSide, canvasSide(Number(op[2])) || 1));
            entry.renderer.setPixelRatio(dpr);
            entry.renderer.setSize(w, h, false);
            break;
          }
          case 'rc': {
            const cfg = (op[1] ?? {}) as Record<string, unknown>;
            if (typeof cfg.toneMapping === 'number') {
              entry.renderer.toneMapping = cfg.toneMapping as import('three').ToneMapping;
            }
            if (typeof cfg.toneMappingExposure === 'number') {
              entry.renderer.toneMappingExposure = cfg.toneMappingExposure;
            }
            if (typeof cfg.outputColorSpace === 'string') {
              entry.renderer.outputColorSpace = cfg.outputColorSpace as import('three').ColorSpace;
            }
            if (typeof cfg.shadowMapEnabled === 'boolean') {
              entry.renderer.shadowMap.enabled = cfg.shadowMapEnabled;
            }
            if (typeof cfg.shadowMapType === 'number') {
              entry.renderer.shadowMap.type = cfg.shadowMapType as import('three').ShadowMapType;
            }
            if (typeof cfg.autoClear === 'boolean') {
              entry.renderer.autoClear = cfg.autoClear;
            }
            if (typeof cfg.clearColor === 'number') {
              entry.renderer.setClearColor(cfg.clearColor, typeof cfg.clearAlpha === 'number' ? cfg.clearAlpha : 1);
            }
            break;
          }
          case 'tex': {
            this.applyTextureOp(THREE, entry, Number(op[1]), (op[2] ?? {}) as Record<string, unknown>, resolvers);
            break;
          }
          case 'geo': {
            this.applyGeometryOp(THREE, entry, Number(op[1]), (op[2] ?? {}) as Record<string, unknown>);
            break;
          }
          case 'mat': {
            this.applyMaterialOp(THREE, entry, Number(op[1]), (op[2] ?? {}) as Record<string, unknown>);
            break;
          }
          case 'mu': {
            const mat = entry.materials.get(Number(op[1])) as import('three').ShaderMaterial | undefined;
            const uMap = op[2] as Record<string, unknown> | undefined;
            if (mat && mat.uniforms && uMap && typeof uMap === 'object') {
              for (const [uk, uv] of Object.entries(uMap)) {
                if (BLOCKED_THREE_KEYS.has(uk)) continue;
                if (!Object.prototype.hasOwnProperty.call(mat.uniforms, uk) || !mat.uniforms[uk]) {
                  mat.uniforms[uk] = { value: decodeUniformValue(THREE, entry, uv) };
                } else {
                  mat.uniforms[uk].value = decodeUniformValue(THREE, entry, uv, mat.uniforms[uk].value);
                }
              }
            }
            break;
          }
          case 'obj': {
            this.applyObjectOp(THREE, entry, Number(op[1]), String(op[2]), (op[3] ?? {}) as Record<string, unknown>, resolvers);
            break;
          }
          case 'scene': {
            const sc = entry.objects.get(Number(op[1])) as import('three').Scene | undefined;
            const spec = (op[2] ?? {}) as Record<string, unknown>;
            if (sc && sc.isScene) {
              if ('bg' in spec) {
                const bg = spec.bg as Record<string, unknown> | null;
                if (!bg) sc.background = null;
                else if (bg.t === 'c' && Array.isArray(bg.v)) {
                  const v = bg.v as number[];
                  sc.background = new THREE.Color().setRGB(v[0] || 0, v[1] || 0, v[2] || 0);
                } else if (bg.t === 'tex') {
                  sc.background = entry.textures.get(Number(bg.v)) ?? null;
                }
              }
              if ('fog' in spec) {
                const f = spec.fog as Record<string, unknown> | null;
                if (!f) sc.fog = null;
                else if (f.t === 'exp2') {
                  const col = Array.isArray(f.c) ? new THREE.Color().setRGB(f.c[0], f.c[1], f.c[2]) : new THREE.Color(0x000000);
                  sc.fog = new THREE.FogExp2(col, Number(f.d) || 0.00025);
                } else if (f.t === 'linear') {
                  const col = Array.isArray(f.c) ? new THREE.Color().setRGB(f.c[0], f.c[1], f.c[2]) : new THREE.Color(0x000000);
                  sc.fog = new THREE.Fog(col, Number(f.near) || 1, Number(f.far) || 1000);
                }
              }
            }
            break;
          }
          case 'ch': {
            const parent = entry.objects.get(Number(op[1]));
            const childIds = op[2] as number[];
            if (parent && Array.isArray(childIds)) {
              const wanted: import('three').Object3D[] = [];
              const wantedSet = new Set<import('three').Object3D>();
              for (let c = 0; c < childIds.length; c++) {
                const ch = entry.objects.get(childIds[c]);
                // Prevent duplicates and scene-graph cycles (`A -> B -> A`) that would hang `raycast()` / `render()`.
                if (ch && ch !== parent && !wantedSet.has(ch) && !isObjectAncestor(ch, parent)) {
                  wanted.push(ch);
                  wantedSet.add(ch);
                }
              }
              // Remove children no longer present
              for (let c = parent.children.length - 1; c >= 0; c--) {
                const existing = parent.children[c];
                if (!wantedSet.has(existing)) {
                  parent.remove(existing);
                }
              }
              // Add missing children and match exact order
              for (let c = 0; c < wanted.length; c++) {
                const ch = wanted[c];
                if (ch.parent !== parent) {
                  parent.add(ch);
                }
              }
              if (parent.children.length === wanted.length) {
                for (let c = 0; c < wanted.length; c++) {
                  parent.children[c] = wanted[c];
                }
              }
            }
            break;
          }
          case 'xf': {
            const obj = entry.objects.get(Number(op[1]));
            if (!obj || !f32) break;
            const mode = Number(op[2]);
            const off = Number(op[3]);
            obj.visible = Boolean(op[4]);
            if (mode === 0 && off + 10 <= f32.length) {
              let ok = true;
              for (let k = 0; k < 10; k++) {
                if (!Number.isFinite(f32[off + k])) { ok = false; break; }
              }
              if (ok) {
                obj.matrixAutoUpdate = true;
                obj.position.set(f32[off], f32[off + 1], f32[off + 2]);
                obj.quaternion.set(f32[off + 3], f32[off + 4], f32[off + 5], f32[off + 6]);
                obj.scale.set(f32[off + 7], f32[off + 8], f32[off + 9]);
              }
            } else if (mode === 1 && off + 16 <= f32.length) {
              let ok = true;
              for (let k = 0; k < 16; k++) {
                if (!Number.isFinite(f32[off + k])) { ok = false; break; }
              }
              if (ok) {
                obj.matrixAutoUpdate = false;
                obj.matrix.fromArray(f32, off);
                obj.matrixWorldNeedsUpdate = true;
              }
            }
            break;
          }
          case 'cam': {
            const cam = entry.objects.get(Number(op[1]));
            const spec = (op[2] ?? {}) as Record<string, unknown>;
            if (cam && (cam as import('three').PerspectiveCamera).isPerspectiveCamera) {
              const p = cam as import('three').PerspectiveCamera;
              if (typeof spec.fov === 'number' && Number.isFinite(spec.fov)) p.fov = spec.fov;
              if (typeof spec.aspect === 'number' && Number.isFinite(spec.aspect) && spec.aspect > 0) p.aspect = spec.aspect;
              const rawNear = typeof spec.near === 'number' && Number.isFinite(spec.near) ? spec.near : p.near;
              const rawFar = typeof spec.far === 'number' && Number.isFinite(spec.far) ? spec.far : p.far;
              p.far = rawFar;
              p.near = safePerspectiveNear(rawNear, rawFar);
              if (typeof spec.zoom === 'number' && Number.isFinite(spec.zoom)) p.zoom = spec.zoom;
              p.updateProjectionMatrix();
            } else if (cam && (cam as import('three').OrthographicCamera).isOrthographicCamera) {
              const o = cam as import('three').OrthographicCamera;
              if (typeof spec.left === 'number' && Number.isFinite(spec.left)) o.left = spec.left;
              if (typeof spec.right === 'number' && Number.isFinite(spec.right)) o.right = spec.right;
              if (typeof spec.top === 'number' && Number.isFinite(spec.top)) o.top = spec.top;
              if (typeof spec.bottom === 'number' && Number.isFinite(spec.bottom)) o.bottom = spec.bottom;
              if (typeof spec.near === 'number' && Number.isFinite(spec.near)) o.near = spec.near;
              if (typeof spec.far === 'number' && Number.isFinite(spec.far)) o.far = spec.far;
              if (typeof spec.zoom === 'number' && Number.isFinite(spec.zoom)) o.zoom = spec.zoom;
              o.updateProjectionMatrix();
            }
            break;
          }
          case 'im': {
            const id = Number(op[1]);
            const inst = entry.objects.get(id) as import('three').InstancedMesh | undefined;
            if (!inst || !inst.isInstancedMesh) break;
            if (typeof op[3] === 'string' && op[3].length > 0) {
              const estBytes = estimateBase64Bytes(op[3]);
              if (estBytes > MAX_UPLOAD_BYTES || !this.trackResourceBytes(entry, `im-mat:${id}`, estBytes)) break;
              const arr = decodeTypedArray('f32', op[3]) as Float32Array;
              if (!this.trackResourceBytes(entry, `im-mat:${id}`, arr.byteLength)) break;
              if (inst.instanceMatrix.array.length !== arr.length) {
                inst.instanceMatrix = new THREE.InstancedBufferAttribute(arr, 16);
              } else {
                (inst.instanceMatrix.array as Float32Array).set(arr);
                inst.instanceMatrix.needsUpdate = true;
              }
            }
            if (typeof op[2] === 'number' && Number.isFinite(op[2])) {
              const maxAllowed = Math.min(MAX_INSTANCED_MESH_CAP, inst.instanceMatrix.count);
              inst.count = Math.max(0, Math.min(maxAllowed, Math.floor(op[2])));
            }
            if (typeof op[4] === 'string' && op[4].length > 0) {
              const estBytes = estimateBase64Bytes(op[4]);
              if (estBytes > MAX_UPLOAD_BYTES || !this.trackResourceBytes(entry, `im-col:${id}`, estBytes)) break;
              const colArr = decodeTypedArray('f32', op[4]) as Float32Array;
              if (!this.trackResourceBytes(entry, `im-col:${id}`, colArr.byteLength)) break;
              const hadColor = Boolean(inst.instanceColor);
              if (!inst.instanceColor || inst.instanceColor.array.length !== colArr.length) {
                inst.instanceColor = new THREE.InstancedBufferAttribute(colArr, 3);
              } else {
                (inst.instanceColor.array as Float32Array).set(colArr);
                inst.instanceColor.needsUpdate = true;
              }
              if (!hadColor && inst.material) {
                if (Array.isArray(inst.material)) {
                  for (const m of inst.material) m.needsUpdate = true;
                } else {
                  inst.material.needsUpdate = true;
                }
              }
            }
            try {
              inst.computeBoundingSphere();
            } catch {
              // ignore degenerate instance matrices
            }
            break;
          }
          case 'del': {
            const kind = String(op[1]);
            const id = Number(op[2]);
            if (kind === 'geo') {
              entry.geometries.get(id)?.dispose();
              entry.geometries.delete(id);
              this.releaseResourceBytesPrefix(entry, `geo:${id}:`);
            } else if (kind === 'mat') {
              entry.materials.get(id)?.dispose();
              entry.materials.delete(id);
            } else if (kind === 'tex') {
              entry.textures.get(id)?.dispose();
              entry.textures.delete(id);
              this.releaseResourceBytes(entry, `tex:${id}`);
            } else if (kind === 'obj') {
              const o = entry.objects.get(id);
              o?.parent?.remove(o);
              if (o && (o.userData as Record<string, unknown> | undefined)?.__softnGltf) {
                disposeObjectTree(o);
              }
              entry.objects.delete(id);
              this.releaseResourceBytes(entry, `im-mat:${id}`);
              this.releaseResourceBytes(entry, `im-col:${id}`);
            }
            break;
          }
          case 'render': {
            const scId = Number(op[1]);
            const camId = Number(op[2]);
            const sc = entry.objects.get(scId) as import('three').Scene | undefined;
            const cam = entry.objects.get(camId) as import('three').Camera | undefined;
            if (sc && cam) {
              entry.lastRender = { sceneId: scId, cameraId: camId };
              entry.renderer.render(sc, cam);
              entry.dirty = true;
            }
            break;
          }
        }
      } catch {
        // Isolate malformed scene ops without crashing Worker
      }
    }
    return true;
  }

  private trackResourceBytes(entry: NativeThreeRendererEntry, key: string, nextBytes: number): boolean {
    if (!entry.resourceBytes) entry.resourceBytes = new Map();
    if (typeof entry.allocatedBytes !== 'number') entry.allocatedBytes = 0;
    const prev = entry.resourceBytes.get(key) ?? 0;
    const nextTotal = entry.allocatedBytes - prev + nextBytes;
    if (nextTotal > MAX_THREE_CUMULATIVE_BYTES) return false;
    entry.allocatedBytes = Math.max(0, nextTotal);
    if (nextBytes > 0) entry.resourceBytes.set(key, nextBytes);
    else entry.resourceBytes.delete(key);
    return true;
  }

  private releaseResourceBytes(entry: NativeThreeRendererEntry, key: string): void {
    if (!entry.resourceBytes) return;
    if (typeof entry.allocatedBytes !== 'number') entry.allocatedBytes = 0;
    const prev = entry.resourceBytes.get(key);
    if (prev !== undefined) {
      entry.allocatedBytes = Math.max(0, entry.allocatedBytes - prev);
      entry.resourceBytes.delete(key);
    }
  }

  private releaseResourceBytesPrefix(entry: NativeThreeRendererEntry, prefix: string): void {
    if (!entry.resourceBytes) return;
    if (typeof entry.allocatedBytes !== 'number') entry.allocatedBytes = 0;
    for (const [k, v] of [...entry.resourceBytes]) {
      if (k.startsWith(prefix)) {
        entry.allocatedBytes = Math.max(0, entry.allocatedBytes - v);
        entry.resourceBytes.delete(k);
      }
    }
  }

  private applyTextureOp(
    THREE: ThreeNamespace,
    entry: NativeThreeRendererEntry,
    id: number,
    spec: Record<string, unknown>,
    resolvers?: WebGLExecResolvers
  ): void {
    if (!entry.textures.has(id) && entry.textures.size >= MAX_RESOURCES) return;
    let tex = entry.textures.get(id);
    const kind = String(spec.kind || 'canvas');
    if (kind === 'canvas') {
      const cid = Number(spec.cid) || 0;
      const w = Number(spec.w) || 256;
      const h = Number(spec.h) || 256;
      const cmds = Array.isArray(spec.cmds) ? spec.cmds : [];
      const offscreen = resolvers?.getCanvas2DMirror?.(cid, w, h, cmds) ?? null;
      if (offscreen) {
        if (!tex) {
          tex = new THREE.CanvasTexture(offscreen as unknown as HTMLCanvasElement);
          entry.textures.set(id, tex);
        } else {
          tex.image = offscreen;
        }
      }
    } else if (kind === 'data') {
      const w = Math.max(1, Math.min(MAX_THREE_TEXTURE_SIDE, Math.floor(Number(spec.w) || 1)));
      const h = Math.max(1, Math.min(MAX_THREE_TEXTURE_SIDE, Math.floor(Number(spec.h) || 1)));
      const allocSize = w * h * 4;
      if (allocSize > MAX_THREE_TEXTURE_BYTES) return;
      const prevTexBytes = entry.resourceBytes.get(`tex:${id}`) ?? 0;
      if (entry.allocatedBytes - prevTexBytes + allocSize > MAX_THREE_CUMULATIVE_BYTES) return;
      if (typeof spec.b64 === 'string' && Math.ceil((spec.b64.length * 3) / 4) > MAX_THREE_TEXTURE_BYTES) return;
      const data = typeof spec.b64 === 'string' ? decodeTypedArray(String(spec.tc || 'u8'), spec.b64) : new Uint8Array(allocSize);
      if (data.byteLength > MAX_THREE_TEXTURE_BYTES || !this.trackResourceBytes(entry, `tex:${id}`, data.byteLength)) return;
      const fmt = typeof spec.format === 'number' ? (spec.format as import('three').PixelFormat) : THREE.RGBAFormat;
      const typ = typeof spec.type === 'number' ? (spec.type as import('three').TextureDataType) : THREE.UnsignedByteType;
      tex?.dispose();
      tex = new THREE.DataTexture(data as BufferSource, w, h, fmt, typ);
      entry.textures.set(id, tex);
    } else if (kind === 'img') {
      const bmp = typeof spec.ref === 'string' ? (resolvers?.getImageBitmap?.(spec.ref) ?? null) : null;
      if (bmp) {
        if (!tex) {
          tex = new THREE.Texture(bmp as unknown as HTMLImageElement);
          entry.textures.set(id, tex);
        } else {
          tex.image = bmp;
        }
      }
    }
    if (!tex) return;
    if (typeof spec.colorSpace === 'string') tex.colorSpace = spec.colorSpace as import('three').ColorSpace;
    if (typeof spec.wrapS === 'number') tex.wrapS = spec.wrapS as import('three').Wrapping;
    if (typeof spec.wrapT === 'number') tex.wrapT = spec.wrapT as import('three').Wrapping;
    if (Array.isArray(spec.repeat)) tex.repeat.set(Number(spec.repeat[0]) || 1, Number(spec.repeat[1]) || 1);
    if (Array.isArray(spec.offset)) tex.offset.set(Number(spec.offset[0]) || 0, Number(spec.offset[1]) || 0);
    if (typeof spec.minFilter === 'number') tex.minFilter = spec.minFilter as import('three').MinificationTextureFilter;
    if (typeof spec.magFilter === 'number') tex.magFilter = spec.magFilter as import('three').MagnificationTextureFilter;
    if (typeof spec.generateMipmaps === 'boolean') tex.generateMipmaps = spec.generateMipmaps;
    if (typeof spec.flipY === 'boolean') tex.flipY = spec.flipY;
    if (typeof spec.anisotropy === 'number') tex.anisotropy = spec.anisotropy;
    tex.needsUpdate = true;
  }

  private applyGeometryOp(
    THREE: ThreeNamespace,
    entry: NativeThreeRendererEntry,
    id: number,
    spec: Record<string, unknown>
  ): void {
    let geo = entry.geometries.get(id);
    if (!geo) {
      if (entry.geometries.size >= MAX_RESOURCES) return;
      geo = spec.instanced ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
      entry.geometries.set(id, geo);
    }
    const attrs = spec.attrs as Record<string, Record<string, unknown>> | undefined;
    if (attrs && typeof attrs === 'object') {
      for (const [name, aSpec] of Object.entries(attrs)) {
        if (BLOCKED_THREE_KEYS.has(name)) continue;
        if (!aSpec || typeof aSpec.b64 !== 'string') continue;
        const estBytes = estimateBase64Bytes(aSpec.b64);
        if (estBytes > MAX_UPLOAD_BYTES || !this.trackResourceBytes(entry, `geo:${id}:attr:${name}`, estBytes)) continue;
        const arr = decodeTypedArray(String(aSpec.tc || 'f32'), aSpec.b64);
        if (!this.trackResourceBytes(entry, `geo:${id}:attr:${name}`, arr.byteLength)) continue;
        const itemSize = Number(aSpec.s) || 3;
        const normalized = Boolean(aSpec.n);
        if (aSpec.inst) {
          geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, itemSize, normalized, Number(aSpec.mpa) || 1));
        } else {
          geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize, normalized));
        }
      }
    }
    if ('index' in spec) {
      const idx = spec.index as { tc?: string; b64?: string } | null;
      if (idx && typeof idx.b64 === 'string') {
        const estBytes = estimateBase64Bytes(idx.b64);
        if (estBytes <= MAX_UPLOAD_BYTES && this.trackResourceBytes(entry, `geo:${id}:index`, estBytes)) {
          const arr = decodeTypedArray(String(idx.tc || 'u16'), idx.b64);
          if (this.trackResourceBytes(entry, `geo:${id}:index`, arr.byteLength)) {
            geo.setIndex(new THREE.BufferAttribute(arr, 1));
          }
        }
      } else {
        this.releaseResourceBytes(entry, `geo:${id}:index`);
        geo.setIndex(null);
      }
    }
    if (Array.isArray(spec.drawRange)) {
      geo.setDrawRange(Number(spec.drawRange[0]) || 0, Number(spec.drawRange[1]) ?? Infinity);
    }
    if (Array.isArray(spec.groups)) {
      geo.clearGroups();
      const cappedGroups = (spec.groups as Array<[number, number, number?]>).slice(0, MAX_GEO_GROUPS);
      for (const g of cappedGroups) {
        if (Array.isArray(g)) geo.addGroup(Number(g[0]) || 0, Number(g[1]) || 0, g[2] !== undefined ? Number(g[2]) : undefined);
      }
    }
    if (
      typeof spec.instanceCount === 'number' &&
      Number.isFinite(spec.instanceCount) &&
      (geo as import('three').InstancedBufferGeometry).isInstancedBufferGeometry
    ) {
      (geo as import('three').InstancedBufferGeometry).instanceCount = Math.max(
        0,
        Math.min(MAX_INSTANCED_MESH_CAP, Math.floor(spec.instanceCount))
      );
    }
    if (
      Array.isArray(spec.bs) &&
      spec.bs.length === 4 &&
      spec.bs.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      geo.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(spec.bs[0], spec.bs[1], spec.bs[2]),
        Math.max(0, spec.bs[3])
      );
    } else if ((geo as import('three').InstancedBufferGeometry).isInstancedBufferGeometry) {
      // Custom InstancedBufferGeometry (e.g. LineGeometry) stores world points in instanced
      // attributes rather than `position`, so computing from `position` alone yields a tiny
      // origin sphere that causes false frustum culling.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    } else if (geo.getAttribute('position')) {
      try {
        geo.computeBoundingSphere();
      } catch {
        // ignore degenerate geometry
      }
    }
  }

  private applyMaterialOp(
    THREE: ThreeNamespace,
    entry: NativeThreeRendererEntry,
    id: number,
    spec: Record<string, unknown>
  ): void {
    let mat = entry.materials.get(id);
    const isExisting = Boolean(mat);
    const type = String(spec.type || 'MeshStandardMaterial');
    if (!mat) {
      if (entry.materials.size >= MAX_RESOURCES) return;
      switch (type) {
        case 'MeshBasicMaterial': mat = new THREE.MeshBasicMaterial(); break;
        case 'MeshLambertMaterial': mat = new THREE.MeshLambertMaterial(); break;
        case 'MeshPhongMaterial': mat = new THREE.MeshPhongMaterial(); break;
        case 'MeshPhysicalMaterial': mat = new THREE.MeshPhysicalMaterial(); break;
        case 'MeshNormalMaterial': mat = new THREE.MeshNormalMaterial(); break;
        case 'MeshDepthMaterial': mat = new THREE.MeshDepthMaterial(); break;
        case 'LineBasicMaterial': mat = new THREE.LineBasicMaterial(); break;
        case 'LineDashedMaterial': mat = new THREE.LineDashedMaterial(); break;
        case 'PointsMaterial': mat = new THREE.PointsMaterial(); break;
        case 'ShadowMaterial': mat = new THREE.ShadowMaterial(); break;
        case 'SpriteMaterial': mat = new THREE.SpriteMaterial(); break;
        case 'RawShaderMaterial': mat = new THREE.RawShaderMaterial(); break;
        case 'ShaderMaterial': mat = new THREE.ShaderMaterial(); break;
        default: mat = new THREE.MeshStandardMaterial(); break;
      }
      entry.materials.set(id, mat);
    }

    const m = mat as unknown as Record<string, unknown>;
    let shaderPropsChanged = false;
    if (Array.isArray(spec.color) && m.color && (m.color as import('three').Color).isColor) {
      (m.color as import('three').Color).setRGB(spec.color[0], spec.color[1], spec.color[2]);
    }
    if (Array.isArray(spec.emissive) && m.emissive && (m.emissive as import('three').Color).isColor) {
      (m.emissive as import('three').Color).setRGB(spec.emissive[0], spec.emissive[1], spec.emissive[2]);
    }
    const scalarKeys = [
      'emissiveIntensity', 'roughness', 'metalness', 'opacity', 'transparent', 'side',
      'vertexColors', 'wireframe', 'depthWrite', 'depthTest', 'toneMapped', 'blending',
      'fog', 'alphaTest', 'size', 'sizeAttenuation', 'polygonOffset', 'polygonOffsetFactor',
      'polygonOffsetUnits', 'linewidth', 'dashSize', 'gapSize', 'scale', 'visible',
      'flatShading', 'dithering', 'lights', 'clipping',
    ];
    for (const k of scalarKeys) {
      if (k in spec && k in m) {
        if (isExisting && SHADER_RECOMPILE_KEYS.has(k) && m[k] !== spec[k]) {
          shaderPropsChanged = true;
        }
        m[k] = spec[k];
      }
    }
    const texKeys = ['map', 'alphaMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'normalMap'];
    for (const tk of texKeys) {
      if (tk in spec && tk in m) {
        const tid = Number(spec[tk]);
        const nextTex = tid > 0 ? (entry.textures.get(tid) ?? null) : null;
        if (isExisting && Boolean(m[tk]) !== Boolean(nextTex)) {
          shaderPropsChanged = true;
        }
        m[tk] = nextTex;
      }
    }
    if ((mat as import('three').ShaderMaterial).isShaderMaterial) {
      const sm = mat as import('three').ShaderMaterial;
      let recompile = shaderPropsChanged;
      if (typeof spec.vertexShader === 'string' && sm.vertexShader !== spec.vertexShader) {
        sm.vertexShader = spec.vertexShader;
        recompile = true;
      }
      if (typeof spec.fragmentShader === 'string' && sm.fragmentShader !== spec.fragmentShader) {
        sm.fragmentShader = spec.fragmentShader;
        recompile = true;
      }
      if (spec.defines && typeof spec.defines === 'object' && !Array.isArray(spec.defines)) {
        const cleanDefines: Record<string, unknown> = Object.create(null);
        for (const [dk, dv] of Object.entries(spec.defines as Record<string, unknown>)) {
          if (BLOCKED_THREE_KEYS.has(dk)) continue;
          cleanDefines[dk] = dv;
        }
        sm.defines = cleanDefines;
        recompile = true;
      }
      if (spec.extensions && typeof spec.extensions === 'object' && !Array.isArray(spec.extensions)) {
        const extTarget = sm.extensions as unknown as Record<string, unknown>;
        for (const [ek, ev] of Object.entries(spec.extensions as Record<string, unknown>)) {
          if (BLOCKED_THREE_KEYS.has(ek) || !ALLOWED_SHADER_EXTENSIONS.has(ek)) continue;
          if (typeof ev === 'boolean') extTarget[ek] = ev;
        }
      }
      if (typeof spec.glslVersion === 'string') {
        sm.glslVersion = spec.glslVersion as import('three').GLSLVersion;
      }
      if (spec.uniforms && typeof spec.uniforms === 'object' && !Array.isArray(spec.uniforms)) {
        const nextUniforms: Record<string, import('three').IUniform> = sm.uniforms ?? Object.create(null);
        for (const [uk, uv] of Object.entries(spec.uniforms as Record<string, unknown>)) {
          if (BLOCKED_THREE_KEYS.has(uk)) continue;
          if (!Object.prototype.hasOwnProperty.call(nextUniforms, uk) || !nextUniforms[uk]) {
            nextUniforms[uk] = { value: decodeUniformValue(THREE, entry, uv) };
          } else {
            nextUniforms[uk].value = decodeUniformValue(THREE, entry, uv, nextUniforms[uk].value);
          }
        }
        sm.uniforms = nextUniforms;
      }
      if (recompile) sm.needsUpdate = true;
    } else if (spec.needsUpdate || shaderPropsChanged) {
      mat.needsUpdate = true;
    }
  }

  private applyObjectOp(
    THREE: ThreeNamespace,
    entry: NativeThreeRendererEntry,
    id: number,
    kind: string,
    spec: Record<string, unknown>,
    resolvers?: ThreeFrameResolvers
  ): void {
    let obj = entry.objects.get(id);
    if (!obj) {
      if (entry.objects.size >= MAX_OBJECTS) return;
      switch (kind) {
        case 'Scene': obj = new THREE.Scene(); break;
        case 'Group': obj = new THREE.Group(); break;
        case 'GLTF': {
          const holder = new THREE.Group();
          (holder.userData as Record<string, unknown>).__softnGltf = true;
          obj = holder;
          if (typeof spec.src === 'string' && spec.src) {
            this.loadGltfIntoHolder(THREE, entry, holder, spec.src, resolvers);
          }
          break;
        }
        case 'Mesh': {
          const geo = entry.geometries.get(Number(spec.geo));
          const mat = this.resolveMaterial(entry, spec.mat);
          obj = new THREE.Mesh(geo, mat);
          break;
        }
        case 'InstancedMesh': {
          const geo = entry.geometries.get(Number(spec.geo));
          const mat = this.resolveMaterial(entry, spec.mat);
          const cap = Math.max(1, Math.min(MAX_INSTANCED_MESH_CAP, Math.floor(Number(spec.cap) || Number(spec.count) || 1)));
          const matrixBytes = cap * 64;
          if (!this.trackResourceBytes(entry, `im-mat:${id}`, matrixBytes)) return;
          obj = new THREE.InstancedMesh(geo, mat, cap);
          break;
        }
        case 'Line': {
          obj = new THREE.Line(entry.geometries.get(Number(spec.geo)), this.resolveMaterial(entry, spec.mat));
          break;
        }
        case 'LineSegments': {
          obj = new THREE.LineSegments(entry.geometries.get(Number(spec.geo)), this.resolveMaterial(entry, spec.mat));
          break;
        }
        case 'LineLoop': {
          obj = new THREE.LineLoop(entry.geometries.get(Number(spec.geo)), this.resolveMaterial(entry, spec.mat));
          break;
        }
        case 'Points': {
          obj = new THREE.Points(entry.geometries.get(Number(spec.geo)), this.resolveMaterial(entry, spec.mat));
          break;
        }
        case 'Sprite': {
          obj = new THREE.Sprite(this.resolveMaterial(entry, spec.mat) as import('three').SpriteMaterial);
          break;
        }
        case 'AmbientLight': obj = new THREE.AmbientLight(); break;
        case 'HemisphereLight': obj = new THREE.HemisphereLight(); break;
        case 'DirectionalLight': obj = new THREE.DirectionalLight(); break;
        case 'PointLight': obj = new THREE.PointLight(); break;
        case 'SpotLight': obj = new THREE.SpotLight(); break;
        case 'PerspectiveCamera': {
          const far = Number(spec.far) || 2000;
          const near = safePerspectiveNear(Number(spec.near) || 0.1, far);
          obj = new THREE.PerspectiveCamera(
            Number(spec.fov) || 50,
            Number(spec.aspect) || 1,
            near,
            far
          );
          break;
        }
        case 'OrthographicCamera':
          obj = new THREE.OrthographicCamera(
            Number(spec.left) || -1,
            Number(spec.right) || 1,
            Number(spec.top) || 1,
            Number(spec.bottom) || -1,
            Number(spec.near) || 0.1,
            Number(spec.far) || 2000
          );
          break;
        default:
          obj = new THREE.Object3D();
          break;
      }
      obj.userData.__snId = id;
      entry.objects.set(id, obj);
    }

    if (typeof spec.castShadow === 'boolean') obj.castShadow = spec.castShadow;
    if (typeof spec.receiveShadow === 'boolean') obj.receiveShadow = spec.receiveShadow;
    if (typeof spec.frustumCulled === 'boolean') obj.frustumCulled = spec.frustumCulled;
    if (typeof spec.renderOrder === 'number') obj.renderOrder = spec.renderOrder;
    if (typeof spec.visible === 'boolean') obj.visible = spec.visible;
    if (typeof spec.layersMask === 'number') obj.layers.mask = spec.layersMask;

    if ('geo' in spec && 'geometry' in obj) {
      const g = entry.geometries.get(Number(spec.geo));
      if (g) (obj as import('three').Mesh).geometry = g;
    }
    if ('mat' in spec && 'material' in obj) {
      const m = this.resolveMaterial(entry, spec.mat);
      if (m) (obj as import('three').Mesh).material = m;
    }

    // Light properties
    if ((obj as import('three').Light).isLight) {
      const l = obj as import('three').Light;
      if (Array.isArray(spec.color)) l.color.setRGB(spec.color[0], spec.color[1], spec.color[2]);
      if (typeof spec.intensity === 'number') l.intensity = spec.intensity;
      if ((obj as import('three').HemisphereLight).isHemisphereLight && Array.isArray(spec.groundColor)) {
        (obj as import('three').HemisphereLight).groundColor.setRGB(
          spec.groundColor[0],
          spec.groundColor[1],
          spec.groundColor[2]
        );
      }
      if ((obj as import('three').PointLight).isPointLight) {
        const pl = obj as import('three').PointLight;
        if (typeof spec.distance === 'number') pl.distance = spec.distance;
        if (typeof spec.decay === 'number') pl.decay = spec.decay;
      }
      if ((obj as import('three').SpotLight).isSpotLight) {
        const sl = obj as import('three').SpotLight;
        if (typeof spec.distance === 'number') sl.distance = spec.distance;
        if (typeof spec.decay === 'number') sl.decay = spec.decay;
        if (typeof spec.angle === 'number') sl.angle = spec.angle;
        if (typeof spec.penumbra === 'number') sl.penumbra = spec.penumbra;
      }
      if (typeof spec.targetId === 'number' && 'target' in obj) {
        const tgt = entry.objects.get(spec.targetId);
        if (tgt) (obj as import('three').DirectionalLight).target = tgt;
      }
      if (spec.shadow && typeof spec.shadow === 'object' && 'shadow' in obj && (obj as import('three').DirectionalLight).shadow) {
        const sh = (obj as import('three').DirectionalLight).shadow;
        const sSpec = spec.shadow as Record<string, unknown>;
        if (Array.isArray(sSpec.mapSize)) {
          const mw = Math.max(64, Math.min(2048, Number(sSpec.mapSize[0]) || 512));
          const mh = Math.max(64, Math.min(2048, Number(sSpec.mapSize[1]) || 512));
          if (sh.mapSize.width !== mw || sh.mapSize.height !== mh) {
            sh.mapSize.set(mw, mh);
            if (sh.map) {
              sh.map.dispose();
              sh.map = null;
            }
          }
        }
        if (typeof sSpec.bias === 'number') sh.bias = sSpec.bias;
        if (typeof sSpec.normalBias === 'number') sh.normalBias = sSpec.normalBias;
        if (typeof sSpec.radius === 'number') sh.radius = sSpec.radius;
        if (sSpec.cam && typeof sSpec.cam === 'object' && (sh.camera as import('three').OrthographicCamera).isOrthographicCamera) {
          const sc = sh.camera as import('three').OrthographicCamera;
          const cSpec = sSpec.cam as Record<string, unknown>;
          if (typeof cSpec.left === 'number') sc.left = cSpec.left;
          if (typeof cSpec.right === 'number') sc.right = cSpec.right;
          if (typeof cSpec.top === 'number') sc.top = cSpec.top;
          if (typeof cSpec.bottom === 'number') sc.bottom = cSpec.bottom;
          if (typeof cSpec.near === 'number') sc.near = cSpec.near;
          if (typeof cSpec.far === 'number') sc.far = cSpec.far;
          sc.updateProjectionMatrix();
        }
      }
    }
  }

  private resolveMaterial(
    entry: NativeThreeRendererEntry,
    matSpec: unknown
  ): import('three').Material | import('three').Material[] | undefined {
    if (Array.isArray(matSpec)) {
      const list = matSpec.map((id) => entry.materials.get(Number(id))).filter((m): m is import('three').Material => Boolean(m));
      return list.length > 0 ? list : undefined;
    }
    return entry.materials.get(Number(matSpec));
  }

  raycast(
    rendererId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    near: number,
    far: number,
    targetIds: number[],
    recursive: boolean,
    cameraId?: number
  ): Array<{
    id: number;
    d: number;
    p: [number, number, number];
    fi?: number;
    uv?: [number, number];
    ii?: number;
  }> {
    const THREE = this.THREE;
    const entry = this.renderers.get(rendererId);
    if (!THREE || !entry) return [];

    const targets: import('three').Object3D[] = [];
    for (let i = 0; i < targetIds.length; i++) {
      const o = entry.objects.get(targetIds[i]);
      if (o) targets.push(o);
    }
    if (targets.length === 0) return [];

    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.set(origin[0] || 0, origin[1] || 0, origin[2] || 0);
    raycaster.ray.direction.set(direction[0] || 0, direction[1] || 0, direction[2] || -1).normalize();
    raycaster.near = Number.isFinite(near) ? near : 0;
    raycaster.far = Number.isFinite(far) ? far : Infinity;
    if (cameraId && cameraId > 0) {
      const cam = entry.objects.get(cameraId);
      if (cam && (cam as import('three').Camera).isCamera) {
        raycaster.camera = cam as import('three').Camera;
      }
    }

    // Ensure root world matrices are current before intersecting (bounded against cyclic graphs).
    const roots = new Set<import('three').Object3D>();
    for (const t of targets) {
      let cur = t;
      const seen = new Set<import('three').Object3D>([cur]);
      while (cur.parent && !seen.has(cur.parent) && seen.size < MAX_OBJECTS) {
        cur = cur.parent;
        seen.add(cur);
      }
      roots.add(cur);
    }
    for (const r of roots) r.updateMatrixWorld();

    const hits = raycaster.intersectObjects(targets, recursive);
    const out: Array<{
      id: number;
      d: number;
      p: [number, number, number];
      fi?: number;
      uv?: [number, number];
      ii?: number;
    }> = [];
    for (let i = 0; i < hits.length && i < 64; i++) {
      const h = hits[i];
      const snId = Number(h.object?.userData?.__snId);
      if (!snId) continue;
      out.push({
        id: snId,
        d: h.distance,
        p: [h.point.x, h.point.y, h.point.z],
        ...(typeof h.faceIndex === 'number' ? { fi: h.faceIndex } : {}),
        ...(h.uv ? { uv: [h.uv.x, h.uv.y] } : {}),
        ...(typeof h.instanceId === 'number' ? { ii: h.instanceId } : {}),
      });
    }
    return out;
  }

  takeDirtyFrames(): WebGLFramePayload[] {
    const out: WebGLFramePayload[] = [];
    for (const entry of this.renderers.values()) {
      if (!entry.dirty || entry.canvasId <= 0) continue;
      entry.dirty = false;
      if (entry.canvas.width <= 0 || entry.canvas.height <= 0) continue;
      if (typeof entry.canvas.transferToImageBitmap !== 'function') continue;
      try {
        const bitmap = entry.canvas.transferToImageBitmap();
        out.push({
          canvasId: entry.canvasId,
          bitmap,
          width: entry.canvas.width,
          height: entry.canvas.height,
        });
      } catch {
        // Ignore lost-context transfer failures
      }
    }
    return out;
  }

  disposeRenderer(rendererId: number): void {
    const entry = this.renderers.get(rendererId);
    if (!entry) return;
    this.renderers.delete(rendererId);
    this.releaseEntry(entry);
  }

  disposeCanvas(canvasId: number): void {
    for (const [id, entry] of [...this.renderers]) {
      if (entry.canvasId === canvasId) {
        this.renderers.delete(id);
        this.releaseEntry(entry);
      }
    }
  }

  disposeAll(): void {
    for (const entry of this.renderers.values()) {
      this.releaseEntry(entry);
    }
    this.renderers.clear();
    for (const tplPromise of this.gltfTemplateCache.values()) {
      void tplPromise.then((tpl) => { if (tpl) disposeObjectTree(tpl, true); }).catch(() => undefined);
    }
    this.gltfTemplateCache.clear();
  }

  private releaseEntry(entry: NativeThreeRendererEntry): void {
    entry.disposed = true;
    for (const g of entry.geometries.values()) {
      try { g.dispose(); } catch { /* ignore */ }
    }
    for (const m of entry.materials.values()) {
      try { m.dispose(); } catch { /* ignore */ }
    }
    for (const t of entry.textures.values()) {
      try { t.dispose(); } catch { /* ignore */ }
    }
    entry.geometries.clear();
    entry.materials.clear();
    entry.textures.clear();
    entry.objects.clear();
    try {
      entry.renderer.dispose();
    } catch {
      // ignore
    }
    try {
      entry.renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // ignore
    }
    try {
      entry.canvas.width = 1;
      entry.canvas.height = 1;
    } catch {
      // ignore
    }
  }
}
