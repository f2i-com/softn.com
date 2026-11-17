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
  // 4. Virtual-Origin 'fetch()' & Binary 'Response' ('arrayBuffer()', 'blob()')
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
