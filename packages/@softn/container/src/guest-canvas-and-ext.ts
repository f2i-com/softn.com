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
  // 2. HTMLCanvasElement & CanvasRenderingContext2D Command Buffer
  // ---------------------------------------------------------------------------
  var __extraOps = [];
  var __dirtyCanvases = [];

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
    for (var i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return g.btoa(s);
  }

  function Canvas2DContext(canvas) {
    this.canvas = canvas;
    this._cmds = [];
    this._dirty = false;
    this._fillStyle = '#000000';
    this._strokeStyle = '#000000';
    this._lineWidth = 1;
    this._lineCap = 'butt';
    this._lineJoin = 'miter';
    this._globalAlpha = 1;
    this._globalCompositeOperation = 'source-over';
    this._font = '10px sans-serif';
    this._textAlign = 'start';
    this._textBaseline = 'alphabetic';
    this._shadowColor = 'rgba(0, 0, 0, 0)';
    this._shadowBlur = 0;
    this._shadowOffsetX = 0;
    this._shadowOffsetY = 0;
  }

  function markCanvasDirty(ctx) {
    if (!ctx._dirty) {
      ctx._dirty = true;
      __dirtyCanvases.push(ctx);
    }
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
  Canvas2DContext.prototype.createLinearGradient = function () {
    var grad = { _color: '#3b82f6', addColorStop: function (_off, col) { grad._color = col; } };
    return grad;
  };
  Canvas2DContext.prototype.createRadialGradient = Canvas2DContext.prototype.createLinearGradient;
  Canvas2DContext.prototype.drawImage = function (img) {
    var ref = null;
    if (img && img.__softnNode) ref = 'node:' + img.__softnNode;
    else if (img && typeof img.getAttribute === 'function' && img.getAttribute('src')) ref = img.getAttribute('src');
    if (!ref) return;
    var args = ['drawImage', ref];
    for (var i = 1; i < arguments.length; i++) args.push(Number(arguments[i]) || 0);
    this._cmds.push(args);
    markCanvasDirty(this);
  };

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
          if (this.__ctx2d) { this.__ctx2d._cmds.length = 0; markCanvasDirty(this.__ctx2d); }
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
          if (this.__ctx2d) { this.__ctx2d._cmds.length = 0; markCanvasDirty(this.__ctx2d); }
        }
      },
    });
    g.HTMLElement.prototype.getContext = function (type) {
      if (this.tagName !== 'CANVAS') return null;
      if (type === '2d') {
        if (!this.__ctx2d) this.__ctx2d = new Canvas2DContext(this);
        return this.__ctx2d;
      }
      return null;
    };
    g.HTMLElement.prototype.toDataURL = function () {
      return 'data:image/png;base64,';
    };
    void origMake;
  }

  // Wrap '__softnDocTake' so Canvas2D and Split-Realm Three.js ops ride in the exact same turn flush!
  var origDocTake = g.__softnDocTake;
  g.__softnPushExtraOp = function (op) { __extraOps.push(op); };
  g.__softnDocTake = function (failed) {
    for (var i = 0; i < __dirtyCanvases.length; i++) {
      var ctx = __dirtyCanvases[i];
      ctx._dirty = false;
      var cid = ctx.canvas && ctx.canvas.__softnNode;
      if (cid && ctx._cmds.length > 0) {
        __extraOps.push(['k2d', cid, ctx.canvas.width, ctx.canvas.height, ctx._cmds.splice(0, ctx._cmds.length)]);
      }
    }
    __dirtyCanvases.length = 0;
    var domOps = origDocTake ? origDocTake(failed) : null;
    if (__extraOps.length === 0) return domOps;
    var extra = __extraOps.splice(0, __extraOps.length);
    return domOps ? domOps.concat(extra) : extra;
  };

  // ---------------------------------------------------------------------------
  // 3. Virtual-Origin 'fetch()' & Binary 'Response' ('arrayBuffer()', 'blob()')
  // ---------------------------------------------------------------------------
  function b64ToBytes(b64) {
    var bin = g.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

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
          resolve(new ContainerResponse(vfsReply, rawUrl));
        } catch (err) {
          reject(new TypeError(err && err.message ? err.message : 'VFS fetch failed'));
        }
        return;
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
          if (sent.bodyBase64 !== undefined) reqOpts.bodyBase64 = sent.bodyBase64;
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
            var contentType = options.headers && options.headers['content-type'];
            options.body = typeof opts.body === 'string' && contentType && /\bjson\b/i.test(contentType)
              ? JSON.parse(opts.body) : opts.body;
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
  }
})();
`;
