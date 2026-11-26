// SoftN Mobile v2 Container Extension Prelude
// Layered immediately after `zipp-browser`'s HOST_PRELUDE_JS + dom_shim.js.
// Provides:
//   - Full-stack `fetch()` routed to the in-process ZIPP backend + bundle VFS + gated net
//   - Persistent `localStorage` + `softn:db` + `softn:sqlite` backed by native Android SQLite
//   - Cross-platform Device Bridges (`softn:device`, `softn:camera`, `softn:bluetooth`,
//     `softn:location`, `softn:haptics`, `softn:notifications`) with async JNI resolution
//   - Upgraded HTML/CSS/inline-style/input serializer & interactive event helpers

// Top-level global slot bindings (zipp-vm resolves bare global identifiers at compile time)
var __softnBuiltins = Object.create(null);
var __softnResolveDeviceCall = function () { return false; };
var __softnDeliverWsFrames = function () { return 0; };
var __getDynamicHeadStyles = function () { return ""; };
var __softnInspectNode = function () { return "{}"; };
var __softnInspectSelect = function () { return "{}"; };
var __softnSetSelectIndex = function () { return false; };
var __softnSetInputValue = function () { return false; };
var __softnToggleCheckbox = function () { return false; };
var __softnCheckRadio = function () { return false; };
var __softnLabelControl = function () { return -1; };
var __softnDispatchClick = function () { return false; };
var __softnSubmitAncestorForm = function () { return false; };
var __zippDispatchPointerEvent = function () { return false; };
var __softnDispatchTap = function () { return false; };
var softn = {};

(function () {
  var g = typeof globalThis !== "undefined" ? globalThis : window;
  // Signal to @softn/core runtimes that this environment is ALREADY executing
  // inside the host native `zipp-vm` (prevents nested WASM ZIPP-on-ZIPP).
  g.__SOFTN_NATIVE_ZIPP_HOST__ = true;
  if (typeof window !== "undefined") window.__SOFTN_NATIVE_ZIPP_HOST__ = true;

  // ── 1. Full-stack fetch() routing through Rust host (`softn.fetch`) ────
  function makeHeaders(pairsOrObj) {
    var map = Object.create(null);
    if (Array.isArray(pairsOrObj)) {
      for (var i = 0; i < pairsOrObj.length; i++) {
        var pair = pairsOrObj[i];
        if (pair && pair.length >= 2) {
          var k = String(pair[0]).toLowerCase();
          map[k] = map[k] ? map[k] + ", " + String(pair[1]) : String(pair[1]);
        }
      }
    } else if (pairsOrObj && typeof pairsOrObj === "object") {
      var ks = Object.keys(pairsOrObj);
      for (var j = 0; j < ks.length; j++) {
        map[ks[j].toLowerCase()] = String(pairsOrObj[ks[j]]);
      }
    }
    return {
      get: function (name) {
        var k = String(name || "").toLowerCase();
        return k in map ? map[k] : null;
      },
      has: function (name) {
        return String(name || "").toLowerCase() in map;
      },
      forEach: function (cb) {
        var keys = Object.keys(map);
        for (var i = 0; i < keys.length; i++) cb(map[keys[i]], keys[i], this);
      },
      entries: function () {
        var out = [];
        var keys = Object.keys(map);
        for (var i = 0; i < keys.length; i++) out.push([keys[i], map[keys[i]]]);
        return out;
      }
    };
  }

  function makeResponse(raw, reqUrl, credentials) {
    var status = typeof raw.status === "number" ? raw.status : 200;
    var ok = status >= 200 && status < 300;
    var bodyText = typeof raw.body === "string" ? raw.body : "";
    var headers = makeHeaders(raw.headers || []);
    var ct = headers.get("content-type") || "application/octet-stream";
    var url = raw.url || reqUrl || "";
    var cachedBytes = raw._bytes || null;
    // The body's own bytes: handed over beside the response when they are not ASCII
    // (`_bytes`), else its text's. Never the URL fetched again: that was a second request,
    // a GET whatever the method, without the page's headers.
    function readBytes() {
      if (cachedBytes) return Promise.resolve(cachedBytes.slice(0));
      var enc = typeof TextEncoder === "function" ? new TextEncoder().encode(bodyText) : null;
      if (enc) return Promise.resolve(enc instanceof Uint8Array ? enc : new Uint8Array(enc));
      var out = new Uint8Array(bodyText.length);
      for (var i = 0; i < bodyText.length; i++) out[i] = bodyText.charCodeAt(i) & 0xff;
      return Promise.resolve(out);
    }
    return {
      ok: ok,
      status: status,
      statusText: raw.statusText || (ok ? "OK" : "Error"),
      url: url,
      redirected: false,
      type: "basic",
      headers: headers,
      text: function () { return Promise.resolve(bodyText); },
      json: function () {
        return new Promise(function (resolve, reject) {
          try { resolve(JSON.parse(bodyText)); }
          catch (e) { reject(e); }
        });
      },
      arrayBuffer: function () {
        return readBytes().then(function (u8) { return u8.buffer; });
      },
      bytes: function () {
        return readBytes();
      },
      blob: function () {
        return readBytes().then(function (u8) {
          if (typeof Blob === "function") {
            var b = new Blob([u8], { type: ct });
            b._url = url;
            return b;
          }
          return {
            size: u8.byteLength,
            type: ct,
            arrayBuffer: function () { return Promise.resolve(u8.slice(0).buffer); },
            text: function () { return Promise.resolve(bodyText); }
          };
        });
      },
      clone: function () { return makeResponse(raw, reqUrl, credentials); }
    };
  }

  function softnFetch(input, init) {
    var isReq = input && typeof input === "object" && typeof input.url === "string";
    var url = typeof input === "string"
      ? input
      : (isReq ? input.url : (input && input.href ? String(input.href) : String(input || "")));
    var opts = init || {};
    var method = String(opts.method || (isReq && input.method) || "GET").toUpperCase();
    var credsRaw = opts.credentials || (isReq && input.credentials) || "same-origin";
    var credentials = credsRaw === "omit" ? "omit" : (credsRaw === "include" ? "include" : "same-origin");
    var srcHeaders = opts.headers !== undefined ? opts.headers : (isReq ? input.headers : null);
    var headersObj = {};
    if (srcHeaders) {
      if (typeof srcHeaders.forEach === "function") {
        srcHeaders.forEach(function (v, k) { headersObj[k] = String(v); });
      } else if (srcHeaders._headers && typeof srcHeaders._headers === "object") {
        var ihk = Object.keys(srcHeaders._headers);
        for (var ii = 0; ii < ihk.length; ii++) headersObj[ihk[ii]] = String(srcHeaders._headers[ihk[ii]]);
      } else if (Array.isArray(srcHeaders)) {
        for (var i = 0; i < srcHeaders.length; i++) {
          if (srcHeaders[i] && srcHeaders[i].length >= 2) {
            headersObj[String(srcHeaders[i][0])] = String(srcHeaders[i][1]);
          }
        }
      } else if (typeof srcHeaders === "object") {
        var hk = Object.keys(srcHeaders);
        for (var j = 0; j < hk.length; j++) headersObj[hk[j]] = String(srcHeaders[hk[j]]);
      }
    }
    var rawBody = opts.body !== undefined ? opts.body : (isReq && input.body !== undefined ? input.body : null);
    var body = "";
    if (rawBody !== undefined && rawBody !== null) {
      body = typeof rawBody === "string" ? rawBody : String(rawBody);
    }
    return new Promise(function (resolve, reject) {
      try {
        // Fast binary-preserving path for blob:, data:, and binary asset extensions
        // (Three.js .glb/.hdr, images, Wasm) so bytes never pass through UTF-8 lossy decoding.
        var lowerUrl = url.split("?")[0].split("#")[0].toLowerCase();
        var isBinaryAsset = method === "GET" && (
          url.indexOf("blob:") === 0 ||
          url.indexOf("data:") === 0 ||
          /\.(glb|hdr|png|jpe?g|webp|gif|bmp|wasm|bin|woff2?|ttf|otf|mp3|ogg|wav)$/.test(lowerUrl)
        );
        if (isBinaryAsset) {
          var info = JSON.parse(__zippHostCall("http_bytes", url, credentials, JSON.stringify(headersObj)));
          if (info && info.error && !info.status) {
            reject(new TypeError(String(info.error)));
            return;
          }
          var len = (info && info.len) || 0;
          if (__zippHostBytes.length < len) {
            __zippHostBytes = new Uint8Array(Math.max(len, __zippHostBytes.length * 2));
          }
          __zippHostCall("take_bytes");
          var bytes = __zippHostBytes.slice(0, len);
          if (__zippHostBytes.length > 262144) {
            __zippHostBytes = new Uint8Array(65536);
          }
          var textBody = "";
          if (info.contentType && /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(String(info.contentType))) {
            try { textBody = new TextDecoder().decode(bytes); } catch (e) {}
          }
          resolve(makeResponse({
            url: url,
            status: info.status || 200,
            headers: info.contentType ? [["content-type", info.contentType], ["content-length", String(len)]] : [["content-length", String(len)]],
            body: textBody,
            _bytes: bytes
          }, url, credentials));
          return;
        }
        var raw = __zippHostCall("softn.fetch", method, url, JSON.stringify(headersObj), body, credentials, "bytes");
        var parsed = JSON.parse(raw);
        if (parsed && parsed.error && !parsed.status) {
          reject(new TypeError(String(parsed.error)));
          return;
        }
        if (parsed && typeof parsed.binLen === "number") {
          var blen = parsed.binLen;
          if (__zippHostBytes.length < blen) {
            __zippHostBytes = new Uint8Array(Math.max(blen, __zippHostBytes.length * 2));
          }
          __zippHostCall("take_bytes");
          parsed._bytes = __zippHostBytes.slice(0, blen);
          if (__zippHostBytes.length > 262144) {
            __zippHostBytes = new Uint8Array(65536);
          }
        }
        resolve(makeResponse(parsed, url, credentials));
      } catch (e) {
        reject(e);
      }
    });
  }

  window.fetch = softnFetch;
  fetch = softnFetch;

  if (typeof console !== "undefined" && console && typeof env !== "undefined") {
    console.error = function () {
      var parts = [];
      for (var ci = 0; ci < arguments.length; ci++) {
        var x = arguments[ci];
        parts.push(x && typeof x === "object" && x.stack ? String(x.stack) : String(x));
      }
      env.log("error", parts.join(" "));
    };
  }

  // ── 1b. In-process WebSocket bridge to Container v2 Rust/local backend ──
  var __wsRegistry = Object.create(null);
  var __wsSeq = 1;
  var __WS_MAX_OPEN = 64;

  function dispatchWsFrame(frame) {
    if (!frame || !frame.wsId) return;
    var sock = __wsRegistry[String(frame.wsId)];
    if (!sock) return;
    var ty = String(frame.type || "text");
    if (ty === "close") {
      sock.readyState = 3;
      delete __wsRegistry[sock._id];
      var cev = { type: "close", code: frame.code || 1000, reason: frame.reason || "", wasClean: true };
      if (typeof sock.onclose === "function") { try { sock.onclose(cev); } catch (e) {} }
      sock._emit("close", cev);
    } else if (ty === "text" || ty === "binary") {
      var mev = { type: "message", data: frame.data !== undefined ? frame.data : "" };
      if (typeof sock.onmessage === "function") { try { sock.onmessage(mev); } catch (e) {} }
      sock._emit("message", mev);
    }
  }

  __softnDeliverWsFrames = function (framesJson) {
    if (!framesJson) return 0;
    var list;
    try { list = JSON.parse(framesJson); } catch (e) { return 0; }
    if (!Array.isArray(list)) return 0;
    for (var i = 0; i < list.length; i++) dispatchWsFrame(list[i]);
    return list.length;
  };
  g.__softnDeliverWsFrames = __softnDeliverWsFrames;

  function SoftnWebSocket(url) {
    var self = this;
    this._id = "ws_" + (__wsSeq++);
    this.url = String(url || "");
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.protocol = "";
    this.extensions = "";
    this.binaryType = "blob";
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._listeners = Object.create(null);
    if (Object.keys(__wsRegistry).length >= __WS_MAX_OPEN) {
      throw new Error("WebSocket connection limit exceeded");
    }
    __wsRegistry[this._id] = this;

    setTimeout(function () {
      if (self.readyState !== 0) return;
      try {
        var raw = __zippHostCall("softn.ws", "open", self._id, self.url, "");
        var res = raw ? JSON.parse(raw) : { accepted: false };
        if (res && res.accepted) {
          self.readyState = 1;
          var oev = { type: "open" };
          if (typeof self.onopen === "function") { try { self.onopen(oev); } catch (e) {} }
          self._emit("open", oev);
          if (Array.isArray(res.wsFrames)) {
            for (var i = 0; i < res.wsFrames.length; i++) dispatchWsFrame(res.wsFrames[i]);
          }
        } else {
          self.readyState = 3;
          delete __wsRegistry[self._id];
          var eev = { type: "error", message: (res && res.body) || "WebSocket rejected" };
          if (typeof self.onerror === "function") { try { self.onerror(eev); } catch (e) {} }
          self._emit("error", eev);
          var cev = { type: "close", code: 1006, reason: "", wasClean: false };
          if (typeof self.onclose === "function") { try { self.onclose(cev); } catch (e) {} }
          self._emit("close", cev);
        }
      } catch (err) {
        self.readyState = 3;
        delete __wsRegistry[self._id];
        if (typeof self.onerror === "function") { try { self.onerror({ type: "error", error: err }); } catch (e) {} }
        if (typeof self.onclose === "function") { try { self.onclose({ type: "close", code: 1006, reason: "", wasClean: false }); } catch (e) {} }
      }
    }, 0);
  }
  SoftnWebSocket.CONNECTING = 0;
  SoftnWebSocket.OPEN = 1;
  SoftnWebSocket.CLOSING = 2;
  SoftnWebSocket.CLOSED = 3;
  SoftnWebSocket.prototype.addEventListener = function (t, fn) {
    if (!this._listeners[t]) this._listeners[t] = [];
    this._listeners[t].push(fn);
  };
  SoftnWebSocket.prototype.removeEventListener = function (t, fn) {
    var list = this._listeners[t];
    if (!list) return;
    var idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  };
  SoftnWebSocket.prototype._emit = function (t, ev) {
    var list = this._listeners[t];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(this, ev); } catch (e) {}
    }
  };
  SoftnWebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) return;
    try {
      var raw = __zippHostCall("softn.ws", "send", this._id, typeof data === "string" ? data : String(data), "");
      var res = raw ? JSON.parse(raw) : null;
      if (res && Array.isArray(res.wsFrames)) {
        for (var i = 0; i < res.wsFrames.length; i++) dispatchWsFrame(res.wsFrames[i]);
      }
    } catch (e) {}
  };
  SoftnWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    delete __wsRegistry[this._id];
    try {
      __zippHostCall("softn.ws", "close", this._id, String(code || 1000), String(reason || ""));
    } catch (e) {}
    var cev = { type: "close", code: code || 1000, reason: reason || "", wasClean: true };
    if (typeof this.onclose === "function") { try { this.onclose(cev); } catch (e) {} }
    this._emit("close", cev);
  };
  window.WebSocket = SoftnWebSocket;
  g.WebSocket = SoftnWebSocket;

  // Safe polyfills for common modern browser APIs used by React/Vite apps
  if (typeof window.AbortController === "undefined") {
    function SoftnAbortController() {
      this.signal = { aborted: false, reason: undefined, addEventListener: function () {}, removeEventListener: function () {} };
      this.abort = function (r) { this.signal.aborted = true; this.signal.reason = r; };
    }
    window.AbortController = SoftnAbortController;
    g.AbortController = SoftnAbortController;
  }
  if (!window.crypto) window.crypto = {};
  if (typeof window.crypto.getRandomValues !== "function") {
    window.crypto.getRandomValues = function (arr) {
      if (!arr || typeof arr.byteLength !== "number") {
        throw new TypeError("getRandomValues requires a TypedArray");
      }
      var len = arr.byteLength;
      if (len > 65536) {
        throw new Error("QuotaExceededError: getRandomValues max 65536 bytes");
      }
      var hex = __zippHostCall("random", String(len));
      var view = new Uint8Array(arr.buffer, arr.byteOffset || 0, len);
      for (var i = 0; i < len; i++) {
        view[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
      }
      return arr;
    };
  }
  if (typeof window.crypto.randomUUID !== "function") {
    window.crypto.randomUUID = function () {
      var hex = __zippHostCall("random", "16");
      if (typeof hex === "string" && hex.length >= 32) {
        var b6 = (parseInt(hex.slice(12, 14), 16) & 0x0f) | 0x40;
        var b8 = (parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80;
        var h6 = (b6 < 16 ? "0" : "") + b6.toString(16);
        var h8 = (b8 < 16 ? "0" : "") + b8.toString(16);
        return (
          hex.slice(0, 8) + "-" +
          hex.slice(8, 12) + "-" +
          h6 + hex.slice(14, 16) + "-" +
          h8 + hex.slice(18, 20) + "-" +
          hex.slice(20, 32)
        );
      }
      throw new Error("CSPRNG unavailable for randomUUID");
    };
  }
  if (typeof g.crypto === "undefined") g.crypto = window.crypto;

  // ── 2. Persistent localStorage backed by Android app SQLite ────────────
  var lsData = Object.create(null);
  try {
    var loadedLs = __zippHostCall("softn.storage", "load_all", "", "");
    if (loadedLs) {
      var parsedLs = JSON.parse(loadedLs);
      if (parsedLs && typeof parsedLs === "object") {
        var pks = Object.keys(parsedLs);
        for (var pi = 0; pi < pks.length; pi++) {
          lsData[pks[pi]] = String(parsedLs[pks[pi]]);
        }
      }
    }
  } catch (e) {}

  var persistentLocalStorage = {
    getItem: function (k) {
      var key = String(k);
      return Object.prototype.hasOwnProperty.call(lsData, key) ? lsData[key] : null;
    },
    setItem: function (k, v) {
      var key = String(k);
      var val = String(v);
      var ok = false;
      try { ok = __zippHostCall("softn.storage", "set", key, val) === "true"; } catch (e) { ok = false; }
      if (!ok) {
        throw new Error("QuotaExceededError: localStorage limit exceeded");
      }
      lsData[key] = val;
    },
    removeItem: function (k) {
      var key = String(k);
      delete lsData[key];
      try { __zippHostCall("softn.storage", "remove", key, ""); } catch (e) {}
    },
    clear: function () {
      lsData = Object.create(null);
      try { __zippHostCall("softn.storage", "clear", "", ""); } catch (e) {}
    },
    key: function (i) {
      var ks = Object.keys(lsData);
      return i >= 0 && i < ks.length ? ks[i] : null;
    },
    get length() { return Object.keys(lsData).length; }
  };
  window.localStorage = persistentLocalStorage;
  localStorage = persistentLocalStorage;

  // ── 3. Async/Sync Device Bridge (`softn:device`, `softn:camera`, etc.) ─
  var __nextDeviceReqId = 1;
  var __pendingDeviceCalls = Object.create(null);

  function deviceRpc(namespace, method, params) {
    var reqId = __nextDeviceReqId++;
    return new Promise(function (resolve, reject) {
      try {
        var raw = __zippHostCall(
          "softn.device",
          String(reqId),
          String(namespace),
          String(method),
          JSON.stringify(params || {})
        );
        var resp = raw ? JSON.parse(raw) : null;
        if (!resp) {
          reject(new Error(namespace + "." + method + " returned empty response"));
          return;
        }
        if (resp.pending) {
          __pendingDeviceCalls[reqId] = { resolve: resolve, reject: reject };
          return;
        }
        if (resp.ok === false || resp.error) {
          reject(new Error(String(resp.error || (namespace + "." + method + " failed"))));
          return;
        }
        resolve(resp.result);
      } catch (e) {
        reject(e);
      }
    });
  }

  __softnResolveDeviceCall = function (reqId, ok, payloadJson) {
    var entry = __pendingDeviceCalls[reqId];
    if (!entry) return false;
    delete __pendingDeviceCalls[reqId];
    if (ok) {
      try {
        entry.resolve(payloadJson ? JSON.parse(payloadJson) : null);
      } catch (e) {
        entry.resolve(payloadJson);
      }
    } else {
      var msg = payloadJson || "Native device call failed";
      try {
        var parsedErr = JSON.parse(payloadJson);
        if (parsedErr && parsedErr.error) msg = String(parsedErr.error);
      } catch (e) {}
      entry.reject(new Error(msg));
    }
    return true;
  };
  g.__softnResolveDeviceCall = __softnResolveDeviceCall;

  var softnDevice = {
    getInfo: function () { return deviceRpc("device", "getInfo", {}); },
    share: function (opts) { return deviceRpc("device", "share", opts || {}); },
    clipboardWrite: function (text) { return deviceRpc("device", "clipboardWrite", { text: String(text == null ? "" : text) }); },
    clipboardRead: function () { return deviceRpc("device", "clipboardRead", {}); }
  };
  var softnCamera = {
    isAvailable: function () { return deviceRpc("camera", "isAvailable", {}); },
    takePhoto: function (opts) { return deviceRpc("camera", "takePhoto", opts || {}); },
    pickPhoto: function (opts) { return deviceRpc("camera", "pickPhoto", opts || {}); }
  };
  var softnBluetooth = {
    isAvailable: function () { return deviceRpc("bluetooth", "isAvailable", {}); },
    scan: function (opts) { return deviceRpc("bluetooth", "scan", opts || {}); },
    connect: function (deviceId) { return deviceRpc("bluetooth", "connect", { deviceId: String(deviceId || "") }); },
    disconnect: function (deviceId) { return deviceRpc("bluetooth", "disconnect", { deviceId: String(deviceId || "") }); },
    read: function (deviceId, serviceUuid, characteristicUuid) {
      return deviceRpc("bluetooth", "read", {
        deviceId: String(deviceId || ""),
        serviceUuid: String(serviceUuid || ""),
        characteristicUuid: String(characteristicUuid || "")
      });
    },
    write: function (deviceId, serviceUuid, characteristicUuid, base64, withoutResponse) {
      return deviceRpc("bluetooth", "write", {
        deviceId: String(deviceId || ""),
        serviceUuid: String(serviceUuid || ""),
        characteristicUuid: String(characteristicUuid || ""),
        base64: String(base64 || ""),
        withoutResponse: Boolean(withoutResponse)
      });
    }
  };
  var softnLocation = {
    isAvailable: function () { return deviceRpc("location", "isAvailable", {}); },
    getCurrentPosition: function (opts) { return deviceRpc("location", "getCurrentPosition", opts || {}); }
  };
  var softnHaptics = {
    isAvailable: function () { return deviceRpc("haptics", "isAvailable", {}); },
    impact: function (style) { return deviceRpc("haptics", "impact", { style: style || "medium" }); },
    vibrate: function (durationMs) { return deviceRpc("haptics", "vibrate", { durationMs: Number(durationMs) || 40 }); }
  };
  var softnNotifications = {
    isAvailable: function () { return deviceRpc("notifications", "isAvailable", {}); },
    notify: function (opts) {
      var payload = typeof opts === "string" ? { title: opts } : (opts || {});
      return deviceRpc("notifications", "notify", payload);
    }
  };
  var softnFiles = {
    isAvailable: function () { return deviceRpc("files", "isAvailable", {}); },
    pick: function (opts) { return deviceRpc("files", "pick", opts || {}); },
    save: function (opts) { return deviceRpc("files", "save", opts || {}); }
  };
  var softnSensors = {
    isAvailable: function () { return deviceRpc("sensors", "isAvailable", {}); },
    getMotion: function () { return deviceRpc("sensors", "getMotion", {}); }
  };
  var softnPermissions = {
    query: function (name) { return deviceRpc("permissions", "query", { name: String(name || "") }); }
  };

  // ── 4. Persistent `softn:db` XDB collections ───────────────────────────
  var xdbData = Object.create(null);
  try {
    var rawXdb = __zippHostCall("softn.xdb", "load_all", "", "");
    if (rawXdb) {
      var parsedXdb = JSON.parse(rawXdb);
      if (parsedXdb && typeof parsedXdb === "object") {
        var xks = Object.keys(parsedXdb);
        for (var xi = 0; xi < xks.length; xi++) {
          xdbData[xks[xi]] = parsedXdb[xks[xi]];
        }
      }
    }
  } catch (e) {}

  function persistCollection(col) {
    try { __zippHostCall("softn.xdb", "save", col, JSON.stringify(xdbData[col] || [])); } catch (e) {}
  }
  var softnDb = {
    query: function (col) {
      return (xdbData[col] || []).slice();
    },
    get: function (col, id) {
      var list = xdbData[col] || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
      return null;
    },
    create: function (col, record) {
      if (!xdbData[col]) xdbData[col] = [];
      var item = Object.assign({ id: "rec_" + Date.now() + "_" + Math.floor(Math.random() * 10000) }, record);
      xdbData[col].push(item);
      persistCollection(col);
      return item;
    },
    update: function (col, id, patch) {
      var list = xdbData[col] || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) {
          list[i] = Object.assign({}, list[i], patch, { id: id });
          persistCollection(col);
          return list[i];
        }
      }
      return null;
    },
    remove: function (col, id) {
      var list = xdbData[col] || [];
      xdbData[col] = list.filter(function (r) { return !r || r.id !== id; });
      persistCollection(col);
      return true;
    },
    subscribe: function () { return function () {}; }
  };

  // ── 5. Direct `softn:sqlite` helper (for frontend-only SQLite apps) ────
  var softnSqlite = {
    open: function (name) {
      return new Promise(function (resolve, reject) {
        try {
          var raw = __zippHostCall("app.sql.open", String(name || "app.db"), "", "");
          var opened = JSON.parse(raw);
          if (opened.error) { reject(new Error(opened.error)); return; }
          var id = String(opened.id);
          resolve({
            id: opened.id,
            query: function (sql, params) {
              var r = JSON.parse(__zippHostCall("app.sql.query", id, String(sql), params !== undefined ? JSON.stringify(params) : ""));
              if (r.error) return Promise.reject(new Error(r.error));
              var cols = r.columns || [];
              var rows = (r.rows || []).map(function (arr) {
                var obj = {};
                for (var i = 0; i < cols.length; i++) obj[cols[i]] = arr[i];
                return obj;
              });
              return Promise.resolve({ columns: cols, rows: rows, rawRows: r.rows || [] });
            },
            execute: function (sql, params) {
              var r = JSON.parse(__zippHostCall("app.sql.execute", id, String(sql), params !== undefined ? JSON.stringify(params) : ""));
              if (r.error) return Promise.reject(new Error(r.error));
              return Promise.resolve(r);
            },
            all: function (sql, params) { return this.query(sql, params).then(function (r) { return r.rows; }); },
            first: function (sql, params) { return this.query(sql, params).then(function (r) { return r.rows[0] || null; }); },
            run: function (sql, params) { return this.execute(sql, params); },
            close: function () { __zippHostCall("app.sql.close", id, "", ""); return Promise.resolve({ ok: true }); }
          });
        } catch (e) {
          reject(e);
        }
      });
    }
  };

  // Expose both `globalThis.softn` and virtual ES module registry `__softnBuiltins`
  var softnApiObj = { fetch: softnFetch };
  var softnRoot = {
    device: softnDevice,
    camera: softnCamera,
    bluetooth: softnBluetooth,
    location: softnLocation,
    haptics: softnHaptics,
    notifications: softnNotifications,
    files: softnFiles,
    sensors: softnSensors,
    permissions: softnPermissions,
    db: softnDb,
    storage: persistentLocalStorage,
    sqlite: softnSqlite,
    net: { fetch: softnFetch },
    api: softnApiObj
  };
  softn = softnRoot;
  g.softn = softnRoot;
  window.softn = softnRoot;

  __softnBuiltins = Object.assign(Object.create(null), {
    "softn:device": Object.assign({ device: softnDevice, default: softnDevice }, softnDevice),
    "softn:camera": Object.assign({ camera: softnCamera, default: softnCamera }, softnCamera),
    "softn:bluetooth": Object.assign({ bluetooth: softnBluetooth, ble: softnBluetooth, default: softnBluetooth }, softnBluetooth),
    "softn:location": Object.assign({ location: softnLocation, default: softnLocation }, softnLocation),
    "softn:haptics": Object.assign({ haptics: softnHaptics, default: softnHaptics }, softnHaptics),
    "softn:notifications": Object.assign({ notifications: softnNotifications, default: softnNotifications }, softnNotifications),
    "softn:files": Object.assign({ files: softnFiles, default: softnFiles }, softnFiles),
    "softn:sensors": Object.assign({ sensors: softnSensors, default: softnSensors }, softnSensors),
    "softn:permissions": Object.assign({ permissions: softnPermissions, default: softnPermissions }, softnPermissions),
    "softn:db": { db: softnDb, subscribe: softnDb.subscribe, default: softnDb },
    "softn:storage": { storage: persistentLocalStorage, default: persistentLocalStorage },
    "softn:net": { fetch: softnFetch, default: { fetch: softnFetch } },
    "softn:api": { api: softnApiObj, fetch: softnFetch, default: softnApiObj },
    "softn:sqlite": { open: softnSqlite.open, default: softnSqlite },
    "softn:backend": { backend: { call: function () { return Promise.reject(new Error("Use fetch('/api/...') for container v2 backends")); } } }
  });
  g.__softnBuiltins = __softnBuiltins;

  // Wire standard Web APIs to the permission-gated SoftN native bridges so
  // unmodified SoftN and web apps slot into Android and "just work".
  function __bytesToB64(input) {
    var u8 = input instanceof Uint8Array
      ? input
      : (input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : (ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(0)));
    var s = "";
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function __b64ToDataView(b64) {
    var raw = atob(String(b64 || ""));
    var buf = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    return new DataView(buf.buffer);
  }

  // A Web Bluetooth UUID as the bridge takes it: a 16- or 32-bit alias given as a number
  // (`0x180D`, as `BluetoothUUID.getService` reads one) as its hex digits; a string as
  // written. `String(0x180D)` was "6157", a different service, refused by the allowlist.
  function __bleUuid(v) {
    if (typeof v === "number" && isFinite(v) && v >= 0 && v <= 0xffffffff && Math.floor(v) === v) {
      var hex = v.toString(16);
      var width = v <= 0xffff ? 4 : 8;
      while (hex.length < width) hex = "0" + hex;
      return hex;
    }
    return String(v);
  }

  var __geoWatchSeq = 1;
  var __geoWatches = Object.create(null);

  if (window.navigator) {
    window.navigator.vibrate = function (ms) {
      var dur = Array.isArray(ms) ? (ms[0] || 40) : (Number(ms) || 40);
      softnHaptics.vibrate(dur).catch(function () {});
      return true;
    };
    window.navigator.share = function (opts) { return softnDevice.share(opts || {}); };
    window.navigator.clipboard = {
      writeText: function (text) { return softnDevice.clipboardWrite(text); },
      readText: function () {
        return softnDevice.clipboardRead().then(function (r) {
          return r && typeof r.text === "string" ? r.text : "";
        });
      }
    };
    window.navigator.geolocation = {
      getCurrentPosition: function (success, error, opts) {
        var o = opts || {};
        softnLocation.getCurrentPosition({
          highAccuracy: Boolean(o.enableHighAccuracy || o.highAccuracy),
          timeoutMs: Number(o.timeout || o.timeoutMs) || 10000,
          maximumAgeMs: Number(o.maximumAge || o.maximumAgeMs) || 0
        }).then(
          function (pos) {
            if (typeof success === "function") {
              success({
                coords: {
                  latitude: pos.latitude,
                  longitude: pos.longitude,
                  accuracy: pos.accuracy,
                  altitude: pos.altitude,
                  altitudeAccuracy: null,
                  heading: pos.heading !== undefined ? pos.heading : null,
                  speed: pos.speed !== undefined ? pos.speed : null
                },
                timestamp: pos.timestamp
              });
            }
          },
          function (err) {
            if (typeof error === "function") {
              var msg = err && err.message ? err.message : String(err);
              var code = /denied|permission/i.test(msg) ? 1 : (/timeout/i.test(msg) ? 3 : 2);
              error({ code: code, message: msg, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
            }
          }
        );
      },
      watchPosition: function (success, error, opts) {
        var id = __geoWatchSeq++;
        var interval = Math.max(1500, Number(opts && opts.intervalMs) || 3000);
        var poll = function () {
          if (!__geoWatches[id]) return;
          window.navigator.geolocation.getCurrentPosition(success, error, opts);
        };
        __geoWatches[id] = setInterval(poll, interval);
        poll();
        return id;
      },
      clearWatch: function (id) {
        if (__geoWatches[id]) {
          clearInterval(__geoWatches[id]);
          delete __geoWatches[id];
        }
      }
    };
    // Standard Web Bluetooth API backed by Android BLE GATT (`softn:bluetooth`)
    window.navigator.bluetooth = {
      getAvailability: function () {
        return softnBluetooth.isAvailable().then(function (r) {
          return Boolean(r && r.available && r.permitted);
        }).catch(function () { return false; });
      },
      requestDevice: function (opts) {
        var o = opts || {};
        // The scan looks for what the filters name. `optionalServices` are what the page
        // may use once connected, not what a device must advertise: as scan filters they
        // let a device that advertises only one of them be the one picked.
        var services = [];
        if (Array.isArray(o.filters)) {
          for (var i = 0; i < o.filters.length; i++) {
            var f = o.filters[i];
            if (f && Array.isArray(f.services)) {
              for (var j = 0; j < f.services.length; j++) {
                var s = __bleUuid(f.services[j]);
                if (services.indexOf(s) < 0) services.push(s);
              }
            }
          }
        }
        var namePrefix = "";
        if (Array.isArray(o.filters) && o.filters[0] && o.filters[0].namePrefix) {
          namePrefix = String(o.filters[0].namePrefix);
        }
        return softnBluetooth.scan({
          services: services,
          namePrefix: namePrefix,
          durationMs: Number(o.durationMs) || 3000
        }).then(function (res) {
          var devs = (res && Array.isArray(res.devices)) ? res.devices : [];
          if (!devs.length) {
            throw new DOMException("No Bluetooth devices found", "NotFoundError");
          }
          var picked = devs[0];
          var devId = String(picked.id || "");
          var gatt = {
            device: null,
            connected: false,
            connect: function () {
              return softnBluetooth.connect(devId).then(function (conn) {
                gatt.connected = true;
                gatt._services = (conn && Array.isArray(conn.services)) ? conn.services : [];
                return gatt;
              });
            },
            disconnect: function () {
              gatt.connected = false;
              softnBluetooth.disconnect(devId).catch(function () {});
            },
            getPrimaryService: function (serviceUuid) {
              var sUuid = __bleUuid(serviceUuid);
              return Promise.resolve({
                device: gatt.device,
                uuid: sUuid,
                isPrimary: true,
                getCharacteristic: function (charUuid) {
                  var cUuid = __bleUuid(charUuid);
                  return Promise.resolve({
                    uuid: cUuid,
                    value: null,
                    readValue: function () {
                      var ch = this;
                      return softnBluetooth.read(devId, sUuid, cUuid).then(function (r) {
                        var dv = __b64ToDataView(r && r.base64 ? r.base64 : "");
                        ch.value = dv;
                        return dv;
                      });
                    },
                    writeValue: function (buf) {
                      return softnBluetooth.write(devId, sUuid, cUuid, __bytesToB64(buf), false);
                    },
                    writeValueWithResponse: function (buf) {
                      return softnBluetooth.write(devId, sUuid, cUuid, __bytesToB64(buf), false);
                    },
                    writeValueWithoutResponse: function (buf) {
                      return softnBluetooth.write(devId, sUuid, cUuid, __bytesToB64(buf), true);
                    }
                  });
                }
              });
            }
          };
          var device = {
            id: devId,
            name: picked.name || "",
            rssi: picked.rssi || 0,
            gatt: gatt
          };
          gatt.device = device;
          return device;
        });
      }
    };
    window.navigator.permissions = {
      query: function (desc) {
        var name = (desc && desc.name) ? String(desc.name) : "";
        return softnPermissions.query(name).then(function (r) {
          return {
            name: name,
            state: (r && r.state) ? String(r.state) : "denied",
            onchange: null,
            addEventListener: function () {},
            removeEventListener: function () {}
          };
        }).catch(function () {
          return { name: name, state: "denied", onchange: null, addEventListener: function () {}, removeEventListener: function () {} };
        });
      }
    };
    window.navigator.mediaDevices = {
      enumerateDevices: function () {
        return Promise.all([
          softnCamera.isAvailable().catch(function () { return { available: false, permitted: false }; }),
          softnPermissions.query("microphone").catch(function () { return { state: "denied" }; })
        ]).then(function (arr) {
          var out = [];
          if (arr[0] && arr[0].available) {
            out.push({ deviceId: "back-camera", kind: "videoinput", label: "Android Camera", groupId: "default" });
          }
          if (arr[1] && arr[1].state !== "denied") {
            out.push({ deviceId: "default-mic", kind: "audioinput", label: "Android Microphone", groupId: "default" });
          }
          return out;
        });
      },
      capturePhoto: function (opts) {
        return softnCamera.takePhoto(opts || {});
      },
      getUserMedia: function (constraints) {
        var c = constraints || {};
        if (c.video) {
          return softnCamera.takePhoto({ quality: 85 }).then(function (photo) {
            var track = { kind: "video", label: "Android Camera", enabled: true, readyState: "live", stop: function () { this.readyState = "ended"; } };
            return {
              id: "softn-camera-stream",
              active: true,
              photoDataUrl: photo && photo.dataUrl ? photo.dataUrl : "",
              getTracks: function () { return [track]; },
              getVideoTracks: function () { return [track]; },
              getAudioTracks: function () { return []; }
            };
          });
        }
        return Promise.reject(new DOMException("Only video camera capture is supported on this device", "NotSupportedError"));
      }
    };
  }

  // Standard Web Notifications API backed by Android NotificationManager (`softn:notifications`)
  function SoftnNotification(title, opts) {
    var o = opts || {};
    this.title = String(title || "");
    this.body = String(o.body || "");
    this.tag = o.tag ? String(o.tag) : "";
    this.onclick = null;
    this.onclose = null;
    softnNotifications.notify({ title: this.title, body: this.body, tag: this.tag }).catch(function () {});
  }
  SoftnNotification.permission = "default";
  SoftnNotification.requestPermission = function (cb) {
    return softnPermissions.query("notifications").then(function (r) {
      var st = r && r.state === "granted" ? "granted" : (r && r.state === "denied" ? "denied" : "granted");
      SoftnNotification.permission = st;
      if (typeof cb === "function") cb(st);
      return st;
    }).catch(function () {
      SoftnNotification.permission = "denied";
      if (typeof cb === "function") cb("denied");
      return "denied";
    });
  };
  SoftnNotification.prototype.close = function () {};
  window.Notification = SoftnNotification;
  g.Notification = SoftnNotification;

  // ── 6. Delegate serialization to zipp-browser's full Shadow DOM / SVG / !important serializer ──
  g.__getRenderedHTML = function () {
    if (!doc || !doc.body) return "";
    var kids = doc.body.childNodes || [];
    var parts = new Array(kids.length);
    for (var i = 0; i < kids.length; i++) parts[i] = __serializeNode(kids[i]);
    return parts.join("");
  };
  __getRenderedHTML = g.__getRenderedHTML;

  __getDynamicHeadStyles = function () {
    var css = "";
    if (doc && doc.adoptedStyleSheets && doc.adoptedStyleSheets.length) {
      for (var si = 0; si < doc.adoptedStyleSheets.length; si++) {
        var sheetText = doc.adoptedStyleSheets[si] && doc.adoptedStyleSheets[si]._text;
        if (sheetText) css += "\n" + sheetText;
      }
    }
    if (!doc || !doc.head || !doc.head.childNodes) return css;
    var kids = doc.head.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n && n.nodeType === 1 && String(n.tagName || "").toLowerCase() === "style") {
        css += "\n" + (n.textContent || "");
      }
    }
    return css;
  };
  g.__getDynamicHeadStyles = __getDynamicHeadStyles;

  // ── 7. Interactive event & form input helpers for Android touch/IME ────
  __softnInspectNode = function (flid) {
    var node = __nodesById[flid];
    if (!node) return "{}";
    var tag = String(node.tagName || "").toLowerCase();
    var type = (node.getAttribute && node.getAttribute("type")) || node.type || "text";
    var val = node.value !== undefined && node.value !== null ? String(node.value) : "";
    return JSON.stringify({
      flid: flid,
      tag: tag,
      type: String(type).toLowerCase(),
      value: val,
      checked: Boolean(node.checked),
      href: (node.getAttribute && node.getAttribute("href")) || ""
    });
  };
  g.__softnInspectNode = __softnInspectNode;

  __softnInspectSelect = function (flid) {
    var node = __nodesById[flid];
    if (!node || String(node.tagName || "").toLowerCase() !== "select") return "{}";
    var opts = node.options || [];
    var selIdx = typeof __selectIndex === "function" ? __selectIndex(node) : (node.selectedIndex | 0);
    var out = [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      out.push({
        index: i,
        value: o.value !== undefined && o.value !== null ? String(o.value) : "",
        label: (o.label || o.textContent || o.value || "").trim(),
        disabled: Boolean(o.disabled)
      });
    }
    return JSON.stringify({
      flid: flid,
      selectedIndex: selIdx,
      options: out
    });
  };
  g.__softnInspectSelect = __softnInspectSelect;

  __softnSetSelectIndex = function (flid, idx) {
    var node = __nodesById[flid];
    if (!node || String(node.tagName || "").toLowerCase() !== "select") return false;
    var opts = node.options || [];
    idx = idx | 0;
    if (idx < 0 || idx >= opts.length || opts[idx].disabled) return false;
    var prev = node.value !== undefined && node.value !== null ? String(node.value) : "";
    if (node._valueTracker && typeof node._valueTracker.setValue === "function") {
      try { node._valueTracker.setValue(prev); } catch (e) {}
    }
    for (var i = 0; i < opts.length; i++) {
      opts[i].selected = (i === idx);
    }
    var nextVal = opts[idx].value !== undefined && opts[idx].value !== null ? String(opts[idx].value) : "";
    node.value = nextVal;
    if (node.attributes) node.attributes.value = nextVal;
    if (typeof __domMutations === "number") __domMutations++;
    if (typeof node.dispatchEvent === "function") {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var cur = node;
      while (cur) {
        if (cur._id !== undefined) {
          __zippDispatchEvent(cur._id, flid, "input");
          __zippDispatchEvent(cur._id, flid, "change");
        }
        cur = cur.parentNode;
      }
    }
    return true;
  };
  g.__softnSetSelectIndex = __softnSetSelectIndex;

  __zippDispatchPointerEvent = function (targetFlid, type, clientX, clientY, button, buttons, pointerId) {
    var target = __nodesById[targetFlid];
    if (!target) return false;
    var defaultPrevented = false;
    var stopped = false;
    var ev = {
      type: String(type),
      target: target,
      srcElement: target,
      currentTarget: target,
      eventPhase: 2,
      bubbles: true,
      cancelable: true,
      isTrusted: true,
      timeStamp: Date.now ? Date.now() : 0,
      pointerId: pointerId || 1,
      pointerType: "touch",
      isPrimary: true,
      button: button | 0,
      buttons: buttons | 0,
      clientX: Number(clientX) || 0,
      clientY: Number(clientY) || 0,
      pageX: Number(clientX) || 0,
      pageY: Number(clientY) || 0,
      screenX: Number(clientX) || 0,
      screenY: Number(clientY) || 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      get defaultPrevented() { return defaultPrevented; },
      preventDefault: function () { defaultPrevented = true; },
      stopPropagation: function () { stopped = true; ev._stopped = true; },
      stopImmediatePropagation: function () { stopped = true; ev._stopped = true; },
      composedPath: function () {
        var path = [], n = target;
        while (n) { path.push(n); n = n.parentNode; }
        return path;
      }
    };
    ev.nativeEvent = ev;
    if (typeof target.dispatchEvent === "function") {
      target.dispatchEvent(ev);
    } else {
      var cur = target;
      while (cur && !stopped) {
        ev.currentTarget = cur;
        var byType = cur._id !== undefined ? __eventHandlers[cur._id] : null;
        var list = byType && byType[type];
        if (list) {
          for (var i = 0; i < list.length; i++) {
            try { list[i].call(cur, ev); }
            catch (e) { env.log("error", "pointer " + type + " threw: " + ((e && (e.stack || e.message)) || e)); }
            if (stopped) break;
          }
        }
        cur = cur.parentNode;
      }
    }
    return defaultPrevented;
  };
  g.__zippDispatchPointerEvent = __zippDispatchPointerEvent;

  // A tap as a phone's browser fires it: pointerdown, mousedown, pointerup, mouseup, click,
  // each bubbling from the tapped element through its ancestors to the body, the document
  // and the window (the shim's dispatchEvent), and stopping where a listener stops it. The
  // mouse events follow only a pointerdown nothing canceled, as compatibility mouse events
  // do. Taps used to fire a click alone, one handler list at a time, so stopPropagation()
  // stopped nothing and a document's `mousedown` (how menus close on an outside tap) never
  // came. True when the click's default was prevented.
  __softnDispatchTap = function (targetFlid, clientX, clientY) {
    var target = __nodesById[targetFlid];
    if (!target || typeof target.dispatchEvent !== "function") return false;
    var x = Number(clientX) || 0;
    var y = Number(clientY) || 0;
    var Pointer = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    function fire(Ctor, type, buttons, extra) {
      var init = {
        bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
        clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: buttons
      };
      if (extra) for (var k in extra) init[k] = extra[k];
      var ev = new Ctor(type, init);
      try { ev.isTrusted = true; ev.timeStamp = Date.now ? Date.now() : 0; ev.nativeEvent = ev; } catch (e) {}
      target.dispatchEvent(ev);
      return Boolean(ev.defaultPrevented);
    }
    var touch = { pointerId: 1, pointerType: "touch", isPrimary: true, width: 1, height: 1 };
    var canceled = fire(Pointer, "pointerdown", 1, Object.assign({ pressure: 0.5 }, touch));
    if (!canceled) fire(MouseEvent, "mousedown", 1);
    fire(Pointer, "pointerup", 0, touch);
    if (!canceled) fire(MouseEvent, "mouseup", 0);
    return fire(MouseEvent, "click", 0);
  };
  g.__softnDispatchTap = __softnDispatchTap;

  __softnSetInputValue = function (flid, newValue) {
    var node = __nodesById[flid];
    if (!node) return false;
    var prev = node.value !== undefined && node.value !== null ? String(node.value) : "";
    // Reset React 18's internal `_valueTracker` to previous value so React's delegated
    // `input` handler detects the state change and fires `onChange`.
    if (node._valueTracker && typeof node._valueTracker.setValue === "function") {
      try { node._valueTracker.setValue(prev); } catch (e) {}
    }
    node.value = String(newValue);
    if (node.attributes) node.attributes.value = String(newValue);
    if (typeof __domMutations === "number") __domMutations++;
    var cur = node;
    while (cur) {
      if (cur._id !== undefined) {
        __zippDispatchEvent(cur._id, flid, "input");
        __zippDispatchEvent(cur._id, flid, "change");
      }
      cur = cur.parentNode;
    }
    return true;
  };
  g.__softnSetInputValue = __softnSetInputValue;

  __softnToggleCheckbox = function (flid) {
    var node = __nodesById[flid];
    if (!node) return false;
    node.checked = !node.checked;
    if (node.attributes) {
      if (node.checked) node.attributes.checked = "checked";
      else delete node.attributes.checked;
    }
    if (typeof __domMutations === "number") __domMutations++;
    var cur = node;
    while (cur) {
      if (cur._id !== undefined) {
        __zippDispatchEvent(cur._id, flid, "change");
      }
      cur = cur.parentNode;
    }
    return true;
  };
  g.__softnToggleCheckbox = __softnToggleCheckbox;

  // A tapped radio, checked as a browser checks it before the click: on, and every other
  // radio of its name in the same form (or, outside any form, the document) off, with input
  // and change fired at it when that changed anything. A tap used to leave radios as they
  // were, so a choice could not be made and React's onChange (which reads the click) never ran.
  function __softnInputType(node) {
    return String((node.getAttribute && node.getAttribute("type")) || node.type || "text").toLowerCase();
  }
  function __softnFormOf(node) {
    for (var n = node.parentNode; n; n = n.parentNode) {
      if (String(n.tagName || "").toLowerCase() === "form") return n;
    }
    return null;
  }
  __softnCheckRadio = function (flid) {
    var node = __nodesById[flid];
    if (!node || node.checked || __softnInputType(node) !== "radio") return false;
    node.checked = true;
    if (node.attributes) node.attributes.checked = "checked";
    var name = (node.getAttribute && node.getAttribute("name")) || node.name || "";
    if (name) {
      var form = __softnFormOf(node);
      var stack = [form || doc];
      while (stack.length > 0) {
        var n = stack.pop();
        if (!n) continue;
        if (n !== node && n.checked && String(n.tagName || "").toLowerCase() === "input"
            && __softnInputType(n) === "radio"
            && ((n.getAttribute && n.getAttribute("name")) || n.name || "") === name
            && __softnFormOf(n) === form) {
          n.checked = false;
          if (n.attributes) delete n.attributes.checked;
        }
        var kids = n.childNodes || [];
        for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
      }
    }
    if (typeof __domMutations === "number") __domMutations++;
    if (typeof node.dispatchEvent === "function") {
      node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  };
  g.__softnCheckRadio = __softnCheckRadio;

  // The control a tap on a label's content activates, as a browser finds it: the element the
  // label's `for` names, else the first input, select or textarea inside it. -1 when the tap
  // is on a control, a button or a link (they take it themselves), when the control is
  // disabled, or when no label holds the tapped element. A label's text did nothing on a tap,
  // and SoftN's Checkbox, Radio and Switch put theirs beside an invisible input.
  __softnLabelControl = function (flid) {
    for (var n = __nodesById[flid]; n; n = n.parentNode) {
      var tag = String(n.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button" || tag === "a") return -1;
      if (tag !== "label") continue;
      var forId = n.getAttribute ? n.getAttribute("for") : null;
      var control = null;
      if (forId) {
        control = doc.getElementById ? doc.getElementById(forId) : null;
      } else {
        var stack = (n.childNodes || []).slice().reverse();
        while (stack.length > 0) {
          var c = stack.pop();
          var ct = String((c && c.tagName) || "").toLowerCase();
          if ((ct === "input" && __softnInputType(c) !== "hidden") || ct === "select" || ct === "textarea") {
            control = c;
            break;
          }
          var kids = (c && c.childNodes) || [];
          for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        }
      }
      var ctag = String((control && control.tagName) || "").toLowerCase();
      if (!control || control.disabled || control._id === undefined
          || (ctag !== "input" && ctag !== "select" && ctag !== "textarea")) return -1;
      return control._id;
    }
    return -1;
  };
  g.__softnLabelControl = __softnLabelControl;

  // The click a label's activation sends its control, bubbling from the control (the finger's
  // pointer and mouse events went to the label). True when its default was prevented.
  __softnDispatchClick = function (flid) {
    var target = __nodesById[flid];
    if (!target || typeof target.dispatchEvent !== "function") return false;
    var ev = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, detail: 1 });
    try { ev.isTrusted = true; ev.timeStamp = Date.now ? Date.now() : 0; ev.nativeEvent = ev; } catch (e) {}
    target.dispatchEvent(ev);
    return Boolean(ev.defaultPrevented);
  };
  g.__softnDispatchClick = __softnDispatchClick;

  __softnSubmitAncestorForm = function (flid) {
    var cur = __nodesById[flid];
    while (cur) {
      var tag = String(cur.tagName || "").toLowerCase();
      if (tag === "form") {
        var walk = cur;
        while (walk) {
          if (walk._id !== undefined) {
            __zippDispatchEvent(walk._id, cur._id, "submit");
          }
          walk = walk.parentNode;
        }
        return true;
      }
      cur = cur.parentNode;
    }
    return false;
  };
  g.__softnSubmitAncestorForm = __softnSubmitAncestorForm;

  // ── 8. Real HTML parser for `element.innerHTML` and initial `<body>` seed ──
  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }

  var VOID_TAGS = Object.assign(Object.create(null), { area:1, base:1, br:1, col:1, embed:1, hr:1, img:1, input:1, link:1, meta:1, param:1, source:1, track:1, wbr:1 });

  function pruneSubtreeIds(root) {
    if (!root || !root.childNodes || root.childNodes.length === 0) return;
    var stack = root.childNodes.slice();
    while (stack.length > 0) {
      var n = stack.pop();
      if (!n) continue;
      if (n._id !== undefined) {
        if (typeof __nodesById === "object" && __nodesById) delete __nodesById[n._id];
        if (typeof __eventHandlers === "object" && __eventHandlers) delete __eventHandlers[n._id];
      }
      if (n.childNodes && n.childNodes.length > 0) {
        for (var ci = 0; ci < n.childNodes.length; ci++) stack.push(n.childNodes[ci]);
      }
    }
  }

  function parseHtmlInto(parent, html) {
    pruneSubtreeIds(parent);
    parent.childNodes = [];
    if (typeof __domMutations === "number") __domMutations++;
    if (!html) return;
    var s = String(html);
    var stack = [parent];
    var i = 0;
    var len = s.length;

    while (i < len) {
      var lt = s.indexOf("<", i);
      if (lt < 0) {
        var tail = decodeEntities(s.slice(i));
        if (tail) stack[stack.length - 1].appendChild(new Text(tail));
        break;
      }
      if (lt > i) {
        var txt = decodeEntities(s.slice(i, lt));
        if (txt) stack[stack.length - 1].appendChild(new Text(txt));
      }
      // HTML comment
      if (s.slice(lt, lt + 4) === "<!--") {
        var endComment = s.indexOf("-->", lt + 4);
        i = endComment >= 0 ? endComment + 3 : len;
        continue;
      }
      var gt = s.indexOf(">", lt + 1);
      if (gt < 0) break;
      var inner = s.slice(lt + 1, gt).trim();
      i = gt + 1;
      if (!inner || inner.charAt(0) === "!") continue;

      // Closing tag
      if (inner.charAt(0) === "/") {
        var closeTag = inner.slice(1).trim().toLowerCase();
        for (var k = stack.length - 1; k >= 1; k--) {
          if (String(stack[k].tagName || "").toLowerCase() === closeTag) {
            stack.length = k;
            break;
          }
        }
        continue;
      }

      var selfClose = inner.charAt(inner.length - 1) === "/";
      if (selfClose) inner = inner.slice(0, inner.length - 1).trim();

      var spaceIdx = -1;
      for (var p = 0; p < inner.length; p++) {
        var ch = inner.charCodeAt(p);
        if (ch <= 32) { spaceIdx = p; break; }
      }
      var tagName = (spaceIdx >= 0 ? inner.slice(0, spaceIdx) : inner).toLowerCase();
      if (!tagName || !/^[a-z][a-z0-9:-]*$/.test(tagName)) continue;

      var el = doc.createElement(tagName);
      if (spaceIdx >= 0) {
        var attrStr = inner.slice(spaceIdx + 1);
        var ai = 0;
        var alen = attrStr.length;
        while (ai < alen) {
          while (ai < alen && attrStr.charCodeAt(ai) <= 32) ai++;
          if (ai >= alen) break;
          var ns = ai;
          while (ai < alen && attrStr.charCodeAt(ai) > 32 && attrStr.charAt(ai) !== "=") ai++;
          var aname = attrStr.slice(ns, ai).toLowerCase();
          if (!aname) break;
          while (ai < alen && attrStr.charCodeAt(ai) <= 32) ai++;
          var aval = "";
          if (ai < alen && attrStr.charAt(ai) === "=") {
            ai++;
            while (ai < alen && attrStr.charCodeAt(ai) <= 32) ai++;
            if (ai < alen && (attrStr.charAt(ai) === '"' || attrStr.charAt(ai) === "'")) {
              var q = attrStr.charAt(ai++);
              var vs = ai;
              var ve = attrStr.indexOf(q, ai);
              if (ve < 0) ve = alen;
              aval = decodeEntities(attrStr.slice(vs, ve));
              ai = ve + 1;
            } else {
              var vs2 = ai;
              while (ai < alen && attrStr.charCodeAt(ai) > 32) ai++;
              aval = decodeEntities(attrStr.slice(vs2, ai));
            }
          }
          if (!/^[a-z_][a-z0-9_.:-]*$/.test(aname)) continue;
          if (aname === "id") {
            el.id = aval;
            if (el.attributes) el.attributes.id = aval;
          } else if (aname === "class") {
            el.className = aval;
            if (el.attributes) el.attributes["class"] = aval;
          } else if (aname === "value") {
            el.value = aval;
            if (el.attributes) el.attributes.value = aval;
          } else if (aname === "checked") {
            el.checked = true;
            if (el.attributes) el.attributes.checked = aval || "checked";
          } else {
            el.setAttribute(aname, aval);
          }
        }
      }

      stack[stack.length - 1].appendChild(el);
      if (!selfClose && !VOID_TAGS[tagName]) {
        stack.push(el);
      }
    }
  }

  Object.defineProperty(DOMNode.prototype, "innerHTML", {
    configurable: true,
    get: function () {
      var kids = this.childNodes || [];
      var parts = new Array(kids.length);
      for (var i = 0; i < kids.length; i++) parts[i] = __serializeNode(kids[i]);
      return parts.join("");
    },
    set: function (v) {
      parseHtmlInto(this, v);
    }
  });

  // Seed initial `<html ...>` attributes (e.g. `data-theme="obsidian"`) on `doc.documentElement`
  try {
    var __seedHtmlAttrs = JSON.parse("__SOFTN_HTML_ATTRS_JSON__");
    if (__seedHtmlAttrs && typeof __seedHtmlAttrs === "object" && doc && doc.documentElement) {
      var hks = Object.keys(__seedHtmlAttrs);
      for (var hi = 0; hi < hks.length; hi++) {
        var hk = hks[hi];
        var hv = String(__seedHtmlAttrs[hk]);
        if (hk === "class") doc.documentElement.className = hv;
        else doc.documentElement.setAttribute(hk, hv);
      }
    }
  } catch (e) {}

  // Seed doc.body with the actual HTML body from the bundle's index.html
  var __seedBody = "__SOFTN_BODY_HTML__";
  if (__seedBody && __seedBody.trim()) {
    parseHtmlInto(doc.body, __seedBody);
  }
})();
