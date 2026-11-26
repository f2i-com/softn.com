/**
 * Guest-Side Native V8 Three.js Accelerator Shim (`GUEST_THREE_NATIVE_SOURCE`)
 * and Bundled-Three.js Instrumentation (`hasBundledThree`, `instrumentBundledThree`).
 *
 * Patches BOTH externalized `'three'` AND bundled/inlined Three.js chunks produced by
 * Vite / Rollup / Webpack / esbuild / UMD (`WebGLRenderer` + `Raycaster`) inside the ZIPP
 * sandbox so that:
 * - All GPU WebGL2 rendering, shadow mapping, shader compilation, frustum culling,
 *   and draw calls execute in Native V8 inside `container-worker.js` via `ThreeWorkerHost`
 *   (`/runtime/vendor/three.js` on `OffscreenCanvas` -> zero-copy `ImageBitmap`).
 * - High-poly `Raycaster.intersectObject(s)` calls execute in Native V8 (>200x faster).
 * - Guest JS keeps full Three.js API compatibility (`Vector3`, `Matrix4`, `ExtrudeGeometry`,
 *   `ShaderMaterial`, `Line2`, `OrbitControls`, `Grid`, `Html`, `@react-three/fiber`,
 *   `@react-three/drei`) while sending only tiny dirty scene deltas (~400 bytes/frame).
 */

/** Fast check for whether a JS module/script contains an inlined/bundled Three.js library. */
export function hasBundledThree(code: string): boolean {
  return code.includes('THREE.WebGLRenderer') && code.includes('isWebGLRenderer');
}

/**
 * Find the matching closing `}` for the `{` at `openBraceIdx`, skipping JS string
 * literals, template literals, and line/block comments. Returns -1 if unbalanced.
 */
function findClosingBrace(code: string, openBraceIdx: number): number {
  let depth = 0;
  const len = code.length;
  for (let i = openBraceIdx; i < len; i++) {
    const ch = code.charCodeAt(i);
    // Single / double / template string
    if (ch === 34 || ch === 39 || ch === 96) {
      const q = ch;
      i++;
      while (i < len) {
        const c = code.charCodeAt(i);
        if (c === 92) {
          i += 2;
          continue;
        }
        if (c === q) break;
        i++;
      }
      continue;
    }
    // Comments (`//` and `/* ... */`)
    if (ch === 47 && i + 1 < len) {
      const next = code.charCodeAt(i + 1);
      if (next === 47) {
        i += 2;
        while (i < len && code.charCodeAt(i) !== 10) i++;
        continue;
      }
      if (next === 42) {
        i += 2;
        while (i + 1 < len && !(code.charCodeAt(i) === 42 && code.charCodeAt(i + 1) === 47)) i++;
        i++;
        continue;
      }
    }
    if (ch === 123) {
      depth++;
    } else if (ch === 125) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Surgically instrument a pre-bundled (Vite/Rollup/Webpack/esbuild/UMD) Three.js chunk
 * so `new WebGLRenderer(opts)` delegates to SoftN's Native V8 `ThreeWorkerHost` when
 * available (falling back seamlessly to the bundled JS renderer if unavailable or if a
 * custom `opts.context` was passed), and `Raycaster` delegates `intersectObject(s)` to
 * Native V8 raycasting.
 */
export function instrumentBundledThree(code: string): { code: string; patched: boolean } {
  if (!hasBundledThree(code)) return { code, patched: false };
  const insertions: Array<{ offset: number; text: string }> = [];

  // 1. Hook bundled `WebGLRenderer` constructor right after its opening `{`
  const rendererFlagMatch = /\bthis\.isWebGLRenderer\s*=\s*(?:true|!0)\b/.exec(code);
  if (rendererFlagMatch) {
    const flagIdx = rendererFlagMatch.index;
    const lookbackStart = Math.max(0, flagIdx - 900);
    const slice = code.slice(lookbackStart, flagIdx);
    const ctorRe =
      /(?:\bconstructor|\bfunction(?:\s+[A-Za-z_$][\w$]*)?)\s*\(\s*([A-Za-z_$][\w$]*)?(?:\s*=\s*\{\s*\})?\s*\)\s*\{/g;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = ctorRe.exec(slice)) !== null) {
      lastMatch = m;
    }
    if (lastMatch) {
      const insertAt = lookbackStart + lastMatch.index + lastMatch[0].length;
      const argExpr = lastMatch[1] || 'arguments[0]';
      insertions.push({
        offset: insertAt,
        text: `var __snR=typeof globalThis.__softnTryNativeWebGLRenderer==="function"&&globalThis.__softnTryNativeWebGLRenderer(${argExpr});if(__snR)return __snR;`,
      });
    }
  }

  // 2. Hook bundled `Raycaster` constructor right before its closing `}` so its
  //    prototype's `intersectObject` / `intersectObjects` run in Native V8.
  const rayAnchorIdx = code.indexOf('THREE.Raycaster: Unsupported camera type:');
  if (rayAnchorIdx > 0) {
    const lookbackStart = Math.max(0, rayAnchorIdx - 1200);
    const slice = code.slice(lookbackStart, rayAnchorIdx);
    const ctorRe = /(?:\bconstructor|\bfunction\s+[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
    let matchedClose = -1;
    let m: RegExpExecArray | null;
    while ((m = ctorRe.exec(slice)) !== null) {
      const openBrace = lookbackStart + m.index + m[0].length - 1;
      const closeBrace = findClosingBrace(code, openBrace);
      if (closeBrace > openBrace && closeBrace < rayAnchorIdx) {
        const body = code.slice(openBrace, closeBrace);
        if (body.includes('this.ray') && body.includes('this.params')) {
          matchedClose = closeBrace;
        }
      }
    }
    if (matchedClose > 0) {
      insertions.push({
        offset: matchedClose,
        text: `;if(typeof globalThis.__softnPatchBundledRaycaster==="function"&&!this.constructor.__softnRayPatched)globalThis.__softnPatchBundledRaycaster(this.constructor,this.ray&&this.ray.origin&&this.ray.origin.constructor);`,
      });
    }
  }

  if (insertions.length === 0) return { code, patched: false };
  // Apply from highest offset to lowest so indices never shift.
  insertions.sort((a, b) => b.offset - a.offset);
  let out = code;
  for (const ins of insertions) {
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset);
  }
  return { code: out, patched: true };
}

export const GUEST_THREE_NATIVE_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var doc = g.document;

  function parseHexColor(color, ColorCtor) {
    if (color && color.isColor && typeof color.getHex === 'function') return color.getHex();
    if (typeof color === 'number') return color & 0xffffff;
    if (ColorCtor) {
      try { return new ColorCtor(color).getHex(); } catch (_) {}
    }
    if (typeof color === 'string') {
      var s = color.trim();
      if (s.charAt(0) === '#') {
        var hex = s.slice(1);
        if (hex.length === 3) {
          hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        var n = parseInt(hex.slice(0, 6), 16);
        if (!isNaN(n)) return n & 0xffffff;
      }
      var rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
      if (rgb) {
        return (((Number(rgb[1]) & 255) << 16) | ((Number(rgb[2]) & 255) << 8) | (Number(rgb[3]) & 255)) >>> 0;
      }
    }
    return 0;
  }

  function makeVec2(x, y, Vec2Ctor) {
    if (Vec2Ctor) return new Vec2Ctor(x, y);
    return {
      x: x,
      y: y,
      isVector2: true,
      set: function (nx, ny) { this.x = nx; this.y = ny; return this; },
      clone: function () { return makeVec2(this.x, this.y, null); },
      copy: function (v) { this.x = v.x; this.y = v.y; return this; },
    };
  }

  function makeVec3(x, y, z, Vec3Ctor) {
    if (Vec3Ctor) return new Vec3Ctor(x, y, z);
    return {
      x: x,
      y: y,
      z: z,
      isVector3: true,
      set: function (nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; return this; },
      clone: function () { return makeVec3(this.x, this.y, this.z, null); },
      copy: function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
    };
  }

  function makeColor(hex, ColorCtor) {
    if (ColorCtor) return new ColorCtor().setHex(hex);
    var c = {
      r: ((hex >> 16) & 255) / 255,
      g: ((hex >> 8) & 255) / 255,
      b: (hex & 255) / 255,
      isColor: true,
      getHex: function () {
        return (((Math.round(this.r * 255) & 255) << 16) | ((Math.round(this.g * 255) & 255) << 8) | (Math.round(this.b * 255) & 255)) >>> 0;
      },
      setHex: function (h) {
        this.r = ((h >> 16) & 255) / 255;
        this.g = ((h >> 8) & 255) / 255;
        this.b = (h & 255) / 255;
        return this;
      },
    };
    return c;
  }

  function bytesToB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 4096) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 4096));
    }
    return g.btoa(s);
  }

  function taTypeCode(v) {
    if (v instanceof Float32Array) return 'f32';
    if (v instanceof Uint16Array) return 'u16';
    if (v instanceof Uint32Array) return 'u32';
    if (v instanceof Int32Array) return 'i32';
    if (v instanceof Int16Array) return 'i16';
    if (v instanceof Int8Array) return 'i8';
    if (v instanceof Uint8ClampedArray) return 'u8c';
    return 'u8';
  }

  function encodeTypedArray(v) {
    var u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { tc: taTypeCode(v), b64: bytesToB64(u8) };
  }

  function unpackInterleaved(attr) {
    var count = attr.count | 0;
    var itemSize = attr.itemSize | 0;
    var stride = attr.data && attr.data.stride ? attr.data.stride | 0 : itemSize;
    var offset = attr.offset | 0;
    var src = attr.data && attr.data.array ? attr.data.array : null;
    if (!src || count <= 0 || itemSize <= 0) return new Float32Array(0);
    var out = new Float32Array(count * itemSize);
    for (var i = 0; i < count; i++) {
      var base = i * stride + offset;
      var dst = i * itemSize;
      for (var k = 0; k < itemSize; k++) {
        out[dst + k] = src[base + k];
      }
    }
    return out;
  }

  function objectKindOf(obj) {
    if (obj._snGltfSrc) return 'GLTF';
    if (obj.isScene) return 'Scene';
    if (obj.isInstancedMesh) return 'InstancedMesh';
    if (obj.isMesh) return 'Mesh';
    if (obj.isLineSegments) return 'LineSegments';
    if (obj.isLineLoop) return 'LineLoop';
    if (obj.isLine) return 'Line';
    if (obj.isPoints) return 'Points';
    if (obj.isSprite) return 'Sprite';
    if (obj.isAmbientLight) return 'AmbientLight';
    if (obj.isHemisphereLight) return 'HemisphereLight';
    if (obj.isDirectionalLight) return 'DirectionalLight';
    if (obj.isPointLight) return 'PointLight';
    if (obj.isSpotLight) return 'SpotLight';
    if (obj.isPerspectiveCamera) return 'PerspectiveCamera';
    if (obj.isOrthographicCamera) return 'OrthographicCamera';
    if (obj.isGroup) return 'Group';
    return 'Object3D';
  }

  function materialTypeOf(mat) {
    if (mat.isRawShaderMaterial) return 'RawShaderMaterial';
    if (mat.isShaderMaterial) return 'ShaderMaterial';
    if (mat.isMeshPhysicalMaterial) return 'MeshPhysicalMaterial';
    if (mat.isMeshStandardMaterial) return 'MeshStandardMaterial';
    if (mat.isMeshBasicMaterial) return 'MeshBasicMaterial';
    if (mat.isMeshLambertMaterial) return 'MeshLambertMaterial';
    if (mat.isMeshPhongMaterial) return 'MeshPhongMaterial';
    if (mat.isMeshNormalMaterial) return 'MeshNormalMaterial';
    if (mat.isMeshDepthMaterial) return 'MeshDepthMaterial';
    if (mat.isLineDashedMaterial) return 'LineDashedMaterial';
    if (mat.isLineBasicMaterial) return 'LineBasicMaterial';
    if (mat.isPointsMaterial) return 'PointsMaterial';
    if (mat.isShadowMaterial) return 'ShadowMaterial';
    if (mat.isSpriteMaterial) return 'SpriteMaterial';
    return 'MeshStandardMaterial';
  }

  function colorTriplet(c) {
    return c && typeof c.r === 'number' ? [c.r, c.g, c.b] : null;
  }

  var __activeRenderers = Object.create(null);
  // An object no render reached for this many renders is one the app let go of (looked for
  // every SWEEP_EVERY renders): both sides let go of it, and one the app draws again is sent
  // again as new. Object3Ds are never disposed; each one drawn was kept for good.
  var SWEEP_EVERY = 120;
  var SWEEP_AGE = 240;

  function createNativeRendererClass(THREE) {
    var OrigWebGLRenderer = THREE && THREE.WebGLRenderer ? THREE.WebGLRenderer : null;
    var Vec2Ctor = THREE && THREE.Vector2 ? THREE.Vector2 : null;
    var ColorCtor = THREE && THREE.Color ? THREE.Color : null;

    function NativeWebGLRenderer(opts) {
      opts = opts || {};
      if (opts.context) {
        if (OrigWebGLRenderer) return new OrigWebGLRenderer(opts);
        this._snInitFailed = true;
        return;
      }
      this.domElement = opts.canvas || (doc && doc.createElement ? doc.createElement('canvas') : { width: 300, height: 150, style: {} });
      var w = this.domElement.width || 300;
      var h = this.domElement.height || 150;
      var initOpts = {
        antialias: opts.antialias !== undefined ? !!opts.antialias : true,
        alpha: !!opts.alpha,
        depth: opts.depth !== undefined ? !!opts.depth : true,
        stencil: !!opts.stencil,
        premultipliedAlpha: opts.premultipliedAlpha !== undefined ? !!opts.premultipliedAlpha : true,
        preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
        powerPreference: opts.powerPreference || 'default',
      };
      var info = null;
      try {
        info = host.callSync('three', 'init', String(this.domElement.__softnNode || 0), String(w), String(h), JSON.stringify(initOpts));
      } catch (e) {
        info = null;
      }
      if (!info || !info.rendererId) {
        // Fallback cleanly to built-in JS WebGLRenderer if OffscreenCanvas Three host is unavailable
        if (OrigWebGLRenderer) return new OrigWebGLRenderer(opts);
        this._snInitFailed = true;
        return;
      }

      this.isWebGLRenderer = true;
      this._rid = info.rendererId;
      this._canvasIdSent = this.domElement.__softnNode || 0;
      this._w = w;
      this._h = h;
      this._dpr = 1;
      this._sizeDirty = false;
      this._clearColor = 0x000000;
      this._clearAlpha = opts.alpha ? 0 : 1;
      this._lastCfgSig = '';

      this._nextObjId = 1;
      this._nextGeoId = 1;
      this._nextMatId = 1;
      this._nextTexId = 1;
      this._objIds = new WeakMap();
      this._objById = Object.create(null);
      this._objState = new WeakMap();
      this._geoIds = new WeakMap();
      this._geoState = new WeakMap();
      this._matIds = new WeakMap();
      this._matState = new WeakMap();
      this._texIds = new WeakMap();
      this._texState = new WeakMap();
      this._hooked = new WeakMap();
      this._f32 = new Float32Array(2048);
      this._f32Pos = 0;
      this._ops = [];
      this._pendingDeletes = [];
      this._drawnOps = [];
      this._renderSeq = 0;
      this._disposed = false;
      this._animCb = null;
      this._animRafId = 0;

      this.shadowMap = {
        enabled: false,
        autoUpdate: true,
        needsUpdate: false,
        type: THREE && THREE.PCFShadowMap !== undefined ? THREE.PCFShadowMap : 1,
      };
      this.toneMapping = THREE && THREE.NoToneMapping !== undefined ? THREE.NoToneMapping : 0;
      this.toneMappingExposure = 1;
      this.outputColorSpace = (THREE && THREE.SRGBColorSpace) || 'srgb';
      this.autoClear = true;
      this.autoClearColor = true;
      this.autoClearDepth = true;
      this.autoClearStencil = true;
      this.localClippingEnabled = false;
      this.clippingPlanes = [];
      this.sortObjects = true;
      this.debug = { checkShaderErrors: false };
      this.capabilities = {
        isWebGL2: !!info.isWebGL2,
        maxTextures: 16,
        maxVertexTextures: 16,
        maxTextureSize: info.maxTextureSize || 4096,
        maxCubemapSize: 4096,
        maxAttributes: 16,
        maxVertexUniforms: info.maxVertexUniforms || 1024,
        maxVaryings: 30,
        maxFragmentUniforms: 1024,
        vertexTextures: true,
        logarithmicDepthBuffer: false,
        precision: info.precision || 'highp',
        getMaxAnisotropy: function () { return info.maxAnisotropy || 16; },
        getMaxPrecision: function () { return 'highp'; },
      };
      this.info = {
        memory: { geometries: 0, textures: 0 },
        render: { frame: 0, calls: 0, triangles: 0, points: 0, lines: 0 },
        programs: [],
        autoReset: true,
        reset: function () {},
      };
      this.state = { reset: function () {} };
      this.extensions = { get: function () { return null; }, has: function () { return true; } };
      this.properties = { get: function () { return {}; } };
      this.xr = {
        enabled: false,
        isPresenting: false,
        addEventListener: function () {},
        removeEventListener: function () {},
        setAnimationLoop: function () {},
        setReferenceSpaceType: function () {},
        getSession: function () { return null; },
      };

      var self = this;
      this._glStub = {
        canvas: this.domElement,
        getContextAttributes: function () {
          return info.contextAttributes || { alpha: initOpts.alpha, antialias: initOpts.antialias, depth: initOpts.depth };
        },
        isContextLost: function () { return self._disposed; },
        getParameter: function () { return info.maxTextureSize || 4096; },
        getExtension: function () { return null; },
      };

      __activeRenderers[this._rid] = this;
    }

    NativeWebGLRenderer.prototype._allocF32 = function (count) {
      var off = this._f32Pos;
      var need = off + count;
      if (need > this._f32.length) {
        var nextLen = this._f32.length * 2;
        while (nextLen < need) nextLen *= 2;
        var next = new Float32Array(nextLen);
        next.set(this._f32.subarray(0, off));
        this._f32 = next;
      }
      this._f32Pos = need;
      return off;
    };

    NativeWebGLRenderer.prototype.getContext = function () { return this._glStub; };
    NativeWebGLRenderer.prototype.getPixelRatio = function () { return this._dpr; };
    NativeWebGLRenderer.prototype.setPixelRatio = function (dpr) {
      var next = Math.max(0.5, Math.min(2, Number(dpr) || 1));
      if (next !== this._dpr) {
        this._dpr = next;
        this._sizeDirty = true;
      }
    };
    NativeWebGLRenderer.prototype.setSize = function (w, h, updateStyle) {
      var nw = Math.max(1, Math.floor(Number(w) || 1));
      var nh = Math.max(1, Math.floor(Number(h) || 1));
      this._w = nw;
      this._h = nh;
      if (this.domElement) {
        this.domElement.width = Math.round(nw * this._dpr);
        this.domElement.height = Math.round(nh * this._dpr);
        if (updateStyle !== false && this.domElement.style) {
          this.domElement.style.width = nw + 'px';
          this.domElement.style.height = nh + 'px';
        }
      }
      this._sizeDirty = true;
    };
    Object.defineProperty(NativeWebGLRenderer.prototype, 'outputEncoding', {
      enumerable: true,
      configurable: true,
      get: function () { return this.outputColorSpace === 'srgb-linear' ? 3000 : 3001; },
      set: function (enc) { this.outputColorSpace = enc === 3000 ? 'srgb-linear' : 'srgb'; },
    });
    NativeWebGLRenderer.prototype.getSize = function (target) {
      return (target || makeVec2(0, 0, Vec2Ctor)).set(this._w, this._h);
    };
    NativeWebGLRenderer.prototype.getDrawingBufferSize = function (target) {
      return (target || makeVec2(0, 0, Vec2Ctor)).set(Math.round(this._w * this._dpr), Math.round(this._h * this._dpr));
    };
    NativeWebGLRenderer.prototype.setClearColor = function (color, alpha) {
      this._clearColor = parseHexColor(color, ColorCtor);
      if (alpha !== undefined) this._clearAlpha = Number(alpha);
    };
    NativeWebGLRenderer.prototype.getClearColor = function (target) {
      return (target || makeColor(0, ColorCtor)).setHex(this._clearColor);
    };
    NativeWebGLRenderer.prototype.getClearAlpha = function () { return this._clearAlpha; };
    NativeWebGLRenderer.prototype.setClearAlpha = function (a) { this._clearAlpha = Number(a); };
    NativeWebGLRenderer.prototype.setViewport = function () {};
    NativeWebGLRenderer.prototype.setScissor = function () {};
    NativeWebGLRenderer.prototype.setScissorTest = function () {};
    NativeWebGLRenderer.prototype.clear = function () {};
    NativeWebGLRenderer.prototype.clearColor = function () {};
    NativeWebGLRenderer.prototype.clearDepth = function () {};
    NativeWebGLRenderer.prototype.clearStencil = function () {};
    NativeWebGLRenderer.prototype.resetState = function () {};
    NativeWebGLRenderer.prototype.setRenderTarget = function () {};
    NativeWebGLRenderer.prototype.getRenderTarget = function () { return null; };
    NativeWebGLRenderer.prototype.compile = function () {};
    NativeWebGLRenderer.prototype.compileAsync = function () { return Promise.resolve(); };
    NativeWebGLRenderer.prototype.forceContextLoss = function () {};
    NativeWebGLRenderer.prototype.setAnimationLoop = function (cb) {
      this._animCb = typeof cb === 'function' ? cb : null;
      if (this._animRafId) {
        g.cancelAnimationFrame(this._animRafId);
        this._animRafId = 0;
      }
      if (!this._animCb) return;
      var self = this;
      function tick(ts) {
        if (!self._animCb || self._disposed) return;
        self._animRafId = g.requestAnimationFrame(tick);
        self._animCb(ts);
      }
      this._animRafId = g.requestAnimationFrame(tick);
    };

    NativeWebGLRenderer.prototype._encodeUniformVal = function (v) {
      if (v === null || v === undefined) return null;
      var t = typeof v;
      if (t === 'number' || t === 'boolean' || t === 'string') return v;
      if (v.isVector2) return { $t: 'v2', v: [v.x, v.y] };
      if (v.isVector3) return { $t: 'v3', v: [v.x, v.y, v.z] };
      if (v.isVector4) return { $t: 'v4', v: [v.x, v.y, v.z, v.w] };
      if (v.isColor) return { $t: 'c', v: [v.r, v.g, v.b] };
      if (v.isMatrix3) return { $t: 'm3', v: Array.prototype.slice.call(v.elements) };
      if (v.isMatrix4) return { $t: 'm4', v: Array.prototype.slice.call(v.elements) };
      if (v.isTexture) return { $t: 'tex', v: this._syncTexture(v) };
      if (ArrayBuffer.isView(v)) {
        var enc = encodeTypedArray(v);
        return { $t: 'ta', tc: enc.tc, v: enc.b64 };
      }
      if (Array.isArray(v)) {
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(this._encodeUniformVal(v[i]));
        return out;
      }
      return null;
    };

    NativeWebGLRenderer.prototype._uniformSig = function (v) {
      if (v === null || v === undefined) return 'n';
      var t = typeof v;
      if (t === 'number' || t === 'boolean' || t === 'string') return String(v);
      if (v.isVector2) return 'v2:' + v.x + ',' + v.y;
      if (v.isVector3) return 'v3:' + v.x + ',' + v.y + ',' + v.z;
      if (v.isVector4) return 'v4:' + v.x + ',' + v.y + ',' + v.z + ',' + v.w;
      if (v.isColor) return 'c:' + v.r + ',' + v.g + ',' + v.b;
      if (v.isTexture) return 'tex:' + (this._texIds.get(v) || 0) + ':' + v.version;
      if (v.isMatrix3 || v.isMatrix4) return 'm:' + v.elements.join(',');
      return '';
    };

    // A geometry, material or texture the app disposes: let go of in the Worker, and forgotten
    // here, so one the app goes on drawing (three.js uploads it again) is sent again as new,
    // with a new id. (Under its old id, what the app changed after was the Worker's new object,
    // which no mesh or material drew with.) Heard once for each.
    NativeWebGLRenderer.prototype._hookDispose = function (res, kind, ids, states) {
      if (typeof res.addEventListener !== 'function' || this._hooked.get(res)) return;
      this._hooked.set(res, true);
      var self = this;
      res.addEventListener('dispose', function () {
        var gone = ids.get(res);
        if (gone === undefined) return;
        ids.delete(res);
        states.delete(res);
        if (!self._disposed) self._pendingDeletes.push(['del', kind, gone]);
      });
    };

    NativeWebGLRenderer.prototype._syncTexture = function (tex) {
      if (!tex) return 0;
      var id = this._texIds.get(tex);
      var st = this._texState.get(tex);
      var img = tex.image;
      var hasCanvasCmds = !!(img && img.tagName === 'CANVAS' && img.__ctx2d && img.__ctx2d._cmds && img.__ctx2d._cmds.length > 0);
      var curVer = (tex.version | 0);
      var sig = curVer + '|' + tex.colorSpace + '|' + tex.wrapS + '|' + tex.wrapT + '|' +
        (tex.repeat ? tex.repeat.x + ',' + tex.repeat.y : '') + '|' +
        (tex.offset ? tex.offset.x + ',' + tex.offset.y : '') + '|' +
        tex.minFilter + '|' + tex.magFilter + '|' + (tex.generateMipmaps ? 1 : 0) + '|' + (tex.flipY ? 1 : 0);

      if (id && st && st.sig === sig && !hasCanvasCmds) {
        return id;
      }
      if (!id) {
        id = this._nextTexId++;
        this._texIds.set(tex, id);
        this._hookDispose(tex, 'tex', this._texIds, this._texState);
      }

      var spec = {
        colorSpace: tex.colorSpace,
        wrapS: tex.wrapS,
        wrapT: tex.wrapT,
        repeat: tex.repeat ? [tex.repeat.x, tex.repeat.y] : [1, 1],
        offset: tex.offset ? [tex.offset.x, tex.offset.y] : [0, 0],
        minFilter: tex.minFilter,
        magFilter: tex.magFilter,
        generateMipmaps: !!tex.generateMipmaps,
        flipY: !!tex.flipY,
        anisotropy: tex.anisotropy || 1,
      };
      if (img && img.tagName === 'CANVAS') {
        var pending = [];
        if (img.__ctx2d && img.__ctx2d._cmds && img.__ctx2d._cmds.length > 0) {
          pending = img.__ctx2d._cmds.splice(0, img.__ctx2d._cmds.length);
          // Drawn on the page's canvas too, which they were taken from (a canvas the app also
          // shows was blank there); marked as drawn on the Worker's copy once the frame that
          // draws them there has run (render).
          if (img.__softnNode && typeof g.__softnPushExtraOp === 'function') {
            var drawnOp = ['k2d', img.__softnNode, img.width, img.height, pending];
            g.__softnPushExtraOp(drawnOp);
            this._drawnOps.push(drawnOp);
          }
          if (typeof g.__softnClearCanvas2DDrawing === 'function') g.__softnClearCanvas2DDrawing(img.__ctx2d);
        }
        spec.kind = 'canvas';
        spec.cid = img.__softnNode || 0;
        spec.w = img.width || 256;
        spec.h = img.height || 256;
        spec.cmds = pending;
      } else if (tex.isDataTexture && img && img.data) {
        var enc = encodeTypedArray(img.data);
        spec.kind = 'data';
        spec.w = img.width || 1;
        spec.h = img.height || 1;
        spec.tc = enc.tc;
        spec.b64 = enc.b64;
        spec.format = tex.format;
        spec.type = tex.type;
      } else if (img && img.tagName === 'IMG') {
        if (typeof g.__softnMirrorPicture === 'function') g.__softnMirrorPicture(img);
        var src = typeof img.getAttribute === 'function' ? img.getAttribute('src') : null;
        spec.kind = 'img';
        // By the name its picture was decoded under, the one a canvas draws it by: an image
        // asked for with CORS and on no page (every one TextureLoader makes) is 'cors:' and
        // its address, and asked for by its address alone it had no picture.
        var picRef = typeof g.__softnPictureRef === 'function' ? g.__softnPictureRef(img) : null;
        spec.ref = picRef || (img.__softnNode && img.isConnected ? 'node:' + img.__softnNode : (src || ''));
      } else {
        return 0;
      }

      this._ops.push(['tex', id, spec]);
      this._texState.set(tex, { sig: sig });
      return id;
    };

    NativeWebGLRenderer.prototype._syncGeometry = function (geo) {
      if (!geo) return 0;
      var id = this._geoIds.get(geo);
      var st = this._geoState.get(geo);
      // Shared by many meshes: looked at once a render.
      if (id && st && st.seq === this._renderSeq) return id;
      var attrs = geo.attributes || {};
      var attrNames = Object.keys(attrs);
      var dr = geo.drawRange || { start: 0, count: Infinity };
      var sig = dr.start + ':' + dr.count + ':' + (geo.instanceCount !== undefined ? geo.instanceCount : '') +
        ':' + (geo.index ? geo.index.version : -1) + ':' + (geo.groups ? geo.groups.length : 0);
      for (var i = 0; i < attrNames.length; i++) {
        var a = attrs[attrNames[i]];
        var av = a && a.isInterleavedBufferAttribute && a.data ? a.data.version : (a ? a.version : 0);
        sig += '|' + attrNames[i] + ':' + av + ':' + (a ? a.count : 0);
      }
      if (id && st && st.sig === sig) {
        st.seq = this._renderSeq;
        return id;
      }
      if (!id) {
        id = this._nextGeoId++;
        this._geoIds.set(geo, id);
        this._hookDispose(geo, 'geo', this._geoIds, this._geoState);
      }

      var prevVers = st ? st.attrVers : Object.create(null);
      var nextVers = Object.create(null);
      var encAttrs = {};
      var hasAttrDelta = false;
      for (var ai = 0; ai < attrNames.length; ai++) {
        var name = attrNames[ai];
        var attr = attrs[name];
        if (!attr) continue;
        var ver = attr.isInterleavedBufferAttribute && attr.data ? attr.data.version : attr.version;
        var keySig = ver + ':' + attr.count + ':' + attr.itemSize;
        nextVers[name] = keySig;
        if (prevVers[name] === keySig) continue;
        hasAttrDelta = true;
        if (attr.isInterleavedBufferAttribute) {
          var unpacked = unpackInterleaved(attr);
          var uEnc = encodeTypedArray(unpacked);
          encAttrs[name] = {
            tc: uEnc.tc,
            b64: uEnc.b64,
            s: attr.itemSize,
            n: !!attr.normalized,
            inst: !!(attr.data && attr.data.isInstancedInterleavedBuffer),
            mpa: (attr.data && attr.data.meshPerAttribute) || 1,
          };
        } else if (attr.array) {
          var aEnc = encodeTypedArray(attr.array);
          encAttrs[name] = {
            tc: aEnc.tc,
            b64: aEnc.b64,
            s: attr.itemSize,
            n: !!attr.normalized,
            inst: !!attr.isInstancedBufferAttribute,
            mpa: attr.meshPerAttribute || 1,
          };
        }
      }

      var spec = {
        instanced: !!geo.isInstancedBufferGeometry,
        drawRange: [dr.start, dr.count === Infinity ? 2147483647 : dr.count],
      };
      if (hasAttrDelta) spec.attrs = encAttrs;
      var idxVer = geo.index ? geo.index.version + ':' + geo.index.count : 'none';
      if (!st || st.idxVer !== idxVer) {
        if (geo.index && geo.index.array) {
          spec.index = encodeTypedArray(geo.index.array);
        } else {
          spec.index = null;
        }
      }
      if (geo.groups && geo.groups.length > 0) {
        var grps = [];
        for (var gi = 0; gi < geo.groups.length; gi++) {
          grps.push([geo.groups[gi].start, geo.groups[gi].count, geo.groups[gi].materialIndex]);
        }
        spec.groups = grps;
      }
      if (geo.isInstancedBufferGeometry && typeof geo.instanceCount === 'number' && geo.instanceCount !== Infinity) {
        spec.instanceCount = geo.instanceCount;
      }
      if (!geo.boundingSphere && typeof geo.computeBoundingSphere === 'function') {
        try { geo.computeBoundingSphere(); } catch (_) {}
      }
      if (geo.boundingSphere && geo.boundingSphere.center && isFinite(geo.boundingSphere.radius)) {
        var bsc = geo.boundingSphere.center;
        if (isFinite(bsc.x) && isFinite(bsc.y) && isFinite(bsc.z)) {
          spec.bs = [bsc.x, bsc.y, bsc.z, geo.boundingSphere.radius];
        }
      }

      this._ops.push(['geo', id, spec]);
      this._geoState.set(geo, { sig: sig, attrVers: nextVers, idxVer: idxVer, seq: this._renderSeq });
      return id;
    };

    NativeWebGLRenderer.prototype._syncMaterial = function (mat) {
      if (!mat) return 0;
      if (Array.isArray(mat)) {
        var arr = [];
        for (var i = 0; i < mat.length; i++) arr.push(this._syncMaterial(mat[i]));
        return arr;
      }
      var id = this._matIds.get(mat);
      var st = this._matState.get(mat);
      // Shared by many meshes: looked at once a render (its textures and uniforms with it).
      if (id && st && st.seq === this._renderSeq) return id;
      var isShader = !!mat.isShaderMaterial;
      var mapId = mat.map ? this._syncTexture(mat.map) : 0;
      var alphaMapId = mat.alphaMap ? this._syncTexture(mat.alphaMap) : 0;
      var emissiveMapId = mat.emissiveMap ? this._syncTexture(mat.emissiveMap) : 0;

      var c = mat.color;
      var em = mat.emissive;
      var defSig = '';
      if (isShader && mat.defines) {
        var dKeys = Object.keys(mat.defines);
        for (var dki = 0; dki < dKeys.length; dki++) {
          defSig += dKeys[dki] + '=' + mat.defines[dKeys[dki]] + ';';
        }
      }
      var sig = (mat.version | 0) + '|' +
        (c ? c.r.toFixed(4) + ',' + c.g.toFixed(4) + ',' + c.b.toFixed(4) : '') + '|' +
        (em ? em.r.toFixed(4) + ',' + em.g.toFixed(4) + ',' + em.b.toFixed(4) : '') + '|' +
        mat.emissiveIntensity + '|' + mat.roughness + '|' + mat.metalness + '|' +
        mat.opacity + '|' + (mat.transparent ? 1 : 0) + '|' + mat.side + '|' +
        (mat.vertexColors ? 1 : 0) + '|' + (mat.wireframe ? 1 : 0) + '|' +
        (mat.depthWrite ? 1 : 0) + '|' + (mat.depthTest ? 1 : 0) + '|' +
        (mat.toneMapped ? 1 : 0) + '|' + mat.blending + '|' + (mat.fog ? 1 : 0) + '|' +
        (mat.visible ? 1 : 0) + '|' + mat.size + '|' + mat.linewidth + '|' +
        (mat.polygonOffset ? 1 : 0) + ',' + (mat.polygonOffsetFactor || 0) + ',' + (mat.polygonOffsetUnits || 0) + '|' +
        (mat.alphaTest || 0) + '|' + (mat.flatShading ? 1 : 0) + '|' +
        mapId + '|' + alphaMapId + '|' + emissiveMapId + '|' + defSig;

      if (id && st && st.sig === sig) {
        if (isShader && mat.uniforms) {
          // Check only shader uniforms for incremental updates
          var uKeys = Object.keys(mat.uniforms);
          var changedU = null;
          for (var ui = 0; ui < uKeys.length; ui++) {
            var uk = uKeys[ui];
            var uEntry = mat.uniforms[uk];
            if (!uEntry) continue;
            var uSig = this._uniformSig(uEntry.value);
            if (st.uSigs[uk] !== uSig) {
              st.uSigs[uk] = uSig;
              if (!changedU) changedU = {};
              changedU[uk] = this._encodeUniformVal(uEntry.value);
            }
          }
          if (changedU) this._ops.push(['mu', id, changedU]);
        }
        st.seq = this._renderSeq;
        return id;
      }

      if (!id) {
        id = this._nextMatId++;
        this._matIds.set(mat, id);
        this._hookDispose(mat, 'mat', this._matIds, this._matState);
      }

      var spec = {
        type: materialTypeOf(mat),
        opacity: mat.opacity,
        transparent: !!mat.transparent,
        side: mat.side,
        vertexColors: !!mat.vertexColors,
        depthWrite: !!mat.depthWrite,
        depthTest: !!mat.depthTest,
        toneMapped: !!mat.toneMapped,
        blending: mat.blending,
        fog: mat.fog !== false,
        visible: mat.visible !== false,
      };
      if (c) spec.color = [c.r, c.g, c.b];
      if (em) spec.emissive = [em.r, em.g, em.b];
      if (typeof mat.emissiveIntensity === 'number') spec.emissiveIntensity = mat.emissiveIntensity;
      if (typeof mat.roughness === 'number') spec.roughness = mat.roughness;
      if (typeof mat.metalness === 'number') spec.metalness = mat.metalness;
      if (typeof mat.wireframe === 'boolean') spec.wireframe = mat.wireframe;
      if (typeof mat.alphaTest === 'number' && mat.alphaTest > 0) spec.alphaTest = mat.alphaTest;
      if (typeof mat.size === 'number') spec.size = mat.size;
      if (typeof mat.sizeAttenuation === 'boolean') spec.sizeAttenuation = mat.sizeAttenuation;
      if (typeof mat.polygonOffset === 'boolean') spec.polygonOffset = mat.polygonOffset;
      if (typeof mat.polygonOffsetFactor === 'number') spec.polygonOffsetFactor = mat.polygonOffsetFactor;
      if (typeof mat.polygonOffsetUnits === 'number') spec.polygonOffsetUnits = mat.polygonOffsetUnits;
      if (typeof mat.linewidth === 'number') spec.linewidth = mat.linewidth;
      if (typeof mat.dashSize === 'number') spec.dashSize = mat.dashSize;
      if (typeof mat.gapSize === 'number') spec.gapSize = mat.gapSize;
      if (typeof mat.scale === 'number') spec.scale = mat.scale;
      if (typeof mat.flatShading === 'boolean') spec.flatShading = mat.flatShading;
      if (mapId) spec.map = mapId; else if ('map' in mat) spec.map = 0;
      if (alphaMapId) spec.alphaMap = alphaMapId;
      if (emissiveMapId) spec.emissiveMap = emissiveMapId;

      var uSigs = Object.create(null);
      if (isShader) {
        spec.vertexShader = mat.vertexShader;
        spec.fragmentShader = mat.fragmentShader;
        if (mat.defines) spec.defines = mat.defines;
        if (mat.extensions) spec.extensions = mat.extensions;
        if (mat.glslVersion) spec.glslVersion = mat.glslVersion;
        if (typeof mat.lights === 'boolean') spec.lights = mat.lights;
        if (typeof mat.clipping === 'boolean') spec.clipping = mat.clipping;
        if (mat.uniforms) {
          var encU = {};
          var keys = Object.keys(mat.uniforms);
          for (var k = 0; k < keys.length; k++) {
            var kn = keys[k];
            var uv = mat.uniforms[kn] ? mat.uniforms[kn].value : null;
            uSigs[kn] = this._uniformSig(uv);
            encU[kn] = this._encodeUniformVal(uv);
          }
          spec.uniforms = encU;
        }
      }

      this._ops.push(['mat', id, spec]);
      this._matState.set(mat, { sig: sig, uSigs: uSigs, seq: this._renderSeq });
      return id;
    };

    NativeWebGLRenderer.prototype._syncObject = function (obj) {
      if (!obj) return 0;
      var id = this._objIds.get(obj);
      var st = this._objState.get(obj);
      var kind = st ? st.kind : objectKindOf(obj);
      var isNew = !id;

      var geoId = obj.geometry ? this._syncGeometry(obj.geometry) : 0;
      var matId = obj.material ? this._syncMaterial(obj.material) : 0;
      var targetId = 0;
      if ((obj.isDirectionalLight || obj.isSpotLight) && obj.target) {
        targetId = this._syncObject(obj.target);
      }

      if (isNew) {
        id = this._nextObjId++;
        this._objIds.set(obj, id);
        this._objById[id] = obj;
        obj._snThreeRid = this._rid;
        obj._snThreeId = id;
        st = { kind: kind, xf: null, ch: null, metaSig: '', camSig: '', sceneSig: '', imSig: '' };
        this._objState.set(obj, st);
      }
      st.seen = this._renderSeq;

      // Build metadata signature (geo, mat, shadows, light params, gltf src)
      var matKey = Array.isArray(matId) ? matId.join(',') : String(matId);
      var metaSig = geoId + '|' + matKey + '|' + (obj.castShadow ? 1 : 0) + '|' + (obj.receiveShadow ? 1 : 0) +
        '|' + (obj.frustumCulled ? 1 : 0) + '|' + (obj.renderOrder | 0) + '|' + (obj.layers ? obj.layers.mask : 1) +
        (obj._snGltfSrc ? '|G:' + obj._snGltfSrc : '');
      if (obj.isLight) {
        metaSig += '|L:' + (obj.color ? obj.color.r.toFixed(4) + ',' + obj.color.g.toFixed(4) + ',' + obj.color.b.toFixed(4) : '') +
          '|' + obj.intensity + '|' + targetId;
        if (obj.isHemisphereLight && obj.groundColor) {
          metaSig += '|G:' + obj.groundColor.r.toFixed(4) + ',' + obj.groundColor.g.toFixed(4) + ',' + obj.groundColor.b.toFixed(4);
        }
        if (obj.isPointLight || obj.isSpotLight) {
          metaSig += '|D:' + obj.distance + '|' + obj.decay + '|' + (obj.angle || 0) + '|' + (obj.penumbra || 0);
        }
        if (obj.shadow && obj.shadow.camera) {
          var sc = obj.shadow.camera;
          metaSig += '|S:' + obj.shadow.mapSize.width + 'x' + obj.shadow.mapSize.height + '|' +
            obj.shadow.bias + '|' + obj.shadow.normalBias + '|' + obj.shadow.radius + '|' +
            sc.left + ',' + sc.right + ',' + sc.top + ',' + sc.bottom + ',' + sc.near + ',' + sc.far;
        }
      }

      if (isNew || st.metaSig !== metaSig) {
        var spec = {
          castShadow: !!obj.castShadow,
          receiveShadow: !!obj.receiveShadow,
          frustumCulled: obj.frustumCulled !== false,
          renderOrder: obj.renderOrder || 0,
          visible: obj.visible !== false,
          layersMask: obj.layers ? obj.layers.mask : 1,
        };
        if (geoId) spec.geo = geoId;
        if (matId) spec.mat = matId;
        if (obj._snGltfSrc) spec.src = obj._snGltfSrc;
        if (obj.isInstancedMesh) {
          spec.cap = obj.instanceMatrix ? Math.max(1, obj.instanceMatrix.count | 0) : Math.max(1, obj.count | 0);
          spec.count = obj.count | 0;
        }
        if (obj.isPerspectiveCamera) {
          spec.fov = obj.fov; spec.aspect = obj.aspect; spec.near = obj.near; spec.far = obj.far;
        } else if (obj.isOrthographicCamera) {
          spec.left = obj.left; spec.right = obj.right; spec.top = obj.top; spec.bottom = obj.bottom;
          spec.near = obj.near; spec.far = obj.far;
        }
        if (obj.isLight) {
          spec.color = colorTriplet(obj.color);
          spec.intensity = obj.intensity;
          if (obj.isHemisphereLight) spec.groundColor = colorTriplet(obj.groundColor);
          if (obj.isPointLight || obj.isSpotLight) {
            spec.distance = obj.distance;
            spec.decay = obj.decay;
          }
          if (obj.isSpotLight) {
            spec.angle = obj.angle;
            spec.penumbra = obj.penumbra;
          }
          if (targetId) spec.targetId = targetId;
          if (obj.shadow) {
            var shSpec = {
              mapSize: [obj.shadow.mapSize.width, obj.shadow.mapSize.height],
              bias: obj.shadow.bias,
              normalBias: obj.shadow.normalBias,
              radius: obj.shadow.radius,
            };
            if (obj.shadow.camera && obj.shadow.camera.isOrthographicCamera) {
              shSpec.cam = {
                left: obj.shadow.camera.left,
                right: obj.shadow.camera.right,
                top: obj.shadow.camera.top,
                bottom: obj.shadow.camera.bottom,
                near: obj.shadow.camera.near,
                far: obj.shadow.camera.far,
              };
            }
            spec.shadow = shSpec;
          }
        }
        this._ops.push(['obj', id, kind, spec]);
        st.metaSig = metaSig;
      }

      // Transform delta (packed directly into Float32Array staging buffer)
      var vis = obj.visible !== false ? 1 : 0;
      if (obj.matrixAutoUpdate !== false) {
        var p = obj.position, q = obj.quaternion, s = obj.scale;
        var prev = st.xf;
        if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z) &&
            isFinite(q.x) && isFinite(q.y) && isFinite(q.z) && isFinite(q.w) &&
            isFinite(s.x) && isFinite(s.y) && isFinite(s.z) &&
            (!prev || prev.length !== 11 ||
            prev[0] !== p.x || prev[1] !== p.y || prev[2] !== p.z ||
            prev[3] !== q.x || prev[4] !== q.y || prev[5] !== q.z || prev[6] !== q.w ||
            prev[7] !== s.x || prev[8] !== s.y || prev[9] !== s.z || prev[10] !== vis)) {
          var off = this._allocF32(10);
          var f = this._f32;
          f[off] = p.x; f[off + 1] = p.y; f[off + 2] = p.z;
          f[off + 3] = q.x; f[off + 4] = q.y; f[off + 5] = q.z; f[off + 6] = q.w;
          f[off + 7] = s.x; f[off + 8] = s.y; f[off + 9] = s.z;
          this._ops.push(['xf', id, 0, off, vis]);
          if (!prev || prev.length !== 11) prev = st.xf = new Array(11);
          prev[0] = p.x; prev[1] = p.y; prev[2] = p.z;
          prev[3] = q.x; prev[4] = q.y; prev[5] = q.z; prev[6] = q.w;
          prev[7] = s.x; prev[8] = s.y; prev[9] = s.z; prev[10] = vis;
        }
      } else {
        var el = obj.matrix.elements;
        var mFinite = true;
        for (var mf = 0; mf < 16; mf++) {
          if (!isFinite(el[mf])) { mFinite = false; break; }
        }
        var prevM = st.xf;
        var mChanged = mFinite && (!prevM || prevM.length !== 17 || prevM[16] !== vis);
        if (mFinite && !mChanged) {
          for (var mi = 0; mi < 16; mi++) {
            if (prevM[mi] !== el[mi]) { mChanged = true; break; }
          }
        }
        if (mChanged) {
          var mOff = this._allocF32(16);
          this._f32.set(el, mOff);
          this._ops.push(['xf', id, 1, mOff, vis]);
          if (!prevM || prevM.length !== 17) prevM = st.xf = new Array(17);
          for (var mj = 0; mj < 16; mj++) prevM[mj] = el[mj];
          prevM[16] = vis;
        }
      }

      // Camera projection delta
      if (obj.isPerspectiveCamera) {
        var pcSig = obj.fov + '|' + obj.aspect + '|' + obj.near + '|' + obj.far + '|' + obj.zoom;
        if (st.camSig !== pcSig) {
          this._ops.push(['cam', id, { fov: obj.fov, aspect: obj.aspect, near: obj.near, far: obj.far, zoom: obj.zoom }]);
          st.camSig = pcSig;
        }
      } else if (obj.isOrthographicCamera) {
        var ocSig = obj.left + '|' + obj.right + '|' + obj.top + '|' + obj.bottom + '|' + obj.near + '|' + obj.far + '|' + obj.zoom;
        if (st.camSig !== ocSig) {
          this._ops.push(['cam', id, { left: obj.left, right: obj.right, top: obj.top, bottom: obj.bottom, near: obj.near, far: obj.far, zoom: obj.zoom }]);
          st.camSig = ocSig;
        }
      }

      // Scene background & fog delta
      if (obj.isScene) {
        var bg = obj.background;
        var bgTexId = bg && bg.isTexture ? this._syncTexture(bg) : 0;
        var bgSig = !bg ? 'n' : bg.isColor ? 'c:' + bg.r + ',' + bg.g + ',' + bg.b : bgTexId ? 't:' + bgTexId : 'n';
        var fg = obj.fog;
        var fgSig = !fg ? 'n' : fg.isFogExp2
          ? 'e:' + fg.color.r + ',' + fg.color.g + ',' + fg.color.b + ',' + fg.density
          : 'l:' + fg.color.r + ',' + fg.color.g + ',' + fg.color.b + ',' + fg.near + ',' + fg.far;
        var scSig = bgSig + '|' + fgSig;
        if (st.sceneSig !== scSig) {
          var scSpec = {};
          if (!bg) scSpec.bg = null;
          else if (bg.isColor) scSpec.bg = { t: 'c', v: [bg.r, bg.g, bg.b] };
          else if (bgTexId) scSpec.bg = { t: 'tex', v: bgTexId };
          if (!fg) scSpec.fog = null;
          else if (fg.isFogExp2) scSpec.fog = { t: 'exp2', c: [fg.color.r, fg.color.g, fg.color.b], d: fg.density };
          else scSpec.fog = { t: 'linear', c: [fg.color.r, fg.color.g, fg.color.b], near: fg.near, far: fg.far };
          this._ops.push(['scene', id, scSpec]);
          st.sceneSig = scSig;
        }
      }

      // InstancedMesh matrices / colors delta
      if (obj.isInstancedMesh) {
        var imVer = (obj.count | 0) + '|' + (obj.instanceMatrix ? obj.instanceMatrix.version : 0) + '|' +
          (obj.instanceColor ? obj.instanceColor.version : -1);
        if (st.imSig !== imVer) {
          var matB64 = obj.instanceMatrix && obj.instanceMatrix.array ? encodeTypedArray(obj.instanceMatrix.array).b64 : '';
          var colB64 = obj.instanceColor && obj.instanceColor.array ? encodeTypedArray(obj.instanceColor.array).b64 : '';
          this._ops.push(['im', id, obj.count | 0, matB64, colB64]);
          st.imSig = imVer;
        }
      }

      // Children hierarchy delta
      var children = obj.children;
      if (children && children.length > 0) {
        var cids = new Array(children.length);
        for (var ci = 0; ci < children.length; ci++) {
          cids[ci] = this._syncObject(children[ci]);
        }
        var prevCh = st.ch;
        var chDiff = !prevCh || prevCh.length !== cids.length;
        if (!chDiff) {
          for (var ck = 0; ck < cids.length; ck++) {
            if (prevCh[ck] !== cids[ck]) { chDiff = true; break; }
          }
        }
        if (chDiff) {
          this._ops.push(['ch', id, cids]);
          st.ch = cids;
        }
      } else if (st.ch && st.ch.length > 0) {
        this._ops.push(['ch', id, []]);
        st.ch = [];
      }

      return id;
    };

    NativeWebGLRenderer.prototype.render = function (scene, camera) {
      if (this._disposed || !scene || !camera) return;
      this._ops.length = 0;
      this._f32Pos = 0;
      this._drawnOps.length = 0;
      this._renderSeq++;

      var cid = this.domElement && this.domElement.__softnNode ? this.domElement.__softnNode : 0;
      if (cid > 0 && cid !== this._canvasIdSent) {
        this._canvasIdSent = cid;
        this._ops.push(['cid', cid]);
      }
      if (this._sizeDirty) {
        this._sizeDirty = false;
        this._ops.push(['rs', this._w, this._h, this._dpr]);
      }
      var cfgSig = this.toneMapping + '|' + this.toneMappingExposure + '|' + this.outputColorSpace + '|' +
        (this.shadowMap.enabled ? 1 : 0) + '|' + this.shadowMap.type + '|' + (this.autoClear ? 1 : 0) + '|' +
        this._clearColor + '|' + this._clearAlpha;
      if (cfgSig !== this._lastCfgSig) {
        this._lastCfgSig = cfgSig;
        this._ops.push(['rc', {
          toneMapping: this.toneMapping,
          toneMappingExposure: this.toneMappingExposure,
          outputColorSpace: this.outputColorSpace,
          shadowMapEnabled: !!this.shadowMap.enabled,
          shadowMapType: this.shadowMap.type,
          autoClear: !!this.autoClear,
          clearColor: this._clearColor,
          clearAlpha: this._clearAlpha,
        }]);
      }

      var sceneId = this._syncObject(scene);
      var cameraId = this._syncObject(camera);
      this._ops.push(['render', sceneId, cameraId]);
      if (this._pendingDeletes.length > 0) {
        for (var di = 0; di < this._pendingDeletes.length; di++) this._ops.push(this._pendingDeletes[di]);
        this._pendingDeletes.length = 0;
      }
      if (this._renderSeq % SWEEP_EVERY === 0) this._sweepObjects();

      var f32B64 = '';
      if (this._f32Pos > 0) {
        var used = this._f32.subarray(0, this._f32Pos);
        f32B64 = bytesToB64(new Uint8Array(used.buffer, used.byteOffset, used.byteLength));
      }
      var ran = false;
      try {
        ran = host.callSync('three', 'frame', String(this._rid), JSON.stringify(this._ops), f32B64) === true;
      } catch (e) {}
      // Run: the canvases' drawing that came with it is on the Worker's copies now.
      for (var dk = 0; dk < this._drawnOps.length; dk++) if (ran) this._drawnOps[dk][5] = 'mirrored';
      this._drawnOps.length = 0;
      this.info.render.frame++;
    };

    // The objects no render has reached for SWEEP_AGE renders, let go of here and in the Worker.
    // (Not of the scene the app draws, nor anything in it: each render reaches all of that.)
    NativeWebGLRenderer.prototype._sweepObjects = function () {
      var ids = Object.keys(this._objById);
      for (var si = 0; si < ids.length; si++) {
        var oid = Number(ids[si]);
        var o = this._objById[oid];
        var ost = o ? this._objState.get(o) : null;
        if (ost && this._renderSeq - (ost.seen || 0) <= SWEEP_AGE) continue;
        this._ops.push(['del', 'obj', oid]);
        delete this._objById[oid];
        if (o) {
          this._objIds.delete(o);
          this._objState.delete(o);
          if (o._snThreeRid === this._rid) { o._snThreeRid = 0; o._snThreeId = 0; }
        }
      }
    };

    NativeWebGLRenderer.prototype.dispose = function () {
      if (this._disposed) return;
      this._disposed = true;
      if (this._animRafId) {
        g.cancelAnimationFrame(this._animRafId);
        this._animRafId = 0;
      }
      delete __activeRenderers[this._rid];
      try { host.callSync('three', 'dispose', String(this._rid), 'renderer'); } catch (e) {}
    };

    return NativeWebGLRenderer;
  }

  function patchRaycasterCtor(OrigRaycaster, Vector3Ctor, Vector2Ctor) {
    if (!OrigRaycaster || !OrigRaycaster.prototype || OrigRaycaster.__softnRayPatched) return;
    if (typeof host === 'undefined' || typeof host.callSync !== 'function') return;
    OrigRaycaster.__softnRayPatched = true;

    var vec3Ctor = Vector3Ctor || null;
    var vec2Ctor = Vector2Ctor || null;
    var origSetFromCamera = OrigRaycaster.prototype.setFromCamera;
    if (!vec2Ctor && typeof origSetFromCamera === 'function') {
      OrigRaycaster.prototype.setFromCamera = function (coords, camera) {
        if (!vec2Ctor && coords && coords.isVector2 && typeof coords.constructor === 'function') {
          vec2Ctor = coords.constructor;
        }
        return origSetFromCamera.call(this, coords, camera);
      };
    }

    var origIntersectObjects = OrigRaycaster.prototype.intersectObjects;

    function runNativeRaycast(raycaster, list, recursive, optionalTarget) {
      var out = optionalTarget || [];
      var byRid = null;
      var fallback = [];
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o && o._snThreeRid && o._snThreeId && __activeRenderers[o._snThreeRid]) {
          if (!byRid) byRid = Object.create(null);
          if (!byRid[o._snThreeRid]) byRid[o._snThreeRid] = [];
          byRid[o._snThreeRid].push(o._snThreeId);
        } else if (o) {
          fallback.push(o);
        }
      }
      if (!byRid) {
        return origIntersectObjects.call(raycaster, list, recursive, out);
      }
      var ray = raycaster.ray;
      if (!vec3Ctor && ray && ray.origin && typeof ray.origin.constructor === 'function') {
        vec3Ctor = ray.origin.constructor;
      }
      var origin = [ray.origin.x, ray.origin.y, ray.origin.z];
      var dir = [ray.direction.x, ray.direction.y, ray.direction.z];
      var near = raycaster.near;
      var far = raycaster.far === Infinity ? 1e30 : raycaster.far;
      var rids = Object.keys(byRid);
      for (var ri = 0; ri < rids.length; ri++) {
        var rid = Number(rids[ri]);
        var renderer = __activeRenderers[rid];
        var camId = raycaster.camera && raycaster.camera._snThreeRid === rid ? raycaster.camera._snThreeId : 0;
        var hits = null;
        try {
          hits = host.callSync(
            'three',
            'raycast',
            String(rid),
            JSON.stringify([origin, dir, near, far, byRid[rid], recursive !== false, camId])
          );
        } catch (e) {
          hits = null;
        }
        if (Array.isArray(hits)) {
          for (var hi = 0; hi < hits.length; hi++) {
            var h = hits[hi];
            var guestObj = renderer && renderer._objById[h.id];
            if (!guestObj) continue;
            var item = {
              distance: h.d,
              point: makeVec3(h.p[0], h.p[1], h.p[2], vec3Ctor),
              object: guestObj,
            };
            if (typeof h.fi === 'number') item.faceIndex = h.fi;
            if (Array.isArray(h.uv)) item.uv = makeVec2(h.uv[0], h.uv[1], vec2Ctor);
            if (typeof h.ii === 'number') item.instanceId = h.ii;
            out.push(item);
          }
        }
      }
      if (fallback.length > 0) {
        origIntersectObjects.call(raycaster, fallback, recursive, out);
      }
      if (out.length > 1) {
        out.sort(function (a, b) { return a.distance - b.distance; });
      }
      return out;
    }

    OrigRaycaster.prototype.intersectObject = function (object, recursive, optionalTarget) {
      return runNativeRaycast(this, [object], recursive !== false, optionalTarget);
    };
    OrigRaycaster.prototype.intersectObjects = function (objects, recursive, optionalTarget) {
      return runNativeRaycast(this, objects, recursive !== false, optionalTarget);
    };
  }

  // Standalone native renderer class for pre-bundled/inlined Three.js chunks (Vite/Rollup/Webpack/UMD)
  var BundledNativeWebGLRenderer = createNativeRendererClass(null);

  g.__softnTryNativeWebGLRenderer = function (opts) {
    if (typeof host === 'undefined' || typeof host.callSync !== 'function') return null;
    try {
      var inst = new BundledNativeWebGLRenderer(opts || {});
      if (!inst || inst._snInitFailed || !inst._rid) return null;
      return inst;
    } catch (e) {
      return null;
    }
  };

  g.__softnPatchBundledRaycaster = function (RaycasterCtor, Vector3Ctor, Vector2Ctor) {
    patchRaycasterCtor(RaycasterCtor, Vector3Ctor, Vector2Ctor);
  };

  g.__softnPatchThreeNative = function (THREE) {
    if (!THREE || THREE.__softnNativePatched) return;
    if (typeof host === 'undefined' || typeof host.callSync !== 'function') return;
    THREE.__softnNativePatched = true;

    var NativeWebGLRenderer = createNativeRendererClass(THREE);

    Object.defineProperty(THREE, 'WebGLRenderer', {
      enumerable: true,
      configurable: true,
      value: NativeWebGLRenderer,
    });

    function loadGLTF(path) {
      var grp = new THREE.Group();
      grp._snGltfSrc = String(path || '');
      return grp;
    }
    Object.defineProperty(THREE, 'loadGLTF', {
      enumerable: true,
      configurable: true,
      value: loadGLTF,
    });

    patchRaycasterCtor(THREE.Raycaster, THREE.Vector3, THREE.Vector2);
  };
})();
`;
