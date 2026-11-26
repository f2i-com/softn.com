/**
 * Worker-Side Hardware-Accelerated WebGL / WebGL2 Host (`OffscreenCanvas`).
 *
 * Executes batched & synchronous WebGL1/WebGL2 calls from the sandboxed guest VM
 * against a real browser `OffscreenCanvas` GPU context inside `container-worker.js`,
 * then transfers finished frames zero-copy to the host `<canvas>` via
 * `OffscreenCanvas.transferToImageBitmap()` -> `ImageBitmapRenderingContext.transferFromImageBitmap()`.
 *
 * Security & resource bounds:
 * - Strictly caps concurrent contexts, object handles per context, drawing dimensions,
 *   and single-upload byte size.
 * - Never exposes host DOM or raw GPU handles to guest code (integer handle table only).
 * - Cleanly releases GPU contexts (`WEBGL_lose_context`) on canvas sweep or container dispose.
 */

import { base64ToBytes, bytesToBase64, canvasSide } from './worker-gpu-utils';

const MAX_WEBGL_CONTEXTS = 16;
const MAX_WEBGL_HANDLES = 32_768;
const MAX_WEBGL_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_WEBGL_CUMULATIVE_BYTES = 256 * 1024 * 1024;
const SERVER_HANDLE_BASE = 1_000_000_000;

/** Explicit allowlist of read/query/status WebGL methods permitted on the synchronous `syncCmd` path. */
const ALLOWED_SYNC_GL_METHODS: ReadonlySet<string> = new Set([
  'getUniformLocation', 'getAttribLocation', 'getShaderParameter', 'getProgramParameter',
  'getShaderInfoLog', 'getProgramInfoLog', 'getActiveUniform', 'getActiveAttrib',
  'getActiveUniformBlockName', 'getActiveUniformBlockParameter', 'getActiveUniforms',
  'getUniformBlockIndex', 'getBufferParameter', 'getFramebufferAttachmentParameter',
  'getRenderbufferParameter', 'getTexParameter', 'getVertexAttrib', 'getVertexAttribOffset',
  'getUniform', 'getQuery', 'getQueryParameter', 'getSamplerParameter', 'getSyncParameter',
  'getIndexedParameter', 'getInternalformatParameter', 'getFragDataLocation',
  'getTransformFeedbackVarying', 'getAttachedShaders', 'getShaderSource', 'getError',
  'checkFramebufferStatus', 'clientWaitSync', 'getParameter', 'readPixels',
  'isBuffer', 'isEnabled', 'isFramebuffer', 'isProgram', 'isQuery', 'isRenderbuffer',
  'isSampler', 'isShader', 'isSync', 'isTexture', 'isTransformFeedback', 'isVertexArray',
]);

/** Explicit allowlist of WebGL object-creation methods permitted for `op === 'c'`. */
const CREATE_KIND_BY_METHOD: Readonly<Record<string, string>> = {
  createBuffer: 'buffer',
  createTexture: 'texture',
  createProgram: 'program',
  createShader: 'shader',
  createFramebuffer: 'framebuffer',
  createRenderbuffer: 'renderbuffer',
  createVertexArray: 'vao',
  createQuery: 'query',
  createSampler: 'sampler',
  createTransformFeedback: 'transformFeedback',
  fenceSync: 'sync',
};

/** Explicit allowlist of WebGL object-deletion methods permitted for `op === 'd'` and their expected object kind. */
const DELETE_KIND_BY_METHOD: Readonly<Record<string, string>> = {
  deleteBuffer: 'buffer',
  deleteTexture: 'texture',
  deleteProgram: 'program',
  deleteShader: 'shader',
  deleteFramebuffer: 'framebuffer',
  deleteRenderbuffer: 'renderbuffer',
  deleteVertexArray: 'vao',
  deleteQuery: 'query',
  deleteSampler: 'sampler',
  deleteTransformFeedback: 'transformFeedback',
  deleteSync: 'sync',
};

/** WebGL methods that mutate the default/active drawing buffer and schedule a frame presentation. */
const DRAW_METHODS = new Set([
  'clear',
  'drawArrays',
  'drawElements',
  'drawArraysInstanced',
  'drawElementsInstanced',
  'drawRangeElements',
  'blitFramebuffer',
  'clearBufferfv',
  'clearBufferiv',
  'clearBufferuiv',
  'clearBufferfi',
]);

/** Static capability parameters pre-cached once on `webgl.init` so Three.js startup incurs 0 extra sync calls. */
const STATIC_PARAM_NAMES = [
  'VERSION',
  'SHADING_LANGUAGE_VERSION',
  'VENDOR',
  'RENDERER',
  'MAX_TEXTURE_SIZE',
  'MAX_CUBE_MAP_TEXTURE_SIZE',
  'MAX_VERTEX_ATTRIBS',
  'MAX_VERTEX_UNIFORM_VECTORS',
  'MAX_FRAGMENT_UNIFORM_VECTORS',
  'MAX_VARYING_VECTORS',
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
  'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
  'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_RENDERBUFFER_SIZE',
  'MAX_SAMPLES',
  'MAX_3D_TEXTURE_SIZE',
  'MAX_ARRAY_TEXTURE_LAYERS',
  'MAX_UNIFORM_BUFFER_BINDINGS',
  'MAX_UNIFORM_BLOCK_SIZE',
  'UNIFORM_BUFFER_OFFSET_ALIGNMENT',
  'MAX_COLOR_ATTACHMENTS',
  'MAX_DRAW_BUFFERS',
  'MAX_VIEWPORT_DIMS',
  'ALIASED_LINE_WIDTH_RANGE',
  'ALIASED_POINT_SIZE_RANGE',
  'SUBPIXEL_BITS',
  'RED_BITS',
  'GREEN_BITS',
  'BLUE_BITS',
  'ALPHA_BITS',
  'DEPTH_BITS',
  'STENCIL_BITS',
  'MAX_ELEMENTS_VERTICES',
  'MAX_ELEMENTS_INDICES',
  'MAX_VARYING_COMPONENTS',
  'MAX_VERTEX_UNIFORM_COMPONENTS',
  'MAX_FRAGMENT_UNIFORM_COMPONENTS',
  'MAX_VERTEX_UNIFORM_BLOCKS',
  'MAX_FRAGMENT_UNIFORM_BLOCKS',
  'MAX_COMBINED_UNIFORM_BLOCKS',
  'MAX_TEXTURE_LOD_BIAS',
  'MIN_PROGRAM_TEXEL_OFFSET',
  'MAX_PROGRAM_TEXEL_OFFSET',
];

const SHADER_TYPES = ['VERTEX_SHADER', 'FRAGMENT_SHADER'] as const;
const PRECISION_TYPES = [
  'LOW_FLOAT',
  'MEDIUM_FLOAT',
  'HIGH_FLOAT',
  'LOW_INT',
  'MEDIUM_INT',
  'HIGH_INT',
] as const;

type AnyWebGLContext = WebGL2RenderingContext | WebGLRenderingContext;

interface WebGLCtxEntry {
  ctxId: number;
  canvasId: number;
  canvas: OffscreenCanvas;
  gl: AnyWebGLContext;
  isWebGL2: boolean;
  handles: Map<number, unknown>;
  /** Object kind recorded at creation (`buffer`, `texture`, etc.) to prevent cross-type delete eviction. */
  handleKinds: Map<number, string>;
  /** Cumulative GPU allocation accounting (`resourceKey` -> bytes) bounded by MAX_WEBGL_CUMULATIVE_BYTES. */
  handleBytes: Map<string, number>;
  allocatedBytes: number;
  activeTextureUnit: number;
  boundBuffers: Map<number, number>;
  boundTextures: Map<string, number>;
  boundRenderbuffer: number;
  /** O(1) reverse map from opaque WebGL object -> handle id (avoids O(N) scan in encodeSimpleReturn). */
  handleIds: WeakMap<object, number>;
  /** Cache `programHid:uniformName` -> server handle id so per-frame getUniformLocation calls never leak handles. */
  uniformLocations: Map<string, number>;
  extensions: Map<string, Record<string, unknown>>;
  extensionMeta: Map<string, { constants: Record<string, number>; methods: string[] }>;
  allowedMethods: Set<string>;
  extensionMethods: Map<string, Set<string>>;
  nextServerHandleId: number;
  dirty: boolean;
  hasDrawn: boolean;
}

export interface WebGLFramePayload {
  canvasId: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface WebGLExecResolvers {
  getCanvas2DMirror?: (id: number, width: number, height: number, pendingCmds: unknown[]) => OffscreenCanvas | null;
  getImageBitmap?: (ref: string) => ImageBitmap | null;
}

function decodeTypedArray(typeCode: string, b64: string): ArrayBufferView | ArrayBuffer {
  if (Math.ceil((b64.length * 3) / 4) > MAX_WEBGL_UPLOAD_BYTES + 4) {
    throw new RangeError('WebGL buffer upload exceeds size limit');
  }
  const bytes = base64ToBytes(b64);
  if (bytes.byteLength > MAX_WEBGL_UPLOAD_BYTES) {
    throw new RangeError('WebGL buffer upload exceeds size limit');
  }
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  switch (typeCode) {
    case 'f32': return new Float32Array(buf);
    case 'f64': return new Float64Array(buf);
    case 'i8': return new Int8Array(buf);
    case 'u8': return new Uint8Array(buf);
    case 'u8c': return new Uint8ClampedArray(buf);
    case 'i16': return new Int16Array(buf);
    case 'u16': return new Uint16Array(buf);
    case 'i32': return new Int32Array(buf);
    case 'u32': return new Uint32Array(buf);
    case 'ab': return buf;
    default: return new Uint8Array(buf);
  }
}

function typeCodeOf(view: ArrayBufferView): string {
  if (view instanceof Float32Array) return 'f32';
  if (view instanceof Uint16Array) return 'u16';
  if (view instanceof Uint32Array) return 'u32';
  if (view instanceof Int32Array) return 'i32';
  if (view instanceof Int16Array) return 'i16';
  if (view instanceof Int8Array) return 'i8';
  if (view instanceof Uint8ClampedArray) return 'u8c';
  return 'u8';
}

function encodeSimpleReturn(val: unknown, entry: WebGLCtxEntry): unknown {
  if (val === null || val === undefined) return null;
  const t = typeof val;
  if (t === 'boolean' || t === 'number' || t === 'string') return val;
  if (Array.isArray(val)) return val.map((v) => encodeSimpleReturn(v, entry));
  if (ArrayBuffer.isView(val)) {
    return { __glTA: typeCodeOf(val), data: Array.from(val as unknown as ArrayLike<number>) };
  }
  // WebGLActiveInfo ({ name, size, type })
  if (typeof (val as { name?: unknown; size?: unknown; type?: unknown }).name === 'string' &&
      typeof (val as { size?: unknown }).size === 'number' &&
      typeof (val as { type?: unknown }).type === 'number') {
    const info = val as WebGLActiveInfo;
    return { name: info.name, size: info.size, type: info.type };
  }
  // WebGLShaderPrecisionFormat ({ rangeMin, rangeMax, precision })
  if (typeof (val as { rangeMin?: unknown; precision?: unknown }).rangeMin === 'number' &&
      typeof (val as { precision?: unknown }).precision === 'number') {
    const fmt = val as WebGLShaderPrecisionFormat;
    return { rangeMin: fmt.rangeMin, rangeMax: fmt.rangeMax, precision: fmt.precision };
  }
  // Opaque WebGL object (e.g. getParameter(CURRENT_PROGRAM) / getUniformLocation) — O(1) via WeakMap.
  if (typeof val === 'object') {
    const existing = entry.handleIds.get(val as object);
    if (existing !== undefined && entry.handles.get(existing) === val) {
      return { __glH: existing };
    }
  }
  if (entry.handles.size < MAX_WEBGL_HANDLES) {
    const hid = entry.nextServerHandleId++;
    entry.handles.set(hid, val);
    if (typeof val === 'object') entry.handleIds.set(val as object, hid);
    return { __glH: hid };
  }
  return null;
}

export class WebGLWorkerHost {
  private readonly contexts = new Map<number, WebGLCtxEntry>();
  private nextCtxId = 1;

  hasActiveContexts(): boolean {
    return this.contexts.size > 0;
  }

  init(
    canvasId: number,
    requestedKind: string,
    width: number,
    height: number,
    attrs?: Record<string, unknown>
  ): Record<string, unknown> | null {
    if (typeof OffscreenCanvas !== 'function') return null;
    if (this.contexts.size >= MAX_WEBGL_CONTEXTS) {
      // Evict the oldest never-drawn probe context (e.g. feature-detection canvases like `webglAvailable()`).
      for (const [oldId, oldEntry] of this.contexts) {
        if (!oldEntry.hasDrawn) {
          this.contexts.delete(oldId);
          this.releaseEntry(oldEntry);
          break;
        }
      }
      if (this.contexts.size >= MAX_WEBGL_CONTEXTS) return null;
    }

    const w = Math.max(1, Math.min(4096, canvasSide(width) || 300));
    const h = Math.max(1, Math.min(4096, canvasSide(height) || 150));
    let canvas: OffscreenCanvas;
    let gl: AnyWebGLContext | null = null;
    let isWebGL2 = false;

    try {
      canvas = new OffscreenCanvas(w, h);
      const want2 = requestedKind === 'webgl2';
      const contextOpts: WebGLContextAttributes = {
        alpha: attrs?.alpha !== undefined ? Boolean(attrs.alpha) : true,
        depth: attrs?.depth !== undefined ? Boolean(attrs.depth) : true,
        stencil: attrs?.stencil !== undefined ? Boolean(attrs.stencil) : false,
        antialias: attrs?.antialias !== undefined ? Boolean(attrs.antialias) : true,
        premultipliedAlpha: attrs?.premultipliedAlpha !== undefined ? Boolean(attrs.premultipliedAlpha) : true,
        preserveDrawingBuffer: attrs?.preserveDrawingBuffer !== undefined ? Boolean(attrs.preserveDrawingBuffer) : false,
        powerPreference:
          attrs?.powerPreference === 'high-performance' || attrs?.powerPreference === 'low-power'
            ? attrs.powerPreference
            : 'default',
        failIfMajorPerformanceCaveat: Boolean(attrs?.failIfMajorPerformanceCaveat),
      };
      if (want2) {
        gl = canvas.getContext('webgl2', contextOpts) as WebGL2RenderingContext | null;
        isWebGL2 = Boolean(gl);
      } else {
        gl = (canvas.getContext('webgl', contextOpts) ??
          (canvas.getContext as (id: string, opts?: WebGLContextAttributes) => RenderingContext | null)(
            'experimental-webgl',
            contextOpts
          )) as WebGLRenderingContext | null;
      }
    } catch {
      return null;
    }

    if (!gl) return null;

    const ctxId = this.nextCtxId++;
    const allowedMethods = new Set<string>();
    const entry: WebGLCtxEntry = {
      ctxId,
      canvasId: Number.isInteger(canvasId) && canvasId > 0 ? canvasId : 0,
      canvas,
      gl,
      isWebGL2,
      handles: new Map(),
      handleKinds: new Map(),
      handleBytes: new Map(),
      allocatedBytes: 0,
      activeTextureUnit: 0,
      boundBuffers: new Map(),
      boundTextures: new Map(),
      boundRenderbuffer: 0,
      handleIds: new WeakMap(),
      uniformLocations: new Map(),
      extensions: new Map(),
      extensionMeta: new Map(),
      allowedMethods,
      extensionMethods: new Map(),
      nextServerHandleId: SERVER_HANDLE_BASE,
      dirty: false,
      hasDrawn: false,
    };
    this.contexts.set(ctxId, entry);

    // Collect all GL constants & callable method names from the real context prototype chain
    const constants: Record<string, number> = Object.create(null);
    const methodsSet = allowedMethods;
    const glRec = gl as unknown as Record<string, unknown>;
    for (let proto: object | null = gl; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor' || key.startsWith('_')) continue;
        if (/^[A-Z][A-Z0-9_]+$/.test(key)) {
          const val = glRec[key];
          if (typeof val === 'number') constants[key] = val;
        } else {
          const desc = Object.getOwnPropertyDescriptor(proto, key);
          if (desc && typeof desc.value === 'function') {
            methodsSet.add(key);
          }
        }
      }
    }

    // Pre-cache immutable capability parameters so Three.js startup incurs zero extra roundtrips
    const params: Record<number, unknown> = Object.create(null);
    for (const name of STATIC_PARAM_NAMES) {
      const code = constants[name];
      if (code === undefined) continue;
      try {
        const val = gl.getParameter(code);
        if (val !== undefined) params[code] = encodeSimpleReturn(val, entry);
      } catch {
        // Ignore parameters unavailable on this WebGL version
      }
    }

    // Pre-cache shader precision formats
    const precisions: Record<string, { rangeMin: number; rangeMax: number; precision: number } | null> = Object.create(null);
    for (const sName of SHADER_TYPES) {
      const sCode = constants[sName];
      if (sCode === undefined) continue;
      for (const pName of PRECISION_TYPES) {
        const pCode = constants[pName];
        if (pCode === undefined) continue;
        try {
          const fmt = gl.getShaderPrecisionFormat(sCode, pCode);
          precisions[`${sCode}:${pCode}`] = fmt
            ? { rangeMin: fmt.rangeMin, rangeMax: fmt.rangeMax, precision: fmt.precision }
            : null;
        } catch {
          precisions[`${sCode}:${pCode}`] = null;
        }
      }
    }

    return {
      ctxId,
      isWebGL2,
      width: canvas.width,
      height: canvas.height,
      constants,
      params,
      precisions,
      supportedExtensions: gl.getSupportedExtensions() ?? [],
      contextAttributes: gl.getContextAttributes() ?? {},
      methods: [...methodsSet],
    };
  }

  getExtension(ctxId: number, name: string): Record<string, unknown> | null {
    const entry = this.contexts.get(ctxId);
    if (!entry) return null;
    const cachedMeta = entry.extensionMeta.get(name);
    if (cachedMeta) return cachedMeta;
    let ext = entry.extensions.get(name);
    if (!ext) {
      let raw: unknown = null;
      try {
        raw = entry.gl.getExtension(name);
      } catch {
        raw = null;
      }
      if (!raw || typeof raw !== 'object') return null;
      ext = raw as Record<string, unknown>;
      entry.extensions.set(name, ext);
    }
    const constants: Record<string, number> = Object.create(null);
    const methods: string[] = [];
    const extMethodSet = new Set<string>();
    for (let proto: object | null = ext; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor' || key.startsWith('_')) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (desc && typeof desc.value === 'function') {
          if (!extMethodSet.has(key)) {
            extMethodSet.add(key);
            methods.push(key);
          }
        } else {
          const val = ext[key];
          if (typeof val === 'number') constants[key] = val;
        }
      }
    }
    entry.extensionMethods.set(name, extMethodSet);
    const meta = { constants, methods };
    entry.extensionMeta.set(name, meta);
    return meta;
  }

  private decodeArg(arg: unknown, entry: WebGLCtxEntry, resolvers?: WebGLExecResolvers): unknown {
    if (!Array.isArray(arg) || arg.length === 0 || typeof arg[0] !== 'string' || !arg[0].startsWith('$')) {
      return arg;
    }
    switch (arg[0]) {
      case '$h':
        return entry.handles.get(Number(arg[1])) ?? null;
      case '$b':
        return decodeTypedArray(String(arg[1]), String(arg[2]));
      case '$f32': {
        if (!Array.isArray(arg[1]) || arg[1].length * 4 > MAX_WEBGL_UPLOAD_BYTES) {
          throw new RangeError('WebGL Float32Array upload exceeds size limit');
        }
        return new Float32Array(arg[1] as number[]);
      }
      case '$i32': {
        if (!Array.isArray(arg[1]) || arg[1].length * 4 > MAX_WEBGL_UPLOAD_BYTES) {
          throw new RangeError('WebGL Int32Array upload exceeds size limit');
        }
        return new Int32Array(arg[1] as number[]);
      }
      case '$u32': {
        if (!Array.isArray(arg[1]) || arg[1].length * 4 > MAX_WEBGL_UPLOAD_BYTES) {
          throw new RangeError('WebGL Uint32Array upload exceeds size limit');
        }
        return new Uint32Array(arg[1] as number[]);
      }
      case '$c2d': {
        const cid = Number(arg[1]);
        const w = Number(arg[2]);
        const h = Number(arg[3]);
        const pending = Array.isArray(arg[4]) ? (arg[4] as unknown[]) : [];
        return resolvers?.getCanvas2DMirror?.(cid, w, h, pending) ?? null;
      }
      case '$gl': {
        const other = this.contexts.get(Number(arg[1]));
        return other ? other.canvas : null;
      }
      case '$img':
        return resolvers?.getImageBitmap?.(String(arg[1])) ?? null;
      case '$imagedata': {
        const w = Math.max(1, Math.min(4096, Math.floor(Number(arg[1]) || 1)));
        const h = Math.max(1, Math.min(4096, Math.floor(Number(arg[2]) || 1)));
        const expectedBytes = w * h * 4;
        const b64 = String(arg[3] ?? '');
        if (
          expectedBytes > MAX_WEBGL_UPLOAD_BYTES ||
          b64.length > Math.ceil((MAX_WEBGL_UPLOAD_BYTES * 4) / 3) + 16
        ) {
          throw new RangeError('WebGL ImageData upload exceeds size limit');
        }
        const raw = base64ToBytes(b64);
        return typeof ImageData === 'function' && raw.byteLength === expectedBytes
          ? new ImageData(new Uint8ClampedArray(raw), w, h)
          : null;
      }
      default:
        return arg;
    }
  }

  exec(
    ctxId: number,
    cmds: unknown[],
    syncCmd?: unknown[] | null,
    resolvers?: WebGLExecResolvers
  ): unknown {
    const entry = this.contexts.get(ctxId);
    if (!entry) return null;
    const gl = entry.gl;
    const glRec = gl as unknown as Record<string, (...a: unknown[]) => unknown>;

    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i];
      if (!Array.isArray(cmd) || cmd.length === 0) continue;
      const op = cmd[0];
      try {
        if (op === 'v') {
          const method = String(cmd[1]);
          if (!entry.allowedMethods.has(method)) continue;
          const fn = glRec[method];
          if (typeof fn !== 'function') continue;
          const decoded: unknown[] = [];
          for (let j = 2; j < cmd.length; j++) decoded.push(this.decodeArg(cmd[j], entry, resolvers));
          if (!this.checkAndTrackAllocation(entry, method, decoded)) {
            continue;
          }
          fn.apply(gl, decoded);
          this.updateBindingState(entry, method, cmd, decoded);
          if (method === 'linkProgram' && Array.isArray(cmd[2]) && cmd[2][0] === '$h') {
            const progPrefix = `${Number(cmd[2][1])}:`;
            for (const [key, uHid] of entry.uniformLocations) {
              if (key.startsWith(progPrefix)) {
                entry.uniformLocations.delete(key);
                entry.handles.delete(uHid);
              }
            }
          }
          if (DRAW_METHODS.has(method)) {
            entry.dirty = true;
            entry.hasDrawn = true;
          }
        } else if (op === 'c') {
          const method = String(cmd[1]);
          const kind = Object.prototype.hasOwnProperty.call(CREATE_KIND_BY_METHOD, method)
            ? CREATE_KIND_BY_METHOD[method]
            : undefined;
          if (!kind || !entry.allowedMethods.has(method)) continue;
          const hid = Number(cmd[2]);
          const fn = glRec[method];
          // Reject duplicate handle IDs so overwriting `hid` cannot leak unbounded GPU objects under MAX_WEBGL_HANDLES.
          if (typeof fn !== 'function' || entry.handles.has(hid) || entry.handles.size >= MAX_WEBGL_HANDLES) continue;
          const decoded: unknown[] = [];
          for (let j = 3; j < cmd.length; j++) decoded.push(this.decodeArg(cmd[j], entry, resolvers));
          const created = fn.apply(gl, decoded);
          if (created !== null && created !== undefined) {
            entry.handles.set(hid, created);
            entry.handleKinds.set(hid, kind);
            if (typeof created === 'object') entry.handleIds.set(created as object, hid);
          }
        } else if (op === 'd') {
          const method = String(cmd[1]);
          const expectedKind = Object.prototype.hasOwnProperty.call(DELETE_KIND_BY_METHOD, method)
            ? DELETE_KIND_BY_METHOD[method]
            : undefined;
          if (!expectedKind || !entry.allowedMethods.has(method)) continue;
          const hid = Number(cmd[2]);
          const obj = entry.handles.get(hid);
          const actualKind = entry.handleKinds.get(hid);
          const fn = glRec[method];
          // Require matching object kind and invoke GL delete BEFORE removing from the handle table
          // so invalid/mismatched delete calls cannot evict live GPU resources out of MAX_WEBGL_HANDLES.
          if (typeof fn !== 'function' || obj === undefined || (actualKind !== undefined && actualKind !== expectedKind)) {
            continue;
          }
          fn.call(gl, obj);
          entry.handles.delete(hid);
          entry.handleKinds.delete(hid);
          this.releaseHandleBytes(entry, hid);
          if (method === 'deleteProgram') {
            const progPrefix = `${hid}:`;
            for (const [key, uHid] of entry.uniformLocations) {
              if (key.startsWith(progPrefix)) {
                entry.uniformLocations.delete(key);
                entry.handles.delete(uHid);
              }
            }
          }
        } else if (op === 'resize') {
          const w = Math.max(1, Math.min(4096, canvasSide(Number(cmd[1])) || 1));
          const h = Math.max(1, Math.min(4096, canvasSide(Number(cmd[2])) || 1));
          if (entry.canvas.width !== w) entry.canvas.width = w;
          if (entry.canvas.height !== h) entry.canvas.height = h;
        } else if (op === 'canvasId') {
          const cid = Number(cmd[1]);
          if (Number.isInteger(cid) && cid > 0) entry.canvasId = cid;
        } else if (op === 'x') {
          const extName = String(cmd[1]);
          const method = String(cmd[2]);
          const ext = entry.extensions.get(extName);
          if (!ext || !entry.extensionMethods.get(extName)?.has(method)) continue;
          const fn = ext[method];
          if (typeof fn !== 'function') continue;
          const decoded: unknown[] = [];
          for (let j = 3; j < cmd.length; j++) decoded.push(this.decodeArg(cmd[j], entry, resolvers));
          (fn as (...a: unknown[]) => unknown).apply(ext, decoded);
          if (method.startsWith('draw')) {
            entry.dirty = true;
            entry.hasDrawn = true;
          }
        }
      } catch {
        // Invalid WebGL call sets GL error flag / no-ops without crashing the container Worker.
      }
    }

    if (!syncCmd || !Array.isArray(syncCmd) || syncCmd.length === 0) return null;

    try {
      if (syncCmd[0] === 'ext') {
        const extName = String(syncCmd[1]);
        const ext = entry.extensions.get(extName);
        const method = String(syncCmd[2]);
        if (!ext || !entry.extensionMethods.get(extName)?.has(method)) return null;
        const fn = ext[method];
        if (typeof fn !== 'function') return null;
        const decoded: unknown[] = [];
        for (let j = 3; j < syncCmd.length; j++) decoded.push(this.decodeArg(syncCmd[j], entry, resolvers));
        const res = (fn as (...a: unknown[]) => unknown).apply(ext, decoded);
        return encodeSimpleReturn(res, entry);
      }

      const method = String(syncCmd[0]);
      if (method === 'readPixels') {
        const x = Number(syncCmd[1]) || 0;
        const y = Number(syncCmd[2]) || 0;
        const w = Math.max(0, Math.min(4096, Number(syncCmd[3]) || 0));
        const h = Math.max(0, Math.min(4096, Number(syncCmd[4]) || 0));
        const format = Number(syncCmd[5]) || 0;
        const type = Number(syncCmd[6]) || 0;
        const byteLen = Math.min(MAX_WEBGL_UPLOAD_BYTES, Math.max(0, Number(syncCmd[7]) || w * h * 4));
        const typeCode = String(syncCmd[8] || 'u8');
        const buf = new ArrayBuffer(byteLen);
        let view: ArrayBufferView;
        switch (typeCode) {
          case 'f32': view = new Float32Array(buf); break;
          case 'u16': view = new Uint16Array(buf); break;
          case 'i32': view = new Int32Array(buf); break;
          case 'u32': view = new Uint32Array(buf); break;
          default: view = new Uint8Array(buf); break;
        }
        gl.readPixels(x, y, w, h, format, type, view);
        return { __glB64: bytesToBase64(new Uint8Array(buf)) };
      }

      if (!ALLOWED_SYNC_GL_METHODS.has(method) || !entry.allowedMethods.has(method)) return null;
      const fn = glRec[method];
      if (typeof fn !== 'function') return null;
      const decoded: unknown[] = [];
      for (let j = 1; j < syncCmd.length; j++) decoded.push(this.decodeArg(syncCmd[j], entry, resolvers));
      const res = fn.apply(gl, decoded);
      if (method === 'getUniformLocation') {
        if (res === null || res === undefined) return null;
        const progHid = Array.isArray(syncCmd[1]) && syncCmd[1][0] === '$h' ? Number(syncCmd[1][1]) : -1;
        const uName = typeof syncCmd[2] === 'string' ? syncCmd[2] : '';
        const cacheKey = progHid >= 0 ? `${progHid}:${uName}` : null;
        if (cacheKey !== null) {
          const existingHid = entry.uniformLocations.get(cacheKey);
          if (existingHid !== undefined && entry.handles.has(existingHid)) {
            entry.handles.set(existingHid, res);
            return { __glH: existingHid };
          }
        }
        if (entry.handles.size >= MAX_WEBGL_HANDLES) return null;
        const hid = entry.nextServerHandleId++;
        entry.handles.set(hid, res);
        if (cacheKey !== null) entry.uniformLocations.set(cacheKey, hid);
        return { __glH: hid };
      }
      return encodeSimpleReturn(res, entry);
    } catch {
      return null;
    }
  }

  takeDirtyFrames(): WebGLFramePayload[] {
    const out: WebGLFramePayload[] = [];
    for (const entry of this.contexts.values()) {
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

  disposeContext(ctxId: number): void {
    const entry = this.contexts.get(ctxId);
    if (!entry) return;
    this.contexts.delete(ctxId);
    this.releaseEntry(entry);
  }

  disposeCanvas(canvasId: number): void {
    for (const [ctxId, entry] of [...this.contexts]) {
      if (entry.canvasId === canvasId) {
        this.contexts.delete(ctxId);
        this.releaseEntry(entry);
      }
    }
  }

  disposeAll(): void {
    for (const entry of this.contexts.values()) {
      this.releaseEntry(entry);
    }
    this.contexts.clear();
  }

  private updateBindingState(entry: WebGLCtxEntry, method: string, rawCmd: unknown[], decoded: unknown[]): void {
    const rawHandleId = (arg: unknown): number =>
      Array.isArray(arg) && arg[0] === '$h' ? Number(arg[1]) || 0 : 0;
    if (method === 'bindBuffer' && typeof decoded[0] === 'number') {
      const hid = rawHandleId(rawCmd[3]);
      if (hid > 0) entry.boundBuffers.set(decoded[0], hid);
      else entry.boundBuffers.delete(decoded[0]);
    } else if (method === 'activeTexture' && typeof decoded[0] === 'number') {
      entry.activeTextureUnit = Math.max(0, decoded[0] - 0x84c0);
    } else if (method === 'bindTexture' && typeof decoded[0] === 'number') {
      const hid = rawHandleId(rawCmd[3]);
      const key = `${entry.activeTextureUnit}:${decoded[0]}`;
      if (hid > 0) entry.boundTextures.set(key, hid);
      else entry.boundTextures.delete(key);
    } else if (method === 'bindRenderbuffer') {
      entry.boundRenderbuffer = rawHandleId(rawCmd[3]);
    }
  }

  private trackHandleBytes(entry: WebGLCtxEntry, key: string, nextBytes: number): boolean {
    const clamped = Number.isFinite(nextBytes) && nextBytes > 0 ? Math.ceil(nextBytes) : 0;
    if (clamped > MAX_WEBGL_CUMULATIVE_BYTES) return false;
    const prev = entry.handleBytes.get(key) ?? 0;
    const nextTotal = entry.allocatedBytes - prev + clamped;
    if (nextTotal > MAX_WEBGL_CUMULATIVE_BYTES) return false;
    entry.allocatedBytes = Math.max(0, nextTotal);
    if (clamped === 0) entry.handleBytes.delete(key);
    else entry.handleBytes.set(key, clamped);
    return true;
  }

  private releaseHandleBytes(entry: WebGLCtxEntry, hid: number): void {
    const prefix = `${hid}:`;
    for (const [k, sz] of [...entry.handleBytes]) {
      if (k === String(hid) || k.startsWith(prefix)) {
        entry.allocatedBytes = Math.max(0, entry.allocatedBytes - sz);
        entry.handleBytes.delete(k);
      }
    }
    for (const [target, bound] of [...entry.boundBuffers]) {
      if (bound === hid) entry.boundBuffers.delete(target);
    }
    for (const [slot, bound] of [...entry.boundTextures]) {
      if (bound === hid) entry.boundTextures.delete(slot);
    }
    if (entry.boundRenderbuffer === hid) entry.boundRenderbuffer = 0;
  }

  private checkAndTrackAllocation(entry: WebGLCtxEntry, method: string, decoded: unknown[]): boolean {
    if (method === 'bufferData') {
      const target = Number(decoded[0]) || 0;
      const hid = entry.boundBuffers.get(target);
      if (!hid) return true;
      let bytes = 0;
      const src = decoded[1];
      if (typeof src === 'number') {
        bytes = src;
      } else if (ArrayBuffer.isView(src)) {
        const lenOverride = typeof decoded[4] === 'number' && decoded[4] > 0 ? decoded[4] * ((src as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : 0;
        bytes = lenOverride || src.byteLength;
      } else if (src instanceof ArrayBuffer) {
        bytes = src.byteLength;
      }
      return this.trackHandleBytes(entry, `${hid}:buf`, bytes);
    }
    if (method === 'texImage2D') {
      const target = Number(decoded[0]) || 0;
      const level = Number(decoded[1]) || 0;
      // Cube-map faces (0x8515..0x851A) share the bound TEXTURE_CUBE_MAP (0x8513).
      const bindTarget = target >= 0x8515 && target <= 0x851a ? 0x8513 : target;
      const hid = entry.boundTextures.get(`${entry.activeTextureUnit}:${bindTarget}`);
      if (!hid) return true;
      let bytes = 0;
      if (decoded.length >= 8 && typeof decoded[3] === 'number' && typeof decoded[4] === 'number') {
        const w = Math.max(0, decoded[3]);
        const h = Math.max(0, decoded[4]);
        const src = decoded[8];
        const srcBytes = ArrayBuffer.isView(src) ? src.byteLength : 0;
        bytes = Math.max(w * h * 4, srcBytes);
      } else if (decoded.length >= 6 && decoded[5] && typeof decoded[5] === 'object') {
        const img = decoded[5] as { width?: number; height?: number };
        bytes = Math.max(0, Number(img.width) || 0) * Math.max(0, Number(img.height) || 0) * 4;
      }
      return this.trackHandleBytes(entry, `${hid}:t2:${target}:${level}`, bytes);
    }
    if (method === 'texImage3D') {
      const target = Number(decoded[0]) || 0;
      const level = Number(decoded[1]) || 0;
      const hid = entry.boundTextures.get(`${entry.activeTextureUnit}:${target}`);
      if (!hid) return true;
      const w = Math.max(0, Number(decoded[3]) || 0);
      const h = Math.max(0, Number(decoded[4]) || 0);
      const depth = Math.max(0, Number(decoded[5]) || 0);
      const src = decoded[9];
      const srcBytes = ArrayBuffer.isView(src) ? src.byteLength : 0;
      return this.trackHandleBytes(entry, `${hid}:t3:${level}`, Math.max(w * h * depth * 4, srcBytes));
    }
    if (method === 'texStorage2D') {
      const target = Number(decoded[0]) || 0;
      const levels = Math.max(1, Number(decoded[1]) || 1);
      const w = Math.max(0, Number(decoded[3]) || 0);
      const h = Math.max(0, Number(decoded[4]) || 0);
      const hid = entry.boundTextures.get(`${entry.activeTextureUnit}:${target}`);
      if (!hid) return true;
      const faces = target === 0x8513 ? 6 : 1;
      const mipFactor = levels > 1 ? 1.34 : 1;
      return this.trackHandleBytes(entry, `${hid}:ts2`, w * h * 4 * faces * mipFactor);
    }
    if (method === 'texStorage3D') {
      const target = Number(decoded[0]) || 0;
      const levels = Math.max(1, Number(decoded[1]) || 1);
      const w = Math.max(0, Number(decoded[3]) || 0);
      const h = Math.max(0, Number(decoded[4]) || 0);
      const depth = Math.max(0, Number(decoded[5]) || 0);
      const hid = entry.boundTextures.get(`${entry.activeTextureUnit}:${target}`);
      if (!hid) return true;
      const mipFactor = levels > 1 ? 1.34 : 1;
      return this.trackHandleBytes(entry, `${hid}:ts3`, w * h * depth * 4 * mipFactor);
    }
    if (method === 'renderbufferStorage' || method === 'renderbufferStorageMultisample') {
      const hid = entry.boundRenderbuffer;
      if (!hid) return true;
      const isMs = method === 'renderbufferStorageMultisample';
      const samples = isMs ? Math.max(1, Number(decoded[1]) || 1) : 1;
      const w = Math.max(0, Number(decoded[isMs ? 3 : 2]) || 0);
      const h = Math.max(0, Number(decoded[isMs ? 4 : 3]) || 0);
      return this.trackHandleBytes(entry, `${hid}:rb`, w * h * 4 * samples);
    }
    return true;
  }

  private releaseEntry(entry: WebGLCtxEntry): void {
    try {
      const lose = entry.gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    } catch {
      // ignore
    }
    try {
      entry.canvas.width = 1;
      entry.canvas.height = 1;
    } catch {
      // ignore
    }
    entry.handles.clear();
    entry.handleKinds.clear();
    entry.handleBytes.clear();
    entry.boundBuffers.clear();
    entry.boundTextures.clear();
    entry.boundRenderbuffer = 0;
    entry.allocatedBytes = 0;
    entry.uniformLocations.clear();
    entry.extensions.clear();
  }
}
