/**
 * On-Demand Guest WebGL / WebGL2 Proxy injected inside the ZIPP Sandbox.
 *
 * Dynamically loaded and evaluated ONLY when an app uses WebGL / WebGL2 / Three.js
 * so non-3D apps pay 0 bytes of Worker download and 0 bytes of ZIPP VM startup parsing.
 */

export const GUEST_WEBGL_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var doc = g.document;
  // ---------------------------------------------------------------------------
  // 3b. Hardware-Accelerated WebGL / WebGL2 Proxy (Worker OffscreenCanvas GPU)
  // ---------------------------------------------------------------------------
  function makeGlHandleCtor(name) {
    function Ctor(id) { this.__glId = id; }
    Ctor.prototype.toString = function () { return '[object ' + name + ']'; };
    if (!g[name]) g[name] = Ctor;
    return g[name];
  }
  var GlObject = makeGlHandleCtor('WebGLObject');
  var GlBuffer = makeGlHandleCtor('WebGLBuffer');
  var GlTexture = makeGlHandleCtor('WebGLTexture');
  var GlProgram = makeGlHandleCtor('WebGLProgram');
  var GlShader = makeGlHandleCtor('WebGLShader');
  var GlFramebuffer = makeGlHandleCtor('WebGLFramebuffer');
  var GlRenderbuffer = makeGlHandleCtor('WebGLRenderbuffer');
  var GlVertexArray = makeGlHandleCtor('WebGLVertexArrayObject');
  var GlUniformLocation = makeGlHandleCtor('WebGLUniformLocation');
  var GlQuery = makeGlHandleCtor('WebGLQuery');
  var GlSampler = makeGlHandleCtor('WebGLSampler');
  var GlSync = makeGlHandleCtor('WebGLSync');
  var GlTransformFeedback = makeGlHandleCtor('WebGLTransformFeedback');
  makeGlHandleCtor('WebGLActiveInfo');
  makeGlHandleCtor('WebGLShaderPrecisionFormat');

  var GL_CREATE_CTORS = {
    createBuffer: GlBuffer,
    createTexture: GlTexture,
    createProgram: GlProgram,
    createShader: GlShader,
    createFramebuffer: GlFramebuffer,
    createRenderbuffer: GlRenderbuffer,
    createVertexArray: GlVertexArray,
    createQuery: GlQuery,
    createSampler: GlSampler,
    createTransformFeedback: GlTransformFeedback,
    fenceSync: GlSync,
  };
  var GL_DELETE_SET = {
    deleteBuffer: 1, deleteTexture: 1, deleteProgram: 1, deleteShader: 1,
    deleteFramebuffer: 1, deleteRenderbuffer: 1, deleteVertexArray: 1,
    deleteQuery: 1, deleteSampler: 1, deleteTransformFeedback: 1, deleteSync: 1,
  };
  var GL_SYNC_SET = {
    getUniformLocation: 1, getAttribLocation: 1, getShaderParameter: 1, getProgramParameter: 1,
    getShaderInfoLog: 1, getProgramInfoLog: 1, getActiveUniform: 1, getActiveAttrib: 1,
    getActiveUniformBlockName: 1, getActiveUniformBlockParameter: 1, getActiveUniforms: 1,
    getUniformBlockIndex: 1, getBufferParameter: 1, getFramebufferAttachmentParameter: 1,
    getRenderbufferParameter: 1, getTexParameter: 1, getVertexAttrib: 1, getVertexAttribOffset: 1,
    getUniform: 1, getQuery: 1, getQueryParameter: 1, getSamplerParameter: 1, getSyncParameter: 1,
    getIndexedParameter: 1, getInternalformatParameter: 1, getFragDataLocation: 1,
    getTransformFeedbackVarying: 1, getAttachedShaders: 1, getShaderSource: 1, getError: 1,
    checkFramebufferStatus: 1, clientWaitSync: 1, getParameter: 1, readPixels: 1,
    isBuffer: 1, isEnabled: 1, isFramebuffer: 1, isProgram: 1, isQuery: 1, isRenderbuffer: 1,
    isSampler: 1, isShader: 1, isSync: 1, isTexture: 1, isTransformFeedback: 1, isVertexArray: 1,
  };

  function glTypeCode(v) {
    if (v instanceof Float32Array) return 'f32';
    if (v instanceof Float64Array) return 'f64';
    if (v instanceof Uint16Array) return 'u16';
    if (v instanceof Uint32Array) return 'u32';
    if (v instanceof Int32Array) return 'i32';
    if (v instanceof Int16Array) return 'i16';
    if (v instanceof Int8Array) return 'i8';
    if (v instanceof Uint8ClampedArray) return 'u8c';
    if (v instanceof ArrayBuffer) return 'ab';
    return 'u8';
  }

  function decodeGlReturn(val, ctx, isUniformLoc) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'object') return val;
    if (typeof val.__glH === 'number') {
      if (ctx && ctx._handles && ctx._handles[val.__glH]) return ctx._handles[val.__glH];
      var h = isUniformLoc ? new GlUniformLocation(val.__glH) : new GlObject(val.__glH);
      if (ctx && ctx._handles) ctx._handles[val.__glH] = h;
      return h;
    }
    if (typeof val.__glTA === 'string' && Array.isArray(val.data)) {
      switch (val.__glTA) {
        case 'f32': return new Float32Array(val.data);
        case 'i32': return new Int32Array(val.data);
        case 'u32': return new Uint32Array(val.data);
        case 'u16': return new Uint16Array(val.data);
        case 'i16': return new Int16Array(val.data);
        case 'i8': return new Int8Array(val.data);
        case 'u8c': return new Uint8ClampedArray(val.data);
        default: return new Uint8Array(val.data);
      }
    }
    return val;
  }

  function encodeGlArg(v, est) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'string') { est.n += v.length; return v; }
    if (typeof v.__glId === 'number') return ['$h', v.__glId];
    if (v.tagName === 'CANVAS') {
      if (v.__ctxGl) {
        v.__ctxGl._flush();
        return ['$gl', v.__ctxGl._ctxId];
      }
      var pending = [];
      if (v.__ctx2d && v.__ctx2d._cmds && v.__ctx2d._cmds.length > 0) {
        pending = v.__ctx2d._cmds.slice();
        // Flush those commands to the host 2D canvas too instead of stealing them from it.
        var c2dId = v.__softnNode || 0;
        if (c2dId && typeof g.__softnPushExtraOp === 'function') {
          var drawnOp = ['k2d', c2dId, v.width, v.height, v.__ctx2d._cmds.splice(0, v.__ctx2d._cmds.length)];
          g.__softnPushExtraOp(drawnOp);
          // The Worker draws them on its copy of the canvas when this call runs (pending):
          // marked as drawn there once it has, or the turn's end drew them on it again.
          est.drawn = drawnOp;
        } else v.__ctx2d._cmds.length = 0;
        if (typeof g.__softnClearCanvas2DDrawing === 'function') g.__softnClearCanvas2DDrawing(v.__ctx2d);
      }
      est.n += pending.length * 40;
      return ['$c2d', v.__softnNode || 0, v.width || 300, v.height || 150, pending];
    }
    if (v.tagName === 'IMG') {
      var ref = typeof g.__softnPictureRef === 'function' ? g.__softnPictureRef(v) : null;
      if (ref && typeof g.__softnMirrorPictureRef === 'function') g.__softnMirrorPictureRef(ref, v, false);
      return ['$img', ref || ''];
    }
    if ((typeof g.ImageData === 'function' && v instanceof g.ImageData) || (v.data && typeof v.width === 'number' && typeof v.height === 'number' && ArrayBuffer.isView(v.data))) {
      var idBytes = new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength);
      var idB64 = typeof g.__softnBytesTo64 === 'function' ? g.__softnBytesTo64(idBytes) : '';
      est.n += idB64.length;
      return ['$imagedata', v.width, v.height, idB64];
    }
    if (ArrayBuffer.isView(v)) {
      if (v instanceof Float32Array && v.length <= 64) {
        est.n += v.length * 10;
        return ['$f32', Array.prototype.slice.call(v)];
      }
      if (v instanceof Int32Array && v.length <= 64) {
        est.n += v.length * 8;
        return ['$i32', Array.prototype.slice.call(v)];
      }
      if (v instanceof Uint32Array && v.length <= 64) {
        est.n += v.length * 8;
        return ['$u32', Array.prototype.slice.call(v)];
      }
      var u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      var b64 = typeof g.__softnBytesTo64 === 'function' ? g.__softnBytesTo64(u8) : '';
      est.n += b64.length;
      return ['$b', glTypeCode(v), b64];
    }
    if (v instanceof ArrayBuffer) {
      var abB64 = typeof g.__softnBytesTo64 === 'function' ? g.__softnBytesTo64(new Uint8Array(v)) : '';
      est.n += abB64.length;
      return ['$b', 'ab', abB64];
    }
    if (Array.isArray(v)) {
      est.n += v.length * 8;
      return v;
    }
    return null;
  }

  var __glContexts = [];
  var __hasWeakRef = typeof g.WeakRef === 'function';
  var __glWiredProto = false;
  var __glConstantsInstalled = false;

  function WebGLRenderingContext(canvas, info) {
    this.canvas = canvas;
    this._ctxId = info.ctxId;
    this._isWebGL2 = !!info.isWebGL2;
    this._canvasIdSent = canvas.__softnNode || 0;
    this._q = [];
    this._qBytes = 0;
    this._nextHid = 1;
    this._handles = Object.create(null);
    this._params = info.params || Object.create(null);
    this._precisions = info.precisions || Object.create(null);
    this._supportedExtensions = info.supportedExtensions || [];
    this._contextAttributes = info.contextAttributes || {};
    this._extCache = Object.create(null);
    this._lost = false;
    this.drawingBufferColorSpace = 'srgb';
    this.unpackColorSpace = 'srgb';
    __glContexts.push(__hasWeakRef ? new g.WeakRef(this) : this);
  }
  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    WebGLRenderingContext.prototype[Symbol.toStringTag] = 'WebGLRenderingContext';
  }
  Object.defineProperty(WebGLRenderingContext.prototype, 'drawingBufferWidth', {
    configurable: true,
    get: function () { return this.canvas ? this.canvas.width : 0; },
  });
  Object.defineProperty(WebGLRenderingContext.prototype, 'drawingBufferHeight', {
    configurable: true,
    get: function () { return this.canvas ? this.canvas.height : 0; },
  });
  WebGLRenderingContext.prototype._ensureCanvasId = function () {
    var cid = this.canvas && this.canvas.__softnNode ? this.canvas.__softnNode : 0;
    if (cid > 0 && cid !== this._canvasIdSent) {
      this._canvasIdSent = cid;
      this._q.push(['canvasId', cid]);
    }
  };
  WebGLRenderingContext.prototype._resize = function (w, h) {
    this._ensureCanvasId();
    this._q.push(['resize', w, h]);
    this._qBytes += 24;
  };
  WebGLRenderingContext.prototype._flush = function (syncCmd) {
    this._ensureCanvasId();
    if (!syncCmd && this._q.length === 0) return null;
    var cmds = this._q.splice(0, this._q.length);
    this._qBytes = 0;
    try {
      return host.callSync(
        'webgl',
        'exec',
        String(this._ctxId),
        JSON.stringify(cmds),
        syncCmd ? JSON.stringify(syncCmd) : ''
      );
    } catch (e) {
      return null;
    }
  };
  WebGLRenderingContext.prototype.getSupportedExtensions = function () {
    return this._supportedExtensions.slice();
  };
  WebGLRenderingContext.prototype.getContextAttributes = function () {
    var out = {};
    for (var k in this._contextAttributes) out[k] = this._contextAttributes[k];
    return out;
  };
  WebGLRenderingContext.prototype.isContextLost = function () {
    return !!this._lost;
  };
  WebGLRenderingContext.prototype.getShaderPrecisionFormat = function (st, pt) {
    var key = String(st) + ':' + String(pt);
    var fmt = this._precisions[key];
    return fmt ? { rangeMin: fmt.rangeMin, rangeMax: fmt.rangeMax, precision: fmt.precision } : { rangeMin: 127, rangeMax: 127, precision: 23 };
  };
  WebGLRenderingContext.prototype.getParameter = function (pname) {
    if (Object.prototype.hasOwnProperty.call(this._params, pname)) {
      return decodeGlReturn(this._params[pname], this, false);
    }
    return decodeGlReturn(this._flush(['getParameter', pname]), this, false);
  };
  WebGLRenderingContext.prototype.getExtension = function (name) {
    var key = String(name);
    if (Object.prototype.hasOwnProperty.call(this._extCache, key)) return this._extCache[key];
    var info = null;
    try { info = host.callSync('webgl', 'ext', String(this._ctxId), key); } catch (e) { info = null; }
    if (!info) { this._extCache[key] = null; return null; }
    var self = this;
    var extObj = {};
    if (info.constants) {
      for (var ck in info.constants) extObj[ck] = info.constants[ck];
    }
    var methods = info.methods || [];
    for (var mi = 0; mi < methods.length; mi++) {
      (function (mname) {
        var isSyncExt = /^(?:get|is|check|create)/.test(mname);
        var isDeleteExt = /^delete/.test(mname);
        extObj[mname] = function () {
          var est = { n: 24 };
          var encoded = [];
          for (var ai = 0; ai < arguments.length; ai++) encoded.push(encodeGlArg(arguments[ai], est));
          if (mname === 'loseContext') self._lost = true;
          if (mname === 'restoreContext') self._lost = false;
          if (isSyncExt) {
            return decodeGlReturn(self._flush(['ext', key, mname].concat(encoded)), self, false);
          }
          // An object the extension made, deleted: let go of here too (the Worker lets go of its own).
          if (isDeleteExt && arguments[0] && typeof arguments[0].__glId === 'number') delete self._handles[arguments[0].__glId];
          self._ensureCanvasId();
          self._q.push(['x', key, mname].concat(encoded));
          self._qBytes += est.n;
          if (self._q.length >= 2000 || self._qBytes >= 400000) self._flush();
        };
      })(methods[mi]);
    }
    this._extCache[key] = extObj;
    return extObj;
  };
  WebGLRenderingContext.prototype.readPixels = function (x, y, w, h, format, type, pixels) {
    if (!pixels || !ArrayBuffer.isView(pixels)) return;
    var res = this._flush(['readPixels', x, y, w, h, format, type, pixels.byteLength, glTypeCode(pixels)]);
    if (res && typeof res.__glB64 === 'string' && typeof g.__softnBytesFrom64 === 'function') {
      var raw = g.__softnBytesFrom64(res.__glB64);
      var dst = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      dst.set(raw.subarray(0, dst.length));
    }
  };

  function WebGL2RenderingContext(canvas, info) {
    WebGLRenderingContext.call(this, canvas, info);
  }
  // Keep WebGL2RenderingContext separate from WebGLRenderingContext's prototype chain
  // (matching browser WebGL2 spec so (gl instanceof WebGLRenderingContext) is false on WebGL2).
  WebGL2RenderingContext.prototype = Object.create(Object.prototype);
  (function () {
    var keys = Object.getOwnPropertyNames(WebGLRenderingContext.prototype);
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      if (k === 'constructor') continue;
      var desc = Object.getOwnPropertyDescriptor(WebGLRenderingContext.prototype, k);
      if (desc) Object.defineProperty(WebGL2RenderingContext.prototype, k, desc);
    }
  })();
  WebGL2RenderingContext.prototype.constructor = WebGL2RenderingContext;
  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    WebGL2RenderingContext.prototype[Symbol.toStringTag] = 'WebGL2RenderingContext';
  }

  g.WebGLRenderingContext = WebGLRenderingContext;
  g.WebGL2RenderingContext = WebGL2RenderingContext;

  function installGlSurface(info) {
    if (info.constants && (!__glConstantsInstalled || info.isWebGL2)) {
      for (var ck in info.constants) {
        var cv = info.constants[ck];
        WebGLRenderingContext[ck] = cv;
        WebGLRenderingContext.prototype[ck] = cv;
        WebGL2RenderingContext[ck] = cv;
        WebGL2RenderingContext.prototype[ck] = cv;
      }
      if (info.isWebGL2) __glConstantsInstalled = true;
    }
    var methods = info.methods || [];
    for (var i = 0; i < methods.length; i++) {
      var m = methods[i];
      if (WebGLRenderingContext.prototype[m] && WebGL2RenderingContext.prototype[m]) continue;
      (function (mname) {
        var fn;
        if (GL_CREATE_CTORS[mname]) {
          var Ctor = GL_CREATE_CTORS[mname];
          fn = function () {
            var hid = this._nextHid++;
            var h = new Ctor(hid);
            this._handles[hid] = h;
            var est = { n: 24 };
            var cmd = ['c', mname, hid];
            for (var ai = 0; ai < arguments.length; ai++) cmd.push(encodeGlArg(arguments[ai], est));
            this._ensureCanvasId();
            this._q.push(cmd);
            this._qBytes += est.n;
            if (this._q.length >= 2000 || this._qBytes >= 400000) this._flush();
            return h;
          };
        } else if (GL_DELETE_SET[mname]) {
          fn = function (obj) {
            if (!obj || typeof obj.__glId !== 'number') return;
            delete this._handles[obj.__glId];
            this._q.push(['d', mname, obj.__glId]);
            this._qBytes += 16;
          };
        } else if (GL_SYNC_SET[mname]) {
          var isUloc = mname === 'getUniformLocation';
          fn = function () {
            var est = { n: 24 };
            var cmd = [mname];
            for (var ai = 0; ai < arguments.length; ai++) cmd.push(encodeGlArg(arguments[ai], est));
            return decodeGlReturn(this._flush(cmd), this, isUloc);
          };
        } else {
          fn = function () {
            var est = { n: 24 };
            var cmd = ['v', mname];
            for (var ai = 0; ai < arguments.length; ai++) cmd.push(encodeGlArg(arguments[ai], est));
            this._ensureCanvasId();
            this._q.push(cmd);
            this._qBytes += est.n;
            if (est.drawn) {
              // Run now, while the Worker's copy of that canvas is as the app drew it: its
              // drawing is the copy's once the Worker says it ran this (true).
              if (this._flush() === true) est.drawn[5] = 'mirrored';
            } else if (this._q.length >= 2000 || this._qBytes >= 400000) this._flush();
          };
        }
        if (!WebGLRenderingContext.prototype[mname]) WebGLRenderingContext.prototype[mname] = fn;
        if (!WebGL2RenderingContext.prototype[mname]) WebGL2RenderingContext.prototype[mname] = fn;
      })(m);
    }
    __glWiredProto = true;
  }

  function createGuestWebGLContext(canvas, kind, attrs) {
    if (typeof host === 'undefined' || typeof host.callSync !== 'function') return null;
    var info = null;
    try {
      info = host.callSync(
        'webgl',
        'init',
        String(canvas.__softnNode || 0),
        String(kind),
        String(canvas.width || 300),
        String(canvas.height || 150),
        attrs ? JSON.stringify(attrs) : '{}'
      );
    } catch (e) {
      info = null;
    }
    if (!info || !info.ctxId) return null;
    installGlSurface(info);
    var ctx = info.isWebGL2
      ? new WebGL2RenderingContext(canvas, info)
      : new WebGLRenderingContext(canvas, info);
    canvas.__ctxGl = ctx;
    if (typeof g.__softnRegisterCanvasGone === 'function' && canvas.__softnNode) g.__softnRegisterCanvasGone(canvas, canvas.__softnNode);
    return ctx;
  }

  function flushWebGL() {
    var alive = [];
    for (var i = 0; i < __glContexts.length; i++) {
      var ref = __glContexts[i];
      var ctx = __hasWeakRef && ref && typeof ref.deref === 'function' ? ref.deref() : ref;
      if (!ctx) continue;
      alive.push(ref);
      if (ctx._q.length > 0) ctx._flush();
    }
    if (alive.length !== __glContexts.length) __glContexts = alive;
  }

  g.__softnCreateWebGLContext = createGuestWebGLContext;
  g.__softnFlushWebGL = flushWebGL;
  g.__softnDisposeWebGLCanvas = function (goneId) {
    if (__glContexts.length > 0 && typeof host !== 'undefined' && typeof host.callSync === 'function') {
      try { host.callSync('webgl', 'dispose', String(goneId), 'canvas'); } catch (e) {}
    }
  };
})();
`;
