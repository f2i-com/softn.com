/**
 * The web's own APIs an app's script reaches for beyond the document, set up in the guest
 * after the document (core's shell), the container's extensions and the browser's globals.
 *
 * Each of these was simply not there, and an app that named one stopped where it did:
 *
 *   - `Blob`, `File` and `FileReader`: bytes with a type, kept in the guest. `Response.blob()`
 *     gave an object that was none of these.
 *   - `URL.createObjectURL()`: an address for a blob the app made, which the page can draw
 *     (an image, a video's poster, a stylesheet's `url()`) and the app can `fetch`. The bytes
 *     are handed to the host, which mints the address the page loads by the rule it has for
 *     the app's own files (an SVG is a `data:` address, HTML is plain text). A link to one
 *     goes nowhere: nothing here saves a file to the person's disk.
 *   - A request's body as the web has it: `FormData`, `URLSearchParams`, a blob or bytes
 *     (they were all sent as the text "{}"), `Request`, and a `signal` that ends the wait.
 *   - `XMLHttpRequest`, over the same `fetch` and so under the same grant.
 *   - `WebSocket`, opened by the Worker for the app under the rule `fetch` is held to: the
 *     network granted, and the host one the app declared (`wss:` as `https:`).
 *   - `MessageChannel`; `new Image()` and an image's `load`, `error`, `complete`,
 *     `naturalWidth` and `decode()`, for one on the page and for one that never is (a
 *     game's sprites, a preloader); `document.createRange()`; `customElements`, for elements
 *     that draw in the page's own tree (there is no shadow root here to attach).
 *
 * Everything is defined only where it is missing.
 */
export const GUEST_WEB_APIS_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var doc = g.document;
  var bridge = typeof host !== 'undefined' ? host : null;
  var push = typeof g.__softnPushExtraOp === 'function' ? g.__softnPushExtraOp : null;
  var ORIGIN = g.location && g.location.origin ? String(g.location.origin) : 'https://app.softn.local';

  function failure(message, name) {
    return typeof g.DOMException === 'function' ? new g.DOMException(message, name) : new Error(message);
  }
  function define(name, value) {
    if (typeof g[name] !== 'undefined') return false;
    try { g[name] = value; return true; } catch (e) { return false; }
  }
  function later(fn) { g.setTimeout(fn, 0); }

  // ---------------------------------------------------------------------------
  // 1. Bytes
  // ---------------------------------------------------------------------------
  function utf8(text) { return new g.TextEncoder().encode(String(text)); }
  function fromUtf8(bytes) { return new g.TextDecoder().decode(bytes); }
  function toBase64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return g.btoa(out);
  }
  function fromBase64(text) {
    var bin = g.atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesOf(part) {
    if (part instanceof Uint8Array) return part;
    if (part instanceof ArrayBuffer) return new Uint8Array(part);
    if (part && part.buffer instanceof ArrayBuffer && typeof part.byteLength === 'number') return new Uint8Array(part.buffer, part.byteOffset || 0, part.byteLength);
    if (part && part._softnBytes instanceof Uint8Array) return part._softnBytes;
    return utf8(part);
  }
  function concat(parts) {
    var list = [];
    var size = 0;
    for (var i = 0; i < parts.length; i++) { var bytes = bytesOf(parts[i]); list.push(bytes); size += bytes.length; }
    var out = new Uint8Array(size);
    var at = 0;
    for (var k = 0; k < list.length; k++) { out.set(list[k], at); at += list[k].length; }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 2. Blob, File, FileReader
  // ---------------------------------------------------------------------------
  function Blob(parts, options) {
    if (!(this instanceof Blob)) throw new TypeError("Failed to construct 'Blob': Please use the 'new' operator.");
    var bytes = concat(parts === undefined || parts === null ? [] : Array.prototype.slice.call(parts));
    var type = options && options.type !== undefined ? String(options.type) : '';
    Object.defineProperty(this, '_softnBytes', { value: bytes, enumerable: false });
    this.size = bytes.length;
    // As a browser keeps it: lower case, and nothing at all if it is not plain text.
    this.type = /^[\x20-\x7e]*$/.test(type) ? type.toLowerCase() : '';
  }
  Blob.prototype.slice = function (start, end, type) {
    var size = this.size;
    var from = start === undefined ? 0 : start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
    var to = end === undefined ? size : end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
    return new Blob([this._softnBytes.subarray(from, Math.max(from, to))], { type: type === undefined ? '' : type });
  };
  Blob.prototype.bytes = function () { return Promise.resolve(new Uint8Array(this._softnBytes)); };
  Blob.prototype.arrayBuffer = function () {
    var bytes = this._softnBytes;
    return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  Blob.prototype.text = function () { return Promise.resolve(fromUtf8(this._softnBytes)); };
  try { Object.defineProperty(Blob.prototype, Symbol.toStringTag, { configurable: true, get: function () { return this instanceof File ? 'File' : 'Blob'; } }); } catch (e) {}

  function File(parts, name, options) {
    if (!(this instanceof File)) throw new TypeError("Failed to construct 'File': Please use the 'new' operator.");
    if (arguments.length < 2) throw new TypeError("Failed to construct 'File': 2 arguments required.");
    Blob.call(this, parts, options);
    this.name = String(name);
    this.lastModified = options && typeof options.lastModified === 'number' ? options.lastModified : Date.now();
    this.webkitRelativePath = '';
  }
  File.prototype = Object.create(Blob.prototype);
  File.prototype.constructor = File;

  var hasBlob = typeof g.Blob === 'function';
  define('Blob', Blob);
  define('File', File);
  var BlobClass = g.Blob;
  function isBlob(value) { return !!value && value._softnBytes instanceof Uint8Array; }

  // What an object a listener can be put on, and a handler set on as a property, is made of.
  var Target = typeof g.EventTarget === 'function' ? g.EventTarget : null;
  function tell(target, type, fields, EventClass) {
    var Kind = EventClass || g.Event;
    var event = new Kind(type, fields || {});
    if (fields) for (var key in fields) { try { if (event[key] === undefined) event[key] = fields[key]; } catch (e) {} }
    try { target.dispatchEvent(event); } catch (e) { g.console.error(e); }
    var handler = target['on' + type];
    if (typeof handler === 'function') { try { handler.call(target, event); } catch (e) { g.console.error(e); } }
    return event;
  }

  if (Target && typeof g.FileReader === 'undefined') {
    var FileReader = class extends Target {
      constructor() { super(); this.readyState = 0; this.result = null; this.error = null; this._run = 0; }
      _read(blob, make) {
        if (!isBlob(blob)) throw new TypeError("Failed to execute 'read' on 'FileReader': parameter 1 is not of type 'Blob'.");
        if (this.readyState === 1) throw failure('The object is in an invalid state.', 'InvalidStateError');
        var self = this;
        var run = ++this._run;
        this.readyState = 1;
        this.result = null;
        this.error = null;
        later(function () {
          if (run !== self._run || self.readyState !== 1) return;
          var size = blob.size;
          tell(self, 'loadstart', { loaded: 0, total: size, lengthComputable: true }, g.ProgressEvent);
          try { self.result = make(blob._softnBytes); } catch (e) { self.error = e; }
          self.readyState = 2;
          tell(self, self.error ? 'error' : 'load', { loaded: size, total: size, lengthComputable: true }, g.ProgressEvent);
          tell(self, 'loadend', { loaded: size, total: size, lengthComputable: true }, g.ProgressEvent);
        });
      }
      readAsText(blob) { this._read(blob, fromUtf8); }
      readAsArrayBuffer(blob) { this._read(blob, function (bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }); }
      readAsDataURL(blob) { this._read(blob, function (bytes) { return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + toBase64(bytes); }); }
      readAsBinaryString(blob) {
        this._read(blob, function (bytes) { var out = ''; for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return out; });
      }
      abort() {
        if (this.readyState !== 1) return;
        this._run++;
        this.readyState = 2;
        this.result = null;
        tell(this, 'abort', {}, g.ProgressEvent);
        tell(this, 'loadend', {}, g.ProgressEvent);
      }
    };
    FileReader.EMPTY = 0; FileReader.LOADING = 1; FileReader.DONE = 2;
    FileReader.prototype.EMPTY = 0; FileReader.prototype.LOADING = 1; FileReader.prototype.DONE = 2;
    define('FileReader', FileReader);
  }

  // A form's data keeps a file as a file. The document's FormData holds text (it was written
  // for a form's fields), and a file appended to one became the words "[object File]". A
  // blob is kept beside it under a mark, and handed back wherever the data is read.
  var FormClass = g.FormData;
  if (typeof FormClass === 'function' && !FormClass.prototype._softnFiles) {
    var MARK = '\u0000softn-file:';
    var kept = Object.create(null);
    var keptSeq = 0;
    var keep = function (value, filename) {
      if (!isBlob(value)) return value;
      var file = value instanceof File && filename === undefined ? value : new File([value], filename === undefined ? (value.name === undefined ? 'blob' : value.name) : String(filename), { type: value.type });
      var mark = MARK + (++keptSeq);
      kept[mark] = file;
      return mark;
    };
    var back = function (value) { return typeof value === 'string' && value.indexOf(MARK) === 0 && kept[value] ? kept[value] : value; };
    var formProto = FormClass.prototype;
    var plain = { append: formProto.append, set: formProto.set, get: formProto.get, getAll: formProto.getAll, forEach: formProto.forEach, entries: formProto.entries, values: formProto.values };
    formProto._softnFiles = true;
    formProto.append = function (name, value, filename) { return plain.append.call(this, name, keep(value, filename)); };
    formProto.set = function (name, value, filename) { return plain.set.call(this, name, keep(value, filename)); };
    formProto.get = function (name) { return back(plain.get.call(this, name)); };
    formProto.getAll = function (name) { return plain.getAll.call(this, name).map(back); };
    formProto.forEach = function (fn, thisArg) {
      var self = this;
      return plain.forEach.call(this, function (value, name) { fn.call(thisArg, back(value), name, self); });
    };
    var pairs = function (form) { var list = []; plain.forEach.call(form, function (value, name) { list.push([name, back(value)]); }); return list; };
    formProto.entries = function () { return pairs(this)[Symbol.iterator](); };
    formProto.values = function () { return pairs(this).map(function (pair) { return pair[1]; })[Symbol.iterator](); };
    formProto[Symbol.iterator] = function () { return this.entries(); };
  }

  // ---------------------------------------------------------------------------
  // 3. An address for a blob
  // ---------------------------------------------------------------------------
  // The page draws from it and the app fetches it. The host is handed the bytes with the
  // address, at once: a turn that makes the address and sets it on an image tells both.
  var BLOB_PREFIX = 'blob:' + ORIGIN + '/';
  var MAX_BLOB_URL_BYTES = 32 * 1024 * 1024;
  var blobUrls = Object.create(null);
  var blobSeq = 0;
  function blobAt(address) {
    var text = String(address);
    return text.indexOf(BLOB_PREFIX) === 0 ? blobUrls[text.slice(BLOB_PREFIX.length)] || null : null;
  }
  var UrlClass = g.URL;
  if (!hasBlob && typeof UrlClass === 'function' && typeof UrlClass.createObjectURL !== 'function') {
    UrlClass.createObjectURL = function (blob) {
      if (!isBlob(blob)) throw new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.");
      var id = 'b' + (++blobSeq).toString(36) + '-' + Math.floor(Math.random() * 0x7fffffff).toString(36);
      blobUrls[id] = blob;
      if (push && blob.size <= MAX_BLOB_URL_BYTES) push(['blob', id, blob.type, toBase64(blob._softnBytes)]);
      return BLOB_PREFIX + id;
    };
    UrlClass.revokeObjectURL = function (address) {
      var text = String(address);
      if (text.indexOf(BLOB_PREFIX) !== 0) return;
      var id = text.slice(BLOB_PREFIX.length);
      if (!blobUrls[id]) return;
      delete blobUrls[id];
      if (push) push(['unblob', id]);
    };
  }

  // ---------------------------------------------------------------------------
  // 4. A request, and what it carries
  // ---------------------------------------------------------------------------
  // What a body is sent as, and the Content-Type that goes with it when the app named none.
  function encodeBody(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return { text: body, type: 'text/plain;charset=UTF-8' };
    if (isBlob(body)) return { bytes: body._softnBytes, type: body.type || null };
    if (body instanceof ArrayBuffer || (body.buffer instanceof ArrayBuffer && typeof body.byteLength === 'number')) return { bytes: bytesOf(body), type: null };
    if (typeof g.URLSearchParams === 'function' && body instanceof g.URLSearchParams) return { text: body.toString(), type: 'application/x-www-form-urlencoded;charset=UTF-8' };
    if (typeof g.FormData === 'function' && body instanceof g.FormData) {
      var boundary = '----SoftNFormBoundary' + Math.floor(Math.random() * 0x7fffffff).toString(36) + Date.now().toString(36);
      var parts = [];
      var quoted = function (text) { return String(text).replace(/\r?\n/g, '%0D%0A').replace(/"/g, '%22'); };
      body.forEach(function (value, name) {
        var head = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + quoted(name) + '"';
        if (isBlob(value)) {
          parts.push(head + '; filename="' + quoted(value.name === undefined ? 'blob' : value.name) + '"\r\nContent-Type: ' + (value.type || 'application/octet-stream') + '\r\n\r\n');
          parts.push(value._softnBytes);
          parts.push('\r\n');
        } else {
          parts.push(head + '\r\n\r\n' + String(value) + '\r\n');
        }
      });
      parts.push('--' + boundary + '--\r\n');
      return { bytes: concat(parts), type: 'multipart/form-data; boundary=' + boundary };
    }
    // Anything else was sent as its JSON, and still is: apps written for this depend on it.
    return { text: JSON.stringify(body), type: null };
  }
  g.__softnEncodeBody = function (body, headers) {
    var encoded = encodeBody(body);
    if (!encoded) return {};
    var named = false;
    for (var key in headers) if (key.toLowerCase() === 'content-type') named = true;
    if (!named && encoded.type) headers['content-type'] = encoded.type;
    return encoded.bytes ? { bodyBase64: toBase64(encoded.bytes) } : { body: encoded.text };
  };

  if (typeof g.Request === 'undefined' && typeof g.Headers === 'function') {
    var Request = function (input, init) {
      if (!(this instanceof Request)) throw new TypeError("Failed to construct 'Request': Please use the 'new' operator.");
      var from = input instanceof Request ? input : null;
      var options = init || {};
      var address = from ? from.url : String(input && input.href ? input.href : input);
      try { address = new g.URL(address, g.location ? g.location.href : ORIGIN + '/').href; } catch (e) {}
      this.url = address;
      this.method = String(options.method || (from && from.method) || 'GET').toUpperCase();
      this.headers = new g.Headers(options.headers || (from ? from.headers : undefined));
      this.signal = options.signal || (from && from.signal) || null;
      this.credentials = options.credentials || (from && from.credentials) || 'same-origin';
      this.mode = options.mode || (from && from.mode) || 'cors';
      this.cache = options.cache || (from && from.cache) || 'default';
      this.redirect = options.redirect || (from && from.redirect) || 'follow';
      this.referrer = 'about:client';
      this.bodyUsed = false;
      Object.defineProperty(this, '_softnBody', { value: options.body !== undefined ? options.body : from ? from._softnBody : null, enumerable: false });
    };
    Request.prototype.clone = function () { return new Request(this); };
    Request.prototype.text = function () {
      this.bodyUsed = true;
      var encoded = encodeBody(this._softnBody);
      return Promise.resolve(!encoded ? '' : encoded.bytes ? fromUtf8(encoded.bytes) : encoded.text);
    };
    Request.prototype.json = function () { return this.text().then(function (text) { return JSON.parse(text); }); };
    Request.prototype.arrayBuffer = function () {
      this.bodyUsed = true;
      var encoded = encodeBody(this._softnBody);
      var bytes = !encoded ? new Uint8Array(0) : encoded.bytes ? encoded.bytes : utf8(encoded.text);
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    };
    Request.prototype.blob = function () { return this.arrayBuffer().then(function (buffer) { return new BlobClass([buffer]); }); };
    define('Request', Request);
  }

  // fetch as the app calls it: a Request for an address, a blob's own address, a signal.
  var plainFetch = g.fetch;
  if (typeof plainFetch === 'function' && !plainFetch._softnWeb) {
    var webFetch = function (input, init) {
      var options = init;
      var address = input;
      if (typeof g.Request === 'function' && input instanceof g.Request) {
        address = input.url;
        options = Object.assign({ method: input.method, headers: input.headers, signal: input.signal }, init || {});
        if (options.body === undefined && input._softnBody !== null && input._softnBody !== undefined) options.body = input._softnBody;
      } else if (input && typeof input === 'object' && typeof input.href === 'string') {
        address = input.href;
      }
      var signal = options && options.signal;
      if (signal && signal.aborted) return Promise.reject(signal.reason !== undefined ? signal.reason : failure('The operation was aborted.', 'AbortError'));
      var blob = blobAt(address);
      var sent = blob
        ? Promise.resolve(new g.Response({ ok: true, status: 200, statusText: 'OK', headers: { 'content-type': blob.type || 'application/octet-stream', 'content-length': String(blob.size) }, base64: toBase64(blob._softnBytes) }, String(address)))
        : String(address).indexOf('blob:') === 0
          ? Promise.reject(new TypeError('Failed to fetch'))
          : plainFetch(address, options);
      if (!signal || typeof signal.addEventListener !== 'function') return sent;
      // The wait ends when the app says so; what was asked of the network is let finish.
      return new Promise(function (resolve, reject) {
        signal.addEventListener('abort', function () { reject(signal.reason !== undefined ? signal.reason : failure('The operation was aborted.', 'AbortError')); });
        sent.then(resolve, reject);
      });
    };
    webFetch._softnWeb = true;
    g.fetch = webFetch;
  }
  // A response's blob is a Blob.
  if (typeof g.Response === 'function' && g.Response.prototype && typeof g.Response.prototype.bytes === 'function') {
    g.Response.prototype.blob = function () {
      var type = (this.headers && this.headers.get('content-type')) || '';
      return this.bytes().then(function (bytes) { return new BlobClass([bytes], { type: type }); });
    };
    if (typeof g.Response.prototype.formData !== 'function' && typeof g.FormData === 'function') {
      g.Response.prototype.formData = function () {
        return this.text().then(function (text) {
          var form = new g.FormData();
          new g.URLSearchParams(text).forEach(function (value, name) { form.append(name, value); });
          return form;
        });
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 5. XMLHttpRequest, over fetch
  // ---------------------------------------------------------------------------
  if (Target && typeof g.XMLHttpRequest === 'undefined') {
    var XHR = class extends Target {
      constructor() {
        super();
        this.readyState = 0; this.status = 0; this.statusText = ''; this.responseURL = '';
        this.responseType = ''; this.response = ''; this.timeout = 0; this.withCredentials = false;
        this.upload = new Target();
        this._headers = {}; this._reply = null; this._run = 0; this._text = ''; this._mime = null;
      }
      get responseText() {
        if (this.responseType !== '' && this.responseType !== 'text') throw failure("The value is only accessible if the object's 'responseType' is '' or 'text'.", 'InvalidStateError');
        return this._text;
      }
      get responseXML() { return null; }
      _state(next) { this.readyState = next; tell(this, 'readystatechange', {}); }
      open(method, address, async) {
        if (async === false) throw failure('A request that holds the page until it is answered is not made here: call open() without false.', 'NotSupportedError');
        this._method = String(method).toUpperCase();
        try { this._url = new g.URL(String(address), g.location ? g.location.href : ORIGIN + '/').href; } catch (e) { throw failure("Failed to execute 'open' on 'XMLHttpRequest': Invalid URL", 'SyntaxError'); }
        this._headers = {}; this._reply = null; this._run++; this._text = '';
        this.status = 0; this.statusText = ''; this.response = this.responseType === '' || this.responseType === 'text' ? '' : null;
        this._state(1);
      }
      setRequestHeader(name, value) {
        if (this.readyState !== 1) throw failure("Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
        var key = String(name).toLowerCase();
        this._headers[key] = this._headers[key] === undefined ? String(value) : this._headers[key] + ', ' + String(value);
      }
      overrideMimeType(mime) { this._mime = String(mime); }
      getResponseHeader(name) { return this._reply ? this._reply.headers.get(String(name)) : null; }
      getAllResponseHeaders() {
        if (!this._reply) return '';
        var lines = [];
        this._reply.headers.forEach(function (value, key) { lines.push(key + ': ' + value); });
        return lines.length ? lines.join('\r\n') + '\r\n' : '';
      }
      send(body) {
        if (this.readyState !== 1) throw failure("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
        var self = this;
        var run = ++this._run;
        var done = false;
        var options = { method: this._method, headers: this._headers };
        if (body !== undefined && body !== null && this._method !== 'GET' && this._method !== 'HEAD') options.body = body;
        var finish = function (type) {
          if (done || run !== self._run) return;
          done = true;
          if (timer) g.clearTimeout(timer);
          if (type !== 'load') { self.status = 0; self.statusText = ''; self._text = ''; self.response = self.responseType === '' || self.responseType === 'text' ? '' : null; }
          self._state(4);
          var size = self._size || 0;
          tell(self, type, { loaded: type === 'load' ? size : 0, total: type === 'load' ? size : 0, lengthComputable: type === 'load' }, g.ProgressEvent);
          tell(self, 'loadend', { loaded: type === 'load' ? size : 0, total: type === 'load' ? size : 0, lengthComputable: type === 'load' }, g.ProgressEvent);
        };
        var timer = this.timeout > 0 ? g.setTimeout(function () { finish('timeout'); }, this.timeout) : 0;
        this._finish = finish;
        tell(this, 'loadstart', { loaded: 0, total: 0, lengthComputable: false }, g.ProgressEvent);
        g.fetch(this._url, options).then(function (reply) {
          if (done || run !== self._run) return;
          self._reply = reply;
          self.status = reply.status;
          self.statusText = reply.statusText || '';
          self.responseURL = reply.url || self._url;
          self._state(2);
          return reply.bytes().then(function (bytes) {
            if (done || run !== self._run) return;
            self._size = bytes.length;
            var kind = self.responseType;
            if (kind === '' || kind === 'text') { self._text = fromUtf8(bytes); self.response = self._text; }
            else if (kind === 'json') { try { self.response = JSON.parse(fromUtf8(bytes)); } catch (e) { self.response = null; } }
            else if (kind === 'arraybuffer') self.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            else if (kind === 'blob') self.response = new BlobClass([bytes], { type: self._mime || reply.headers.get('content-type') || '' });
            else self.response = null;
            self._state(3);
            tell(self, 'progress', { loaded: bytes.length, total: bytes.length, lengthComputable: true }, g.ProgressEvent);
            finish('load');
          });
        }).then(undefined, function () { finish('error'); });
      }
      abort() {
        var finish = this._finish;
        this._finish = null;
        if (finish && this.readyState > 0 && this.readyState < 4) finish('abort');
        this._run++;
        this.readyState = 0;
      }
    };
    ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (name, value) { XHR[name] = value; XHR.prototype[name] = value; });
    try { Object.defineProperty(XHR, 'name', { value: 'XMLHttpRequest', configurable: true }); } catch (e) {}
    define('XMLHttpRequest', XHR);
  }

  // ---------------------------------------------------------------------------
  // 6. WebSocket
  // ---------------------------------------------------------------------------
  // The Worker opens the socket and holds it. What arrives is asked for a batch at a time
  // (the bridge answers a call once), in the order it came.
  if (Target && bridge && typeof bridge.call === 'function' && typeof g.WebSocket === 'undefined') {
    var socketSeq = 0;
    var Socket = class extends Target {
      constructor(address, protocols) {
        super();
        var parsed;
        try { parsed = new g.URL(String(address), g.location ? g.location.href : ORIGIN + '/'); } catch (e) { throw failure("Failed to construct 'WebSocket': The URL '" + address + "' is invalid.", 'SyntaxError'); }
        var scheme = String(parsed.protocol);
        if (scheme === 'https:') scheme = 'wss:';
        if (scheme === 'http:') scheme = 'ws:';
        if (scheme !== 'ws:' && scheme !== 'wss:') throw failure("Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'.", 'SyntaxError');
        this.url = scheme + String(parsed.href).slice(String(parsed.protocol).length);
        this.readyState = 0;
        this.binaryType = 'blob';
        this.bufferedAmount = 0;
        this.protocol = '';
        this.extensions = '';
        var list = protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : Array.prototype.slice.call(protocols).map(String);
        var self = this;
        var id = String(++socketSeq);
        this._id = id;
        var closed = function (code, reason, clean) {
          if (self.readyState === 3) return;
          self.readyState = 3;
          tell(self, 'close', { code: code, reason: reason || '', wasClean: !!clean }, g.CloseEvent);
        };
        var heard = function (event) {
          if (event.t === 'open') {
            if (self.readyState !== 0) return;
            self.readyState = 1;
            self.protocol = event.protocol || '';
            self.extensions = event.extensions || '';
            tell(self, 'open', {});
          } else if (event.t === 'message') {
            if (self.readyState !== 1) return;
            var data = event.data;
            if (typeof event.base64 === 'string') {
              var bytes = fromBase64(event.base64);
              data = self.binaryType === 'arraybuffer' ? bytes.buffer : new BlobClass([bytes]);
            }
            tell(self, 'message', { data: data, origin: self.url.replace(/^(wss?:\/\/[^/]+).*$/, '$1') }, g.MessageEvent);
          } else if (event.t === 'error') {
            tell(self, 'error', {});
          } else if (event.t === 'close') {
            closed(event.code, event.reason, event.wasClean);
          }
        };
        var next = function () {
          bridge.call('ws.next', [id], function (reply) {
            var events = reply && reply.events ? reply.events : [];
            for (var i = 0; i < events.length; i++) heard(events[i]);
            if (!reply || reply.error) { closed(1006, '', false); return; }
            if (self.readyState !== 3) next();
          });
        };
        bridge.call('ws.open', [id, this.url, JSON.stringify(list)], function (reply) {
          if (!reply || reply.error) {
            g.console.error("WebSocket connection to '" + self.url + "' failed: " + (reply && reply.error ? reply.error : 'refused'));
            tell(self, 'error', {});
            closed(1006, '', false);
            return;
          }
          next();
        });
      }
      send(data) {
        if (this.readyState === 0) throw failure("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
        if (this.readyState !== 1) return;
        if (typeof data === 'string') bridge.call('ws.send', [this._id, 'text', data]);
        else bridge.call('ws.send', [this._id, 'base64', toBase64(bytesOf(data))]);
      }
      close(code, reason) {
        if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) throw failure("Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. " + code + ' is neither.', 'InvalidAccessError');
        if (this.readyState >= 2) return;
        this.readyState = 2;
        bridge.call('ws.close', [this._id, code === undefined ? '' : String(code), reason === undefined ? '' : String(reason)]);
      }
    };
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (name, value) { Socket[name] = value; Socket.prototype[name] = value; });
    try { Object.defineProperty(Socket, 'name', { value: 'WebSocket', configurable: true }); } catch (e) {}
    define('WebSocket', Socket);
  }

  // ---------------------------------------------------------------------------
  // 7. MessageChannel
  // ---------------------------------------------------------------------------
  if (Target && typeof g.MessageChannel === 'undefined') {
    var Port = class extends Target {
      constructor() { super(); this._other = null; this._open = true; this._started = false; this._held = []; this._onmessage = null; }
      get onmessage() { return this._onmessage; }
      // Setting the handler starts the port, as it does in a browser.
      set onmessage(handler) { this._onmessage = handler; this.start(); }
      postMessage(data) {
        var other = this._other;
        if (!this._open || !other || !other._open) return;
        var copy = typeof g.structuredClone === 'function' ? g.structuredClone(data) : data;
        later(function () {
          if (!other._open) return;
          if (!other._started) { other._held.push(copy); return; }
          other._deliver(copy);
        });
      }
      _deliver(data) {
        var event = new g.MessageEvent('message', { data: data });
        try { this.dispatchEvent(event); } catch (e) { g.console.error(e); }
        if (typeof this._onmessage === 'function') { try { this._onmessage.call(this, event); } catch (e) { g.console.error(e); } }
      }
      start() {
        if (this._started) return;
        this._started = true;
        var held = this._held.splice(0);
        var self = this;
        if (held.length) later(function () { for (var i = 0; i < held.length; i++) self._deliver(held[i]); });
      }
      close() { this._open = false; }
      addEventListener(type, listener, options) { super.addEventListener(type, listener, options); }
    };
    var Channel = function () {
      if (!(this instanceof Channel)) throw new TypeError("Failed to construct 'MessageChannel': Please use the 'new' operator.");
      this.port1 = new Port();
      this.port2 = new Port();
      this.port1._other = this.port2;
      this.port2._other = this.port1;
    };
    try { Object.defineProperty(Channel, 'name', { value: 'MessageChannel', configurable: true }); } catch (e) {}
    define('MessagePort', Port);
    define('MessageChannel', Channel);
  }

  // ---------------------------------------------------------------------------
  // 8. Images: when one has loaded, and how large it is
  // ---------------------------------------------------------------------------
  // The page loads an image, and says so with load or error. Neither bubbles, so neither
  // was heard: img.onload never ran, and complete was always true. An image that is never
  // put on the page (new Image(), a game's sprites, a preloader) had nothing to load it:
  // the host is asked to, and answers by the same two events.
  var ImageClass = g.HTMLImageElement;
  if (doc && typeof ImageClass === 'function' && typeof WeakMap === 'function') {
    var images = new WeakMap();
    var waiting = Object.create(null);
    var imageSeq = 0;
    var stateOf = function (img) {
      var state = images.get(img);
      if (!state) { state = { src: null, done: false, ok: false, width: 0, height: 0, told: false, decoders: [] }; images.set(img, state); }
      return state;
    };
    var settle = function (img, ok, width, height) {
      var state = stateOf(img);
      state.done = true; state.ok = ok; state.width = ok ? Number(width) || 0 : 0; state.height = ok ? Number(height) || 0 : 0;
      var decoders = state.decoders.splice(0);
      for (var i = 0; i < decoders.length; i++) { if (ok) decoders[i][0](); else decoders[i][1](failure('The source image cannot be decoded.', 'EncodingError')); }
    };
    var sourceChanged = function (img) {
      var src = img.getAttribute('src');
      var state = stateOf(img);
      if (state.src === src) return;
      state.src = src; state.done = false; state.ok = false; state.width = 0; state.height = 0; state.told = false;
      if (!src) { state.done = true; return; }
      // On the page, the page's own image loads it. Apart, the host is asked: at the end of
      // the turn, when it is known which images stayed apart (a framework makes every
      // image apart and puts it on the page a moment later).
      if (push && unplaced.indexOf(img) < 0) unplaced.push(img);
    };
    var unplaced = [];
    var askForUnplaced = function () {
      if (unplaced.length === 0) return;
      var list = unplaced;
      unplaced = [];
      for (var i = 0; i < list.length; i++) {
        var img = list[i];
        var state = stateOf(img);
        if (img.isConnected || state.done || !state.src) continue;
        var token = String(++imageSeq);
        waiting[token] = img;
        push(['img', token, state.src]);
      }
    };
    var takeChanges = g.__softnDocTake;
    if (typeof takeChanges === 'function' && push) g.__softnDocTake = function (failed) { askForUnplaced(); return takeChanges(failed); };
    // The page's own images: heard here first, as the event goes down to the image.
    var heardOnPage = function (event) {
      var img = event.target;
      if (!img || String(img.localName || '').toLowerCase() !== 'img' || !(img instanceof ImageClass)) return;
      var state = stateOf(img);
      var again = state.told && state.src === img.getAttribute('src');
      state.src = img.getAttribute('src');
      settle(img, event.type === 'load', event.naturalWidth, event.naturalHeight);
      // Already said, when the host loaded it apart: an image says load once for an address.
      if (again) { if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation(); else event.stopPropagation(); }
      state.told = true;
    };
    doc.addEventListener('load', heardOnPage, true);
    doc.addEventListener('error', heardOnPage, true);
    doc.addEventListener('softn:image', function (event) {
      var img = waiting[event.token];
      delete waiting[event.token];
      if (!img) return;
      var state = stateOf(img);
      if (state.src !== event.src) return;
      settle(img, !!event.ok, event.width, event.height);
      state.told = true;
      tell(img, event.ok ? 'load' : 'error', {});
    });
    var proto = ImageClass.prototype;
    var elementProto = g.Element && g.Element.prototype;
    var plainSet = elementProto && elementProto.setAttribute;
    var plainRemove = elementProto && elementProto.removeAttribute;
    if (typeof plainSet === 'function') {
      proto.setAttribute = function (name, value) {
        plainSet.call(this, name, value);
        if (String(name).toLowerCase() === 'src') sourceChanged(this);
      };
      proto.removeAttribute = function (name) {
        plainRemove.call(this, name);
        if (String(name).toLowerCase() === 'src') sourceChanged(this);
      };
    }
    var srcOf = Object.getOwnPropertyDescriptor(proto, 'src');
    if (srcOf && srcOf.set) {
      Object.defineProperty(proto, 'src', { configurable: true, get: srcOf.get, set: function (value) { srcOf.set.call(this, value); sourceChanged(this); } });
    }
    var sized = function (name, side) {
      var own = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, {
        configurable: true,
        // What its markup says, or the picture's own size once it is known.
        get: function () { var written = own && own.get ? own.get.call(this) : 0; return written || stateOf(this)[side]; },
        set: function (value) { this.setAttribute(name, String(Math.max(0, Number(value) || 0))); },
      });
    };
    sized('width', 'width');
    sized('height', 'height');
    Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: function () { return stateOf(this).width; } });
    Object.defineProperty(proto, 'naturalHeight', { configurable: true, get: function () { return stateOf(this).height; } });
    Object.defineProperty(proto, 'complete', {
      configurable: true,
      get: function () { var state = stateOf(this); return !this.getAttribute('src') || state.done; },
    });
    Object.defineProperty(proto, 'currentSrc', { configurable: true, get: function () { return this.src; } });
    proto.decode = function () {
      var img = this;
      var state = stateOf(img);
      if (!img.getAttribute('src')) return Promise.reject(failure('The source image cannot be decoded.', 'EncodingError'));
      if (state.done) return state.ok ? Promise.resolve() : Promise.reject(failure('The source image cannot be decoded.', 'EncodingError'));
      return new Promise(function (resolve, reject) { state.decoders.push([resolve, reject]); });
    };
    if (typeof g.Image === 'undefined') {
      var ImageMaker = function (width, height) {
        var img = doc.createElement('img');
        if (width !== undefined) img.setAttribute('width', String(width));
        if (height !== undefined) img.setAttribute('height', String(height));
        return img;
      };
      ImageMaker.prototype = proto;
      try { Object.defineProperty(ImageMaker, 'name', { value: 'Image', configurable: true }); } catch (e) {}
      define('Image', ImageMaker);
    }
  }

  // ---------------------------------------------------------------------------
  // 9. A range of the document
  // ---------------------------------------------------------------------------
  // Enough for code that marks a place in the page, parses markup through one
  // (createContextualFragment) or asks where one is. Nothing is selected by it: the
  // selection is the page's.
  if (doc && typeof doc.createRange !== 'function' && typeof g.Range === 'undefined') {
    var lengthOf = function (node) { return node.nodeType === 3 || node.nodeType === 8 ? String(node.nodeValue || '').length : node.childNodes ? node.childNodes.length : 0; };
    var indexOf = function (node) { var at = 0; for (var n = node.previousSibling; n; n = n.previousSibling) at++; return at; };
    var Range = function () {
      this.startContainer = doc; this.startOffset = 0; this.endContainer = doc; this.endOffset = 0;
    };
    Object.defineProperty(Range.prototype, 'collapsed', { configurable: true, get: function () { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; } });
    Object.defineProperty(Range.prototype, 'commonAncestorContainer', {
      configurable: true,
      get: function () {
        var chain = [];
        for (var a = this.startContainer; a; a = a.parentNode) chain.push(a);
        for (var b = this.endContainer; b; b = b.parentNode) if (chain.indexOf(b) >= 0) return b;
        return doc;
      },
    });
    Range.prototype.setStart = function (node, offset) { this.startContainer = node; this.startOffset = Number(offset) || 0; };
    Range.prototype.setEnd = function (node, offset) { this.endContainer = node; this.endOffset = Number(offset) || 0; };
    Range.prototype.setStartBefore = function (node) { this.setStart(node.parentNode, indexOf(node)); };
    Range.prototype.setStartAfter = function (node) { this.setStart(node.parentNode, indexOf(node) + 1); };
    Range.prototype.setEndBefore = function (node) { this.setEnd(node.parentNode, indexOf(node)); };
    Range.prototype.setEndAfter = function (node) { this.setEnd(node.parentNode, indexOf(node) + 1); };
    Range.prototype.selectNode = function (node) { this.setStartBefore(node); this.setEndAfter(node); };
    Range.prototype.selectNodeContents = function (node) { this.setStart(node, 0); this.setEnd(node, lengthOf(node)); };
    Range.prototype.collapse = function (toStart) {
      if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
      else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    };
    Range.prototype.cloneRange = function () {
      var copy = new Range();
      copy.setStart(this.startContainer, this.startOffset);
      copy.setEnd(this.endContainer, this.endOffset);
      return copy;
    };
    Range.prototype.detach = function () {};
    Range.prototype.createContextualFragment = function (markup) {
      var holder = doc.createElement('template');
      holder.innerHTML = String(markup);
      return holder.content;
    };
    Range.prototype.insertNode = function (node) {
      var at = this.startContainer;
      if (at.nodeType === 3) { var rest = at.splitText(this.startOffset); at.parentNode.insertBefore(node, rest); }
      else at.insertBefore(node, at.childNodes[this.startOffset] || null);
    };
    Range.prototype.deleteContents = function () {
      if (this.collapsed) return;
      if (this.startContainer === this.endContainer) {
        var at = this.startContainer;
        if (at.nodeType === 3 || at.nodeType === 8) at.nodeValue = String(at.nodeValue).slice(0, this.startOffset) + String(at.nodeValue).slice(this.endOffset);
        else { var gone = Array.prototype.slice.call(at.childNodes, this.startOffset, this.endOffset); for (var i = 0; i < gone.length; i++) at.removeChild(gone[i]); }
        this.collapse(true);
      }
    };
    Range.prototype.toString = function () {
      if (this.startContainer === this.endContainer) {
        var at = this.startContainer;
        if (at.nodeType === 3) return String(at.nodeValue).slice(this.startOffset, this.endOffset);
        return Array.prototype.slice.call(at.childNodes, this.startOffset, this.endOffset).map(function (node) { return node.textContent || ''; }).join('');
      }
      return String(this.commonAncestorContainer.textContent || '');
    };
    // Where it is: the box of what it is in, for want of the text's own.
    Range.prototype.getBoundingClientRect = function () {
      var at = this.commonAncestorContainer;
      while (at && at.nodeType !== 1) at = at.parentNode;
      return at && typeof at.getBoundingClientRect === 'function' ? at.getBoundingClientRect() : new g.DOMRect(0, 0, 0, 0);
    };
    Range.prototype.getClientRects = function () { var rect = this.getBoundingClientRect(); return rect.width || rect.height ? [rect] : []; };
    Range.START_TO_START = 0; Range.START_TO_END = 1; Range.END_TO_END = 2; Range.END_TO_START = 3;
    define('Range', Range);
    try { doc.constructor.prototype.createRange = function () { return new Range(); }; } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 9b. element.animate
  // ---------------------------------------------------------------------------
  // The page runs the animation (it draws it); the script holds what it would hold in a
  // browser: an Animation to wait on, end early or cancel. Svelte's transitions are made
  // this way, and stopped the app where one began.
  var AnimatedProto = g.Element && g.Element.prototype;
  if (doc && Target && push && AnimatedProto && typeof AnimatedProto.animate !== 'function') {
    var animations = Object.create(null);
    var animationSeq = 0;
    var clock = function () { return g.performance && typeof g.performance.now === 'function' ? g.performance.now() : Date.now(); };
    var Animation = class extends Target {
      constructor(target, frames, timing) {
        super();
        var self = this;
        this.id = typeof timing.id === 'string' ? timing.id : '';
        this.playState = 'running';
        this.pending = false;
        this.playbackRate = 1;
        this.startTime = clock() + (Number(timing.delay) || 0);
        this.timeline = null;
        this.onfinish = null; this.oncancel = null; this.onremove = null;
        this.effect = {
          target: target,
          getKeyframes: function () { return frames; },
          getTiming: function () { return timing; },
          getComputedTiming: function () { return Object.assign({ progress: null }, timing); },
          updateTiming: function () {},
        };
        this._key = String(++animationSeq);
        this._held = null;
        this._span = typeof timing.duration === 'number' ? timing.duration * (typeof timing.iterations === 'number' ? timing.iterations : 1) : 0;
        this.finished = new Promise(function (resolve, reject) { self._resolve = resolve; self._reject = reject; });
        // An animation that is cancelled is not an error nobody caught.
        this.finished.then(undefined, function () {});
        this.ready = Promise.resolve(this);
      }
      get currentTime() {
        if (this.playState === 'idle') return null;
        if (this.playState === 'paused') return this._held;
        if (this.playState === 'finished') return this._span;
        return Math.max(0, (clock() - this.startTime) * this.playbackRate);
      }
      set currentTime(value) { if (typeof value === 'number') this.startTime = clock() - value; }
      _ended() {
        if (this.playState === 'idle' || this.playState === 'finished') return;
        this.playState = 'finished';
        this._resolve(this);
        tell(this, 'finish', {});
      }
      cancel() {
        if (this.playState === 'idle') return;
        var running = this.playState !== 'finished';
        this.playState = 'idle';
        delete animations[this._key];
        push(['anim-ctl', this._key, 'cancel']);
        if (running) this._reject(failure('The user aborted a request.', 'AbortError'));
        tell(this, 'cancel', {});
      }
      finish() {
        if (this.playState === 'idle') return;
        push(['anim-ctl', this._key, 'finish']);
        this._ended();
      }
      pause() {
        if (this.playState !== 'running') return;
        this._held = this.currentTime;
        this.playState = 'paused';
        push(['anim-ctl', this._key, 'pause']);
      }
      play() {
        if (this.playState !== 'paused') return;
        this.startTime = clock() - (this._held || 0);
        this.playState = 'running';
        push(['anim-ctl', this._key, 'play']);
      }
      reverse() { this.playbackRate = -this.playbackRate; push(['anim-ctl', this._key, 'reverse']); }
      updatePlaybackRate(rate) { this.playbackRate = Number(rate) || 1; }
      commitStyles() {}
      persist() {}
    };
    try { Object.defineProperty(Animation, 'name', { value: 'Animation', configurable: true }); } catch (e) {}
    define('Animation', Animation);
    AnimatedProto.animate = function (keyframes, options) {
      var timing = typeof options === 'number' ? { duration: options } : Object.assign({}, options || {});
      // Forever cannot be carried as a number: said in words.
      if (timing.iterations === Infinity) timing.iterations = 'infinite';
      var frames;
      try { frames = JSON.parse(JSON.stringify(keyframes === undefined || keyframes === null ? [] : keyframes)); } catch (e) { frames = []; }
      var animation = new Animation(this, frames, timing);
      var id = this === doc.body ? 1 : this.__softnNode;
      if (typeof id === 'number' && id > 0 && this.isConnected !== false) {
        animations[animation._key] = animation;
        push(['anim', animation._key, id, frames, timing]);
      } else {
        // Not on the page: there is nothing to draw, and it ends.
        later(function () { animation._ended(); });
      }
      return animation;
    };
    AnimatedProto.getAnimations = function () {
      var el = this;
      return Object.keys(animations).map(function (key) { return animations[key]; }).filter(function (animation) { return animation.effect && animation.effect.target === el; });
    };
    doc.addEventListener('softn:animation', function (event) {
      var animation = animations[event.id];
      if (!animation) return;
      if (event.state === 'finished') animation._ended();
      else { delete animations[event.id]; animation.playState = 'idle'; }
    });
  }

  // ---------------------------------------------------------------------------
  // 10. customElements
  // ---------------------------------------------------------------------------
  // An element of the app's own making, by a name with a hyphen in it. It draws in the page's
  // own tree: there is no shadow root to attach here (attachShadow is not defined, so a
  // library that needs one says so instead of drawing nothing).
  var NativeHTML = g.HTMLElement;
  if (doc && typeof NativeHTML === 'function' && typeof g.customElements === 'undefined' && typeof Object.setPrototypeOf === 'function') {
    var definitions = Object.create(null);
    var byConstructor = typeof Map === 'function' ? new Map() : null;
    var waitingFor = Object.create(null);
    var upgrading = [];
    var made = typeof WeakSet === 'function' ? new WeakSet() : null;
    var joined = typeof WeakSet === 'function' ? new WeakSet() : null;
    var watching = false;

    // new HTMLElement() is what a custom element's constructor reaches through super(): it
    // is given the element that is being made into one.
    var plainCreate = doc.createElement;
    var Upgradable = function HTMLElement() {
      var el = upgrading.length ? upgrading[upgrading.length - 1] : null;
      var target = new.target;
      if (!target || target === Upgradable) throw new TypeError('Illegal constructor');
      if (el) upgrading[upgrading.length - 1] = null;
      else {
        // new MyElement(), by the script itself: an element by the name it was defined under.
        var tag = byConstructor ? byConstructor.get(target) : null;
        if (!tag) throw new TypeError('Illegal constructor');
        el = plainCreate.call(doc, tag);
        made.add(el);
      }
      Object.setPrototypeOf(el, target.prototype);
      return el;
    };
    Upgradable.prototype = NativeHTML.prototype;
    try { g.HTMLElement = Upgradable; } catch (e) {}

    var nameOf = function (el) { return el && el.nodeType === 1 ? String(el.localName || '').toLowerCase() : ''; };
    var guard = function (fn) { try { fn(); } catch (e) { g.console.error(e); } };
    var upgrade = function (el) {
      var definition = definitions[nameOf(el)];
      if (!definition || made.has(el)) return;
      made.add(el);
      upgrading.push(el);
      try { new definition.ctor(); } catch (e) { g.console.error(e); } finally { upgrading.pop(); }
      if (typeof el.attributeChangedCallback === 'function' && el.getAttributeNames) {
        var names = el.getAttributeNames();
        for (var i = 0; i < names.length; i++) {
          if (definition.observed.indexOf(names[i]) >= 0) (function (name) { guard(function () { el.attributeChangedCallback(name, null, el.getAttribute(name)); }); })(names[i]);
        }
      }
      if (el.isConnected) connect(el);
    };
    var connect = function (el) {
      if (!made.has(el) || joined.has(el)) return;
      joined.add(el);
      if (typeof el.connectedCallback === 'function') guard(function () { el.connectedCallback(); });
    };
    var disconnect = function (el) {
      if (!joined.has(el)) return;
      joined.delete(el);
      if (typeof el.disconnectedCallback === 'function') guard(function () { el.disconnectedCallback(); });
    };
    var each = function (root, fn) {
      if (!root || root.nodeType !== 1 && root.nodeType !== 11 && root.nodeType !== 9) return;
      if (root.nodeType === 1 && nameOf(root).indexOf('-') > 0) fn(root);
      if (typeof root.querySelectorAll !== 'function') return;
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) if (nameOf(all[i]).indexOf('-') > 0) fn(all[i]);
    };
    var watch = function () {
      if (watching || typeof g.MutationObserver !== 'function') return;
      watching = true;
      new g.MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var record = records[i];
          if (record.type === 'childList') {
            for (var a = 0; a < record.addedNodes.length; a++) each(record.addedNodes[a], function (el) { upgrade(el); if (el.isConnected) connect(el); });
            for (var r = 0; r < record.removedNodes.length; r++) each(record.removedNodes[r], function (el) { if (!el.isConnected) disconnect(el); });
          } else if (record.type === 'attributes') {
            changed(record.target, record.attributeName, record.oldValue);
          }
        }
      }).observe(doc, { childList: true, subtree: true, attributes: true, attributeOldValue: true });
      // An element that is not on the page is not watched: an attribute set on one is told
      // as it is set (a framework sets a new element's attributes before it places it).
      var elementProto = g.Element && g.Element.prototype;
      if (!elementProto) return;
      ['setAttribute', 'removeAttribute', 'toggleAttribute'].forEach(function (method) {
        var plainMethod = elementProto[method];
        if (typeof plainMethod !== 'function') return;
        elementProto[method] = function (name) {
          if (!made.has(this) || this.isConnected) return plainMethod.apply(this, arguments);
          var key = String(name).toLowerCase();
          var before = this.getAttribute(key);
          var result = plainMethod.apply(this, arguments);
          if (this.getAttribute(key) !== before) changed(this, key, before);
          return result;
        };
      });
    };
    var changed = function (el, name, before) {
      var definition = definitions[nameOf(el)];
      if (!definition || !made.has(el) || definition.observed.indexOf(name) < 0 || typeof el.attributeChangedCallback !== 'function') return;
      guard(function () { el.attributeChangedCallback(name, before, el.getAttribute(name)); });
    };

    var registry = {
      define: function (name, ctor) {
        var key = String(name);
        if (typeof ctor !== 'function') throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': parameter 2 is not of type 'Function'.");
        if (!/^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(key)) throw failure("Failed to execute 'define' on 'CustomElementRegistry': \"" + key + '" is not a valid custom element name', 'SyntaxError');
        // The softn- names are the runtime's own elements, drawn by the page.
        if (key.indexOf('softn-') === 0) throw failure("Failed to execute 'define' on 'CustomElementRegistry': the name \"" + key + '" is the runtime\'s', 'NotSupportedError');
        if (definitions[key]) throw failure("Failed to execute 'define' on 'CustomElementRegistry': the name \"" + key + '" has already been used with this registry', 'NotSupportedError');
        if (byConstructor && byConstructor.has(ctor)) throw failure("Failed to execute 'define' on 'CustomElementRegistry': this constructor has already been used with this registry", 'NotSupportedError');
        var observed = [];
        try { observed = Array.prototype.slice.call(ctor.observedAttributes || []).map(String); } catch (e) {}
        definitions[key] = { ctor: ctor, observed: observed };
        if (byConstructor) byConstructor.set(ctor, key);
        watch();
        each(doc, upgrade);
        var resolvers = waitingFor[key];
        delete waitingFor[key];
        if (resolvers) for (var i = 0; i < resolvers.length; i++) resolvers[i](ctor);
      },
      get: function (name) { var definition = definitions[String(name)]; return definition ? definition.ctor : undefined; },
      getName: function (ctor) { return byConstructor && byConstructor.has(ctor) ? byConstructor.get(ctor) : null; },
      whenDefined: function (name) {
        var key = String(name);
        if (definitions[key]) return Promise.resolve(definitions[key].ctor);
        return new Promise(function (resolve) { (waitingFor[key] || (waitingFor[key] = [])).push(resolve); });
      },
      upgrade: function (root) { each(root, upgrade); },
    };
    define('customElements', registry);

    // An element the script makes by a defined name is one at once, as in a browser.
    if (typeof plainCreate === 'function') {
      try {
        doc.constructor.prototype.createElement = function (name, options) {
          var el = plainCreate.call(this, name, options);
          if (definitions[String(name).toLowerCase()]) upgrade(el);
          return el;
        };
      } catch (e) {}
    }
  }
})();
`;
