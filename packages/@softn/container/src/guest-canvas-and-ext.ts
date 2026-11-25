/**
 * Guest Web API Extensions & Hosted Vendor Shims injected inside the ZIPP Sandbox.
 *
 * Extends `shellPrelude` with:
 * - Full `HTMLCanvasElement.prototype.getContext('2d')` (`CanvasRenderingContext2D`) command recorder
 * - Virtual-origin `fetch()` (`https://app.softn.local/...` + binary `arrayBuffer()`/`blob()`)
 * - Standard `setTimeout` / `setInterval` / `performance.now()` Worker timer bridge
 * - Built-in hosted `/runtime/vendor/` libraries (`three` Split-Realm proxy, `marked`, `htm`, `preact`)
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
  function __reportAsyncError(phase, err) {
    if (typeof g.__softnReportError === 'function') {
      g.__softnReportError(phase, err, 0);
    } else {
      console.error('[SoftN] ' + phase + ' error:', err && err.stack ? err.stack : err && err.message ? err.message : String(err));
    }
  }
  function __invokeTracked(phase, fn, thisArg, args) {
    try {
      var res = args ? fn.apply(thisArg, args) : fn.call(thisArg);
      if (res && typeof res.then === 'function') {
        res.then(undefined, function (err) { __reportAsyncError('unhandledrejection', err); });
      }
    } catch (err) {
      __reportAsyncError(phase, err);
    }
  }

  g.setTimeout = function (fn, ms) {
    var id = __nextTimerId++;
    var args = Array.prototype.slice.call(arguments, 2);
    var delay = Math.max(0, Number(ms) || 0);
    __timers[id] = { fn: fn, args: args, repeat: false, delay: delay };
    host.call('timer.set', [String(id), String(delay), '0'], function () {
      var entry = __timers[id];
      if (!entry) return;
      delete __timers[id];
      if (typeof entry.fn === 'function') __invokeTracked('timer', entry.fn, g, entry.args);
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
          if (typeof entry.fn === 'function') __invokeTracked('timer', entry.fn, g, entry.args);
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
      __invokeTracked('raf', batch[ids[i]], g, [ts]);
    }
  };
  g.__softnWantsRaf = function () {
    return __wantsRaf || Object.keys(__rafCbs).length > 0;
  };

  // ---------------------------------------------------------------------------
  // 2. HTMLCanvasElement & CanvasRenderingContext2D Command Buffer
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

  // Expose Canvas2D hooks so the on-demand WebGL guest module (guest-webgl.ts) can attach when loaded.
  g.__softnMirrorPictureRef = mirrorPicture;
  g.__softnPictureRef = pictureRef;
  g.__softnBytesTo64 = bytesToB64;
  g.__softnClearCanvas2DDrawing = function (ctx) { if (__drawing === ctx) __drawing = null; };
  g.__softnRegisterCanvasGone = function (el, id) { if (__canvasGone && id) __canvasGone.register(el, id); };

  if (g.HTMLElement) {
    var origMake = doc && doc.createElement ? doc.createElement.bind(doc) : null;
    Object.defineProperty(g.HTMLElement.prototype, 'width', {
      configurable: true,
      get: function () {
        if (this.tagName === 'CANVAS') {
          var attr = this.getAttribute('width');
          if (attr === null) return 300;
          var parsed = Number(attr);
          return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 300;
        }
        return this.offsetWidth || 0;
      },
      set: function (v) {
        if (this.tagName === 'CANVAS') {
          var n = Number(v);
          var clean = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300;
          this.setAttribute('width', String(clean));
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
          if (attr === null) return 150;
          var parsed = Number(attr);
          return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 150;
        }
        return this.offsetHeight || 0;
      },
      set: function (v) {
        if (this.tagName === 'CANVAS') {
          var n = Number(v);
          var clean = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 150;
          this.setAttribute('height', String(clean));
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
        return typeof g.__softnCreateWebGLContext === 'function' ? g.__softnCreateWebGLContext(this, type, attrs) : null;
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
    var ssInit = g.__softnInitSessionStorage;
    if (!ssInit && typeof host !== 'undefined' && typeof host.callSync === 'function') {
      try { ssInit = host.callSync('session', 'init'); } catch (_) { ssInit = null; }
    }
    if (ssInit && typeof ssInit === 'object') {
      var ssInitKeys = Object.keys(ssInit);
      for (var ski = 0; ski < ssInitKeys.length; ski++) {
        try { g.sessionStorage.setItem(ssInitKeys[ski], String(ssInit[ssInitKeys[ski]])); } catch (_) {}
      }
      try { delete g.__softnInitSessionStorage; } catch (_) { g.__softnInitSessionStorage = undefined; }
    }
    var origSsSet = g.sessionStorage.setItem;
    var origSsRemove = g.sessionStorage.removeItem;
    var origSsClear = g.sessionStorage.clear;
    if (typeof origSsSet === 'function') {
      g.sessionStorage.setItem = function (k, v) {
        var sk = String(k), sv = String(v);
        if (typeof host !== 'undefined' && typeof host.callSync === 'function') {
          var accepted = host.callSync('session', 'ss', 'set', sk, sv);
          if (accepted === false) {
            var qErr = new Error('QuotaExceededError: sessionStorage quota exceeded');
            qErr.name = 'QuotaExceededError';
            throw qErr;
          }
        }
        origSsSet.call(this, sk, sv);
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
    if (typeof g.__softnFlushWebGL === 'function') g.__softnFlushWebGL();
    syncRouteIfChanged();
    while (__goneCanvases.length) {
      var goneId = __goneCanvases.shift();
      __extraOps.push(['k2dgone', goneId]);
      if (typeof g.__softnDisposeWebGLCanvas === 'function') g.__softnDisposeWebGLCanvas(goneId);
    }
    var domOps = origDocTake ? origDocTake(failed) : null;
    if (__extraOps.length === 0) return domOps;
    var extra = __extraOps.splice(0, __extraOps.length);
    return domOps ? domOps.concat(extra) : extra;
  };

  // ---------------------------------------------------------------------------
  // 3. Virtual-Origin 'fetch()' & Binary 'Response' ('arrayBuffer()', 'blob()')
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
  // 4. Built-in 'softn:*' Capability Bridges (vendor shims load on demand)
  // ---------------------------------------------------------------------------
  var listeners = new Map();
  g.db.subscribe = function (name, listener) {
    if (typeof name !== 'string' || !name || typeof listener !== 'function') {
      throw new TypeError('db.subscribe requires a collection name and listener');
    }
    var group = listeners.get(name);
    if (!group) {
      group = new Set();
      listeners.set(name, group);
      host.callSync('xdb.watch', name, '1');
    }
    var handler = function () { listener(); };
    group.add(handler);
    return function () {
      if (group.delete(handler) && group.size === 0) {
        listeners.delete(name);
        host.callSync('xdb.watch', name, '0');
      }
    };
  };
  g.__softnDbChanged = function (names) {
    names.forEach(function (name) {
      var group = listeners.get(name);
      if (group) Array.from(group).forEach(function (listener) {
        try { if (group.has(listener)) listener(); }
        catch (error) { console.error(error && error.message ? error.message : String(error)); }
      });
    });
  };

  var backend = {
    call: function (action, input, callback) {
      var promise = new Promise(function (resolve) {
        host.call('backend.call', [String(action), JSON.stringify(input === undefined ? {} : input)], resolve);
      });
      return typeof callback === 'function' ? promise.then(function (reply) { callback(reply); return reply; }) : promise;
    }
  };
  g.softn = g.softn || {};
  g.softn.backend = backend;
  if (g.window) g.window.softn = g.softn;

  if (typeof __softnModules !== 'undefined') {
    // 'softn:db' — Synchronous Worker-local XDB backed by host persistence
    __softnModules.define('softn:db', async function (__exports) {
      __exports.db = g.db;
      __exports.subscribe = g.db.subscribe;
      __exports.default = g.db;
    });

    __softnModules.define('softn:backend', async function (__exports) {
      __exports.backend = backend;
      __exports.default = backend;
    });

    __softnModules.define('softn:api', async function (__exports) {
      var api = {
        fetch: async function (path, init) {
          if (typeof path !== 'string' || !/^\/api\//.test(path)) throw new TypeError('Expected an app route under /api/.');
          var opts = init || {};
          var options = { method: String(opts.method || 'GET').toUpperCase() };
          if (opts.headers) {
            options.headers = {};
            new g.Headers(opts.headers).forEach(function (v, k) { options.headers[k] = v; });
          }
          if (opts.body !== undefined) {
            if (typeof g.FormData === 'function' && opts.body instanceof g.FormData) {
              // Convert FormData entries into a plain object (with base64 file payloads) rather
              // than letting JSON.stringify serialize FormData to an empty object.
              var formObj = Object.create(null);
              var entries = [];
              opts.body.forEach(function (val, key) { entries.push([key, val]); });
              for (var ei = 0; ei < entries.length; ei++) {
                var ek = entries[ei][0];
                var ev = entries[ei][1];
                if (ev && typeof ev.arrayBuffer === 'function') {
                  var buf = new Uint8Array(await ev.arrayBuffer());
                  formObj[ek] = { name: ev.name || 'file', type: ev.type || 'application/octet-stream', size: buf.byteLength, base64: bytesToB64(buf) };
                } else {
                  formObj[ek] = ev;
                }
              }
              options.body = formObj;
            } else if (typeof g.Blob === 'function' && opts.body instanceof g.Blob) {
              var blobBuf = new Uint8Array(await opts.body.arrayBuffer());
              options.body = { name: opts.body.name || 'blob', type: opts.body.type || 'application/octet-stream', size: blobBuf.byteLength, base64: bytesToB64(blobBuf) };
            } else if (typeof g.URLSearchParams === 'function' && opts.body instanceof g.URLSearchParams) {
              options.body = opts.body.toString();
            } else {
              var contentType = options.headers && options.headers['content-type'];
              options.body = typeof opts.body === 'string' && contentType && /\bjson\b/i.test(contentType)
                ? JSON.parse(opts.body) : opts.body;
            }
          }
          var reply = await backend.call('nativeRequest', { url: path, options: options });
          if (!reply || reply.error || !reply.result) throw new TypeError(reply && reply.error || 'Backend request failed.');
          var result = reply.result;
          return new ContainerResponse({
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            headers: result.headers || { 'content-type': 'application/json' },
            body: JSON.stringify(result.body)
          }, path);
        }
      };
      __exports.api = api;
      __exports.fetch = api.fetch;
      __exports.default = api;
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
            first: function (sql, params) {
              return this.query(sql, params).then(function (res) { return res.rows.length > 0 ? res.rows[0] : null; });
            },
            get: function (sql, params) {
              return this.first(sql, params);
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

    // Cross-platform Device & Hardware Bridges ('softn:device', 'softn:camera',
    // 'softn:bluetooth', 'softn:location', 'softn:haptics', 'softn:notifications')
    function deviceRpc(namespace, method, params) {
      return new Promise(function (resolve, reject) {
        host.call('device.call', [String(namespace), String(method), JSON.stringify(params || {})], function (reply) {
          if (!reply || reply.error) {
            reject(new Error(reply && reply.error ? String(reply.error) : (namespace + '.' + method + ' failed')));
          } else {
            resolve(reply.result);
          }
        });
      });
    }

    var softnDevice = {
      getInfo: function () { return deviceRpc('device', 'getInfo', {}); },
      share: function (opts) { return deviceRpc('device', 'share', opts || {}); },
      clipboardWrite: function (text) { return deviceRpc('device', 'clipboardWrite', { text: String(text == null ? '' : text) }); },
    };
    var softnCamera = {
      isAvailable: function () { return deviceRpc('camera', 'isAvailable', {}); },
      takePhoto: function (opts) { return deviceRpc('camera', 'takePhoto', opts || {}); },
    };
    var softnBluetooth = {
      isAvailable: function () { return deviceRpc('bluetooth', 'isAvailable', {}); },
      scan: function (opts) { return deviceRpc('bluetooth', 'scan', opts || {}); },
      connect: function (deviceId) { return deviceRpc('bluetooth', 'connect', { deviceId: String(deviceId || '') }); },
      disconnect: function (deviceId) { return deviceRpc('bluetooth', 'disconnect', { deviceId: String(deviceId || '') }); },
      read: function (deviceId, serviceUuid, characteristicUuid) {
        return deviceRpc('bluetooth', 'read', {
          deviceId: String(deviceId || ''),
          serviceUuid: String(serviceUuid || ''),
          characteristicUuid: String(characteristicUuid || ''),
        });
      },
      write: function (deviceId, serviceUuid, characteristicUuid, base64, withoutResponse) {
        return deviceRpc('bluetooth', 'write', {
          deviceId: String(deviceId || ''),
          serviceUuid: String(serviceUuid || ''),
          characteristicUuid: String(characteristicUuid || ''),
          base64: String(base64 || ''),
          withoutResponse: Boolean(withoutResponse),
        });
      },
    };
    var softnLocation = {
      isAvailable: function () { return deviceRpc('location', 'isAvailable', {}); },
      getCurrentPosition: function (opts) { return deviceRpc('location', 'getCurrentPosition', opts || {}); },
    };
    var softnHaptics = {
      isAvailable: function () { return deviceRpc('haptics', 'isAvailable', {}); },
      impact: function (style) { return deviceRpc('haptics', 'impact', { style: style || 'medium' }); },
      vibrate: function (durationMs) { return deviceRpc('haptics', 'vibrate', { durationMs: Number(durationMs) || 40 }); },
    };
    var softnNotifications = {
      isAvailable: function () { return deviceRpc('notifications', 'isAvailable', {}); },
      notify: function (opts) {
        var payload = typeof opts === 'string' ? { title: opts } : (opts || {});
        return deviceRpc('notifications', 'notify', payload);
      },
    };

    g.softn.device = softnDevice;
    g.softn.camera = softnCamera;
    g.softn.bluetooth = softnBluetooth;
    g.softn.location = softnLocation;
    g.softn.haptics = softnHaptics;
    g.softn.notifications = softnNotifications;

    __softnModules.define('softn:device', async function (__exports) {
      __exports.device = softnDevice;
      __exports.getInfo = softnDevice.getInfo;
      __exports.share = softnDevice.share;
      __exports.clipboardWrite = softnDevice.clipboardWrite;
      __exports.default = softnDevice;
    });
    __softnModules.define('softn:camera', async function (__exports) {
      __exports.camera = softnCamera;
      __exports.isAvailable = softnCamera.isAvailable;
      __exports.takePhoto = softnCamera.takePhoto;
      __exports.default = softnCamera;
    });
    __softnModules.define('softn:bluetooth', async function (__exports) {
      __exports.bluetooth = softnBluetooth;
      __exports.ble = softnBluetooth;
      __exports.isAvailable = softnBluetooth.isAvailable;
      __exports.scan = softnBluetooth.scan;
      __exports.connect = softnBluetooth.connect;
      __exports.disconnect = softnBluetooth.disconnect;
      __exports.read = softnBluetooth.read;
      __exports.write = softnBluetooth.write;
      __exports.default = softnBluetooth;
    });
    __softnModules.define('softn:location', async function (__exports) {
      __exports.location = softnLocation;
      __exports.isAvailable = softnLocation.isAvailable;
      __exports.getCurrentPosition = softnLocation.getCurrentPosition;
      __exports.default = softnLocation;
    });
    __softnModules.define('softn:haptics', async function (__exports) {
      __exports.haptics = softnHaptics;
      __exports.isAvailable = softnHaptics.isAvailable;
      __exports.impact = softnHaptics.impact;
      __exports.vibrate = softnHaptics.vibrate;
      __exports.default = softnHaptics;
    });
    __softnModules.define('softn:notifications', async function (__exports) {
      __exports.notifications = softnNotifications;
      __exports.isAvailable = softnNotifications.isAvailable;
      __exports.notify = softnNotifications.notify;
      __exports.default = softnNotifications;
    });

    // Hosted React 18 vendor shim loads on demand via guest-react-vendor.ts when an app uses JSX or imports react.
  }
})();
`;
