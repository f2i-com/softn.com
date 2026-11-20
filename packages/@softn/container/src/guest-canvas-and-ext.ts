/**
 * Guest Web API Extensions & Hosted Vendor Shims injected inside the ZIPP Sandbox.
 *
 * Extends `shellPrelude` with:
 * 1. Hydration of inline HTML event attributes (`onclick="..."`, `onsubmit="..."`) from `SeedNode.h`
 * 2. Full `HTMLCanvasElement.prototype.getContext('2d')` (`CanvasRenderingContext2D`) command recorder
 * 3. Virtual-origin `fetch()` (`https://app.softn.local/...` + binary `arrayBuffer()`/`blob()`)
 * 4. Standard `setTimeout` / `setInterval` / `performance.now()` Worker timer bridge
 * 5. Built-in hosted `/runtime/vendor/` libraries (`three` Split-Realm proxy, `marked`, `htm`, `preact`)
 *    and `softn:*` capability modules (`softn:db`, `softn:net`, `softn:storage`)
 */

export const GUEST_EXTENSIONS_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var doc = g.document;

  // ---------------------------------------------------------------------------
  // 1. Timers & performance.now()
  // ---------------------------------------------------------------------------
  var __startEpoch = Date.now();
  if (typeof g.performance === 'undefined' || !g.performance) {
    g.performance = {
      timeOrigin: __startEpoch,
      now: function () { return Date.now() - __startEpoch; },
    };
  }
  var __timers = Object.create(null);
  var __nextTimerId = 1;
  g.setTimeout = function (fn, ms) {
    var id = __nextTimerId++;
    var args = Array.prototype.slice.call(arguments, 2);
    var delay = Math.max(0, Number(ms) || 0);
    __timers[id] = { fn: fn, args: args, repeat: false, delay: delay };
    host.call('timer.set', [String(id), String(delay), '0'], function () {
      var entry = __timers[id];
      if (!entry) return;
      delete __timers[id];
      if (typeof entry.fn === 'function') entry.fn.apply(g, entry.args);
    });
    return id;
  };
  g.clearTimeout = function (id) {
    var n = Number(id);
    if (__timers[n]) {
      delete __timers[n];
      host.call('timer.clear', [String(n)]);
    }
  };
  g.setInterval = function (fn, ms) {
    var id = __nextTimerId++;
    var args = Array.prototype.slice.call(arguments, 2);
    var delay = Math.max(4, Number(ms) || 4);
    function arm() {
      if (!__timers[id]) return;
      host.call('timer.set', [String(id), String(delay), '1'], function () {
        var entry = __timers[id];
        if (!entry) return;
        try {
          if (typeof entry.fn === 'function') entry.fn.apply(g, entry.args);
        } finally {
          if (__timers[id]) arm();
        }
      });
    }
    __timers[id] = { fn: fn, args: args, repeat: true, delay: delay };
    arm();
    return id;
  };
  g.clearInterval = g.clearTimeout;
  if (g.window) {
    g.window.setTimeout = g.setTimeout;
    g.window.clearTimeout = g.clearTimeout;
    g.window.setInterval = g.setInterval;
    g.window.clearInterval = g.clearInterval;
    g.window.performance = g.performance;
  }

  // Hook requestAnimationFrame so Worker knows when to schedule the next frame
  var __rafCbs = Object.create(null);
  var __rafSeq = 1;
  var __wantsRaf = false;
  g.requestAnimationFrame = function (cb) {
    if (typeof cb !== 'function') throw new TypeError('requestAnimationFrame requires a callback');
    var id = __rafSeq++;
    __rafCbs[id] = cb;
    __wantsRaf = true;
    return id;
  };
  g.cancelAnimationFrame = function (id) {
    delete __rafCbs[Number(id)];
  };
  if (g.window) {
    g.window.requestAnimationFrame = g.requestAnimationFrame;
    g.window.cancelAnimationFrame = g.cancelAnimationFrame;
  }
  g.__softnRunRaf = function (ts) {
    __wantsRaf = false;
    var batch = __rafCbs;
    __rafCbs = Object.create(null);
    var ids = Object.keys(batch);
    for (var i = 0; i < ids.length; i++) {
      try {
        batch[ids[i]](ts);
      } catch (err) {
        console.error('[SoftN] requestAnimationFrame error:', err && err.message ? err.message : String(err));
      }
    }
  };
  g.__softnWantsRaf = function () {
    return __wantsRaf || Object.keys(__rafCbs).length > 0;
  };

  // ---------------------------------------------------------------------------
  // 2. Hydrate inline HTML event attributes ('onclick="..."', 'onsubmit="..."')
  // ---------------------------------------------------------------------------
  g.__softnHydrateInlineHandlers = function (nodes) {
    if (!Array.isArray(nodes) || !doc) return;
    var byId = Object.create(null);
    var all = doc.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].__softnNode) byId[all[i].__softnNode] = all[i];
    }
    function visit(list) {
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        if (item.h && byId[item.i]) {
          for (var attr in item.h) {
            try { byId[item.i].setAttribute(attr, item.h[attr]); } catch (_) {}
          }
        }
        if (item.c) visit(item.c);
      }
    }
    visit(nodes);
  };

  // ---------------------------------------------------------------------------
  // 3. HTMLCanvasElement & CanvasRenderingContext2D Command Buffer
  // ---------------------------------------------------------------------------
  var __extraOps = [];
  // The context drawn on last: the only one whose commands are not among the turn's ops yet.
  // What is drawn goes to the page (and to the Worker's copies) in the order it was drawn,
  // across canvases. Each canvas's drawing went at the end of the turn, one canvas after
  // another: a canvas drawn into another was sent after it, and the other was drawn with
  // what the first had before.
  var __drawing = null;
  function flushDrawing() {
    var ctx = __drawing;
    __drawing = null;
    if (!ctx) return;
    var cid = ctx.canvas && ctx.canvas.__softnNode;
    if (cid && ctx._cmds.length > 0) __extraOps.push(['k2d', cid, ctx.canvas.width, ctx.canvas.height, ctx._cmds.splice(0, ctx._cmds.length)]);
    else ctx._cmds.length = 0;
  }
  // A canvas the app can no longer reach: the page's canvas for it and the Worker's copy are
  // let go of too. Told at the end of the turn, after whatever was drawn with it. (A canvas
  // made for a moment, as a thumbnail is made, was kept on the page for good.)
  var __goneCanvases = [];
  var __canvasGone = typeof g.FinalizationRegistry === 'function' ? new g.FinalizationRegistry(function (id) { __goneCanvases.push(id); }) : null;
  // Said once each: what a canvas read back at once could not have.
  var warnedOnce = {};
  function warnOnce(key, text) {
    if (warnedOnce[key]) return;
    warnedOnce[key] = true;
    g.console.warn('[SoftN] ' + text);
  }

  function GuestImageData(dataOrW, wOrH, maybeH) {
    if (typeof dataOrW === 'number') {
      this.width = dataOrW | 0;
      this.height = wOrH | 0;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrW;
      this.width = wOrH | 0;
      this.height = (maybeH !== undefined ? maybeH : (dataOrW.length / 4 / this.width)) | 0;
    }
  }
  g.ImageData = GuestImageData;

  function bytesToB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 4096) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 4096));
    }
    return g.btoa(s);
  }

  function Canvas2DContext(canvas) {
    this.canvas = canvas;
    this._cmds = [];
    resetState(this);
  }
  // A context's state as it is new, and again when its canvas's size is set.
  function resetState(ctx) {
    var self = ctx;
    self._fillStyle = '#000000';
    self._strokeStyle = '#000000';
    self._lineWidth = 1;
    self._lineCap = 'butt';
    self._lineJoin = 'miter';
    self._globalAlpha = 1;
    self._globalCompositeOperation = 'source-over';
    self._font = '10px sans-serif';
    self._textAlign = 'start';
    self._textBaseline = 'alphabetic';
    self._shadowColor = 'rgba(0, 0, 0, 0)';
    self._shadowBlur = 0;
    self._shadowOffsetX = 0;
    self._shadowOffsetY = 0;
  }

  // A command was given to ctx: what the context drawn on before it was given goes first.
  function markCanvasDirty(ctx) {
    if (__drawing !== ctx) {
      flushDrawing();
      __drawing = ctx;
    }
  }
  // The app set a canvas's size: what it holds is cleared, in its place among what was drawn,
  // and even to the size it had (the way older code clears one, which the page did not do).
  function resetCanvas(canvas) {
    var ctx = canvas.__ctx2d;
    if (__drawing === ctx) {
      // Drawn and then cleared: as well not drawn.
      ctx._cmds.length = 0;
      __drawing = null;
    } else {
      flushDrawing();
    }
    resetState(ctx);
    if (canvas.__softnNode) __extraOps.push(['k2dreset', canvas.__softnNode, canvas.width, canvas.height]);
  }

  [
    'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin',
    'globalAlpha', 'globalCompositeOperation', 'font', 'textAlign',
    'textBaseline', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
  ].forEach(function (prop) {
    var priv = '_' + prop;
    Object.defineProperty(Canvas2DContext.prototype, prop, {
      enumerable: true,
      get: function () { return this[priv]; },
      set: function (v) {
        if (typeof v === 'string' || typeof v === 'number') {
          this[priv] = v;
          this._cmds.push(['prop', prop, v]);
          markCanvasDirty(this);
        } else if ((prop === 'fillStyle' || prop === 'strokeStyle') && v && v.__grad) {
          this[priv] = v;
          this._cmds.push(['grad', prop, v.__grad, v._args, v._stops.slice()]);
          markCanvasDirty(this);
        }
      },
    });
  });

  [
    'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arc', 'ellipse', 'rect', 'roundRect',
    'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip',
    'save', 'restore', 'scale', 'rotate', 'translate', 'transform',
    'setTransform', 'resetTransform', 'setLineDash', 'fillText', 'strokeText',
  ].forEach(function (method) {
    Canvas2DContext.prototype[method] = function () {
      var entry = [method];
      for (var i = 0; i < arguments.length; i++) entry.push(arguments[i]);
      this._cmds.push(entry);
      markCanvasDirty(this);
    };
  });

  Canvas2DContext.prototype.getLineDash = function () { return []; };
  Canvas2DContext.prototype.measureText = function (text) {
    var s = String(text || '');
    var sizeMatch = /(\d+(?:\.\d+)?)px/.exec(this._font);
    var px = sizeMatch ? parseFloat(sizeMatch[1]) : 12;
    var w = s.length * px * 0.56;
    return {
      width: w,
      actualBoundingBoxAscent: px * 0.8,
      actualBoundingBoxDescent: px * 0.2,
      fontBoundingBoxAscent: px * 0.85,
      fontBoundingBoxDescent: px * 0.25,
    };
  };
  Canvas2DContext.prototype.createImageData = function (w, h) {
    return new GuestImageData(w, h);
  };
  Canvas2DContext.prototype.putImageData = function (imgData, dx, dy) {
    if (!imgData || !imgData.data) return;
    var b64 = bytesToB64(new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength));
    this._cmds.push(['putImageData', b64, imgData.width, imgData.height, dx || 0, dy || 0]);
    markCanvasDirty(this);
  };
  Canvas2DContext.prototype.createLinearGradient = function (x0, y0, x1, y1) {
    var stops = [];
    return {
      __grad: 'linear',
      _args: [Number(x0) || 0, Number(y0) || 0, Number(x1) || 0, Number(y1) || 0],
      _stops: stops,
      addColorStop: function (off, col) { stops.push([Number(off) || 0, String(col)]); }
    };
  };
  Canvas2DContext.prototype.createRadialGradient = function (x0, y0, r0, x1, y1, r1) {
    var stops = [];
    return {
      __grad: 'radial',
      _args: [Number(x0) || 0, Number(y0) || 0, Number(r0) || 0, Number(x1) || 0, Number(y1) || 0, Number(r1) || 0],
      _stops: stops,
      addColorStop: function (off, col) { stops.push([Number(off) || 0, String(col)]); }
    };
  };
  // A canvas read back at once (toDataURL, getImageData). The canvas the app draws on is on
  // the page, a thread away, and answers nothing at once. For an app whose own code names
  // one of the two, the Worker keeps a canvas of its own beside each of the app's and draws
  // on it what the app draws; the app's script reads its picture back from that one.
  // What each image was last told to the Worker as, by its name there: kept with the image,
  // and gone with it (by name alone, it grew for as long as the app made images).
  var mirrored = typeof g.WeakMap === 'function' ? new g.WeakMap() : null;
  function mirrorPicture(ref, img, early) {
    if (g.__softnCanvasMirror !== true || typeof host === 'undefined' || typeof host.callSync !== 'function') return;
    var src = img && typeof img.getAttribute === 'function' ? img.getAttribute('src') : null;
    if (!src) return;
    var told = mirrored && img && typeof img === 'object' ? mirrored.get(img) : null;
    if (told && told[ref] === src) return;
    if (mirrored && img && typeof img === 'object') {
      if (!told) { told = {}; mirrored.set(img, told); }
      told[ref] = src;
    }
    var cors = typeof img.getAttribute === 'function' && img.getAttribute('crossorigin') !== null;
    try { host.callSync('canvas.image', ref, String(src), g.location ? g.location.pathname : '/index.html', early ? 'early' : '', cors ? 'cors' : ''); } catch (e) {}
  }
  // A picture is decoded for the Worker's copies as soon as its address is set, not when it
  // is first drawn: drawn in its own load handler, it was not decoded yet, and that drawing
  // never reached the copy. (The Worker also holds the load back until it has decoded it.)
  g.__softnMirrorPicture = function (img) {
    var ref = pictureRef(img);
    if (ref) mirrorPicture(ref, img, true);
  };
  if (g.__softnCanvasMirror === true && doc && typeof doc.querySelectorAll === 'function') {
    var writtenImages = doc.querySelectorAll('img');
    for (var wi = 0; wi < writtenImages.length; wi++) g.__softnMirrorPicture(writtenImages[wi]);
  }
  // Said once: a canvas is not read back here, and why.
  var readBackRefused = false;
  function cannotReadBack() {
    if (readBackRefused) return;
    readBackRefused = true;
    var why = typeof g.__softnCanvasMirror === 'string' ? g.__softnCanvasMirror : 'there is no canvas to read it from';
    g.console.warn('[SoftN] A canvas cannot be read back at once here (' + why + "): toDataURL() answers 'data:,' and getImageData() a transparent picture. canvas.toBlob() asks the page for its picture, and works.");
  }
  // What a read-back answer says it lacks, or why it was not given.
  var LACKING = {
    missing: "A picture drawn into a canvas had not reached the Worker's copy of it when the canvas was read back (one still loading, or a video's frame): what is read back lacks it.",
    partial: "The Worker let go of its copy of a canvas the app had not drawn on lately, to keep within what it holds for copies: what was drawn on it before then is not in what is read back.",
  };
  var REFUSED = {
    size: "A canvas larger than the Worker keeps a copy of was read back: toDataURL() answers 'data:,' and getImageData() a transparent picture. canvas.toBlob() asks the page for its picture, and works.",
    large: "A canvas was read back as more than reaches the app in one answer: toDataURL() answers 'data:,' and getImageData() a transparent picture. Read it in parts, or use canvas.toBlob(), which asks the page.",
    error: 'A canvas could not be read back: it answers as one with nothing drawn.',
  };
  // Everything drawn this turn that the Worker's copies do not have yet goes to them now, on
  // every canvas and in the order it was drawn, and is marked as theirs once they have it.
  function readBack(canvas, kind, extra) {
    if (g.__softnCanvasMirror !== true) { cannotReadBack(); return null; }
    if (!canvas || !canvas.__softnNode || typeof host === 'undefined' || typeof host.callSync !== 'function') return null;
    flushDrawing();
    var sent = [];
    var batches = [];
    for (var i = 0; i < __extraOps.length; i++) {
      var op = __extraOps[i];
      if (op[0] === 'k2d' && op[5] !== 'mirrored') { sent.push(op); batches.push([op[1], op[2], op[3], op[4]]); }
      else if (op[0] === 'k2dreset' && op[4] !== 'mirrored') { sent.push(op); batches.push([op[1], op[2], op[3], null]); }
    }
    var answer;
    try {
      answer = host.callSync.apply(host, [kind, String(canvas.__softnNode), String(canvas.width), String(canvas.height), JSON.stringify(batches)].concat(extra || []));
    } catch (e) {
      // Not taken (more drawing than one call carries): the copies have it at the end of the turn instead.
      warnOnce('carry', 'A canvas was read back after more drawing than reaches the Worker at once (a large putImageData): the answer is from before it, and the canvas is read whole again in the next turn.');
      return null;
    }
    for (var k = 0; k < sent.length; k++) sent[k][sent[k][0] === 'k2d' ? 5 : 4] = 'mirrored';
    if (answer && answer.lacking && LACKING[answer.lacking]) warnOnce('lacking:' + answer.lacking, LACKING[answer.lacking]);
    if (answer && answer.refused && REFUSED[answer.refused]) warnOnce('refused:' + answer.refused, REFUSED[answer.refused]);
    return answer;
  }
  // More of a canvas being read: nothing has been drawn since the call before.
  function readMore(canvas, extra) {
    try {
      return host.callSync.apply(host, ['canvas.pixels', String(canvas.__softnNode), String(canvas.width), String(canvas.height), '[]'].concat(extra));
    } catch (e) {
      return null;
    }
  }
  function notReadable() {
    var message = 'The canvas has a picture from another site drawn into it, and is not read back.';
    var error = typeof g.DOMException === 'function' ? new g.DOMException(message, 'SecurityError') : new Error(message);
    if (error.name !== 'SecurityError') { try { error.name = 'SecurityError'; } catch (e) {} }
    return error;
  }
  // The pixels come as numbers, which the engine reads at once: as base64, they were read
  // here a byte at a time, a megabyte a second, and a read was held to 400,000 pixels.
  // Read in bands of as many rows as one answer carries; at most this many pixels in all.
  var PIXELS_AN_ANSWER = 900000;
  var MAX_READ_PIXELS = 8388608;
  Canvas2DContext.prototype.getImageData = function (x, y, w, h) {
    var left = Math.floor(Number(x) || 0);
    var top = Math.floor(Number(y) || 0);
    // A negative width or height reads the rectangle on the other side of x or y, as a browser reads it.
    var sw = Math.floor(Number(w) || 0);
    var sh = Math.floor(Number(h) || 0);
    if (sw < 0) left += sw;
    if (sh < 0) top += sh;
    var width = Math.max(1, Math.abs(sw));
    var height = Math.max(1, Math.abs(sh));
    if (width * height > MAX_READ_PIXELS) {
      warnOnce('read-size', 'getImageData() of more than ' + MAX_READ_PIXELS + ' pixels at once is not read back here: it answers a transparent picture. Read it in parts.');
      return new GuestImageData(width, height);
    }
    var rows = Math.max(1, Math.floor(PIXELS_AN_ANSWER / width));
    var data = null;
    for (var at = 0; at < height; at += rows) {
      var band = Math.min(rows, height - at);
      var where = [String(left), String(top + at), String(width), String(band)];
      var answer = at === 0 ? readBack(this.canvas, 'canvas.pixels', where) : readMore(this.canvas, where);
      if (answer && answer.tainted) throw notReadable();
      // No canvas to read from, or one past what is read: the size asked for, with nothing in it.
      if (!answer || !answer.pixels) return new GuestImageData(width, height);
      if (!data) data = new Uint8ClampedArray(width * height * 4);
      data.set(answer.pixels, at * width * 4);
    }
    return new GuestImageData(data, width, height);
  };
  // The name the page draws a picture by: an image on no page by its address, which is how
  // the page loaded it (apart, by that address); an image on the page, and any canvas, by
  // its node. An image on no page was named by a node the page was never told of, and a
  // game's sprites made with new Image() drew nothing.
  // One asked for with CORS (crossOrigin) is another picture than the same address without:
  // the page loads it apart, and a canvas it is drawn into can be read back.
  function pictureRef(img) {
    if (!img) return null;
    var src = typeof img.getAttribute === 'function' ? img.getAttribute('src') : null;
    var tag = img.tagName ? String(img.tagName).toUpperCase() : '';
    if (tag === 'IMG' && src && !img.isConnected) return img.getAttribute('crossorigin') !== null ? 'cors:' + src : src;
    if (img.__softnNode) return 'node:' + img.__softnNode;
    return src || null;
  }
  Canvas2DContext.prototype.drawImage = function (img) {
    var ref = pictureRef(img);
    if (!ref) return;
    // A video's frame is drawn on the page and not in the Worker's copy: said so there, once.
    if (img && img.tagName && String(img.tagName).toUpperCase() === 'VIDEO' && g.__softnCanvasMirror === true && mirrored && !mirrored.has(img)) {
      mirrored.set(img, {});
      try { host.callSync('canvas.image', ref, '', '/', 'none'); } catch (e) {}
    }
    mirrorPicture(ref, img);
    var args = ['drawImage', ref];
    for (var i = 1; i < arguments.length; i++) args.push(Number(arguments[i]) || 0);
    this._cmds.push(args);
    markCanvasDirty(this);
  };

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
        pending = v.__ctx2d._cmds.splice(0, v.__ctx2d._cmds.length);
        if (__drawing === v.__ctx2d) __drawing = null;
      }
      est.n += pending.length * 40;
      return ['$c2d', v.__softnNode || 0, v.width || 300, v.height || 150, pending];
    }
    if (v.tagName === 'IMG') {
      var ref = pictureRef(v);
      if (ref) mirrorPicture(ref, v, false);
      return ['$img', ref || ''];
    }
    if (v instanceof GuestImageData || (v.data && typeof v.width === 'number' && typeof v.height === 'number' && ArrayBuffer.isView(v.data))) {
      var idBytes = new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength);
      var idB64 = bytesToB64(idBytes);
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
      var b64 = bytesToB64(u8);
      est.n += b64.length;
      return ['$b', glTypeCode(v), b64];
    }
    if (v instanceof ArrayBuffer) {
      var abB64 = bytesToB64(new Uint8Array(v));
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
    __glContexts.push(this);
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
        extObj[mname] = function () {
          var est = { n: 24 };
          var encoded = [];
          for (var ai = 0; ai < arguments.length; ai++) encoded.push(encodeGlArg(arguments[ai], est));
          if (mname === 'loseContext') self._lost = true;
          if (mname === 'restoreContext') self._lost = false;
          if (isSyncExt) {
            return decodeGlReturn(self._flush(['ext', key, mname].concat(encoded)), self, false);
          }
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
    if (res && typeof res.__glB64 === 'string') {
      var raw = b64ToBytes(res.__glB64);
      var dst = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      dst.set(raw.subarray(0, dst.length));
    }
  };

  function WebGL2RenderingContext(canvas, info) {
    WebGLRenderingContext.call(this, canvas, info);
  }
  WebGL2RenderingContext.prototype = Object.create(WebGLRenderingContext.prototype);
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
      if (WebGLRenderingContext.prototype[m]) continue;
      (function (mname) {
        if (GL_CREATE_CTORS[mname]) {
          var Ctor = GL_CREATE_CTORS[mname];
          WebGLRenderingContext.prototype[mname] = function () {
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
          WebGLRenderingContext.prototype[mname] = function (obj) {
            if (!obj || typeof obj.__glId !== 'number') return;
            delete this._handles[obj.__glId];
            this._q.push(['d', mname, obj.__glId]);
            this._qBytes += 16;
          };
        } else if (GL_SYNC_SET[mname]) {
          var isUloc = mname === 'getUniformLocation';
          WebGLRenderingContext.prototype[mname] = function () {
            var est = { n: 24 };
            var cmd = [mname];
            for (var ai = 0; ai < arguments.length; ai++) cmd.push(encodeGlArg(arguments[ai], est));
            return decodeGlReturn(this._flush(cmd), this, isUloc);
          };
        } else {
          WebGLRenderingContext.prototype[mname] = function () {
            var est = { n: 24 };
            var cmd = ['v', mname];
            for (var ai = 0; ai < arguments.length; ai++) cmd.push(encodeGlArg(arguments[ai], est));
            this._ensureCanvasId();
            this._q.push(cmd);
            this._qBytes += est.n;
            if (this._q.length >= 2000 || this._qBytes >= 400000) this._flush();
          };
        }
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
    if (__canvasGone && canvas.__softnNode) __canvasGone.register(canvas, canvas.__softnNode);
    return ctx;
  }

  function flushWebGL() {
    for (var i = 0; i < __glContexts.length; i++) {
      var ctx = __glContexts[i];
      if (ctx && ctx._q.length > 0) ctx._flush();
    }
  }

  if (g.HTMLElement) {
    var origMake = doc && doc.createElement ? doc.createElement.bind(doc) : null;
    Object.defineProperty(g.HTMLElement.prototype, 'width', {
      configurable: true,
      get: function () {
        if (this.tagName === 'CANVAS') {
          var attr = this.getAttribute('width');
          return attr !== null ? Number(attr) || 300 : 300;
        }
        return this.offsetWidth || 0;
      },
      set: function (v) {
        if (this.tagName === 'CANVAS') {
          this.setAttribute('width', String(Math.max(1, Number(v) || 300)));
          if (this.__ctx2d) resetCanvas(this);
          if (this.__ctxGl) this.__ctxGl._resize(this.width, this.height);
        }
      },
    });
    Object.defineProperty(g.HTMLElement.prototype, 'height', {
      configurable: true,
      get: function () {
        if (this.tagName === 'CANVAS') {
          var attr = this.getAttribute('height');
          return attr !== null ? Number(attr) || 150 : 150;
        }
        return this.offsetHeight || 0;
      },
      set: function (v) {
        if (this.tagName === 'CANVAS') {
          this.setAttribute('height', String(Math.max(1, Number(v) || 150)));
          if (this.__ctx2d) resetCanvas(this);
          if (this.__ctxGl) this.__ctxGl._resize(this.width, this.height);
        }
      },
    });
    // Ensure canvas (and any direct canvas wrapper div such as R3F's events.connected container)
    // always reports a positive CSS box size even before the first asynchronous host box measurement
    // arrives (prevents divide-by-zero NaN in OrbitControls on the first drag pixel).
    if (g.Element && g.Element.prototype) {
      ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'].forEach(function (dimProp) {
        var desc = Object.getOwnPropertyDescriptor(g.Element.prototype, dimProp);
        var origGet = desc && desc.get;
        if (typeof origGet !== 'function') return;
        var isWidth = dimProp === 'clientWidth' || dimProp === 'offsetWidth';
        Object.defineProperty(g.HTMLElement.prototype, dimProp, {
          configurable: true,
          get: function () {
            var v = origGet.call(this);
            if (v > 0) return v;
            if (this.tagName === 'CANVAS') {
              var cssVal = this.style ? parseFloat(isWidth ? this.style.width : this.style.height) : NaN;
              if (cssVal > 0 && isFinite(cssVal)) return Math.round(cssVal);
              return isWidth ? (this.width || 300) : (this.height || 150);
            }
            if (!this.style || this.style.display !== 'none') {
              var c1 = this.firstElementChild;
              if (c1) {
                if (c1.tagName === 'CANVAS') return c1[dimProp];
                var c2 = c1.firstElementChild;
                if (c2 && c2.tagName === 'CANVAS') return c2[dimProp];
              }
            }
            return v;
          },
        });
      });
    }
    g.HTMLElement.prototype.getContext = function (type, attrs) {
      if (this.tagName !== 'CANVAS') return null;
      if (type === '2d') {
        if (this.__ctxGl) return null;
        if (!this.__ctx2d) {
          this.__ctx2d = new Canvas2DContext(this);
          if (__canvasGone && this.__softnNode) __canvasGone.register(this, this.__softnNode);
        }
        return this.__ctx2d;
      }
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
        if (this.__ctx2d) return null;
        if (this.__ctxGl) return this.__ctxGl;
        return createGuestWebGLContext(this, type, attrs);
      }
      return null;
    };
    g.HTMLElement.prototype.toDataURL = function () {
      // A PNG, whatever kind was asked for: the kind a browser answers with when it has not the one named.
      if (this.tagName !== 'CANVAS') return 'data:,';
      var answer = readBack(this, 'canvas.dataurl', []);
      if (answer && answer.tainted) throw notReadable();
      return answer && typeof answer.url === 'string' && answer.url.indexOf('data:image/png;base64,') === 0 ? answer.url : 'data:,';
    };
    void origMake;
  }

  // Wrap '__softnDocTake' so Canvas2D and Split-Realm Three.js ops ride in the exact same turn flush!
  var origDocTake = g.__softnDocTake;
  // Hydrate and persist guest sessionStorage across reloads via IndexedDB session store.
  if (g.sessionStorage) {
    if (g.__softnInitSessionStorage && typeof g.__softnInitSessionStorage === 'object') {
      var ssInitKeys = Object.keys(g.__softnInitSessionStorage);
      for (var ski = 0; ski < ssInitKeys.length; ski++) {
        try { g.sessionStorage.setItem(ssInitKeys[ski], String(g.__softnInitSessionStorage[ssInitKeys[ski]])); } catch (_) {}
      }
      try { delete g.__softnInitSessionStorage; } catch (_) { g.__softnInitSessionStorage = undefined; }
    }
    var origSsSet = g.sessionStorage.setItem;
    var origSsRemove = g.sessionStorage.removeItem;
    var origSsClear = g.sessionStorage.clear;
    if (typeof origSsSet === 'function') {
      g.sessionStorage.setItem = function (k, v) {
        var sk = String(k), sv = String(v);
        origSsSet.call(this, sk, sv);
        if (typeof host !== 'undefined' && typeof host.callSync === 'function') {
          try { host.callSync('session', 'ss', 'set', sk, sv); } catch (_) {}
        }
      };
    }
    if (typeof origSsRemove === 'function') {
      g.sessionStorage.removeItem = function (k) {
        var sk = String(k);
        origSsRemove.call(this, sk);
        if (typeof host !== 'undefined' && typeof host.callSync === 'function') {
          try { host.callSync('session', 'ss', 'remove', sk, ''); } catch (_) {}
        }
      };
    }
    if (typeof origSsClear === 'function') {
      g.sessionStorage.clear = function () {
        origSsClear.call(this);
        if (typeof host !== 'undefined' && typeof host.callSync === 'function') {
          try { host.callSync('session', 'ss', 'clear', '', ''); } catch (_) {}
        }
      };
    }
  }
  var __lastRoutePath = g.location ? (g.location.pathname || '/') + (g.location.search || '') + (g.location.hash || '') : '';
  function syncRouteIfChanged() {
    if (!g.location || typeof host === 'undefined' || typeof host.callSync !== 'function') return;
    var cur = (g.location.pathname || '/') + (g.location.search || '') + (g.location.hash || '');
    if (cur && cur !== __lastRoutePath) {
      __lastRoutePath = cur;
      try { host.callSync('session', 'route', cur); } catch (_) {}
    }
  }
  g.__softnPushExtraOp = function (op) { __extraOps.push(op); };
  g.__softnDocTake = function (failed) {
    flushDrawing();
    flushWebGL();
    syncRouteIfChanged();
    while (__goneCanvases.length) {
      var goneId = __goneCanvases.shift();
      __extraOps.push(['k2dgone', goneId]);
      if (__glContexts.length > 0 && typeof host !== 'undefined' && typeof host.callSync === 'function') {
        try { host.callSync('webgl', 'dispose', String(goneId), 'canvas'); } catch (e) {}
      }
    }
    var domOps = origDocTake ? origDocTake(failed) : null;
    if (__extraOps.length === 0) return domOps;
    var extra = __extraOps.splice(0, __extraOps.length);
    return domOps ? domOps.concat(extra) : extra;
  };

  // ---------------------------------------------------------------------------
  // 4. Virtual-Origin 'fetch()' & Binary 'Response' ('arrayBuffer()', 'blob()')
  // ---------------------------------------------------------------------------
  // Bytes from base64. Made here a byte at a time, which is this engine's slowest work: a few
  // megabytes took more than a turn has and stopped the app. More than a little is made by
  // the Worker, which answers with numbers this engine reads at once, in pieces the bridge
  // carries (4 million characters from here, 16 MB of JSON back).
  var DECODED_BY_WORKER = 65536;
  var DECODE_PIECE = 3000000;
  function b64ToBytesHere(b64) {
    var bin = g.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64ToBytes(b64) {
    var text = String(b64).replace(/[\s]+/g, '');
    if (text.length < DECODED_BY_WORKER || typeof host === 'undefined' || typeof host.callSync !== 'function') return b64ToBytesHere(text);
    var pad = text.charAt(text.length - 1) === '=' ? (text.charAt(text.length - 2) === '=' ? 2 : 1) : 0;
    var out = new Uint8Array(Math.floor(text.length / 4) * 3 - pad);
    var at = 0;
    for (var from = 0; from < text.length; from += DECODE_PIECE) {
      var numbers = null;
      try { numbers = host.callSync('bytes.decode', text.slice(from, from + DECODE_PIECE)); } catch (e) { numbers = null; }
      if (!numbers || typeof numbers.length !== 'number') return b64ToBytesHere(text);
      out.set(numbers, at);
      at += numbers.length;
    }
    return at === out.length ? out : out.subarray(0, at);
  }
  g.__softnBytesFrom64 = b64ToBytes;

  function ContainerResponse(payload, url) {
    this.ok = !!payload.ok;
    this.status = Number(payload.status) || 200;
    this.statusText = payload.statusText || (this.ok ? 'OK' : 'Error');
    this.url = url;
    this.headers = new g.Headers(payload.headers || {});
    this.bodyUsed = false;
    Object.defineProperty(this, '_payload', { value: payload, enumerable: false });
  }
  ContainerResponse.prototype.text = function () {
    this.bodyUsed = true;
    if (typeof this._payload.body === 'string') return Promise.resolve(this._payload.body);
    if (typeof this._payload.base64 === 'string') {
      return Promise.resolve(new g.TextDecoder().decode(b64ToBytes(this._payload.base64)));
    }
    return Promise.resolve('');
  };
  ContainerResponse.prototype.json = function () {
    return this.text().then(function (t) { return JSON.parse(t); });
  };
  ContainerResponse.prototype.bytes = function () {
    this.bodyUsed = true;
    if (typeof this._payload.base64 === 'string') return Promise.resolve(b64ToBytes(this._payload.base64));
    return Promise.resolve(new g.TextEncoder().encode(this._payload.body || ''));
  };
  ContainerResponse.prototype.arrayBuffer = function () {
    return this.bytes().then(function (u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); });
  };
  ContainerResponse.prototype.blob = function () {
    var ct = this.headers.get('content-type') || 'application/octet-stream';
    return this.bytes().then(function (u8) {
      return { size: u8.byteLength, type: ct, arrayBuffer: function () { return Promise.resolve(u8.buffer); }, text: function () { return Promise.resolve(new g.TextDecoder().decode(u8)); } };
    });
  };
  ContainerResponse.prototype.clone = function () {
    return new ContainerResponse(this._payload, this.url);
  };

  g.Response = ContainerResponse;
  g.fetch = function (input, init) {
    return new Promise(function (resolve, reject) {
      var rawUrl = typeof input === 'string' ? input : input && input.url ? String(input.url) : String(input);
      var method = init && init.method ? String(init.method).toUpperCase() : 'GET';
      var origin = g.location && g.location.origin ? g.location.origin : 'https://app.softn.local';
      var isLocalVfs =
        method === 'GET' &&
        (rawUrl.indexOf(origin + '/') === 0 || !/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(rawUrl));

      if (isLocalVfs) {
        try {
          var vfsReply = host.callSync('vfs.fetch', rawUrl, g.location ? g.location.pathname : '/index.html');
          if (!vfsReply || !vfsReply.backend) {
            resolve(new ContainerResponse(vfsReply, rawUrl));
            return;
          }
        } catch (err) {
          reject(new TypeError(err && err.message ? err.message : 'VFS fetch failed'));
          return;
        }
      }

      var reqOpts = { method: method, headers: {}, body: undefined };
      if (init && init.headers) {
        var h = init.headers instanceof g.Headers ? init.headers : new g.Headers(init.headers);
        h.forEach(function (v, k) { reqOpts.headers[k] = v; });
      }
      if (init && init.body !== undefined && init.body !== null) {
        // FormData, URLSearchParams, a blob, bytes: each as the web sends it (guest-web-apis.ts).
        if (typeof g.__softnEncodeBody === 'function') {
          var sent = g.__softnEncodeBody(init.body, reqOpts.headers);
          if (sent.bodyParts !== undefined) reqOpts.bodyParts = sent.bodyParts;
          else if (sent.bodyBase64 !== undefined) reqOpts.bodyBase64 = sent.bodyBase64;
          else reqOpts.body = sent.body;
        } else {
          reqOpts.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        }
      }

      host.call('net.fetch', [rawUrl, JSON.stringify(reqOpts)], function (reply) {
        if (!reply || reply.error) {
          reject(new TypeError(reply && reply.error ? String(reply.error) : 'Network fetch denied or failed'));
        } else {
          resolve(new ContainerResponse(reply, rawUrl));
        }
      });
    });
  };
  if (g.window) {
    g.window.fetch = g.fetch;
    g.window.Response = g.Response;
  }

  // ---------------------------------------------------------------------------
  // 5. Built-in 'softn:*' Capabilities & Hosted Vendor Modules
  // ---------------------------------------------------------------------------
  if (typeof __softnModules !== 'undefined') {
    // 'softn:db' — Synchronous Worker-local XDB backed by host persistence
    __softnModules.define('softn:db', async function (__exports) {
      __exports.db = g.db;
      __exports.default = g.db;
    });

    // 'softn:storage' — App-scoped localStorage
    __softnModules.define('softn:storage', async function (__exports) {
      __exports.storage = g.localStorage;
      __exports.default = g.localStorage;
    });

    // 'softn:net' — Capability-gated fetch
    __softnModules.define('softn:net', async function (__exports) {
      __exports.fetch = g.fetch;
      __exports.default = { fetch: g.fetch };
    });

    // 'softn:sqlite' — Sandboxed XDB SQLite 3 database capability (async host RPC)
    __softnModules.define('softn:sqlite', async function (__exports) {
      function sqlRpc(op, args) {
        return new Promise(function (resolve, reject) {
          host.call('sqlite.op', [op, JSON.stringify(args || [])], function (reply) {
            if (!reply || reply.error) {
              reject(new Error(reply && reply.error ? String(reply.error) : 'SQLite operation failed'));
            } else {
              resolve(reply.result);
            }
          });
        });
      }
      function open(name) {
        return sqlRpc('open', [name || 'app.db']).then(function (opened) {
          if (opened && opened.error) throw new Error(opened.error);
          var id = opened.id;
          return {
            id: id,
            query: function (sql, params) {
              return sqlRpc('query', [id, String(sql), params !== undefined ? JSON.stringify(params) : '']).then(function (res) {
                if (res && res.error) throw new Error(res.error);
                var cols = (res && res.columns) || [];
                var rawRows = (res && res.rows) || [];
                var rows = rawRows.map(function (arr) {
                  var obj = {};
                  for (var i = 0; i < cols.length; i++) obj[cols[i]] = arr[i];
                  return obj;
                });
                return { columns: cols, rows: rows, rawRows: rawRows };
              });
            },
            execute: function (sql, params) {
              return sqlRpc('execute', [id, String(sql), params !== undefined ? JSON.stringify(params) : '']).then(function (res) {
                if (res && res.error) throw new Error(res.error);
                return res;
              });
            },
            all: function (sql, params) {
              return this.query(sql, params).then(function (res) { return res.rows; });
            },
            get: function (sql, params) {
              return this.query(sql, params).then(function (res) { return res.rows.length > 0 ? res.rows[0] : null; });
            },
            run: function (sql, params) {
              return this.execute(sql, params);
            },
            seedJson: function (seed) {
              var payload = typeof seed === 'string' ? seed : JSON.stringify(seed);
              return sqlRpc('seed_json', [id, payload]).then(function (res) {
                if (res && res.error) throw new Error(res.error);
                return res;
              });
            },
            close: function () {
              return sqlRpc('close', [id]);
            },
          };
        });
      }
      var api = { open: open };
      __exports.open = open;
      __exports.default = api;
    });

    // 'softn-vendor:marked' — Hosted zero-bundle Markdown renderer
    __softnModules.define('softn-vendor:marked', async function (__exports) {
      var inlineCodeRe = new RegExp('\\x60([^\\x60]+)\\x60', 'g');
      function escapeMd(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function inlineMd(s) {
        return escapeMd(s)
          .replace(inlineCodeRe, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*]+)\*/g, '<em>$1</em>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
      }
      function parseMarkdown(md) {
        var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
        var out = [];
        var inList = false;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (/^\s*[-*]\s+/.test(line)) {
            if (!inList) { out.push('<ul>'); inList = true; }
            out.push('<li>' + inlineMd(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
            continue;
          }
          if (inList) { out.push('</ul>'); inList = false; }
          var hm = /^(#{1,6})\s+(.*)$/.exec(line);
          if (hm) {
            var lvl = hm[1].length;
            out.push('<h' + lvl + '>' + inlineMd(hm[2]) + '</h' + lvl + '>');
          } else if (line.trim() !== '') {
            out.push('<p>' + inlineMd(line) + '</p>');
          }
        }
        if (inList) out.push('</ul>');
        return out.join('\n');
      }
      __exports.marked = { parse: parseMarkdown };
      __exports.parse = parseMarkdown;
      __exports.default = { parse: parseMarkdown };
    });

    // 'softn-vendor:preact' & 'softn-vendor:preact/hooks' & 'softn-vendor:htm'
    // Hosted zero-build reactive VDOM library (~3 KB) running directly against Guest DOM!
    __softnModules.define('softn-vendor:preact', async function (__exports) {
      var currentComponent = null;
      function h(type, props) {
        var children = [];
        for (var i = 2; i < arguments.length; i++) {
          var c = arguments[i];
          if (Array.isArray(c)) {
            for (var j = 0; j < c.length; j++) children.push(c[j]);
          } else {
            children.push(c);
          }
        }
        return { type: type, props: Object.assign({}, props || {}, { children: children }) };
      }
      function Fragment(props) { return props.children; }

      function mountVNode(vnode) {
        if (vnode === null || vnode === undefined || typeof vnode === 'boolean') {
          return doc.createComment('');
        }
        if (typeof vnode === 'string' || typeof vnode === 'number') {
          return doc.createTextNode(String(vnode));
        }
        if (Array.isArray(vnode)) {
          var frag = doc.createDocumentFragment();
          for (var i = 0; i < vnode.length; i++) frag.appendChild(mountVNode(vnode[i]));
          return frag;
        }
        if (typeof vnode.type === 'function') {
          var inst = { hooks: [], hookIdx: 0, vnode: vnode, container: null, dom: null, rerender: null };
          var wrapper = doc.createElement('div');
          wrapper.style.display = 'contents';
          inst.rerender = function () {
            inst.hookIdx = 0;
            var prev = currentComponent;
            currentComponent = inst;
            var rendered;
            try { rendered = vnode.type(vnode.props); } finally { currentComponent = prev; }
            while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
            wrapper.appendChild(mountVNode(rendered));
          };
          inst.rerender();
          return wrapper;
        }
        var el = doc.createElement(String(vnode.type));
        var p = vnode.props || {};
        for (var k in p) {
          if (k === 'children' || k === 'key') continue;
          var val = p[k];
          if (k === 'className' || k === 'class') {
            if (val) el.setAttribute('class', String(val));
          } else if (k === 'style' && val && typeof val === 'object') {
            for (var sk in val) el.style[sk] = val[sk];
          } else if (k.toLowerCase().indexOf('on') === 0 && typeof val === 'function') {
            el.addEventListener(k.slice(2).toLowerCase(), val);
          } else if (k === 'value') {
            el.value = val == null ? '' : String(val);
          } else if (k === 'checked') {
            el.checked = !!val;
          } else if (val !== false && val != null) {
            el.setAttribute(k, val === true ? '' : String(val));
          }
        }
        var kids = p.children || [];
        for (var ci = 0; ci < kids.length; ci++) el.appendChild(mountVNode(kids[ci]));
        return el;
      }

      function render(vnode, container) {
        if (!container) return;
        while (container.firstChild) container.removeChild(container.firstChild);
        container.appendChild(mountVNode(vnode));
      }

      g.__softnPreactCurrent = function () { return currentComponent; };
      __exports.h = h;
      __exports.createElement = h;
      __exports.Fragment = Fragment;
      __exports.render = render;
      __exports.default = { h: h, createElement: h, Fragment: Fragment, render: render };
    });

    __softnModules.define('softn-vendor:preact/hooks', async function (__exports) {
      function getInst() {
        var inst = g.__softnPreactCurrent && g.__softnPreactCurrent();
        if (!inst) throw new Error('Hooks can only be called inside a component');
        return inst;
      }
      function useState(initial) {
        var inst = getInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) {
          inst.hooks.push(typeof initial === 'function' ? initial() : initial);
        }
        var setState = function (next) {
          var cur = inst.hooks[idx];
          var resolved = typeof next === 'function' ? next(cur) : next;
          if (!Object.is(cur, resolved)) {
            inst.hooks[idx] = resolved;
            inst.rerender();
          }
        };
        return [inst.hooks[idx], setState];
      }
      function useRef(initial) {
        var inst = getInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) inst.hooks.push({ current: initial });
        return inst.hooks[idx];
      }
      function useEffect(fn, deps) {
        var inst = getInst();
        var idx = inst.hookIdx++;
        var prev = inst.hooks[idx];
        var changed = !prev || !deps || deps.some(function (d, i) { return !Object.is(d, prev.deps[i]); });
        if (changed) {
          inst.hooks[idx] = { deps: deps, cleanup: null };
          Promise.resolve().then(function () {
            if (prev && typeof prev.cleanup === 'function') prev.cleanup();
            var c = fn();
            if (typeof c === 'function') inst.hooks[idx].cleanup = c;
          });
        }
      }
      function useMemo(fn, deps) {
        var inst = getInst();
        var idx = inst.hookIdx++;
        var prev = inst.hooks[idx];
        if (!prev || !deps || deps.some(function (d, i) { return !Object.is(d, prev.deps[i]); })) {
          var val = fn();
          inst.hooks[idx] = { deps: deps, val: val };
          return val;
        }
        return prev.val;
      }
      __exports.useState = useState;
      __exports.useRef = useRef;
      __exports.useEffect = useEffect;
      __exports.useMemo = useMemo;
    });

    // 'softn-vendor:react', 'softn-vendor:react-dom', 'softn-vendor:react-dom/client',
    // 'softn-vendor:react/jsx-runtime', 'softn-vendor:react/jsx-dev-runtime'
    // Full-featured hosted React 18 reconciling VDOM runtime on Guest DOM so uncompiled
    // React .tsx / .jsx source apps run directly with zero Vite/Webpack build step!
    (function () {
      var SVG_NS = 'http://www.w3.org/2000/svg';
      var UNITLESS_CSS = {
        animationIterationCount: 1, aspectRatio: 1, borderImageOutset: 1, borderImageSlice: 1,
        borderImageWidth: 1, boxFlex: 1, boxFlexGroup: 1, boxOrdinalGroup: 1, columnCount: 1,
        columns: 1, flex: 1, flexGrow: 1, flexPositive: 1, flexShrink: 1, flexNegative: 1,
        flexOrder: 1, gridArea: 1, gridRow: 1, gridRowEnd: 1, gridRowSpan: 1, gridRowStart: 1,
        gridColumn: 1, gridColumnEnd: 1, gridColumnSpan: 1, gridColumnStart: 1, fontWeight: 1,
        lineClamp: 1, lineHeight: 1, opacity: 1, order: 1, orphans: 1, scale: 1, tabSize: 1,
        widows: 1, zIndex: 1, zoom: 1, fillOpacity: 1, floodOpacity: 1, stopOpacity: 1,
        strokeDasharray: 1, strokeDashoffset: 1, strokeMiterlimit: 1, strokeOpacity: 1, strokeWidth: 1
      };
      var Fragment = function Fragment(props) { return props ? props.children : null; };
      Fragment.$$softnKind = 'fragment';
      var StrictMode = function StrictMode(props) { return props ? props.children : null; };
      StrictMode.$$softnKind = 'fragment';
      var Suspense = function Suspense(props) { return props ? props.children : null; };
      Suspense.$$softnKind = 'fragment';
      var PortalType = { $$softnKind: 'portal' };

      function createElement(type, rawProps) {
        var props = {};
        var key = null;
        var ref = null;
        if (rawProps && typeof rawProps === 'object') {
          for (var k in rawProps) {
            if (!Object.prototype.hasOwnProperty.call(rawProps, k)) continue;
            if (k === 'key') key = rawProps[k] == null ? null : String(rawProps[k]);
            else if (k === 'ref') ref = rawProps[k];
            else props[k] = rawProps[k];
          }
        }
        var argLen = arguments.length - 2;
        if (argLen === 1) {
          props.children = arguments[2];
        } else if (argLen > 1) {
          var arr = new Array(argLen);
          for (var i = 0; i < argLen; i++) arr[i] = arguments[i + 2];
          props.children = arr;
        }
        return { $$typeof: 'softn.react.element', type: type, key: key, ref: ref, props: props };
      }

      function jsxFactory(type, rawProps, maybeKey) {
        var props = {};
        var key = maybeKey !== undefined && maybeKey !== null ? String(maybeKey) : null;
        var ref = null;
        if (rawProps && typeof rawProps === 'object') {
          for (var k in rawProps) {
            if (!Object.prototype.hasOwnProperty.call(rawProps, k)) continue;
            if (k === 'key' && key === null) key = rawProps[k] == null ? null : String(rawProps[k]);
            else if (k === 'ref') ref = rawProps[k];
            else props[k] = rawProps[k];
          }
        }
        return { $$typeof: 'softn.react.element', type: type, key: key, ref: ref, props: props };
      }

      function isValidElement(obj) {
        return !!(obj && typeof obj === 'object' && obj.$$typeof === 'softn.react.element');
      }

      function cloneElement(el, rawProps) {
        if (!isValidElement(el)) return el;
        var merged = Object.assign({}, el.props, rawProps || {});
        var key = rawProps && rawProps.key !== undefined ? String(rawProps.key) : el.key;
        var ref = rawProps && rawProps.ref !== undefined ? rawProps.ref : el.ref;
        delete merged.key;
        delete merged.ref;
        var argLen = arguments.length - 2;
        if (argLen === 1) merged.children = arguments[2];
        else if (argLen > 1) {
          var arr = new Array(argLen);
          for (var i = 0; i < argLen; i++) arr[i] = arguments[i + 2];
          merged.children = arr;
        }
        return { $$typeof: 'softn.react.element', type: el.type, key: key, ref: ref, props: merged };
      }

      function flattenChildren(input, out) {
        if (!out) out = [];
        if (input === null || input === undefined || typeof input === 'boolean') return out;
        if (Array.isArray(input)) {
          for (var i = 0; i < input.length; i++) flattenChildren(input[i], out);
        } else {
          out.push(input);
        }
        return out;
      }

      function setRef(ref, value) {
        if (!ref) return;
        if (typeof ref === 'function') {
          try { ref(value); } catch (_) {}
        } else if (typeof ref === 'object') {
          ref.current = value;
        }
      }

      function shallowEqual(a, b) {
        if (Object.is(a, b)) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
        var ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !Object.is(a[ka[i]], b[ka[i]])) return false;
        }
        return true;
      }

      var currentComp = null;
      var idSeq = 0;
      var ctxSeq = 0;
      var dirtyQueue = [];
      var flushScheduled = false;
      var pendingEffects = [];
      var effectsScheduled = false;

      function flushEffects() {
        effectsScheduled = false;
        var list = pendingEffects.splice(0);
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (item.inst.unmounted) continue;
          try {
            if (typeof item.prevCleanup === 'function') item.prevCleanup();
            var c = item.fn();
            if (typeof c === 'function') item.slot.cleanup = c;
          } catch (err) {
            g.console && g.console.error && g.console.error(err);
          }
        }
      }

      function scheduleEffects() {
        if (effectsScheduled) return;
        effectsScheduled = true;
        Promise.resolve().then(flushEffects);
      }

      function flushDirty() {
        flushScheduled = false;
        var guard = 0;
        while (dirtyQueue.length > 0 && guard++ < 64) {
          var batch = dirtyQueue.splice(0);
          for (var i = 0; i < batch.length; i++) {
            var inst = batch[i];
            if (!inst.unmounted && inst.dirty) {
              inst.dirty = false;
              rerenderInst(inst);
            }
          }
        }
        if (pendingEffects.length > 0) scheduleEffects();
      }

      function scheduleInst(inst) {
        if (inst.unmounted) return;
        inst.dirty = true;
        if (dirtyQueue.indexOf(inst) < 0) dirtyQueue.push(inst);
        if (!flushScheduled) {
          flushScheduled = true;
          Promise.resolve().then(flushDirty);
        }
      }

      function getNodes(rec) {
        if (!rec) return [];
        if (rec.dom) return [rec.dom];
        if (rec.kind === 'portal') return [];
        if (rec.childRec) return getNodes(rec.childRec);
        if (rec.children && rec.children.length > 0) {
          var out = [];
          for (var i = 0; i < rec.children.length; i++) {
            var sub = getNodes(rec.children[i]);
            for (var j = 0; j < sub.length; j++) out.push(sub[j]);
          }
          if (out.length > 0) return out;
        }
        return rec.anchor ? [rec.anchor] : [];
      }

      function firstDom(rec) {
        var ns = getNodes(rec);
        return ns.length > 0 ? ns[0] : null;
      }

      function nextSiblingAfter(rec) {
        var ns = getNodes(rec);
        if (ns.length === 0) return null;
        var last = ns[ns.length - 1];
        return last ? last.nextSibling : null;
      }

      function mapEventName(propKey, tagName) {
        var raw = propKey.slice(2).toLowerCase();
        if (raw === 'doubleclick') return ['dblclick'];
        if (raw === 'change') {
          var tl = String(tagName || '').toLowerCase();
          if (tl === 'input' || tl === 'textarea') return ['input', 'change'];
          return ['change'];
        }
        if (raw === 'focus') return ['focus'];
        if (raw === 'blur') return ['blur'];
        return [raw];
      }

      function applyStyle(el, prevStyle, nextStyle) {
        if (typeof nextStyle === 'string') {
          el.setAttribute('style', nextStyle);
          return;
        }
        if (prevStyle && typeof prevStyle === 'object') {
          for (var pk in prevStyle) {
            if (!nextStyle || !(pk in nextStyle)) {
              if (pk.indexOf('--') === 0 && el.style.removeProperty) el.style.removeProperty(pk);
              else el.style[pk] = '';
            }
          }
        }
        if (nextStyle && typeof nextStyle === 'object') {
          for (var sk in nextStyle) {
            var sv = nextStyle[sk];
            if (sv == null || sv === false) {
              if (sk.indexOf('--') === 0 && el.style.removeProperty) el.style.removeProperty(sk);
              else el.style[sk] = '';
            } else {
              var cssVal = (typeof sv === 'number' && sv !== 0 && !UNITLESS_CSS[sk] && sk.indexOf('--') !== 0)
                ? (sv + 'px')
                : String(sv);
              if (sk.indexOf('--') === 0 && el.style.setProperty) el.style.setProperty(sk, cssVal);
              else el.style[sk] = cssVal;
            }
          }
        }
      }

      function patchProps(el, prevProps, nextProps, listeners, isSvg, tagName) {
        prevProps = prevProps || {};
        nextProps = nextProps || {};
        // Remove old props/listeners
        for (var pk in prevProps) {
          if (pk === 'children' || pk === 'key' || pk === 'ref') continue;
          if (!(pk in nextProps)) {
            if (pk.length > 2 && pk.charCodeAt(0) === 111 && pk.charCodeAt(1) === 110 && pk.charCodeAt(2) >= 65 && pk.charCodeAt(2) <= 90) {
              var oldEvs = listeners[pk];
              if (oldEvs) {
                for (var oi = 0; oi < oldEvs.length; oi++) el.removeEventListener(oldEvs[oi][0], oldEvs[oi][1]);
                delete listeners[pk];
              }
            } else if (pk === 'className' || pk === 'class') {
              el.removeAttribute('class');
            } else if (pk === 'htmlFor') {
              el.removeAttribute('for');
            } else if (pk === 'style') {
              applyStyle(el, prevProps.style, null);
            } else if (pk === 'dangerouslySetInnerHTML') {
              el.innerHTML = '';
            } else if (pk === 'value') {
              el.value = '';
            } else if (pk === 'checked') {
              el.checked = false;
            } else if (pk === 'disabled' || pk === 'readOnly' || pk === 'multiple' || pk === 'selected' || pk === 'hidden') {
              el[pk === 'readOnly' ? 'readOnly' : pk] = false;
              el.removeAttribute(pk.toLowerCase());
            } else {
              el.removeAttribute(pk);
            }
          }
        }
        // Apply new/changed props
        for (var k in nextProps) {
          if (k === 'children' || k === 'key' || k === 'ref') continue;
          var val = nextProps[k];
          var prevVal = prevProps[k];
          if (k === 'style') {
            applyStyle(el, prevVal, val);
            continue;
          }
          if (Object.is(val, prevVal) && k !== 'value' && k !== 'checked') continue;
          if (k.length > 2 && k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110 && k.charCodeAt(2) >= 65 && k.charCodeAt(2) <= 90) {
            var prevEvs = listeners[k];
            if (prevEvs) {
              for (var pi = 0; pi < prevEvs.length; pi++) el.removeEventListener(prevEvs[pi][0], prevEvs[pi][1]);
              delete listeners[k];
            }
            if (typeof val === 'function') {
              var evNames = mapEventName(k, tagName);
              var attached = [];
              for (var ei = 0; ei < evNames.length; ei++) {
                el.addEventListener(evNames[ei], val);
                attached.push([evNames[ei], val]);
              }
              listeners[k] = attached;
            }
          } else if (k === 'className' || k === 'class') {
            if (val == null || val === false || val === '') el.removeAttribute('class');
            else el.setAttribute('class', String(val));
          } else if (k === 'htmlFor') {
            if (val == null || val === false) el.removeAttribute('for');
            else el.setAttribute('for', String(val));
          } else if (k === 'dangerouslySetInnerHTML') {
            el.innerHTML = val && val.__html != null ? String(val.__html) : '';
          } else if (k === 'value') {
            var strVal = val == null ? '' : String(val);
            if (el.value !== strVal) el.value = strVal;
          } else if (k === 'defaultValue') {
            if (prevVal === undefined && el.value === '') el.value = val == null ? '' : String(val);
          } else if (k === 'checked') {
            el.checked = !!val;
          } else if (k === 'defaultChecked') {
            if (prevVal === undefined) el.checked = !!val;
          } else if (k === 'disabled' || k === 'readOnly' || k === 'multiple' || k === 'selected' || k === 'hidden') {
            el[k] = !!val;
            if (val) el.setAttribute(k.toLowerCase(), '');
            else el.removeAttribute(k.toLowerCase());
          } else if (k === 'autoFocus') {
            if (val && typeof el.focus === 'function') el.focus();
          } else if (val === false || val === null || val === undefined) {
            el.removeAttribute(k);
          } else {
            var attrName = isSvg && k === 'viewBox' ? 'viewBox' : k;
            el.setAttribute(attrName, val === true ? '' : String(val));
          }
        }
      }

      function insertNodesBefore(parentDom, nodes, beforeNode) {
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.parentNode !== parentDom || n.nextSibling !== beforeNode) {
            parentDom.insertBefore(n, beforeNode || null);
          }
        }
      }

      function unmountRec(rec) {
        if (!rec) return;
        if (rec.inst) {
          rec.inst.unmounted = true;
          var hooks = rec.inst.hooks;
          for (var hi = 0; hi < hooks.length; hi++) {
            var h = hooks[hi];
            if (h && h.$$effect && typeof h.cleanup === 'function') {
              try { h.cleanup(); } catch (_) {}
            }
          }
          if (rec.inst.classInst && typeof rec.inst.classInst.componentWillUnmount === 'function') {
            try { rec.inst.classInst.componentWillUnmount(); } catch (_) {}
          }
        }
        if (rec.childRec) unmountRec(rec.childRec);
        if (rec.children) {
          for (var ci = 0; ci < rec.children.length; ci++) unmountRec(rec.children[ci]);
        }
        if (rec.ref) setRef(rec.ref, null);
        if (rec.dom && rec.dom.parentNode) rec.dom.parentNode.removeChild(rec.dom);
        if (rec.anchor && rec.anchor.parentNode) rec.anchor.parentNode.removeChild(rec.anchor);
      }

      function renderComponent(inst, ctxMap) {
        inst.hookIdx = 0;
        inst.ctxMap = ctxMap;
        var type = inst.type;
        var props = inst.props;
        if (type && type.$$softnKind === 'memo') type = type.type;
        if (type && type.$$softnKind === 'forwardRef') {
          var prevF = currentComp;
          currentComp = inst;
          try { return type.render(props, inst.ref); } finally { currentComp = prevF; }
        }
        if (type && type.prototype && (type.prototype.isReactComponent || typeof type.prototype.render === 'function')) {
          if (!inst.classInst) {
            inst.classInst = new type(props);
            inst.classInst.props = props;
            inst.classInst.setState = function (partial, cb) {
              var next = typeof partial === 'function' ? partial(inst.classInst.state, inst.classInst.props) : partial;
              inst.classInst.state = Object.assign({}, inst.classInst.state || {}, next || {});
              scheduleInst(inst);
              if (typeof cb === 'function') Promise.resolve().then(cb);
            };
            inst.classInst.forceUpdate = function () { scheduleInst(inst); };
            if (typeof inst.classInst.componentDidMount === 'function') {
              Promise.resolve().then(function () { if (!inst.unmounted) inst.classInst.componentDidMount(); });
            }
          } else {
            inst.classInst.props = props;
          }
          return inst.classInst.render();
        }
        var prev = currentComp;
        currentComp = inst;
        try {
          return type(props);
        } finally {
          currentComp = prev;
        }
      }

      function rerenderInst(inst) {
        var rec = inst.rec;
        if (!rec || inst.unmounted) return;
        var beforeNode = nextSiblingAfter(rec);
        var rendered = renderComponent(inst, inst.ctxMap);
        rec.childRec = reconcile(rec.parentDom, rec.childRec, rendered, beforeNode, rec.isSvg, inst.ctxMap);
        ensureAnchorState(rec, beforeNode);
      }

      function ensureAnchorState(rec, beforeNode) {
        var childNodes = rec.childRec ? getNodes(rec.childRec) : [];
        if (rec.children) {
          childNodes = [];
          for (var i = 0; i < rec.children.length; i++) {
            var sub = getNodes(rec.children[i]);
            for (var j = 0; j < sub.length; j++) childNodes.push(sub[j]);
          }
        }
        if (childNodes.length === 0) {
          if (!rec.anchor) rec.anchor = doc.createComment('');
          if (rec.anchor.parentNode !== rec.parentDom) {
            rec.parentDom.insertBefore(rec.anchor, beforeNode || null);
          }
        } else if (rec.anchor && rec.anchor.parentNode) {
          rec.anchor.parentNode.removeChild(rec.anchor);
        }
      }

      function normalizeVNode(v) {
        if (v === null || v === undefined || typeof v === 'boolean') return { kind: 'empty' };
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return { kind: 'text', text: String(v) };
        if (Array.isArray(v)) return { kind: 'fragment', children: flattenChildren(v), key: null };
        if (isValidElement(v)) {
          if (v.type === PortalType) return { kind: 'portal', container: v.props.container, children: flattenChildren(v.props.children), key: v.key };
          if (v.type && v.type.$$softnKind === 'fragment') return { kind: 'fragment', children: flattenChildren(v.props.children), key: v.key };
          if (v.type && v.type.$$softnKind === 'provider') return { kind: 'provider', ctxId: v.type._ctxId, value: v.props.value, children: flattenChildren(v.props.children), key: v.key };
          if (typeof v.type === 'string') return { kind: 'host', type: v.type, props: v.props, ref: v.ref, key: v.key };
          if (typeof v.type === 'function' || (v.type && (v.type.$$softnKind === 'memo' || v.type.$$softnKind === 'forwardRef'))) {
            return { kind: 'comp', type: v.type, props: v.props, ref: v.ref, key: v.key };
          }
        }
        return { kind: 'text', text: String(v) };
      }

      function reconcileChildren(parentDom, prevList, nextRawChildren, beforeNode, isSvg, ctxMap) {
        var nextVNodes = [];
        for (var i = 0; i < nextRawChildren.length; i++) nextVNodes.push(normalizeVNode(nextRawChildren[i]));
        var oldByKey = Object.create(null);
        var oldUnkeyed = [];
        for (var oi = 0; oi < prevList.length; oi++) {
          var orec = prevList[oi];
          if (orec.key !== null && orec.key !== undefined) oldByKey[orec.key] = orec;
          else oldUnkeyed.push(orec);
        }
        var used = [];
        var nextRecs = new Array(nextVNodes.length);
        var unkeyedIdx = 0;
        // First pick matching previous records
        var matchedPrev = new Array(nextVNodes.length);
        for (var ni = 0; ni < nextVNodes.length; ni++) {
          var nv = nextVNodes[ni];
          var match = null;
          if (nv.key !== null && nv.key !== undefined) {
            if (oldByKey[nv.key]) {
              match = oldByKey[nv.key];
              delete oldByKey[nv.key];
            }
          } else if (unkeyedIdx < oldUnkeyed.length) {
            match = oldUnkeyed[unkeyedIdx++];
          }
          matchedPrev[ni] = match;
          if (match) used.push(match);
        }
        // Unmount unused old records before inserting/moving
        for (var ui = 0; ui < prevList.length; ui++) {
          if (used.indexOf(prevList[ui]) < 0) unmountRec(prevList[ui]);
        }
        // Reconcile right-to-left so cursor is always the exact beforeNode!
        var cursor = beforeNode || null;
        for (var ri = nextVNodes.length - 1; ri >= 0; ri--) {
          var rec = reconcileNorm(parentDom, matchedPrev[ri], nextVNodes[ri], cursor, isSvg, ctxMap);
          nextRecs[ri] = rec;
          var nodes = getNodes(rec);
          if (nodes.length > 0) {
            insertNodesBefore(parentDom, nodes, cursor);
            cursor = nodes[0];
          }
        }
        return nextRecs;
      }

      function reconcile(parentDom, prevRec, rawVNode, beforeNode, isSvg, ctxMap) {
        return reconcileNorm(parentDom, prevRec, normalizeVNode(rawVNode), beforeNode, isSvg, ctxMap);
      }

      function reconcileNorm(parentDom, prevRec, nv, beforeNode, isSvg, ctxMap) {
        if (nv.kind === 'empty') {
          if (prevRec && prevRec.kind === 'empty') return prevRec;
          var b = prevRec ? (firstDom(prevRec) || beforeNode) : beforeNode;
          if (prevRec) unmountRec(prevRec);
          var c = doc.createComment('');
          parentDom.insertBefore(c, b || null);
          return { kind: 'empty', dom: c, key: null };
        }
        if (nv.kind === 'text') {
          if (prevRec && prevRec.kind === 'text') {
            if (prevRec.text !== nv.text) {
              prevRec.dom.nodeValue = nv.text;
              prevRec.text = nv.text;
            }
            return prevRec;
          }
          var bt = prevRec ? (firstDom(prevRec) || beforeNode) : beforeNode;
          if (prevRec) unmountRec(prevRec);
          var tn = doc.createTextNode(nv.text);
          parentDom.insertBefore(tn, bt || null);
          return { kind: 'text', dom: tn, text: nv.text, key: null };
        }
        if (nv.kind === 'portal') {
          if (prevRec && prevRec.kind === 'portal' && prevRec.container === nv.container) {
            prevRec.children = reconcileChildren(nv.container, prevRec.children, nv.children, null, false, ctxMap);
            return prevRec;
          }
          if (prevRec) unmountRec(prevRec);
          var prec = { kind: 'portal', container: nv.container, children: [], key: nv.key };
          if (nv.container) {
            prec.children = reconcileChildren(nv.container, [], nv.children, null, false, ctxMap);
          }
          return prec;
        }
        if (nv.kind === 'fragment') {
          if (prevRec && prevRec.kind === 'fragment') {
            var bf = nextSiblingAfter(prevRec) || beforeNode;
            prevRec.children = reconcileChildren(parentDom, prevRec.children, nv.children, bf, isSvg, ctxMap);
            ensureAnchorState(prevRec, bf);
            return prevRec;
          }
          var bfNew = prevRec ? (firstDom(prevRec) || beforeNode) : beforeNode;
          if (prevRec) unmountRec(prevRec);
          var frec = { kind: 'fragment', parentDom: parentDom, children: [], anchor: null, key: nv.key };
          frec.children = reconcileChildren(parentDom, [], nv.children, bfNew, isSvg, ctxMap);
          ensureAnchorState(frec, bfNew);
          return frec;
        }
        if (nv.kind === 'provider') {
          var nextCtx = Object.create(ctxMap || null);
          nextCtx[nv.ctxId] = nv.value;
          if (prevRec && prevRec.kind === 'provider' && prevRec.ctxId === nv.ctxId) {
            var bp = nextSiblingAfter(prevRec) || beforeNode;
            prevRec.children = reconcileChildren(parentDom, prevRec.children, nv.children, bp, isSvg, nextCtx);
            ensureAnchorState(prevRec, bp);
            return prevRec;
          }
          var bpNew = prevRec ? (firstDom(prevRec) || beforeNode) : beforeNode;
          if (prevRec) unmountRec(prevRec);
          var pvRec = { kind: 'provider', ctxId: nv.ctxId, parentDom: parentDom, children: [], anchor: null, key: nv.key };
          pvRec.children = reconcileChildren(parentDom, [], nv.children, bpNew, isSvg, nextCtx);
          ensureAnchorState(pvRec, bpNew);
          return pvRec;
        }
        if (nv.kind === 'host') {
          var childSvg = isSvg || nv.type === 'svg';
          if (nv.type === 'foreignObject') childSvg = false;
          if (prevRec && prevRec.kind === 'host' && prevRec.type === nv.type) {
            patchProps(prevRec.dom, prevRec.props, nv.props, prevRec.listeners, isSvg || nv.type === 'svg', nv.type);
            if (prevRec.ref !== nv.ref) {
              setRef(prevRec.ref, null);
              setRef(nv.ref, prevRec.dom);
              prevRec.ref = nv.ref;
            }
            prevRec.props = nv.props;
            if (!nv.props.dangerouslySetInnerHTML) {
              prevRec.children = reconcileChildren(prevRec.dom, prevRec.children, flattenChildren(nv.props.children), null, childSvg, ctxMap);
            } else {
              for (var di = 0; di < prevRec.children.length; di++) unmountRec(prevRec.children[di]);
              prevRec.children = [];
            }
            return prevRec;
          }
          var bh = prevRec ? (firstDom(prevRec) || beforeNode) : beforeNode;
          if (prevRec) unmountRec(prevRec);
          var el = (isSvg || nv.type === 'svg') && typeof doc.createElementNS === 'function'
            ? doc.createElementNS(SVG_NS, nv.type)
            : doc.createElement(nv.type);
          var listeners = Object.create(null);
          patchProps(el, null, nv.props, listeners, isSvg || nv.type === 'svg', nv.type);
          parentDom.insertBefore(el, bh || null);
          var hrec = { kind: 'host', type: nv.type, dom: el, props: nv.props, ref: nv.ref, listeners: listeners, children: [], key: nv.key };
          if (!nv.props.dangerouslySetInnerHTML) {
            hrec.children = reconcileChildren(el, [], flattenChildren(nv.props.children), null, childSvg, ctxMap);
          }
          if (nv.ref) setRef(nv.ref, el);
          return hrec;
        }
        // Component
        if (prevRec && prevRec.kind === 'comp' && prevRec.type === nv.type) {
          var inst = prevRec.inst;
          if (nv.type && nv.type.$$softnKind === 'memo') {
            var cmp = nv.type.compare || shallowEqual;
            if (cmp(inst.props, nv.props) && inst.ctxMap === ctxMap) return prevRec;
          }
          inst.props = nv.props;
          inst.ref = nv.ref;
          inst.dirty = false;
          var bc = nextSiblingAfter(prevRec) || beforeNode;
          var rendered = renderComponent(inst, ctxMap);
          prevRec.childRec = reconcile(parentDom, prevRec.childRec, rendered, bc, isSvg, ctxMap);
          ensureAnchorState(prevRec, bc);
          return prevRec;
        }
        var bcNew = prevRec ? (firstDom(prevRec) || beforeNode) : beforeNode;
        if (prevRec) unmountRec(prevRec);
        var newInst = { type: nv.type, props: nv.props, ref: nv.ref, hooks: [], hookIdx: 0, ctxMap: ctxMap, dirty: false, unmounted: false, rec: null, classInst: null };
        var crec = { kind: 'comp', type: nv.type, inst: newInst, parentDom: parentDom, isSvg: isSvg, childRec: null, anchor: null, key: nv.key };
        newInst.rec = crec;
        var out = renderComponent(newInst, ctxMap);
        crec.childRec = reconcile(parentDom, null, out, bcNew, isSvg, ctxMap);
        ensureAnchorState(crec, bcNew);
        return crec;
      }

      function reqInst() {
        if (!currentComp) throw new Error('Invalid hook call: hooks can only be called inside a function component');
        return currentComp;
      }
      function useState(initial) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) {
          inst.hooks.push({
            val: typeof initial === 'function' ? initial() : initial,
            setter: null
          });
        }
        var slot = inst.hooks[idx];
        if (!slot.setter) {
          slot.setter = function (next) {
            var resolved = typeof next === 'function' ? next(slot.val) : next;
            if (!Object.is(slot.val, resolved)) {
              slot.val = resolved;
              scheduleInst(inst);
            }
          };
        }
        return [slot.val, slot.setter];
      }
      function useReducer(reducer, initialArg, init) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) {
          inst.hooks.push({
            val: typeof init === 'function' ? init(initialArg) : initialArg,
            reducer: reducer,
            dispatch: null
          });
        }
        var slot = inst.hooks[idx];
        slot.reducer = reducer;
        if (!slot.dispatch) {
          slot.dispatch = function (action) {
            var next = slot.reducer(slot.val, action);
            if (!Object.is(slot.val, next)) {
              slot.val = next;
              scheduleInst(inst);
            }
          };
        }
        return [slot.val, slot.dispatch];
      }
      function useRef(initial) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) inst.hooks.push({ current: initial });
        return inst.hooks[idx];
      }
      function depsChanged(prevDeps, nextDeps) {
        if (!prevDeps || !nextDeps || prevDeps.length !== nextDeps.length) return true;
        for (var i = 0; i < nextDeps.length; i++) {
          if (!Object.is(prevDeps[i], nextDeps[i])) return true;
        }
        return false;
      }
      function useEffect(fn, deps) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        var prev = inst.hooks[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          var prevCleanup = prev ? prev.cleanup : null;
          var slot = { $$effect: true, deps: deps, cleanup: null };
          inst.hooks[idx] = slot;
          pendingEffects.push({ inst: inst, fn: fn, prevCleanup: prevCleanup, slot: slot });
          scheduleEffects();
        }
      }
      function useLayoutEffect(fn, deps) {
        useEffect(fn, deps);
      }
      function useMemo(fn, deps) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        var prev = inst.hooks[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          var val = fn();
          inst.hooks[idx] = { deps: deps, val: val };
          return val;
        }
        return prev.val;
      }
      function useCallback(fn, deps) {
        return useMemo(function () { return fn; }, deps);
      }
      function useId() {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) inst.hooks.push(':r' + (++idSeq) + ':');
        return inst.hooks[idx];
      }
      function useTransition() {
        return [false, function (fn) { fn(); }];
      }
      function useDeferredValue(v) { return v; }
      function useSyncExternalStore(subscribe, getSnapshot) {
        var pair = useState(getSnapshot);
        useEffect(function () {
          var check = function () { pair[1](getSnapshot()); };
          check();
          return subscribe(check);
        }, [subscribe]);
        return getSnapshot();
      }
      function createContext(defaultValue) {
        var id = 'ctx_' + (++ctxSeq);
        var Provider = function Provider(props) { return props ? props.children : null; };
        Provider.$$softnKind = 'provider';
        Provider._ctxId = id;
        var Consumer = function Consumer(props) {
          var val = useContext(ctx);
          return typeof props.children === 'function' ? props.children(val) : null;
        };
        var ctx = { _ctxId: id, _defaultValue: defaultValue, Provider: Provider, Consumer: Consumer };
        return ctx;
      }
      function useContext(ctx) {
        var inst = reqInst();
        if (inst.ctxMap && ctx._ctxId in inst.ctxMap) return inst.ctxMap[ctx._ctxId];
        return ctx._defaultValue;
      }
      function forwardRef(renderFn) {
        return { $$softnKind: 'forwardRef', render: renderFn };
      }
      function memo(comp, compare) {
        return { $$softnKind: 'memo', type: comp, compare: compare || null };
      }
      function Component(props) { this.props = props; this.state = {}; }
      Component.prototype.isReactComponent = true;
      function PureComponent(props) { this.props = props; this.state = {}; }
      PureComponent.prototype = Object.create(Component.prototype);
      PureComponent.prototype.isPureReactComponent = true;

      var ChildrenApi = {
        toArray: function (c) { return flattenChildren(c); },
        map: function (c, fn, ctx) { return c == null ? c : flattenChildren(c).map(function (x, i) { return fn.call(ctx, x, i); }); },
        forEach: function (c, fn, ctx) { if (c != null) flattenChildren(c).forEach(function (x, i) { fn.call(ctx, x, i); }); },
        count: function (c) { return flattenChildren(c).length; },
        only: function (c) { var a = flattenChildren(c); if (a.length !== 1) throw new Error('React.Children.only expected a single React element child.'); return a[0]; }
      };

      var roots = new WeakMap();
      function createRoot(container) {
        var currentRec = null;
        var root = {
          render: function (vnode) {
            if (!container) return;
            if (!currentRec) {
              while (container.firstChild) container.removeChild(container.firstChild);
            }
            currentRec = reconcile(container, currentRec, vnode, null, false, Object.create(null));
            if (pendingEffects.length > 0) scheduleEffects();
          },
          unmount: function () {
            if (currentRec) {
              unmountRec(currentRec);
              currentRec = null;
            }
          }
        };
        if (container) roots.set(container, root);
        return root;
      }
      function legacyRender(vnode, container, cb) {
        var root = roots.get(container) || createRoot(container);
        root.render(vnode);
        if (typeof cb === 'function') Promise.resolve().then(cb);
      }
      function createPortal(children, container, key) {
        return { $$typeof: 'softn.react.element', type: PortalType, key: key == null ? null : String(key), ref: null, props: { children: children, container: container } };
      }
      function flushSync(fn) {
        var res = typeof fn === 'function' ? fn() : undefined;
        flushDirty();
        flushEffects();
        return res;
      }

      // Expose universal JSX hooks for transpiled .tsx / .jsx files (classic & automatic JSX!)
      g.__softnJsx = createElement;
      g.__softnFragment = Fragment;

      var ReactObj = {
        version: '18.3.1',
        createElement: createElement,
        cloneElement: cloneElement,
        isValidElement: isValidElement,
        Fragment: Fragment,
        StrictMode: StrictMode,
        Suspense: Suspense,
        Children: ChildrenApi,
        Component: Component,
        PureComponent: PureComponent,
        createContext: createContext,
        forwardRef: forwardRef,
        memo: memo,
        useState: useState,
        useReducer: useReducer,
        useEffect: useEffect,
        useLayoutEffect: useLayoutEffect,
        useRef: useRef,
        useMemo: useMemo,
        useCallback: useCallback,
        useContext: useContext,
        useId: useId,
        useTransition: useTransition,
        useDeferredValue: useDeferredValue,
        useSyncExternalStore: useSyncExternalStore
      };

      __softnModules.define('softn-vendor:react', async function (__exports) {
        Object.assign(__exports, ReactObj);
        __exports.default = ReactObj;
      });
      __softnModules.define('softn-vendor:react-dom/client', async function (__exports) {
        __exports.createRoot = createRoot;
        __exports.hydrateRoot = function (container, vnode) { var r = createRoot(container); r.render(vnode); return r; };
        __exports.default = { createRoot: createRoot, hydrateRoot: __exports.hydrateRoot };
      });
      __softnModules.define('softn-vendor:react-dom', async function (__exports) {
        __exports.render = legacyRender;
        __exports.createPortal = createPortal;
        __exports.flushSync = flushSync;
        __exports.createRoot = createRoot;
        __exports.unmountComponentAtNode = function (container) { var r = roots.get(container); if (r) { r.unmount(); return true; } return false; };
        __exports.default = { render: legacyRender, createPortal: createPortal, flushSync: flushSync, createRoot: createRoot, unmountComponentAtNode: __exports.unmountComponentAtNode };
      });
      __softnModules.define('softn-vendor:react/jsx-runtime', async function (__exports) {
        __exports.jsx = jsxFactory;
        __exports.jsxs = jsxFactory;
        __exports.Fragment = Fragment;
        __exports.default = { jsx: jsxFactory, jsxs: jsxFactory, Fragment: Fragment };
      });
      __softnModules.define('softn-vendor:react/jsx-dev-runtime', async function (__exports) {
        __exports.jsxDEV = jsxFactory;
        __exports.jsx = jsxFactory;
        __exports.jsxs = jsxFactory;
        __exports.Fragment = Fragment;
        __exports.default = { jsxDEV: jsxFactory, jsx: jsxFactory, jsxs: jsxFactory, Fragment: Fragment };
      });
    })();

    __softnModules.define('softn-vendor:htm', async function (__exports) {
      // Tagged template literal builder compatible with 'htm.bind(h)'
      function buildHtm(h, strings, values) {
        var marker = 'htm-slot-';
        var raw = '';
        var map = Object.create(null);
        for (var i = 0; i < strings.length; i++) {
          raw += strings[i];
          if (i < values.length) {
            var key = marker + i + '-end';
            map[key] = values[i];
            raw += key;
          }
        }
        raw = raw.replace(/<(htm-slot-\d+-end)([^>]*?)\/>/g, '<$1$2></$1>');
        var tpl = doc.createElement('template');
        tpl.innerHTML = raw.trim();
        function toVNode(node) {
          if (node.nodeType === 3) {
            var txt = node.nodeValue || '';
            var parts = txt.split(/(htm-slot-\d+-end)/g);
            var res = [];
            for (var p = 0; p < parts.length; p++) {
              if (!parts[p]) continue;
              if (parts[p] in map) res.push(map[parts[p]]);
              else res.push(parts[p]);
            }
            return res.length === 1 ? res[0] : res;
          }
          if (node.nodeType !== 1) return null;
          var props = {};
          var attrs = node.attributes;
          for (var a = 0; a < attrs.length; a++) {
            var aname = attrs[a].name;
            var aval = attrs[a].value;
            props[aname] = aval in map ? map[aval] : aval;
          }
          var children = [];
          var childNodes = node.childNodes;
          for (var c = 0; c < childNodes.length; c++) {
            var cv = toVNode(childNodes[c]);
            if (Array.isArray(cv)) children.push.apply(children, cv);
            else if (cv !== null) children.push(cv);
          }
          var tag = node.tagName.toLowerCase();
          return h.apply(null, [tag in map ? map[tag] : tag, props].concat(children));
        }
        var top = tpl.content.childNodes;
        if (top.length === 1) return toVNode(top[0]);
        var arr = [];
        for (var t = 0; t < top.length; t++) {
          var v = toVNode(top[t]);
          if (v !== null) arr.push(v);
        }
        return arr;
      }
      var htm = {
        bind: function (h) {
          return function (strings) {
            var vals = Array.prototype.slice.call(arguments, 1);
            return buildHtm(h, strings, vals);
          };
        },
      };
      __exports.default = htm;
      __exports.htm = htm;
    });

    // 'softn-vendor:three' — Split-Realm Hosted Three.js Scene-Graph Proxy!
    // Batches scene mutations per frame to the host's lazy-loaded WebGL2 Three.js renderer.
    __softnModules.define('softn-vendor:three', async function (__exports) {
      var nextObjId = 2; // 1 reserved for Scene
      function Vec3(x, y, z, onChange) {
        this._x = x || 0; this._y = y || 0; this._z = z || 0; this._cb = onChange;
      }
      ['x', 'y', 'z'].forEach(function (k) {
        var p = '_' + k;
        Object.defineProperty(Vec3.prototype, k, {
          get: function () { return this[p]; },
          set: function (v) { this[p] = Number(v) || 0; if (this._cb) this._cb(); },
        });
      });
      Vec3.prototype.set = function (x, y, z) {
        this._x = Number(x) || 0; this._y = Number(y) || 0; this._z = Number(z) || 0;
        if (this._cb) this._cb();
        return this;
      };
      Vec3.prototype.toArray = function () { return [this._x, this._y, this._z]; };

      function Color(c) { this.value = c !== undefined ? c : 0xffffff; }
      Color.prototype.set = function (c) { this.value = c; return this; };

      function Object3D(id) {
        var self = this;
        this._id = id || nextObjId++;
        this._dirty = true;
        this.children = [];
        var mark = function () { self._dirty = true; };
        this.position = new Vec3(0, 0, 0, mark);
        this.rotation = new Vec3(0, 0, 0, mark);
        this.scale = new Vec3(1, 1, 1, mark);
      }
      Object3D.prototype.add = function () {
        for (var i = 0; i < arguments.length; i++) {
          var child = arguments[i];
          if (child && child._id) {
            this.children.push(child);
            this._pendingAdds = this._pendingAdds || [];
            this._pendingAdds.push(['add', this._id, child._id]);
          }
        }
        return this;
      };
      Object3D.prototype.remove = function (child) {
        if (!child || !child._id) return this;
        this.children = this.children.filter(function (c) { return c !== child; });
        this._pendingAdds = this._pendingAdds || [];
        this._pendingAdds.push(['remove', this._id, child._id]);
        return this;
      };
      Object3D.prototype.lookAt = function (x, y, z) {
        if (x && typeof x === 'object') {
          this._lookAt = [Number(x.x) || 0, Number(x.y) || 0, Number(x.z) || 0];
        } else {
          this._lookAt = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
        }
        this._dirty = true;
        return this;
      };

      function Scene() { Object3D.call(this, 1); this._kind = 'scene'; }
      Scene.prototype = Object.create(Object3D.prototype);
      function Group() { Object3D.call(this); this._kind = 'group'; }
      Group.prototype = Object.create(Object3D.prototype);

      function PerspectiveCamera(fov, aspect, near, far) {
        Object3D.call(this);
        this._kind = 'camera';
        this._camType = 'perspective';
        this.fov = fov || 60; this.aspect = aspect || 1; this.near = near || 0.1; this.far = far || 1000;
      }
      PerspectiveCamera.prototype = Object.create(Object3D.prototype);
      PerspectiveCamera.prototype.updateProjectionMatrix = function () { this._dirty = true; };

      function BoxGeometry(w, h, d) { this._geo = ['box', w || 1, h || 1, d || 1]; }
      function SphereGeometry(r, ws, hs) { this._geo = ['sphere', r || 1, ws || 24, hs || 16]; }
      function PlaneGeometry(w, h, ws, hs) { this._geo = ['plane', w || 1, h || 1, ws || 1, hs || 1]; }
      function CylinderGeometry(rt, rb, h, rs) { this._geo = ['cylinder', rt || 1, rb || 1, h || 1, rs || 24]; }
      function TorusGeometry(r, t, rs, ts) { this._geo = ['torus', r || 1, t || 0.4, rs || 16, ts || 32]; }

      function MeshStandardMaterial(opts) { this._mat = Object.assign({ kind: 'standard' }, opts || {}); }
      function MeshBasicMaterial(opts) { this._mat = Object.assign({ kind: 'basic' }, opts || {}); }

      function Mesh(geo, mat) {
        Object3D.call(this);
        this._kind = 'mesh';
        this.geometry = geo || new BoxGeometry(1, 1, 1);
        this.material = mat || new MeshStandardMaterial({});
      }
      Mesh.prototype = Object.create(Object3D.prototype);

      function AmbientLight(color, intensity) {
        Object3D.call(this);
        this._kind = 'light'; this._lightKind = 'ambient'; this.color = color; this.intensity = intensity;
      }
      AmbientLight.prototype = Object.create(Object3D.prototype);
      function DirectionalLight(color, intensity) {
        Object3D.call(this);
        this._kind = 'light'; this._lightKind = 'directional'; this.color = color; this.intensity = intensity;
      }
      DirectionalLight.prototype = Object.create(Object3D.prototype);
      function PointLight(color, intensity) {
        Object3D.call(this);
        this._kind = 'light'; this._lightKind = 'point'; this.color = color; this.intensity = intensity;
      }
      PointLight.prototype = Object.create(Object3D.prototype);

      function WebGLRenderer(opts) {
        opts = opts || {};
        this.domElement = opts.canvas || doc.createElement('canvas');
        this._ops = [['init', { antialias: opts.antialias !== false, alpha: !!opts.alpha }]];
        this._created = Object.create(null);
      }
      WebGLRenderer.prototype.setSize = function (w, h) {
        this.domElement.width = w;
        this.domElement.height = h;
        this._ops.push(['resize', w, h, 1]);
      };
      WebGLRenderer.prototype.setPixelRatio = function (dpr) {
        this._dpr = dpr;
      };
      WebGLRenderer.prototype.setClearColor = function (color, alpha) {
        this._ops.push(['clearColor', color instanceof Color ? color.value : color, alpha !== undefined ? alpha : 1]);
      };
      WebGLRenderer.prototype._syncTree = function (obj) {
        if (!this._created[obj._id]) {
          this._created[obj._id] = true;
          if (obj._kind === 'scene' || obj._kind === 'group') this._ops.push(['group', obj._id]);
          else if (obj._kind === 'camera') this._ops.push(['camera', obj._id, obj._camType, [obj.fov, obj.aspect, obj.near, obj.far]]);
          else if (obj._kind === 'mesh') this._ops.push(['mesh', obj._id, { geo: obj.geometry._geo, mat: obj.material._mat }]);
          else if (obj._kind === 'light') this._ops.push(['light', obj._id, obj._lightKind, { color: obj.color, intensity: obj.intensity, pos: obj.position.toArray() }]);
          else if (obj._kind === 'gltf') this._ops.push(['gltf', obj._id, obj._src]);
        }
        // Recursively create/sync children BEFORE emitting parent->child 'add' ops so child IDs exist on host!
        for (var i = 0; i < obj.children.length; i++) this._syncTree(obj.children[i]);
        if (obj._pendingAdds && obj._pendingAdds.length) {
          for (var a = 0; a < obj._pendingAdds.length; a++) this._ops.push(obj._pendingAdds[a]);
          obj._pendingAdds.length = 0;
        }
        if (obj._dirty) {
          obj._dirty = false;
          this._ops.push(['xform', obj._id, obj.position.toArray(), obj.rotation.toArray(), obj.scale.toArray()]);
          if (obj._lookAt) {
            this._ops.push(['lookAt', obj._id, obj._lookAt]);
          }
        }
      };
      WebGLRenderer.prototype.render = function (scene, camera) {
        this._syncTree(scene);
        this._syncTree(camera);
        this._ops.push(['render', scene._id, camera._id]);
        var cid = this.domElement && this.domElement.__softnNode;
        if (cid) {
          g.__softnPushExtraOp(['3d', cid, this._ops.splice(0, this._ops.length)]);
        }
      };

      function loadGLTF(path) {
        var grp = new Object3D();
        grp._kind = 'gltf';
        grp._src = String(path);
        return grp;
      }

      var api = {
        Scene: Scene, Group: Group, Object3D: Object3D,
        PerspectiveCamera: PerspectiveCamera,
        BoxGeometry: BoxGeometry, SphereGeometry: SphereGeometry, PlaneGeometry: PlaneGeometry,
        CylinderGeometry: CylinderGeometry, TorusGeometry: TorusGeometry,
        MeshStandardMaterial: MeshStandardMaterial, MeshBasicMaterial: MeshBasicMaterial,
        Mesh: Mesh, AmbientLight: AmbientLight, DirectionalLight: DirectionalLight, PointLight: PointLight,
        WebGLRenderer: WebGLRenderer, Vector3: Vec3, Color: Color, loadGLTF: loadGLTF,
      };
      Object.assign(__exports, api);
      __exports.default = api;
    });
  }
})();
`;
