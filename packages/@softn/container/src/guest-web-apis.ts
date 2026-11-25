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
 *   - `crypto.subtle`: each call done by the browser's own Web Crypto in the app's Worker,
 *     where the app's keys are kept.
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
  // 0. Code compiled while the app runs
  // ---------------------------------------------------------------------------
  // The engine compiles 64 KB of code at once while an app runs, and past that it stops the
  // app altogether. new Function is held to that here first, with an error the app can catch
  // (a library that compiles a template may fall back on one). eval is not held this way: a
  // direct eval reads the scope it is called in, which a function standing in for eval would
  // take from it.
  var NativeFunction = g.Function;
  var MAX_COMPILE_BYTES = 60000;
  if (typeof NativeFunction === 'function' && !NativeFunction._softnHeld) {
    // In UTF-8 bytes, counted only when the text is long enough for it to matter.
    var compiledSize = function (parts) {
      var texts = [];
      var units = 0;
      for (var i = 0; i < parts.length; i++) { texts.push(String(parts[i])); units += texts[i].length; }
      if (units * 3 <= MAX_COMPILE_BYTES) return units;
      var size = 0;
      for (var t = 0; t < texts.length; t++) {
        for (var k = 0; k < texts[t].length; k++) {
          var c = texts[t].charCodeAt(k);
          size += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        }
      }
      return size;
    };
    // Each kind of function a constructor makes from text: plain, async, generator, async generator.
    var hold = function (Native, word) {
      var Held = function Function() {
        if (compiledSize(arguments) > MAX_COMPILE_BYTES) {
          throw new RangeError('new ' + word + ' was given more code than an app compiles at once while it runs (64 KB).');
        }
        // A class that extends it gets an instance of itself, as from the engine's own.
        return typeof Reflect === 'object' && typeof Reflect.construct === 'function' ? Reflect.construct(Native, arguments, new.target || Native) : Native.apply(this, arguments);
      };
      Held.prototype = Native.prototype;
      try { Object.defineProperty(Held, 'name', { value: Native.name, configurable: true }); } catch (e) {}
      try { Object.defineProperty(Held, '_softnHeld', { value: true }); } catch (e) {}
      // A function's constructor is this one too: fn.constructor('...') goes through it.
      try { Object.defineProperty(Native.prototype, 'constructor', { value: Held, writable: true, configurable: true, enumerable: false }); } catch (e) {}
      return Held;
    };
    var HeldFunction = hold(NativeFunction, 'Function');
    try { g.Function = HeldFunction; } catch (e) {}
    // The others are reached only through a function's constructor: async function () {}.constructor.
    var kinds = [['async function () {}', 'AsyncFunction'], ['function* () {}', 'GeneratorFunction'], ['async function* () {}', 'AsyncGeneratorFunction']];
    for (var kind = 0; kind < kinds.length; kind++) {
      try {
        var sample = (0, eval)('(' + kinds[kind][0] + ')');
        var Native = Object.getPrototypeOf(sample).constructor;
        if (typeof Native === 'function' && Native !== NativeFunction && !Native._softnHeld) hold(Native, kinds[kind][1]);
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // 0b. Math.random
  // ---------------------------------------------------------------------------
  // The engine's gives the same numbers in every app, every time it starts: ids an app makes
  // with it are the same in two tabs (and on two people's machines), and every game deals the
  // same hand. Its crypto.getRandomValues is the machine's own randomness: a generator seeded
  // from it (sfc32) answers Math.random from here on.
  if (g.crypto && typeof g.crypto.getRandomValues === 'function' && typeof Math.random === 'function') {
    try {
      var seed = g.crypto.getRandomValues(new Uint32Array(4));
      var sa = seed[0] | 0, sb = seed[1] | 0, sc = seed[2] | 0, sd = seed[3] | 1;
      var nextRandom = function random() {
        var t = (sa + sb) | 0;
        sa = sb ^ (sb >>> 9);
        sb = (sc + (sc << 3)) | 0;
        sc = (sc << 21) | (sc >>> 11);
        sd = (sd + 1) | 0;
        t = (t + sd) | 0;
        sc = (sc + t) | 0;
        return (t >>> 0) / 4294967296;
      };
      for (var warm = 0; warm < 12; warm++) nextRandom();
      Math.random = nextRandom;
    } catch (e) {}
  }

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
    // Made by the Worker past a little (the layer before this one), a byte at a time here only below that.
    if (typeof g.__softnBytesFrom64 === 'function') return g.__softnBytesFrom64(text);
    var bin = g.atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Bytes that crossed to the app as text (a file the person picked) are kept as that text
  // and made bytes when something reads them. Making them is this engine's slowest work, a
  // byte at a time: all at once it took the whole of a turn for two megabytes, and more than
  // a turn has for anything larger, so a large file was never heard of at all. What only
  // passes the bytes on (an address for the file, a request that uploads it, a data: URL of
  // it) passes the text on and makes no bytes; what reads them reads them a part a turn.
  // (A turn's share: made by the Worker, 2.25 MB is a fraction of a turn; made here, 192 KB.)
  var DECODE_STEP = typeof g.__softnBytesFrom64 === 'function' ? 2250000 : 196608;
  var STREAM_PART = 196608;
  function decodeLater(text, size) {
    return new Promise(function (resolve, reject) {
      var out = new Uint8Array(size);
      var at = 0;
      var from = 0;
      var chars = DECODE_STEP / 3 * 4;
      var step = function () {
        try {
          var piece = fromBase64(text.slice(from, from + chars));
          if (at + piece.length > out.length) { var wider = new Uint8Array(at + piece.length); wider.set(out.subarray(0, at)); out = wider; }
          out.set(piece, at);
          at += piece.length;
          from += chars;
        } catch (e) { reject(e); return; }
        if (from >= text.length) resolve(at === out.length ? out : out.subarray(0, at));
        else g.setTimeout(step, 0);
      };
      step();
    });
  }
  // A blob made from a file still kept as text (a part of it, or a Blob or a File around it)
  // is kept as parts: bytes { u }, or bytes a to b of a text of base64 { t, a, b }. Made bytes
  // at once, a part of one megabyte or more took a turn, and five took more than a turn has.
  function decodedSize(text) {
    var pad = text.length > 0 && text.charAt(text.length - 1) === '=' ? (text.length > 1 && text.charAt(text.length - 2) === '=' ? 2 : 1) : 0;
    return Math.floor(text.length / 4) * 3 - pad;
  }
  function segmentSize(seg) { return seg.u ? seg.u.length : seg.b - seg.a; }
  // The parts a blob is still kept as, or null when it is bytes (or has been made bytes since).
  function lazySegments(blob) {
    if (!blob || blob._softnSegs === undefined) return null;
    var have = Object.getOwnPropertyDescriptor(blob, '_softnBytes');
    return have && have.value ? null : blob._softnSegs;
  }
  // The characters of base64 that hold bytes a to b, and how many bytes of them come before a.
  function covering(seg) {
    var first = Math.floor(seg.a / 3);
    return { text: seg.t.slice(first * 4, Math.ceil(seg.b / 3) * 4), skip: seg.a - first * 3 };
  }
  // A blob's parts made bytes at once: for what must have them now.
  function assembleNow(segs, size) {
    var out = new Uint8Array(size);
    var at = 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg.u) { out.set(seg.u, at); at += seg.u.length; continue; }
      var cover = covering(seg);
      out.set(fromBase64(cover.text).subarray(cover.skip, cover.skip + seg.b - seg.a), at);
      at += seg.b - seg.a;
    }
    return out;
  }
  function defineSegments(blob, segs) {
    var size = 0;
    for (var i = 0; i < segs.length; i++) size += segmentSize(segs[i]);
    Object.defineProperty(blob, '_softnSegs', { value: segs, enumerable: false });
    Object.defineProperty(blob, '_softnBytes', {
      configurable: true,
      enumerable: false,
      get: function () {
        var bytes = assembleNow(segs, size);
        Object.defineProperty(this, '_softnBytes', { value: bytes, enumerable: false, configurable: true });
        return bytes;
      },
    });
    // The whole of one text: what passes it on hands the text on, as for the file itself.
    if (segs.length === 1 && segs[0].t !== undefined && segs[0].a === 0 && segs[0].b === decodedSize(segs[0].t)) Object.defineProperty(blob, '_softnB64', { value: segs[0].t, enumerable: false });
    blob.size = size;
  }
  // Bytes a to b of a text of base64, written into out from the place given, a part a turn.
  function decodeRangeLater(text, a, b, out, into) {
    return new Promise(function (resolve, reject) {
      var pos = Math.floor(a / 3) * 3;
      var step = function () {
        try {
          var stop = Math.min(b, pos + DECODE_STEP);
          var piece = fromBase64(text.slice((pos / 3) * 4, Math.ceil(stop / 3) * 4));
          var from = Math.max(a, pos) - pos;
          var to = Math.min(b, pos + piece.length) - pos;
          if (to > from) out.set(piece.subarray(from, to), into + pos + from - a);
          pos += DECODE_STEP;
        } catch (e) { reject(e); return; }
        if (pos >= b) resolve();
        else g.setTimeout(step, 0);
      };
      step();
    });
  }
  // The text a blob's bytes are still kept as, or null when they are bytes.
  function textOf(blob) {
    if (!blob || blob._softnB64 === undefined) return null;
    var have = Object.getOwnPropertyDescriptor(blob, '_softnBytes');
    return have && have.value ? null : blob._softnB64;
  }
  // A blob's bytes as base64, without making bytes of text that is base64 already.
  function base64Of(blob) {
    var text = textOf(blob);
    return text === null ? toBase64(blob._softnBytes) : text;
  }
  // A blob as it is handed to the page or the Worker: the text it is still kept as, when it
  // is the whole of one; the parts of the texts it is made of, with which of their bytes to
  // keep (made bytes there, where that is quick); or its bytes.
  function piecesOf(blob) {
    var text = textOf(blob);
    if (text !== null) return text;
    var segs = lazySegments(blob);
    if (!segs) return toBase64(blob._softnBytes);
    var pieces = [];
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      if (seg.u) pieces.push({ base64: toBase64(seg.u) });
      else if (seg.a === 0 && seg.b === decodedSize(seg.t)) pieces.push({ base64: seg.t });
      else { var cover = covering(seg); pieces.push({ base64: cover.text, skip: cover.skip, take: seg.b - seg.a }); }
    }
    return pieces;
  }
  // A blob's bytes, later: at once when they are bytes, a part a turn when they are still text.
  function bytesLater(blob) {
    var text = textOf(blob);
    var segs = text === null ? lazySegments(blob) : null;
    if (text === null && !segs) return Promise.resolve(blob._softnBytes);
    if (!blob._softnDecoding) {
      var made;
      if (text !== null) {
        made = decodeLater(text, blob.size);
      } else {
        var out = new Uint8Array(blob.size);
        var chain = Promise.resolve();
        var at = 0;
        segs.forEach(function (seg) {
          var into = at;
          at += segmentSize(seg);
          if (seg.u) out.set(seg.u, into);
          else chain = chain.then(function () { return decodeRangeLater(seg.t, seg.a, seg.b, out, into); });
        });
        made = chain.then(function () { return out; });
      }
      Object.defineProperty(blob, '_softnDecoding', { enumerable: false, value: made.then(function (bytes) {
        Object.defineProperty(blob, '_softnBytes', { value: bytes, enumerable: false, configurable: true });
        return bytes;
      }) });
    }
    return blob._softnDecoding;
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
    var list = parts === undefined || parts === null ? [] : Array.prototype.slice.call(parts);
    var type = options && options.type !== undefined ? String(options.type) : '';
    var lazy = false;
    for (var i = 0; i < list.length && !lazy; i++) lazy = isBlob(list[i]) && !!lazySegments(list[i]);
    if (lazy) {
      // Around a file still kept as text: kept as its parts, made bytes when they are read.
      var segs = [];
      for (var k = 0; k < list.length; k++) {
        var part = list[k];
        var kept = isBlob(part) ? lazySegments(part) : null;
        if (kept) for (var s = 0; s < kept.length; s++) segs.push(kept[s]);
        // A copy: the app's array changed later is not the blob changed.
        else segs.push({ u: bytesOf(part).slice() });
      }
      defineSegments(this, segs);
    } else {
      var bytes = concat(list);
      Object.defineProperty(this, '_softnBytes', { value: bytes, enumerable: false });
      this.size = bytes.length;
    }
    // As a browser keeps it: lower case, and nothing at all if it is not plain text.
    this.type = /^[\x20-\x7e]*$/.test(type) ? type.toLowerCase() : '';
  }
  Blob.prototype.slice = function (start, end, type) {
    var size = this.size;
    var from = start === undefined ? 0 : start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
    var to = Math.max(from, end === undefined ? size : end < 0 ? Math.max(size + end, 0) : Math.min(end, size));
    var kind = type === undefined ? '' : String(type);
    var segs = lazySegments(this);
    if (!segs) return new Blob([this._softnBytes.subarray(from, to)], { type: kind });
    // A part of a file still kept as text is the same text from other places: nothing is made bytes.
    var cut = [];
    var at = 0;
    for (var i = 0; i < segs.length && at < to; i++) {
      var seg = segs[i];
      var length = segmentSize(seg);
      var lo = Math.max(from, at) - at;
      var hi = Math.min(to, at + length) - at;
      if (hi > lo) cut.push(seg.u ? { u: seg.u.subarray(lo, hi) } : { t: seg.t, a: seg.a + lo, b: seg.a + hi });
      at += length;
    }
    var blob = Object.create(Blob.prototype);
    defineSegments(blob, cut);
    blob.type = /^[\x20-\x7e]*$/.test(kind) ? kind.toLowerCase() : '';
    return blob;
  };
  Blob.prototype.bytes = function () { return bytesLater(this).then(function (bytes) { return new Uint8Array(bytes); }); };
  Blob.prototype.arrayBuffer = function () {
    return bytesLater(this).then(function (bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); });
  };
  Blob.prototype.text = function () { return bytesLater(this).then(fromUtf8); };
  // A blob read a part at a time, as a hash or an upload in parts reads a large file: a part
  // a turn, and the whole never held at once. (There was none: stream() was not a function.)
  Blob.prototype.stream = function () {
    var blob = this;
    var at = 0;
    var StreamClass = g.ReadableStream;
    if (typeof StreamClass !== 'function') throw new TypeError("Failed to execute 'stream' on 'Blob': streams are not available here.");
    return new StreamClass({
      pull: function (controller) {
        if (at >= blob.size) { controller.close(); return; }
        // In parts of the size a browser's stream gives (a hash's progress is told by them).
        var end = Math.min(blob.size, at + STREAM_PART);
        var part = blob.slice(at, end);
        at = end;
        return bytesLater(part).then(function (bytes) { controller.enqueue(new Uint8Array(bytes)); });
      },
    });
  };
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
  // A file whose bytes are the text they crossed to the app as, until something reads them.
  function fileKeptAsText(base64, size, name, type, lastModified) {
    var file = Object.create(File.prototype);
    defineSegments(file, [{ t: String(base64), a: 0, b: size }]);
    if (file._softnB64 === undefined) Object.defineProperty(file, '_softnB64', { value: String(base64), enumerable: false });
    file.type = /^[\x20-\x7e]*$/.test(String(type)) ? String(type).toLowerCase() : '';
    file.name = String(name);
    file.lastModified = typeof lastModified === 'number' ? lastModified : Date.now();
    file.webkitRelativePath = '';
    return file;
  }
  // A Blob (or a File, given a name) kept as the base64 it is held as elsewhere (IndexedDB),
  // until something reads it.
  g.__softnKeptAsText = function (base64, type, name, lastModified) {
    var text = String(base64);
    var size = decodedSize(text);
    if (name !== undefined && name !== null) return fileKeptAsText(text, size, name, type, lastModified);
    var blob = Object.create(Blob.prototype);
    defineSegments(blob, [{ t: text, a: 0, b: size }]);
    if (blob._softnB64 === undefined) Object.defineProperty(blob, '_softnB64', { value: text, enumerable: false });
    blob.type = /^[\x20-\x7e]*$/.test(String(type || '')) ? String(type || '').toLowerCase() : '';
    return blob;
  };
  // The same file under another name, without making its bytes.
  function renamed(blob, name) {
    var text = textOf(blob);
    return text === null ? new File([blob], name, { type: blob.type }) : fileKeptAsText(text, blob.size, name, blob.type, blob.lastModified);
  }

  var hasBlob = typeof g.Blob === 'function';
  define('Blob', Blob);
  define('File', File);
  var BlobClass = g.Blob;
  // Asked without making a blob's bytes (asking for them makes them, for one kept as parts).
  function isBlob(value) { return !!value && (value._softnB64 !== undefined || value._softnSegs !== undefined || value._softnBytes instanceof Uint8Array); }

  // What an object a listener can be put on, and a handler set on as a property, is made of.
  var Target = typeof g.EventTarget === 'function' ? g.EventTarget : null;
  function tell(target, type, fields, EventClass) {
    var Kind = EventClass || g.Event;
    var event = new Kind(type, fields || {});
    if (fields) for (var key in fields) { try { if (event[key] === undefined) event[key] = fields[key]; } catch (e) {} }
    try { target.dispatchEvent(event); } catch (e) { g.console.error(e); }
    // A handler set as a property is called here, except on a node of the document, whose own
    // dispatch calls it in its place among the listeners: an image on no page ran its onload
    // twice (a sprite drawn in it was drawn twice).
    var handler = typeof target.nodeType === 'number' ? null : target['on' + type];
    if (typeof handler === 'function') { try { handler.call(target, event); } catch (e) { g.console.error(e); } }
    return event;
  }

  if (Target && typeof g.FileReader === 'undefined') {
    var FileReader = class extends Target {
      constructor() { super(); this.readyState = 0; this.result = null; this.error = null; this._run = 0; }
      _read(blob, make, ofText) {
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
          var end = function () {
            if (run !== self._run || self.readyState !== 1) return;
            self.readyState = 2;
            tell(self, self.error ? 'error' : 'load', { loaded: size, total: size, lengthComputable: true }, g.ProgressEvent);
            tell(self, 'loadend', { loaded: size, total: size, lengthComputable: true }, g.ProgressEvent);
          };
          // What is wanted as base64 is base64 already where the bytes are still kept as text.
          var text = ofText ? textOf(blob) : null;
          if (text !== null) {
            try { self.result = ofText(text); } catch (e) { self.error = e; }
            end();
            return;
          }
          bytesLater(blob).then(function (bytes) {
            if (run !== self._run || self.readyState !== 1) return;
            try { self.result = make(bytes); } catch (e) { self.error = e; }
            end();
          }, function (e) { self.error = e; end(); });
        });
      }
      readAsText(blob) { this._read(blob, fromUtf8); }
      readAsArrayBuffer(blob) { this._read(blob, function (bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }); }
      readAsDataURL(blob) {
        var head = 'data:' + (blob && blob.type ? blob.type : 'application/octet-stream') + ';base64,';
        this._read(blob, function (bytes) { return head + toBase64(bytes); }, function (text) { return head + text; });
      }
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
    // Keep File/Blob values scoped to each FormData instance via WeakMap so GC collects
    // files once the FormData is discarded or entries are deleted/replaced.
    var keptPerForm = typeof WeakMap === 'function' ? new WeakMap() : null;
    var fallbackKept = Object.create(null);
    var keptSeq = 0;
    var storeOf = function (form) {
      if (!keptPerForm) return fallbackKept;
      var map = keptPerForm.get(form);
      if (!map) {
        map = Object.create(null);
        keptPerForm.set(form, map);
      }
      return map;
    };
    var keep = function (form, value, filename) {
      if (!isBlob(value)) return value;
      var file = value instanceof File && filename === undefined ? value : renamed(value, filename === undefined ? (value.name === undefined ? 'blob' : value.name) : String(filename));
      var mark = MARK + (++keptSeq);
      storeOf(form)[mark] = file;
      return mark;
    };
    var back = function (form, value) {
      if (typeof value !== 'string' || value.indexOf(MARK) !== 0) return value;
      var map = keptPerForm ? keptPerForm.get(form) : fallbackKept;
      return map && map[value] ? map[value] : value;
    };
    var dropMarks = function (form, name) {
      var map = keptPerForm ? keptPerForm.get(form) : fallbackKept;
      if (!map) return;
      var existing = plain.getAll.call(form, name);
      for (var i = 0; i < existing.length; i++) {
        if (typeof existing[i] === 'string' && existing[i].indexOf(MARK) === 0) delete map[existing[i]];
      }
    };
    var formProto = FormClass.prototype;
    var plain = { append: formProto.append, set: formProto.set, delete: formProto.delete, get: formProto.get, getAll: formProto.getAll, forEach: formProto.forEach, entries: formProto.entries, values: formProto.values };
    formProto._softnFiles = true;
    formProto.append = function (name, value, filename) { return plain.append.call(this, name, keep(this, value, filename)); };
    formProto.set = function (name, value, filename) { dropMarks(this, name); return plain.set.call(this, name, keep(this, value, filename)); };
    if (typeof plain.delete === 'function') {
      formProto.delete = function (name) { dropMarks(this, name); return plain.delete.call(this, name); };
    }
    formProto.get = function (name) { return back(this, plain.get.call(this, name)); };
    formProto.getAll = function (name) { var self = this; return plain.getAll.call(this, name).map(function (v) { return back(self, v); }); };
    formProto.forEach = function (fn, thisArg) {
      var self = this;
      return plain.forEach.call(this, function (value, name) { fn.call(thisArg, back(self, value), name, self); });
    };
    var pairs = function (form) { var list = []; plain.forEach.call(form, function (value, name) { list.push([name, back(form, value)]); }); return list; };
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
      // An app that makes an address for a blob may put it on a link to save it by.
      if (typeof g.__softnWatchSaves === 'function') g.__softnWatchSaves();
      if (push && blob.size <= MAX_BLOB_URL_BYTES) push(['blob', id, blob.type, piecesOf(blob)]);
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
  // 3b. Saving a file, and reading one the person picked
  // ---------------------------------------------------------------------------
  // A link with download on it, to a blob or to data written into the address, followed:
  // by the person's click, or by the script's own (a.click(), how an export button saves
  // what it made). The script only asks. The page it is drawn in names the app and the file
  // to the person and saves it if they say so, and not at all without a click of theirs just
  // before.
  var AnchorClass = g.HTMLAnchorElement;
  if (doc && push && typeof AnchorClass === 'function') {
    var saveSeq = 0;
    var askToSave = function (anchor) {
      if (!anchor || typeof anchor.hasAttribute !== 'function' || !anchor.hasAttribute('download')) return false;
      var address = String(anchor.getAttribute('href') || '');
      var name = String(anchor.getAttribute('download') || '');
      if (blobAt(address)) {
        push(['save', address.slice(BLOB_PREFIX.length), name]);
        return true;
      }
      var data = /^data:([^,;]*)((?:;[^,;]*)*),([\s\S]*)$/i.exec(address);
      if (!data) return false;
      var bytes;
      try { bytes = /;base64$/i.test(data[2]) ? fromBase64(data[3].replace(/\s+/g, '')) : utf8(decodeURIComponent(data[3])); } catch (e) { return false; }
      var id = 's' + (++saveSeq).toString(36) + '-' + Math.floor(Math.random() * 0x7fffffff).toString(36);
      push(['blob', id, data[1] || 'text/plain', toBase64(bytes)]);
      push(['save', id, name]);
      push(['unblob', id]);
      return true;
    };
    // The person's click on such a link, and the script's click on one that is on the page.
    var listening = false;
    var listenForSaves = function () {
      if (listening) return;
      listening = true;
      doc.addEventListener('click', function (event) {
        if (event.defaultPrevented || event._softnSaved) return;
        var at = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[download]') : null;
        if (at && askToSave(at)) event._softnSaved = true;
      });
    };
    // Listened for only by an app that has such a link: one that makes an address for a
    // blob, sets download on a link, or has one in its markup.
    g.__softnWatchSaves = listenForSaves;
    var anchorProto = AnchorClass.prototype;
    var anchorSet = g.Element && g.Element.prototype.setAttribute;
    if (typeof anchorSet === 'function') {
      anchorProto.setAttribute = function (name, value) {
        if (String(name).toLowerCase() === 'download') listenForSaves();
        return anchorSet.call(this, name, value);
      };
    }
    var downloadOf = Object.getOwnPropertyDescriptor(g.HTMLElement.prototype, 'download');
    if (downloadOf && downloadOf.set) {
      Object.defineProperty(anchorProto, 'download', { configurable: true, get: downloadOf.get, set: function (value) { listenForSaves(); downloadOf.set.call(this, value); } });
    }
    doc.addEventListener('DOMContentLoaded', function () { if (doc.querySelector('a[download]')) listenForSaves(); });
    // The script's click on a link that is on no page (made, clicked and dropped).
    var plainClick = anchorProto.click;
    if (typeof plainClick === 'function') {
      anchorProto.click = function () {
        var cancelled = false;
        var saved = false;
        var watch = function (event) { cancelled = !!event.defaultPrevented; saved = !!event._softnSaved; };
        // Heard last, on the link itself: by then every listener has had its say.
        this.addEventListener('click', watch);
        try { return plainClick.apply(this, arguments); } finally {
          this.removeEventListener('click', watch);
          if (!cancelled && !saved && !this.isConnected) askToSave(this);
        }
      };
    }
  }

  // A file the person picked in a file field. The page reads it for an app that was allowed
  // files (it declares "files", and the person said yes), and hands it over with the change.
  var InputClass = g.HTMLInputElement;
  if (doc && typeof InputClass === 'function' && typeof WeakMap === 'function') {
    // What was picked in each field, by the field's id as the page knows it: the field may
    // be anywhere, in a shadow tree as well as on the page. Kept as it came, and made files
    // when the app first asks for them.
    var given = new Map();
    var filesOf = function (field) {
      var entry = given.get(field.__softnNode);
      if (!entry) return null;
      if (!entry.list) {
        entry.list = listOf(entry.files.map(function (file) {
          var text = String(file.base64 || '');
          var size = typeof file.size === 'number' ? file.size : Math.floor(text.length / 4) * 3 - (text.slice(-2) === '==' ? 2 : text.slice(-1) === '=' ? 1 : 0);
          return fileKeptAsText(text, size, String(file.name || ''), String(file.type || ''), Number(file.lastModified) || 0);
        }));
        entry.files = [];
      }
      return entry.list;
    };
    var listOf = function (files) {
      var list = files.slice();
      Object.defineProperty(list, 'item', { value: function (i) { return this[i] || null; }, enumerable: false });
      Object.defineProperty(list, '_softnFileList', { value: true, enumerable: false });
      return list;
    };
    var empty = listOf([]);
    var warned = false;
    var plainSync = g.__softnDocSync;
    if (typeof plainSync === 'function') {
      g.__softnDocSync = function (changes) {
        for (var i = 0; i < changes.length; i++) {
          var change = changes[i];
          if (!change || change[0] !== 'F') continue;
          var told = change[2] || {};
          // The same choice, told with each event a field makes of it: kept from the first.
          if (told.again) continue;
          if (told.refused && !warned) {
            warned = true;
            g.console.warn('[SoftN] A file was picked, and this app has not been allowed to read files: declare "files" in permission.json. input.files is empty.');
          }
          var files = Array.isArray(told.files) ? told.files : [];
          // A field says both input and change of one choice: the same files, told twice, are kept once.
          var mark = JSON.stringify([files.map(function (file) { return [file.name, file.lastModified, String(file.base64 || '').length]; }), told.skipped || 0]);
          var before = given.get(change[1]);
          if (before && before.mark === mark) continue;
          if (told.skipped) g.console.warn('[SoftN] ' + told.skipped + ' of the files picked were left out: a file field hands an app 10 MB at a time here, and they were past it.');
          given.set(change[1], { mark: mark, files: files, list: null });
        }
        return plainSync(changes);
      };
    }
    if (!('files' in InputClass.prototype)) {
      Object.defineProperty(InputClass.prototype, 'files', {
        configurable: true,
        get: function () { return String(this.type || '').toLowerCase() === 'file' ? filesOf(this) || empty : null; },
      });
    }
    // Setting fileInput.value = '' clears its selected FileList (standard DOM reset pattern).
    var valOwner = InputClass.prototype;
    var valDesc = Object.getOwnPropertyDescriptor(valOwner, 'value') || (g.HTMLElement && Object.getOwnPropertyDescriptor(g.HTMLElement.prototype, 'value'));
    if (valDesc && typeof valDesc.set === 'function') {
      Object.defineProperty(InputClass.prototype, 'value', {
        configurable: true,
        enumerable: valDesc.enumerable !== false,
        get: valDesc.get,
        set: function (v) {
          if (String(this.type || '').toLowerCase() === 'file' && String(v == null ? '' : v) === '') {
            given.delete(this.__softnNode);
          }
          valDesc.set.call(this, v);
        },
      });
    }
    if (typeof g.FileList === 'undefined') {
      var FileListClass = function () { throw new TypeError('Illegal constructor'); };
      try { Object.defineProperty(FileListClass, Symbol.hasInstance, { value: function (value) { return !!value && value._softnFileList === true; } }); } catch (e) {}
      define('FileList', FileListClass);
    }
    // A form's data has the files of its file fields in it (forwarding optional submitter).
    var FormBase = g.FormData;
    if (typeof FormBase === 'function' && !FormBase._softnPicked) {
      var FormWithFiles = function (form, submitter) {
        var data = form === undefined ? new FormBase() : submitter === undefined ? new FormBase(form) : new FormBase(form, submitter);
        if (!form || typeof form.querySelectorAll !== 'function') return data;
        // What each enabled file field of the form holds, by the field's name.
        var held = Object.create(null);
        var any = false;
        var fileFields = form.querySelectorAll('input[name]');
        for (var i = 0; i < fileFields.length; i++) {
          if (String(fileFields[i].type || '').toLowerCase() !== 'file') continue;
          if (fileFields[i].disabled || (typeof fileFields[i].hasAttribute === 'function' && fileFields[i].hasAttribute('disabled'))) continue;
          var files = filesOf(fileFields[i]);
          var name = fileFields[i].getAttribute('name');
          var list = held[name] || (held[name] = []);
          if (!files || files.length === 0) list.push(new File([], '', { type: 'application/octet-stream' }));
          else for (var f = 0; f < files.length; f++) list.push(files[f]);
          any = true;
        }
        if (!any) return data;
        // In the form's own order: a file field's files where the field is among the others.
        var ordered = new FormBase();
        var put = Object.create(null);
        data.forEach(function (value, key) {
          if (!held[key]) { ordered.append(key, value); return; }
          if (put[key]) return;
          put[key] = true;
          for (var k = 0; k < held[key].length; k++) ordered.append(key, held[key][k]);
        });
        for (var left in held) if (!put[left]) for (var m = 0; m < held[left].length; m++) ordered.append(left, held[left][m]);
        return ordered;
      };
      FormWithFiles.prototype = FormBase.prototype;
      FormWithFiles._softnPicked = true;
      try { Object.defineProperty(FormWithFiles, 'name', { value: 'FormData', configurable: true }); } catch (e) {}
      try { g.FormData = FormWithFiles; } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // 4. A request, and what it carries
  // ---------------------------------------------------------------------------
  // What a body is sent as, and the Content-Type that goes with it when the app named none.
  function encodeBody(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return { text: body, type: 'text/plain;charset=UTF-8' };
    if (isBlob(body)) return { parts: [body], type: body.type || null };
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
          parts.push(value);
          parts.push('\r\n');
        } else {
          parts.push(head + '\r\n\r\n' + String(value) + '\r\n');
        }
      });
      parts.push('--' + boundary + '--\r\n');
      return { parts: parts, type: 'multipart/form-data; boundary=' + boundary };
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
    // A body with a file in it goes in its parts, the words as words and each file as
    // base64, and is put together by the Worker: a file still kept as text is never made
    // bytes here to be made text again.
    if (encoded.parts) {
      var sent = [];
      for (var i = 0; i < encoded.parts.length; i++) {
        var part = encoded.parts[i];
        if (typeof part === 'string') { sent.push({ text: part }); continue; }
        // A part of a file still kept as text: the characters that hold it, and which of
        // their bytes are its, which the Worker keeps.
        var pieces = piecesOf(part);
        if (typeof pieces === 'string') sent.push({ base64: pieces });
        else for (var s = 0; s < pieces.length; s++) sent.push(pieces[s]);
      }
      return { bodyParts: sent };
    }
    return encoded.bytes ? { bodyBase64: toBase64(encoded.bytes) } : { body: encoded.text };
  };
  // A body's bytes, for code that reads a request back: a file kept as text, a part a turn.
  function bodyBytesLater(encoded) {
    if (!encoded) return Promise.resolve(new Uint8Array(0));
    if (!encoded.parts) return Promise.resolve(encoded.bytes ? encoded.bytes : utf8(encoded.text));
    return Promise.all(encoded.parts.map(function (part) { return typeof part === 'string' ? utf8(part) : bytesLater(part); })).then(concat);
  }

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
      return !encoded ? Promise.resolve('') : encoded.text !== undefined ? Promise.resolve(encoded.text) : bodyBytesLater(encoded).then(fromUtf8);
    };
    Request.prototype.json = function () { return this.text().then(function (text) { return JSON.parse(text); }); };
    Request.prototype.arrayBuffer = function () {
      this.bodyUsed = true;
      return bodyBytesLater(encodeBody(this._softnBody)).then(function (bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); });
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
        ? Promise.resolve(new g.Response({ ok: true, status: 200, statusText: 'OK', headers: { 'content-type': blob.type || 'application/octet-stream', 'content-length': String(blob.size) }, base64: base64Of(blob) }, String(address)))
        : String(address).indexOf('blob:') === 0
          ? Promise.reject(new TypeError('Failed to fetch'))
          // The network is read as it arrives; a file of the app's own, where it is.
          : (typeof g.__softnReadNetwork === 'function' && g.__softnReadNetwork(address, options)) || plainFetch(address, options);
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
  // 4b. An answer read as it arrives
  // ---------------------------------------------------------------------------
  // A request to the network was answered whole: the app waited for the last byte before it
  // had the first, and response.body was not there at all. An answer that is written out a
  // piece at a time (a model's words as it makes them, a feed that stays open) is one the
  // app reads a piece at a time: the Worker reads the network and hands over what has come
  // each time the app asks, under the rule every request is held to.
  if (typeof g.ReadableStream === 'undefined') {
    var sizeOfPiece = function (piece) { return piece && typeof piece.length === 'number' ? piece.length : 1; };
    // The stream itself: what an underlying source enqueues, read by one reader.
    var Stream = function (source) {
      if (!(this instanceof Stream)) throw new TypeError("Failed to construct 'ReadableStream': Please use the 'new' operator.");
      var self = this;
      this.locked = false;
      this._queue = [];
      this._waiting = [];
      this._state = 'readable';
      this._error = undefined;
      this._source = source || {};
      this._pulling = false;
      // What is here unread, in bytes (or characters), and whether any of it was ever read.
      this._softnSize = 0;
      this._softnRead = false;
      this._softnOnTake = null;
      this._controller = {
        enqueue: function (chunk) {
          if (self._state !== 'readable') return;
          if (self._waiting.length) self._waiting.shift()[0]({ value: chunk, done: false });
          else { self._queue.push(chunk); self._softnSize += sizeOfPiece(chunk); }
        },
        close: function () {
          if (self._state !== 'readable') return;
          self._state = 'closed';
          while (self._waiting.length) self._waiting.shift()[0]({ value: undefined, done: true });
        },
        error: function (reason) {
          if (self._state !== 'readable') return;
          self._state = 'errored';
          self._error = reason;
          while (self._waiting.length) self._waiting.shift()[1](reason);
        },
        get desiredSize() { return 1 - self._queue.length; },
      };
      if (typeof this._source.start === 'function') { try { this._source.start(this._controller); } catch (e) { this._controller.error(e); } }
    };
    Stream.prototype._read = function () {
      var self = this;
      this._softnRead = true;
      if (this._queue.length) {
        var piece = this._queue.shift();
        this._softnSize -= sizeOfPiece(piece);
        if (typeof this._softnOnTake === 'function') this._softnOnTake();
        return Promise.resolve({ value: piece, done: false });
      }
      if (this._state === 'closed') return Promise.resolve({ value: undefined, done: true });
      if (this._state === 'errored') return Promise.reject(this._error);
      var answer = new Promise(function (resolve, reject) { self._waiting.push([resolve, reject]); });
      this._pull();
      return answer;
    };
    // Ask the source for more, one asking at a time, for as long as a reader is waiting.
    Stream.prototype._pull = function () {
      var self = this;
      if (this._pulling || typeof this._source.pull !== 'function' || this._state !== 'readable') return;
      this._pulling = true;
      Promise.resolve().then(function () { return self._source.pull(self._controller); }).then(function () {
        self._pulling = false;
        if (self._waiting.length) self._pull();
      }, function (e) { self._pulling = false; self._controller.error(e); });
    };
    Stream.prototype.cancel = function (reason) {
      if (this._state === 'readable') {
        this._state = 'closed';
        this._queue.length = 0;
        this._softnSize = 0;
        while (this._waiting.length) this._waiting.shift()[0]({ value: undefined, done: true });
        if (typeof this._source.cancel === 'function') { try { this._source.cancel(reason); } catch (e) {} }
      }
      return Promise.resolve();
    };
    Stream.prototype.getReader = function () {
      if (this.locked) throw new TypeError("Failed to execute 'getReader' on 'ReadableStream': ReadableStreamDefaultReader constructor can only accept readable streams that are not yet locked to a reader");
      var stream = this;
      var held = true;
      this.locked = true;
      return {
        read: function () { return held ? stream._read() : Promise.reject(new TypeError('This reader has let the stream go.')); },
        cancel: function (reason) { return stream.cancel(reason); },
        releaseLock: function () { held = false; stream.locked = false; },
        get closed() { return new Promise(function () {}); },
      };
    };
    // Through a decoder: bytes in, text out.
    Stream.prototype.pipeThrough = function (transform) {
      if (!transform || typeof transform._softnTransform !== 'function') throw new TypeError('Only a TextDecoderStream can be piped through here.');
      var reader = this.getReader();
      var change = transform._softnTransform();
      return new Stream({
        pull: function (controller) {
          return reader.read().then(function (step) {
            if (step.done) { var rest = change(null); if (rest) controller.enqueue(rest); controller.close(); return; }
            var text = change(step.value);
            if (text) controller.enqueue(text);
            else return this.pull(controller);
          }.bind(this));
        },
        cancel: function (reason) { return reader.cancel(reason); },
      });
    };
    Stream.prototype.tee = function () { throw failure('A stream is read once here: read it into what you need, or clone the response before it is read.', 'NotSupportedError'); };
    if (typeof Symbol === 'function' && Symbol.asyncIterator) {
      Stream.prototype[Symbol.asyncIterator] = function () {
        var reader = this.getReader();
        return {
          next: function () { return reader.read(); },
          return: function () { reader.cancel(); return Promise.resolve({ value: undefined, done: true }); },
        };
      };
    }
    try { Object.defineProperty(Stream, 'name', { value: 'ReadableStream', configurable: true }); } catch (e) {}
    define('ReadableStream', Stream);

    if (typeof g.TextDecoderStream === 'undefined') {
      // Text may be cut anywhere by the network, a character's bytes included: what is left
      // of one at the end of a piece is kept for the next.
      var DecoderStream = function () {};
      DecoderStream.prototype._softnTransform = function () {
        var kept = new Uint8Array(0);
        return function (chunk) {
          if (chunk === null) { var last = kept.length ? fromUtf8(kept) : ''; kept = new Uint8Array(0); return last; }
          var bytes = concat([kept, chunk]);
          var end = bytes.length;
          // Back over the bytes of a character that has not all arrived.
          for (var back = 1; back <= 3 && back <= end; back++) {
            var b = bytes[end - back];
            if ((b & 0xc0) === 0x80) continue;
            var need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
            if (need > back) end -= back;
            break;
          }
          kept = bytes.slice(end);
          return fromUtf8(bytes.subarray(0, end));
        };
      };
      try { Object.defineProperty(DecoderStream, 'name', { value: 'TextDecoderStream', configurable: true }); } catch (e) {}
      define('TextDecoderStream', DecoderStream);
    }
  }

  // An answer that is already whole (a file of the app's own, a blob) has a body to read too: in one piece.
  if (typeof g.Response === 'function' && g.Response.prototype && typeof g.ReadableStream === 'function' && !('body' in g.Response.prototype)) {
    Object.defineProperty(g.Response.prototype, 'body', {
      configurable: true,
      get: function () {
        var response = this;
        if (!this._softnWhole) {
          Object.defineProperty(this, '_softnWhole', {
            enumerable: false,
            value: new g.ReadableStream({
              pull: function (controller) {
                return response.bytes().then(function (bytes) { if (bytes.length) controller.enqueue(bytes); controller.close(); });
              },
            }),
          });
        }
        return this._softnWhole;
      },
    });
  }

  // A request to the network, answered as it arrives.
  var streamSeq = 0;
  // Twelve are asked of the network at once and not yet answered, and the rest in their
  // turn. A request that has its answer and is still being read (a feed, a long download)
  // is no longer one of the twelve: a page that listens to twelve feeds is not a page that
  // can ask for nothing else. Forty-eight are open at all; the Worker holds a limit of its
  // own above that one, which an app is never to meet.
  var MAX_UNANSWERED = 12;
  var MAX_OPEN_REQUESTS = 48;
  // A body of more characters than this goes to the Worker in pieces of these sizes (words
  // may come to six times their length written out, so their pieces are the smaller).
  var MAX_CALL_BODY_CHARS = 2400000;
  var BASE64_PIECE_CHARS = 2400000;
  var TEXT_PIECE_CHARS = 500000;
  var MAX_UNREAD_BYTES = 2 * 1024 * 1024;
  var unanswered = 0;
  var openRequests = 0;
  var inTurn = [];
  var takeTurns = function () { while (unanswered < MAX_UNANSWERED && openRequests < MAX_OPEN_REQUESTS && inTurn.length) inTurn.shift()(); };
  var readNetwork = function (address, init) {
    var options = init || {};
    var headers = {};
    if (options.headers) {
      var given = typeof g.Headers === 'function' && options.headers instanceof g.Headers ? options.headers : new g.Headers(options.headers);
      given.forEach(function (value, key) { headers[key] = value; });
    }
    var request = Object.assign({ method: options.method ? String(options.method).toUpperCase() : 'GET', headers: headers }, options.body === undefined || options.body === null ? {} : g.__softnEncodeBody(options.body, headers));
    // Whether the browser's own copy of an earlier answer will do: the app's to say.
    if (typeof options.cache === 'string') request.cache = options.cache;
    // A call to the Worker carries four million characters at most. A body past that (a
    // file uploaded, a picture posted) goes ahead of its request in pieces, each a call of
    // its own, and the request names them. It was refused whole: nothing over about three
    // megabytes could be sent anywhere.
    var pieces = null;
    var size = (request.body ? request.body.length : 0) + (request.bodyBase64 ? request.bodyBase64.length : 0);
    if (request.bodyParts) for (var p = 0; p < request.bodyParts.length; p++) size += String(request.bodyParts[p].base64 || request.bodyParts[p].text || '').length;
    if (size > MAX_CALL_BODY_CHARS) {
      pieces = [];
      var whole = request.bodyParts || [request.bodyBase64 !== undefined ? { base64: request.bodyBase64 } : { text: request.body }];
      for (var w = 0; w < whole.length; w++) {
        var isBytes = typeof whole[w].base64 === 'string';
        var all = String(isBytes ? whole[w].base64 : whole[w].text || '');
        // Base64 breaks cleanly every four characters; words are put together again before they are made bytes.
        var step = isBytes ? BASE64_PIECE_CHARS : TEXT_PIECE_CHARS;
        // A part of a file names the bytes it keeps of its characters: each piece names its own share.
        var skip = isBytes && typeof whole[w].skip === 'number' ? whole[w].skip : 0;
        var take = isBytes && typeof whole[w].take === 'number' ? whole[w].take : -1;
        var decoded = 0;
        for (var at = 0; at < all.length; at += step) {
          var chunk = all.slice(at, at + step);
          if (!isBytes) { pieces.push({ text: chunk }); continue; }
          if (take < 0) { pieces.push({ base64: chunk }); continue; }
          var length = decodedSize(chunk);
          var own = Math.max(0, skip - decoded);
          var keep = Math.min(decoded + length, skip + take) - (decoded + own);
          if (keep > 0) pieces.push({ base64: chunk, skip: own, take: keep });
          decoded += length;
        }
      }
      delete request.body;
      delete request.bodyBase64;
      delete request.bodyParts;
    }
    var signal = options.signal && typeof options.signal.addEventListener === 'function' ? options.signal : null;
    var id = String(++streamSeq);
    return new Promise(function (resolve, reject) {
      var head = null;      // the answer's first lines, once they have come
      var began = false;    // asked of the Worker, and one of those open
      var awaited = false;  // one of those not yet answered
      var over = false;     // nothing more will come
      var problem = null;   // how it failed, if it did
      var asking = false;   // the Worker has been asked for what comes next
      var branches = [];    // the answer's body, and one more for each copy made of it
      var whole = null;
      var finished = new Promise(function (done, fail) { whole = [done, fail]; });
      finished.then(undefined, function () {});
      var answered = function () { if (awaited) { awaited = false; unanswered--; } };
      var onAbortListener = null;
      // The end, however it came: once.
      var settle = function (error) {
        if (over) return;
        over = true;
        if (signal && onAbortListener && typeof signal.removeEventListener === 'function') {
          try { signal.removeEventListener('abort', onAbortListener); } catch (e) {}
          onAbortListener = null;
        }
        problem = error || null;
        for (var i = 0; i < branches.length; i++) {
          if (error) branches[i].controller.error(error);
          else branches[i].controller.close();
        }
        if (error) { if (!head) reject(error); whole[1](error); }
        else whole[0]();
        answered();
        if (began) { began = false; openRequests--; }
        takeTurns();
      };
      // Ended from this side (the app let it go, or its signal said stop): the Worker stops reading.
      var stop = function (error) {
        if (over) return;
        if (began) bridge.call('stream.close', [id]);
        settle(error);
      };
      // More is asked for while something is there to take it: code that asked for the
      // whole, a body nobody has begun to read piece by piece (all of it is taken, as it
      // always was), or a reader that keeps up. Behind a reader that has fallen behind, a
      // couple of megabytes wait here unread, the asking stops, and so does the Worker's
      // reading of the network.
      var wanted = function () {
        if (!head) return true;
        for (var i = 0; i < branches.length; i++) {
          var b = branches[i];
          if (b.gone) continue;
          if (b.whole || !(b.body.locked || b.body._softnRead)) return true;
          if (!(b.body._softnSize > MAX_UNREAD_BYTES)) return true;
        }
        return false;
      };
      var next = function () {
        if (over || asking || !began || !wanted()) return;
        asking = true;
        bridge.call('stream.next', [id], function (reply) {
          asking = false;
          var events = reply && reply.events ? reply.events : [];
          for (var i = 0; i < events.length; i++) heard(events[i]);
          if (!reply || reply.error) { settle(new TypeError(reply && reply.error ? String(reply.error) : 'Failed to fetch')); return; }
          next();
        });
      };
      var branch = function (kept) {
        var b = { parts: kept ? kept.slice() : [], controller: null, body: null, gone: false, whole: false };
        b.body = new g.ReadableStream({
          start: function (c) { b.controller = c; },
          cancel: function () {
            b.gone = true;
            b.parts.length = 0;
            // Let go by everything that was reading it: the network is let go too.
            for (var i = 0; i < branches.length; i++) if (!branches[i].gone) { next(); return; }
            stop(null);
          },
        });
        b.body._softnOnTake = next;
        for (var i = 0; i < b.parts.length; i++) b.controller.enqueue(b.parts[i]);
        if (over) { if (problem) b.controller.error(problem); else b.controller.close(); }
        branches.push(b);
        return b;
      };
      var respond = function (b) {
        var response = new g.Response({ ok: !!head.ok, status: head.status, statusText: head.statusText, headers: head.headers || {} }, String(address));
        var taken = false;
        var used = function () { return taken || !!b.body.locked || !!b.body._softnRead; };
        try { Object.defineProperty(response, 'bodyUsed', { configurable: true, enumerable: true, get: used, set: function (value) { taken = !!value; } }); } catch (e) {}
        // Whole, for code that asks for all of it.
        var all = function () {
          if (used()) return Promise.reject(new TypeError('The body of this response has already been read.'));
          taken = true;
          b.whole = true;
          next();
          return finished.then(function () { return concat(b.parts); });
        };
        Object.defineProperty(response, 'body', { configurable: true, get: function () { return b.body; } });
        response.bytes = all;
        response.text = function () { return all().then(fromUtf8); };
        // A copy to read apart from this one: given what has come, and each piece as it comes.
        response.clone = function () {
          if (used()) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used");
          return respond(branch(b.parts));
        };
        return response;
      };
      var heard = function (event) {
        if (over) return;
        if (event.t === 'head') {
          if (head) return;
          head = event;
          answered();
          takeTurns();
          resolve(respond(branch(null)));
        } else if (event.t === 'chunk') {
          var bytes = fromBase64(event.base64);
          for (var i = 0; i < branches.length; i++) {
            var b = branches[i];
            if (b.gone) continue;
            // Kept for text() and its like until a reader takes the stream; then the reader's alone.
            if (b.body.locked || b.body._softnRead) b.parts.length = 0;
            else b.parts.push(bytes);
            b.controller.enqueue(bytes);
          }
        } else if (event.t === 'end') {
          settle(null);
        } else if (event.t === 'error') {
          settle(new TypeError(event.message ? String(event.message) : 'Failed to fetch'));
        }
      };
      if (signal) {
        var stopped = function () { return signal.reason !== undefined ? signal.reason : failure('The operation was aborted.', 'AbortError'); };
        if (signal.aborted) { reject(stopped()); return; }
        onAbortListener = function () { stop(stopped()); };
        signal.addEventListener('abort', onAbortListener);
      }
      inTurn.push(function () {
        if (over) return;
        began = true;
        openRequests++;
        awaited = true;
        unanswered++;
        if (pieces) {
          request.bodyId = 'u' + id;
          for (var i = 0; i < pieces.length; i++) bridge.call('stream.body', [request.bodyId, JSON.stringify(pieces[i])]);
          pieces = null;
        }
        bridge.call('stream.open', [id, String(address), JSON.stringify(request)], function (reply) {
          if (over) return;
          if (!reply || reply.error) {
            // Refused, not failed: a site the app was not granted is refused again when asked again.
            var refused = new TypeError(reply && reply.error ? String(reply.error) : 'Network fetch denied or failed');
            if (reply && reply.denied) refused._softnRefused = true;
            settle(refused);
            return;
          }
          next();
        });
      });
      takeTurns();
    });
  };
  var streams = !!(bridge && typeof bridge.call === 'function' && typeof g.ReadableStream === 'function' && typeof g.Response === 'function');
  // Which addresses are the network's: not the app's own files, which are read where they are.
  var isNetwork = function (address, init) {
    var text = String(address);
    var method = init && init.method ? String(init.method).toUpperCase() : 'GET';
    if (text.indexOf('blob:') === 0 || text.indexOf('data:') === 0) return false;
    var own = method === 'GET' && (text.indexOf(ORIGIN + '/') === 0 || !/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(text));
    return !own;
  };
  g.__softnReadNetwork = streams ? function (address, init) { return isNetwork(address, init) ? readNetwork(address, init) : null; } : null;

  // EventSource: a feed the server keeps open, read a message at a time, and asked for again when it ends.
  if (Target && streams && typeof g.EventSource === 'undefined') {
    var Source = class extends Target {
      constructor(address, init) {
        super();
        try { this.url = new g.URL(String(address), g.location ? g.location.href : ORIGIN + '/').href; } catch (e) { throw failure("Failed to construct 'EventSource': Cannot open an EventSource to '" + address + "'. The URL is invalid.", 'SyntaxError'); }
        this.withCredentials = !!(init && init.withCredentials);
        this.readyState = 0;
        this._last = '';
        this._wait = 3000;
        this._reader = null;
        this._bare = false;
        this._open();
      }
      _open() {
        var self = this;
        if (this.readyState === 2) return;
        this.readyState = 0;
        // Asked for as a browser asks: with nothing a server on another site must first be
        // asked about. The place it left off is the exception (a browser's own EventSource
        // names it freely; a request made for an app cannot), so a server that will not hear
        // of it is asked again without it, and the feed goes on from now.
        var headers = { accept: 'text/event-stream' };
        var placed = !!this._last && !this._bare;
        if (placed) headers['last-event-id'] = this._last;
        var answered = false;
        // close() lets the request go wherever it has got to, answered yet or not.
        var stopper = typeof g.AbortController === 'function' ? new g.AbortController() : null;
        this._stop = stopper;
        readNetwork(this.url, { headers: headers, cache: 'no-store', signal: stopper ? stopper.signal : undefined }).then(function (response) {
          answered = true;
          if (self.readyState === 2) { response.body.cancel(); return; }
          if (!response.ok || String(response.headers.get('content-type') || '').toLowerCase().indexOf('text/event-stream') !== 0) {
            // Not a feed: said, and not asked for again.
            response.body.cancel();
            self.readyState = 2;
            tell(self, 'error', {});
            return;
          }
          self.readyState = 1;
          tell(self, 'open', {});
          var reader = response.body.pipeThrough(new g.TextDecoderStream()).getReader();
          self._reader = reader;
          var buffer = '';
          var data = [];
          var name = '';
          var line = function (text) {
            if (text === '') {
              // A blank line ends a message.
              if (data.length) tell(self, name || 'message', { data: data.join('\n'), lastEventId: self._last, origin: self.url.replace(/^([a-z]+:\/\/[^/]+).*$/i, '$1') }, g.MessageEvent);
              data = [];
              name = '';
              return;
            }
            if (text.charAt(0) === ':') return;
            var colon = text.indexOf(':');
            var field = colon < 0 ? text : text.slice(0, colon);
            var value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
            if (field === 'data') data.push(value);
            else if (field === 'event') name = value;
            else if (field === 'id') { if (value.indexOf('\u0000') < 0) self._last = value; }
            else if (field === 'retry' && /^\d+$/.test(value)) self._wait = Math.max(100, Number(value));
          };
          var read = function () {
            return reader.read().then(function (step) {
              if (self.readyState === 2) return;
              if (step.done) throw new Error('ended');
              buffer += step.value;
              var lines = buffer.split(/\r\n|\n|\r/);
              buffer = lines.pop();
              for (var i = 0; i < lines.length; i++) line(lines[i]);
              return read();
            });
          };
          return read();
        }).then(undefined, function (problem) {
          if (self.readyState === 2) return;
          // Refused (a site the app was not granted): said, and not asked for again.
          if (problem && problem._softnRefused) { self.readyState = 2; tell(self, 'error', {}); return; }
          // Never answered: with its place named, the next asking leaves it out, and the other way about.
          if (!answered && self._last) self._bare = placed;
          // The feed ended or failed: said, and asked for again after the wait the server gave.
          self.readyState = 0;
          tell(self, 'error', {});
          if (self.readyState !== 2) {
            self._retryTimer = g.setTimeout(function () {
              self._retryTimer = 0;
              if (self.readyState !== 2) self._open();
            }, self._wait);
          }
        });
      }
      close() {
        this.readyState = 2;
        if (this._retryTimer) { g.clearTimeout(this._retryTimer); this._retryTimer = 0; }
        if (this._reader) { try { this._reader.cancel(); } catch (e) {} this._reader = null; }
        if (this._stop) { try { this._stop.abort(); } catch (e) {} this._stop = null; }
      }
    };
    ['CONNECTING', 'OPEN', 'CLOSED'].forEach(function (name, value) { Source[name] = value; Source.prototype[name] = value; });
    try { Object.defineProperty(Source, 'name', { value: 'EventSource', configurable: true }); } catch (e) {}
    define('EventSource', Source);
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
        var controller = typeof g.AbortController === 'function' ? new g.AbortController() : null;
        var options = { method: this._method, headers: this._headers };
        if (controller) options.signal = controller.signal;
        if (body !== undefined && body !== null && this._method !== 'GET' && this._method !== 'HEAD') options.body = body;
        var finish = function (type) {
          if (done || run !== self._run) return;
          done = true;
          if (timer) g.clearTimeout(timer);
          if (type === 'abort' || type === 'timeout') {
            if (controller) { try { controller.abort(); } catch (e) {} }
          }
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
              data = self.binaryType === 'arraybuffer'
                ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
                : new BlobClass([bytes]);
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
        else if (isBlob(data)) {
          // A file kept as text goes as that text: made bytes here, it was made all at once.
          var pieces = piecesOf(data);
          bridge.call('ws.send', typeof pieces === 'string' ? [this._id, 'base64', pieces] : [this._id, 'pieces', JSON.stringify(pieces)]);
        } else bridge.call('ws.send', [this._id, 'base64', toBase64(bytesOf(data))]);
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
  // 7b. Worker: a script of the app's run apart, in an engine of its own
  // ---------------------------------------------------------------------------
  // There was none: a library that offloads work to a Worker (a PDF reader, an editor's
  // language service, Comlink, a bundler's ?worker import) stopped, or ran nothing. A Worker
  // of the app's runs in an engine of its own in the container's Worker, from one of the
  // app's script files or a blob of script the app made; messages are copied as structured
  // clone copies them. (Not a MessagePort sent along, nor a Worker inside a Worker.)
  if (bridge && typeof g.Worker === 'undefined' && !g.__softnWorkerSpec) {
    var appWorkers = Object.create(null);
    var appWorkerSeq = 0;
    var AppWorker = function Worker(url, options) {
      if (!(this instanceof AppWorker)) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length === 0) throw new TypeError("Failed to construct 'Worker': 1 argument required, but only 0 present.");
      var id = 'w' + (++appWorkerSeq);
      var address = String(url && typeof url === 'object' && typeof url.href === 'string' ? url.href : url);
      var made = { id: id, type: options && options.type === 'module' ? 'module' : 'classic', name: options && options.name !== undefined ? String(options.name) : '' };
      var blob = blobAt(address);
      if (blob) {
        // A blob of script the app made: its text goes with it.
        made.code = textOf(blob) !== null ? fromUtf8(fromBase64(textOf(blob))) : fromUtf8(blob._softnBytes);
        made.url = address;
      } else {
        try { made.url = new g.URL(address, g.location ? g.location.href : undefined).href; } catch (e) { throw failure("Failed to construct 'Worker': The URL '" + address + "' is invalid.", 'SyntaxError'); }
      }
      Object.defineProperty(this, '_id', { value: id });
      Object.defineProperty(this, '_listeners', { value: Object.create(null) });
      Object.defineProperty(this, '_over', { value: false, writable: true });
      this.onmessage = null;
      this.onmessageerror = null;
      this.onerror = null;
      appWorkers[id] = this;
      var worker = this;
      bridge.call('worker.start', [JSON.stringify(made)], function (answer) {
        if (answer && answer.error) told(worker, 'error', { message: String(answer.error) });
      });
    };
    AppWorker.prototype.postMessage = function (data) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'postMessage' on 'Worker': 1 argument required, but only 0 present.");
      if (this._over) return;
      var packed = g.__softnClone ? g.__softnClone.pack(data) : JSON.stringify(data);
      bridge.call('worker.post', [this._id, packed], function () {});
    };
    AppWorker.prototype.terminate = function () {
      if (this._over) return;
      this._over = true;
      delete appWorkers[this._id];
      bridge.call('worker.end', [this._id], function () {});
    };
    AppWorker.prototype.addEventListener = function (type, listener, options) {
      if (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function')) return;
      var list = this._listeners[type] || (this._listeners[type] = []);
      for (var i = 0; i < list.length; i++) if (list[i].fn === listener) return;
      list.push({ fn: listener, once: !!(options && typeof options === 'object' && options.once) });
    };
    AppWorker.prototype.removeEventListener = function (type, listener) {
      var list = this._listeners[type];
      if (!list) return;
      for (var i = 0; i < list.length; i++) if (list[i].fn === listener) { list.splice(i, 1); return; }
    };
    AppWorker.prototype.dispatchEvent = function (event) {
      var type = event && event.type;
      var handler = this['on' + type];
      if (typeof handler === 'function') { try { handler.call(this, event); } catch (e) { g.console.error(e); } }
      var list = (this._listeners[type] || []).slice();
      for (var i = 0; i < list.length; i++) {
        if (list[i].once) this.removeEventListener(type, list[i].fn);
        try { if (typeof list[i].fn === 'function') list[i].fn.call(this, event); else list[i].fn.handleEvent(event); } catch (e) { g.console.error(e); }
      }
      return !event.defaultPrevented;
    };
    var told = function (worker, type, fields) {
      var Kind = type === 'error' ? g.ErrorEvent : g.MessageEvent;
      var event = null;
      try { event = typeof Kind === 'function' ? new Kind(type, fields) : null; } catch (e) { event = null; }
      if (!event) event = { type: type, defaultPrevented: false, preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () {} };
      for (var key in fields) { try { if (event[key] !== fields[key]) Object.defineProperty(event, key, { value: fields[key], configurable: true }); } catch (e) {} }
      try { Object.defineProperty(event, 'target', { value: worker, configurable: true }); } catch (e) {}
      try { Object.defineProperty(event, 'currentTarget', { value: worker, configurable: true }); } catch (e) {}
      worker.dispatchEvent(event);
    };
    // From the Worker: a message, or an error of its.
    g.__softnWorkerFromWorker = function (id, packed) {
      var worker = appWorkers[id];
      if (!worker) return;
      var data;
      try { data = g.__softnClone ? g.__softnClone.unpack(packed) : JSON.parse(packed); } catch (e) { told(worker, 'messageerror', { data: null }); return; }
      told(worker, 'message', { data: data, ports: [] });
    };
    g.__softnWorkerFailedAt = function (id, message) {
      var worker = appWorkers[id];
      if (worker) told(worker, 'error', { message: String(message), filename: '', lineno: 0, colno: 0, error: null });
    };
    define('Worker', AppWorker);
  }

  // ---------------------------------------------------------------------------
  // 7c. Scripts: the page's own in its document, and those the app adds while it runs
  // ---------------------------------------------------------------------------
  // A <script> the app added to its page did nothing at all: its code never ran, and neither
  // load nor error came, so a webpack build waited for good for each part it loads that way,
  // a loader for each library it adds, and jQuery's DOMEval ran nothing. One the app makes now
  // runs when it joins the document, as in a browser: one of text at once, one by its address
  // when its code has come (in the order they were added, where its async was set false),
  // then load, or error when it could not be had. The page's own scripts are in its document
  // too, already run: document.currentScript is the one running (webpack finds where its parts
  // are from it), getElementsByTagName('script')[0] is there for a snippet that puts its own
  // script beside it, and one of another type (a template, JSON, a shader) holds its text.
  var scriptDocProto = doc ? Object.getPrototypeOf(doc) : null;
  var ScriptBase = g.HTMLElement && g.HTMLElement.prototype;
  if (doc && bridge && scriptDocProto && ScriptBase && typeof g.Node === 'function' && typeof doc.createElement === 'function' && !g.__softnWorkerSpec && typeof WeakMap === 'function') {
    var JS_TYPES = Object.create(null);
    ['', 'text/javascript', 'application/javascript', 'application/ecmascript', 'application/x-ecmascript', 'application/x-javascript',
      'text/ecmascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4',
      'text/javascript1.5', 'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript'].forEach(function (t) { JS_TYPES[t] = true; });
    // What a script is by its type, as a browser reads it: none for a type it does not run.
    var scriptKind = function (el) {
      var type = el.getAttribute('type');
      var language = el.getAttribute('language');
      var t = type !== null ? String(type) : language !== null && language !== '' ? 'text/' + language : '';
      t = t.split(';')[0].replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
      if (JS_TYPES[t]) return 'classic';
      return t === 'module' ? 'module' : null;
    };
    var runScriptText = g.eval;
    var scriptStates = new WeakMap();
    // App-made scripts not started yet: while there are none, an insertion is not looked through.
    var scriptsWaiting = 0;
    var currentScriptEl = null;
    var orderedScripts = [];
    var pageScripts = Object.create(null);
    var pageAddress = function () { return g.location && g.location.href ? String(g.location.href) : ORIGIN + '/'; };
    var absoluteAddress = function (value) {
      try { return new g.URL(String(value), pageAddress()).href; } catch (e) { return String(value); }
    };

    // A script's own properties, on a prototype of its own over HTMLElement's.
    var ScriptProto = Object.create(ScriptBase);
    var scriptAccessor = function (name, get, set) {
      Object.defineProperty(ScriptProto, name, { configurable: true, enumerable: true, get: get, set: set });
    };
    var scriptFlag = function (name, attr) {
      scriptAccessor(name, function () { return this.hasAttribute(attr); }, function (on) { if (on) this.setAttribute(attr, ''); else this.removeAttribute(attr); });
    };
    var scriptText = function (name, attr) {
      scriptAccessor(name, function () { var v = this.getAttribute(attr); return v === null ? '' : v; }, function (v) { this.setAttribute(attr, String(v)); });
    };
    scriptAccessor('src', function () { var v = this.getAttribute('src'); return v === null ? '' : absoluteAddress(v); }, function (v) { this.setAttribute('src', String(v)); });
    scriptAccessor('text', function () { return this.textContent; }, function (v) { this.textContent = v === null || v === undefined ? '' : String(v); });
    // async: true for one the app made, until it is set (as a browser's "force async").
    scriptAccessor('async', function () {
      var state = scriptStates.get(this);
      return !!(state && state.forceAsync) || this.hasAttribute('async');
    }, function (on) {
      var state = scriptStates.get(this);
      if (state) state.forceAsync = false;
      if (on) this.setAttribute('async', ''); else this.removeAttribute('async');
    });
    scriptFlag('defer', 'defer');
    scriptFlag('noModule', 'nomodule');
    scriptAccessor('crossOrigin', function () {
      var v = this.getAttribute('crossorigin');
      return v === null ? null : v.toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous';
    }, function (v) { if (v === null || v === undefined) this.removeAttribute('crossorigin'); else this.setAttribute('crossorigin', String(v)); });
    scriptText('charset', 'charset');
    scriptText('integrity', 'integrity');
    scriptText('event', 'event');
    scriptText('htmlFor', 'for');
    scriptText('referrerPolicy', 'referrerpolicy');
    var ScriptClass = g.HTMLScriptElement;
    if (typeof ScriptClass === 'function') {
      try { ScriptClass.prototype = ScriptProto; } catch (e) {}
      try { Object.defineProperty(ScriptProto, 'constructor', { value: ScriptClass, configurable: true, writable: true }); } catch (e) {}
      try { ScriptClass.supports = function (type) { return type === 'classic' || type === 'module'; }; } catch (e) {}
    }
    // One made and never put in the document (a test of what a script has) is counted out once
    // it is let go of: counted for good, every insertion after it was looked through.
    var unusedScripts = typeof g.FinalizationRegistry === 'function'
      ? new g.FinalizationRegistry(function (state) { if (!state.started) { state.started = true; scriptsWaiting--; } })
      : null;
    var asScript = function (el, byApp) {
      try { Object.setPrototypeOf(el, ScriptProto); } catch (e) {}
      if (byApp) {
        var made = { forceAsync: true, started: false };
        scriptStates.set(el, made);
        scriptsWaiting++;
        if (unusedScripts) unusedScripts.register(el, made);
      }
      return el;
    };
    // One that joined the document with no address and no text runs when it is given either, as in a browser.
    var plainSetAttribute = ScriptBase.setAttribute;
    if (typeof plainSetAttribute === 'function') {
      ScriptProto.setAttribute = function (name, value) {
        plainSetAttribute.call(this, name, value);
        if (scriptsWaiting > 0 && String(name).toLowerCase() === 'src' && scriptStates.has(this)) prepareScript(this);
      };
    }
    var nodeTextContent = Object.getOwnPropertyDescriptor(g.Node.prototype, 'textContent');
    if (nodeTextContent && nodeTextContent.get && nodeTextContent.set) {
      Object.defineProperty(ScriptProto, 'textContent', {
        configurable: true,
        enumerable: true,
        get: nodeTextContent.get,
        set: function (value) {
          nodeTextContent.set.call(this, value);
          if (scriptsWaiting > 0 && scriptStates.has(this)) prepareScript(this);
        },
      });
    }
    // On the document's prototype, where customElements (below) wraps it in turn: set on the
    // document itself, it hid theirs, and no element of the app's own was made.
    var makeElement = doc.createElement;
    scriptDocProto.createElement = function (name) {
      var el = makeElement.apply(this, arguments);
      if (el && el.nodeType === 1 && String(el.localName).toLowerCase() === 'script') asScript(el, true);
      return el;
    };
    var makeElementNS = doc.createElementNS;
    if (typeof makeElementNS === 'function') {
      scriptDocProto.createElementNS = function (ns, name) {
        var el = makeElementNS.apply(this, arguments);
        if (el && el.nodeType === 1 && ns === 'http://www.w3.org/1999/xhtml' && String(el.localName).toLowerCase() === 'script') asScript(el, true);
        return el;
      };
    }

    // Runtime exceptions from added scripts go through __softnReportError; resource-load
    // failures (404 / blocked net) log to console.error and dispatch the element's error event.
    var scriptFailed = function (e, isLoadFailure) {
      try {
        if (!isLoadFailure && typeof g.__softnReportError === 'function') {
          g.__softnReportError('script', e, 0);
        } else {
          g.console.error('[SoftN] A script the app added failed: ' + (e && e.stack ? e.stack : e && e.message ? e.message : String(e)));
        }
      } catch (ignored) {}
    };
    var tellScript = function (el, type) {
      try { el.dispatchEvent(new g.Event(type)); } catch (e) { scriptFailed(e); }
    };
    // Text made ready to run by the Worker: what it declares is the page's, its import() asks the
    // app's modules; refused, in words, past what the engine compiles at once while the app runs.
    var preparedScript = function (text, address) {
      try {
        var answer = bridge.callSync('script.prepare', String(text), String(address));
        return answer && typeof answer === 'object' ? answer : { error: 'The script could not be made ready to run.' };
      } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
      }
    };
    var runScript = function (el, code, fn) {
      var before = currentScriptEl;
      currentScriptEl = el;
      try {
        if (typeof fn === 'string') {
          var compiled = g[fn];
          if (typeof compiled !== 'function') throw new Error('The script ' + el.src + ' was not compiled with the app.');
          compiled.call(g);
        } else {
          (0, runScriptText)(code);
        }
      } catch (e) {
        scriptFailed(e);
      } finally {
        currentScriptEl = before;
      }
    };
    var finishScript = function (entry) {
      if (entry.error !== null) {
        if (entry.error) scriptFailed(entry.error, true);
        tellScript(entry.el, 'error');
        return;
      }
      runScript(entry.el, entry.code, entry.fn);
      tellScript(entry.el, 'load');
    };
    var dataUrlText = function (address) {
      var comma = address.indexOf(',');
      if (comma < 0) return null;
      var meta = address.slice(5, comma);
      var body = address.slice(comma + 1);
      return /;base64$/i.test(meta) ? fromUtf8(fromBase64(decodeURIComponent(body))) : decodeURIComponent(body);
    };
    var inlineModule = function (text) {
      var address = pageAddress();
      bridge.call('esm.inline', [String(text), address], function (reply) {
        if (!reply || reply.error) { scriptFailed(new TypeError(reply && reply.error ? String(reply.error) : 'The module script could not be compiled.')); return; }
        try {
          var blocks = reply.blocks || [];
          for (var i = 0; i < blocks.length; i++) (0, runScriptText)(String(blocks[i]));
        } catch (e) {
          try { bridge.call('esm.forget', [JSON.stringify(reply.urls || [])], function () {}); } catch (ignored) {}
          scriptFailed(e);
          return;
        }
        if (g.__softnModules) g.__softnModules.import(reply.url, address).then(undefined, scriptFailed);
      });
    };
    // A script the app made, scriptsJoining the document: run, or fetched and then run.
    var prepareScript = function (el) {
      var state = scriptStates.get(el);
      if (!state || state.started || !el.isConnected) return;
      var hasSrc = el.hasAttribute('src');
      var text = hasSrc ? '' : el.textContent;
      // One with no address and no text yet runs when it joins the document with some.
      if (!hasSrc && text === '') return;
      var kind = scriptKind(el);
      if (!kind) return;
      state.started = true;
      scriptsWaiting--;
      // A browser that runs modules runs no nomodule script.
      if (kind === 'classic' && el.hasAttribute('nomodule')) return;
      if (!hasSrc) {
        if (kind === 'module') { inlineModule(text); return; }
        var ready = preparedScript(text, pageAddress());
        if (ready.error) { scriptFailed(ready.error); return; }
        runScript(el, ready.code, ready.fn);
        return;
      }
      var raw = el.getAttribute('src');
      var address = raw === '' ? '' : absoluteAddress(raw);
      if (kind === 'module') {
        if (!address || !g.__softnModules) { later(function () { tellScript(el, 'error'); }); return; }
        g.__softnModules.import(address, pageAddress()).then(function () { tellScript(el, 'load'); }, function (e) { scriptFailed(e); tellScript(el, 'error'); });
        return;
      }
      var entry = { el: el, ready: false, code: null, fn: null, error: null, ordered: !state.forceAsync && !el.hasAttribute('async') };
      if (entry.ordered) orderedScripts.push(entry);
      var settle = function (answer) {
        if (!answer || typeof answer !== 'object' || typeof answer.error === 'string' || (typeof answer.code !== 'string' && typeof answer.fn !== 'string')) {
          entry.error = answer && typeof answer.error === 'string' ? answer.error : 'The script at ' + address + ' could not be loaded.';
        } else {
          entry.code = typeof answer.code === 'string' ? answer.code : null;
          entry.fn = typeof answer.fn === 'string' ? answer.fn : null;
        }
        entry.ready = true;
        if (!entry.ordered) { finishScript(entry); return; }
        while (orderedScripts.length && orderedScripts[0].ready) finishScript(orderedScripts.shift());
      };
      if (!address) { later(function () { settle({ error: '' }); }); return; }
      // A blob of script the app made, or a data: address: the text is here already.
      var blob = blobAt(address);
      if (blob || /^data:/i.test(address)) {
        var code = null;
        try { code = blob ? (textOf(blob) !== null ? fromUtf8(fromBase64(textOf(blob))) : fromUtf8(blob._softnBytes)) : dataUrlText(address); } catch (e) { code = null; }
        later(function () { settle(code === null ? { error: 'The script at ' + address + ' could not be read.' } : preparedScript(code, address)); });
        return;
      }
      try { bridge.call('script.load', [address], settle); } catch (e) { later(function () { settle({ error: e && e.message ? e.message : String(e) }); }); }
    };

    // Each way a node joins another: what scriptsJoined is looked through for scripts the app made.
    var scriptsJoining = function (list) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var node = list[i];
        if (!node || typeof node !== 'object' || typeof node.nodeType !== 'number') continue;
        if (node.nodeType === 11) { for (var c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c); }
        else if (node.nodeType === 1) out.push(node);
      }
      return out;
    };
    var scriptsJoined = function (nodes) {
      for (var i = 0; i < nodes.length && scriptsWaiting > 0; i++) {
        var node = nodes[i];
        if (!node.isConnected) continue;
        if (scriptStates.has(node)) prepareScript(node);
        if (node.firstElementChild && typeof node.querySelectorAll === 'function') {
          var inner = node.querySelectorAll('script');
          for (var k = 0; k < inner.length; k++) if (scriptStates.has(inner[k])) prepareScript(inner[k]);
        }
      }
    };
    var watchJoining = function (proto, name, pick) {
      if (!proto || !Object.prototype.hasOwnProperty.call(proto, name) || typeof proto[name] !== 'function') return;
      var plain = proto[name];
      proto[name] = function () {
        if (scriptsWaiting === 0) return plain.apply(this, arguments);
        var nodes = scriptsJoining(pick(arguments));
        var result = plain.apply(this, arguments);
        scriptsJoined(nodes);
        // Text put into one of them that is in the document already.
        if (scriptStates.has(this)) prepareScript(this);
        return result;
      };
    };
    var firstArgument = function (args) { return [args[0]]; };
    var everyArgument = function (args) { return Array.prototype.slice.call(args); };
    var plainInsertBefore = g.Node.prototype.insertBefore;
    watchJoining(g.Node.prototype, 'appendChild', firstArgument);
    watchJoining(g.Node.prototype, 'insertBefore', firstArgument);
    watchJoining(g.Node.prototype, 'replaceChild', firstArgument);
    var joinParents = [g.Element && g.Element.prototype, scriptDocProto, g.DocumentFragment && g.DocumentFragment.prototype];
    var joinChildren = [g.Element && g.Element.prototype, g.Text && g.Text.prototype, g.Comment && g.Comment.prototype];
    ['append', 'prepend', 'replaceChildren'].forEach(function (name) { joinParents.forEach(function (proto) { watchJoining(proto, name, everyArgument); }); });
    ['before', 'after', 'replaceWith'].forEach(function (name) { joinChildren.forEach(function (proto) { watchJoining(proto, name, everyArgument); }); });
    watchJoining(g.Element && g.Element.prototype, 'insertAdjacentElement', function (args) { return [args[1]]; });

    // The page's own scripts, in its document where they were (the Worker says where), already
    // run or never to be: each is document.currentScript while it runs.
    g.__softnPlaceScripts = function (list) {
      if (!Array.isArray(list)) return;
      var shell = typeof __softnShell !== 'undefined' ? __softnShell : null;
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item || typeof item !== 'object') continue;
        try {
          var el = asScript(makeElement.call(doc, 'script'), false);
          var attrs = Array.isArray(item.a) ? item.a : [];
          for (var k = 0; k < attrs.length; k++) if (Array.isArray(attrs[k])) el.setAttribute(String(attrs[k][0]), String(attrs[k][1]));
          if (typeof item.x === 'string' && item.x !== '') el.textContent = item.x;
          var parent = item.p === 'head' ? doc.head : item.p === 1 ? doc.body : shell && typeof shell.byId === 'function' ? shell.byId(item.p) : null;
          if (!parent || parent.nodeType !== 1) parent = item.p === 'head' ? doc.head : doc.body;
          var before = typeof item.b === 'number' && shell && typeof shell.byId === 'function' ? shell.byId(item.b) : null;
          if (before && before.parentNode !== parent) before = null;
          plainInsertBefore.call(parent, el, before);
          if (typeof item.r === 'number') pageScripts[item.r] = el;
        } catch (e) {}
      }
    };
    g.__softnScriptRunning = function (id) {
      currentScriptEl = id === null || id === undefined ? null : pageScripts[id] || null;
    };
    try { Object.defineProperty(scriptDocProto, 'currentScript', { configurable: true, get: function () { return currentScriptEl; } }); } catch (e) {}
    if (!('scripts' in doc)) {
      try { Object.defineProperty(scriptDocProto, 'scripts', { configurable: true, get: function () { return this.getElementsByTagName('script'); } }); } catch (e) {}
    }
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
      // Decoded for the Worker's copies of the app's canvases now, when the app reads them back.
      if (typeof g.__softnMirrorPicture === 'function') g.__softnMirrorPicture(img);
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
        // Put on the page in the turn its address was set (how React and Vue make an image):
        // named for the Worker's copies by its node too, so its load waits for its decoding.
        if (img.isConnected) {
          if (state.src && !state.done && typeof g.__softnMirrorPicture === 'function') g.__softnMirrorPicture(img);
          continue;
        }
        if (state.done || !state.src) continue;
        var token = String(++imageSeq);
        waiting[token] = img;
        push(['img', token, state.src, img.getAttribute('crossorigin') !== null ? 'anonymous' : '']);
      }
    };
    var takeChanges = g.__softnDocTake;
    if (typeof takeChanges === 'function' && push) g.__softnDocTake = function (failed) { askForUnplaced(); return takeChanges(failed); };
    // crossOrigin, as the attribute it is: an image asked for with CORS from a site that
    // allows it can be drawn into a canvas the app then reads back.
    if (!('crossOrigin' in ImageClass.prototype)) {
      try {
        Object.defineProperty(ImageClass.prototype, 'crossOrigin', {
          configurable: true,
          enumerable: true,
          get: function () {
            var given = this.getAttribute('crossorigin');
            return given === null ? null : String(given).toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous';
          },
          set: function (value) {
            if (value === null || value === undefined) this.removeAttribute('crossorigin');
            else this.setAttribute('crossorigin', String(value));
          },
        });
      } catch (e) {}
    }
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
  // 8b. A canvas's picture, as a file
  // ---------------------------------------------------------------------------
  // The picture is on the page, where the canvas is drawn: the page is asked for it, after
  // the turn's drawing, and answers with its bytes. (toDataURL answers at once, which a
  // picture a thread away cannot: it is still empty, and toBlob is the one to use.)
  var CanvasProto = g.HTMLElement && g.HTMLElement.prototype;
  if (doc && push && CanvasProto && typeof CanvasProto.toBlob !== 'function') {
    var pictures = Object.create(null);
    var pictureSeq = 0;
    var asked = [];
    CanvasProto.toBlob = function (callback, type, quality) {
      if (String(this.localName || '').toLowerCase() !== 'canvas') throw new TypeError("Failed to execute 'toBlob': this element is not a canvas.");
      if (typeof callback !== 'function') throw new TypeError("Failed to execute 'toBlob' on 'HTMLCanvasElement': parameter 1 is not of type 'Function'.");
      // On the page or on none: the page keeps a canvas for one the app draws on off it.
      var id = this.__softnNode;
      if (!(typeof id === 'number' && id > 0)) { later(function () { callback(null); }); return; }
      var token = String(++pictureSeq);
      pictures[token] = callback;
      asked.push(['canvas-blob', token, id, type === undefined ? 'image/png' : String(type), typeof quality === 'number' ? quality : -1]);
    };
    var takeDrawn = g.__softnDocTake;
    if (typeof takeDrawn === 'function') {
      g.__softnDocTake = function (failed) {
        var out = takeDrawn(failed);
        if (asked.length === 0) return out;
        var asks = asked.splice(0);
        return out ? out.concat(asks) : asks;
      };
    }
    doc.addEventListener('softn:canvas', function (event) {
      var callback = pictures[event.token];
      delete pictures[event.token];
      if (!callback) return;
      try { callback(typeof event.base64 === 'string' ? new BlobClass([fromBase64(event.base64)], { type: event.kind || 'image/png' }) : null); } catch (e) { g.console.error(e); }
    });
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
  // 9a. Walking the tree, and a document read from text
  // ---------------------------------------------------------------------------
  // createTreeWalker and createNodeIterator (a template library finds its marks with one),
  // DOMParser and document.implementation (a sanitiser reads markup into a document of its
  // own, a feed reader reads XML), XMLSerializer. A document read from text is the tree it
  // was read into, apart from the page: nothing in it is drawn until the app puts it there.
  if (doc && typeof g.NodeFilter === 'undefined') {
    var NodeFilter = {
      FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3, SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_ATTRIBUTE: 2, SHOW_TEXT: 4,
      SHOW_CDATA_SECTION: 8, SHOW_ENTITY_REFERENCE: 16, SHOW_ENTITY: 32, SHOW_PROCESSING_INSTRUCTION: 64, SHOW_COMMENT: 128,
      SHOW_DOCUMENT: 256, SHOW_DOCUMENT_TYPE: 512, SHOW_DOCUMENT_FRAGMENT: 1024, SHOW_NOTATION: 2048,
    };
    define('NodeFilter', NodeFilter);
    var verdict = function (walker, node) {
      if (!((walker.whatToShow >>> 0) & (1 << (node.nodeType - 1)))) return 3;
      var filter = walker.filter;
      if (!filter) return 1;
      return Number(typeof filter === 'function' ? filter(node) : filter.acceptNode(node)) || 3;
    };
    var Walker = function (root, show, filter) {
      this.root = root;
      this.whatToShow = show === undefined || show === null ? 0xffffffff : show >>> 0;
      this.filter = filter || null;
      this.currentNode = root;
    };
    Walker.prototype.nextNode = function () {
      var node = this.currentNode;
      var result = 1;
      for (;;) {
        while (result !== 2 && node.firstChild) {
          node = node.firstChild;
          result = verdict(this, node);
          if (result === 1) { this.currentNode = node; return node; }
        }
        var sibling = null;
        for (var at = node; at; at = at.parentNode) {
          if (at === this.root) return null;
          sibling = at.nextSibling;
          if (sibling) break;
        }
        if (!sibling) return null;
        node = sibling;
        result = verdict(this, node);
        if (result === 1) { this.currentNode = node; return node; }
      }
    };
    Walker.prototype.previousNode = function () {
      var node = this.currentNode;
      while (node !== this.root) {
        var sibling = node.previousSibling;
        while (sibling) {
          node = sibling;
          var result = verdict(this, node);
          while (result !== 2 && node.lastChild) { node = node.lastChild; result = verdict(this, node); }
          if (result === 1) { this.currentNode = node; return node; }
          sibling = node.previousSibling;
        }
        if (node === this.root || !node.parentNode) return null;
        node = node.parentNode;
        if (verdict(this, node) === 1) { this.currentNode = node; return node; }
      }
      return null;
    };
    Walker.prototype.parentNode = function () {
      for (var node = this.currentNode; node && node !== this.root; ) {
        node = node.parentNode;
        if (node && verdict(this, node) === 1) { this.currentNode = node; return node; }
      }
      return null;
    };
    // The first (or last) of a node's children that is shown: one that is skipped is looked inside.
    var childOf = function (walker, parent, last) {
      for (var node = last ? parent.lastChild : parent.firstChild; node; node = last ? node.previousSibling : node.nextSibling) {
        var result = verdict(walker, node);
        if (result === 1) return node;
        if (result === 3) { var inner = childOf(walker, node, last); if (inner) return inner; }
      }
      return null;
    };
    Walker.prototype.firstChild = function () { var node = childOf(this, this.currentNode, false); if (node) this.currentNode = node; return node; };
    Walker.prototype.lastChild = function () { var node = childOf(this, this.currentNode, true); if (node) this.currentNode = node; return node; };
    var siblingOf = function (walker, last) {
      var node = walker.currentNode;
      if (node === walker.root) return null;
      for (;;) {
        for (var sibling = last ? node.previousSibling : node.nextSibling; sibling; sibling = last ? sibling.previousSibling : sibling.nextSibling) {
          var result = verdict(walker, sibling);
          if (result === 1) { walker.currentNode = sibling; return sibling; }
          if (result === 3) { var inner = childOf(walker, sibling, last); if (inner) { walker.currentNode = inner; return inner; } }
        }
        node = node.parentNode;
        if (!node || node === walker.root || verdict(walker, node) === 1) return null;
      }
    };
    Walker.prototype.nextSibling = function () { return siblingOf(this, false); };
    Walker.prototype.previousSibling = function () { return siblingOf(this, true); };
    define('TreeWalker', Walker);

    // One node after another, in the order of the document, from the root on.
    var after = function (node, root) {
      if (node.firstChild) return node.firstChild;
      for (; node && node !== root; node = node.parentNode) if (node.nextSibling) return node.nextSibling;
      return null;
    };
    var before = function (node, root) {
      if (node === root) return null;
      var sibling = node.previousSibling;
      if (!sibling) return node.parentNode;
      while (sibling.lastChild) sibling = sibling.lastChild;
      return sibling;
    };
    var Iterator = function (root, show, filter) {
      this.root = root;
      this.whatToShow = show === undefined || show === null ? 0xffffffff : show >>> 0;
      this.filter = filter || null;
      this.referenceNode = root;
      this.pointerBeforeReferenceNode = true;
    };
    Iterator.prototype.nextNode = function () {
      var node = this.referenceNode;
      var beforeNode = this.pointerBeforeReferenceNode;
      for (;;) {
        if (beforeNode) beforeNode = false;
        else { node = after(node, this.root); if (!node) return null; }
        if (verdict(this, node) === 1) { this.referenceNode = node; this.pointerBeforeReferenceNode = false; return node; }
      }
    };
    Iterator.prototype.previousNode = function () {
      var node = this.referenceNode;
      var beforeNode = this.pointerBeforeReferenceNode;
      for (;;) {
        if (!beforeNode) beforeNode = true;
        else { node = before(node, this.root); if (!node) return null; }
        if (verdict(this, node) === 1) { this.referenceNode = node; this.pointerBeforeReferenceNode = true; return node; }
      }
    };
    Iterator.prototype.detach = function () {};
    define('NodeIterator', Iterator);

    var docProto9 = doc.constructor.prototype;
    if (typeof doc.createTreeWalker !== 'function') docProto9.createTreeWalker = function (root, show, filter) { return new Walker(root, show, filter); };
    if (typeof doc.createNodeIterator !== 'function') docProto9.createNodeIterator = function (root, show, filter) { return new Iterator(root, show, filter); };

    var SVG = 'http://www.w3.org/2000/svg';
    // A document read from text: its tree, and what code asks a document for.
    var documentOf = function (root, kind, parts) {
      var within = function (selector, all) {
        var found = [];
        try { if (root.matches && root.matches(selector)) found.push(root); } catch (e) {}
        var inner = root.querySelectorAll(selector);
        for (var i = 0; i < inner.length; i++) found.push(inner[i]);
        return all ? found : found[0] || null;
      };
      var read = {
        nodeType: 9, nodeName: '#document', contentType: kind, characterSet: 'UTF-8', compatMode: 'CSS1Compat', readyState: 'complete',
        documentElement: root, head: parts ? parts.head : null, body: parts ? parts.body : null,
        defaultView: null, location: null, ownerDocument: null, parentNode: null, nextSibling: null, previousSibling: null,
        firstChild: root, lastChild: root, firstElementChild: root, lastElementChild: root, childNodes: [root], children: [root],
        querySelector: function (selector) { return within(selector, false); },
        querySelectorAll: function (selector) { return within(selector, true); },
        getElementById: function (id) { var all = within('[id]', true); for (var i = 0; i < all.length; i++) if (all[i].getAttribute('id') === String(id)) return all[i]; return null; },
        getElementsByTagName: function (name) { return within(String(name) === '*' ? '*' : String(name), true); },
        getElementsByTagNameNS: function (ns, name) { return within(String(name) === '*' ? '*' : String(name), true); },
        getElementsByClassName: function (names) { return within(String(names).trim().split(/\s+/).map(function (name) { return '.' + name; }).join(''), true); },
        contains: function (node) { return node === read || root.contains(node); },
        createElement: function (name, options) { return doc.createElement(name, options); },
        createElementNS: function (ns, name) { return doc.createElementNS(ns, name); },
        createTextNode: function (text) { return doc.createTextNode(text); },
        createComment: function (text) { return doc.createComment(text); },
        createDocumentFragment: function () { return doc.createDocumentFragment(); },
        createTreeWalker: function (from, show, filter) { return new Walker(from, show, filter); },
        createNodeIterator: function (from, show, filter) { return new Iterator(from, show, filter); },
        createRange: function () { return doc.createRange(); },
        importNode: function (node, deep) { return doc.importNode(node, deep); },
        adoptNode: function (node) { return doc.adoptNode(node); },
        addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return true; },
      };
      Object.defineProperty(read, 'title', {
        enumerable: true,
        get: function () { var el = within('title', false); return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; },
        set: function (text) {
          var el = within('title', false);
          if (!el && read.head) { el = doc.createElement('title'); read.head.appendChild(el); }
          if (el) el.textContent = String(text);
        },
      });
      Object.defineProperty(read, 'textContent', { enumerable: true, get: function () { return null; } });
      read.implementation = implementation;
      return read;
    };
    var htmlDocument = function (markup) {
      var html = doc.createElement('html');
      var head = doc.createElement('head');
      var body = doc.createElement('body');
      html.appendChild(head);
      html.appendChild(body);
      if (markup) {
        var holder = doc.createElement('template');
        holder.innerHTML = String(markup);
        var nodes = Array.prototype.slice.call(holder.content.childNodes);
        for (var i = 0; i < nodes.length; i++) {
          var name = nodes[i].nodeType === 1 ? String(nodes[i].localName).toLowerCase() : '';
          (name === 'title' || name === 'meta' || name === 'base' ? head : body).appendChild(nodes[i]);
        }
      }
      return documentOf(html, 'text/html', { head: head, body: body });
    };
    var implementation = {
      createHTMLDocument: function (title) { var made = htmlDocument(''); if (title !== undefined) made.title = String(title); return made; },
      createDocument: function (ns, name) { return documentOf(name ? doc.createElementNS(ns, name) : doc.createElement('root'), 'application/xml', null); },
      createDocumentType: function () { return null; },
      hasFeature: function () { return true; },
    };
    if (!('implementation' in doc)) { try { Object.defineProperty(docProto9, 'implementation', { configurable: true, get: function () { return implementation; } }); } catch (e) {} }

    if (typeof g.DOMParser === 'undefined') {
      var Parser = function () {};
      Parser.prototype.parseFromString = function (markup, kind) {
        var type = String(kind || 'text/html').toLowerCase();
        var text = String(markup);
        if (type === 'text/html') return htmlDocument(text);
        if (type !== 'image/svg+xml' && type !== 'application/xml' && type !== 'text/xml' && type !== 'application/xhtml+xml') {
          throw new TypeError("Failed to execute 'parseFromString' on 'DOMParser': The provided value '" + kind + "' is not a valid enum value of type SupportedType.");
        }
        // Without its declaration and comments ahead of the root, and with an element written as closed (<a/>) closed.
        text = text.replace(/^\uFEFF?\s*(?:<\?[\s\S]*?\?>\s*|<!DOCTYPE[^>]*>\s*|<!--[\s\S]*?-->\s*)*/i, '');
        var holder;
        if (type === 'image/svg+xml') { holder = doc.createElementNS(SVG, 'svg'); holder.innerHTML = text; }
        else {
          holder = doc.createElement('template');
          holder.innerHTML = text.replace(/<([A-Za-z_][\w:.-]*)((?:\s+[^<>]*?)?)\/>/g, '<$1$2></$1>');
          holder = holder.content;
        }
        var root = null;
        for (var node = holder.firstChild; node; node = node.nextSibling) if (node.nodeType === 1) { root = node; break; }
        if (!root) {
          // As a browser answers text that is not a document: a document that says so.
          root = doc.createElement('parsererror');
          root.textContent = 'This text is not a document: it has no root element.';
        } else if (root.parentNode) root.parentNode.removeChild(root);
        return documentOf(root, type, null);
      };
      define('DOMParser', Parser);
    }
    if (typeof g.XMLSerializer === 'undefined') {
      var Serializer = function () {};
      Serializer.prototype.serializeToString = function (node) {
        if (!node) throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.");
        if (node.nodeType === 9) return node.documentElement ? node.documentElement.outerHTML : '';
        if (node.nodeType === 1) return node.outerHTML;
        if (node.nodeType === 11) return Array.prototype.map.call(node.childNodes, function (child) { return child.nodeType === 1 ? child.outerHTML : String(child.nodeValue || ''); }).join('');
        return node.nodeType === 8 ? '<!--' + String(node.nodeValue || '') + '-->' : String(node.nodeValue || '');
      };
      define('XMLSerializer', Serializer);
    }
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
  // An element of the app's own making, by a name with a hyphen in it: one in the markup,
  // one the script makes, one made with new, on the page or inside a shadow tree (a
  // component that draws other components in its own).
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
    // The shadow root of each element that has one, open or closed: what is in it is
    // looked through with the element, and watched as the page is.
    var rootsOf = typeof WeakMap === 'function' ? new WeakMap() : null;
    var watched = typeof WeakSet === 'function' ? new WeakSet() : null;
    var observer = null;
    var WATCH = { childList: true, subtree: true, attributes: true, attributeOldValue: true };
    var inside = function (el, fn) {
      var root = rootsOf && rootsOf.get(el);
      if (!root) return;
      if (observer && watched && !watched.has(root)) { watched.add(root); observer.observe(root, WATCH); }
      each(root, fn);
    };
    var each = function (root, fn) {
      if (!root || root.nodeType !== 1 && root.nodeType !== 11 && root.nodeType !== 9) return;
      if (root.nodeType === 1) {
        if (nameOf(root).indexOf('-') > 0) fn(root);
        inside(root, fn);
      }
      if (typeof root.querySelectorAll !== 'function') return;
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (nameOf(all[i]).indexOf('-') > 0) fn(all[i]);
        inside(all[i], fn);
      }
    };
    var plainAttach = g.Element && g.Element.prototype.attachShadow;
    if (typeof plainAttach === 'function' && rootsOf) {
      g.Element.prototype.attachShadow = function (init) {
        var root = plainAttach.call(this, init);
        rootsOf.set(this, root);
        if (observer && watched) { watched.add(root); observer.observe(root, WATCH); }
        return root;
      };
    }
    var watch = function () {
      if (watching || typeof g.MutationObserver !== 'function') return;
      watching = true;
      observer = new g.MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var record = records[i];
          if (record.type === 'childList') {
            for (var a = 0; a < record.addedNodes.length; a++) each(record.addedNodes[a], function (el) { upgrade(el); if (el.isConnected) connect(el); });
            for (var r = 0; r < record.removedNodes.length; r++) each(record.removedNodes[r], function (el) { if (!el.isConnected) disconnect(el); });
          } else if (record.type === 'attributes') {
            changed(record.target, record.attributeName, record.oldValue);
          }
        }
      });
      observer.observe(doc, WATCH);
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

  // ---------------------------------------------------------------------------
  // 11. crypto.subtle, done by the browser's own
  // ---------------------------------------------------------------------------
  // The engine has none. Each call is the browser's own Web Crypto, in the app's Worker, where
  // the app's keys are kept: a CryptoKey here names one there, and is let go of there when the
  // app lets go of it here. All of it or none: a library that finds crypto.subtle uses it and
  // does not fall back, so one that did only some of it would be worse than none. (None, as in
  // a browser, where the embedding page is not a secure context.)
  if (bridge && g.crypto && !g.crypto.subtle && g.__softnSubtle === true) {
    (function () {
      // What one call may carry: the bridge takes 4 million characters from the app at once.
      var MAX_SUBTLE_CHARS = 3900000;
      var keyInfo = typeof WeakMap === 'function' ? new WeakMap() : null;
      var CryptoKeyClass = function CryptoKey() { throw new TypeError('Illegal constructor'); };
      var SubtleCryptoClass = function SubtleCrypto() { throw new TypeError('Illegal constructor'); };
      var infoOf = function (key) {
        var info = keyInfo ? keyInfo.get(key) : key && key._softnKeyInfo;
        if (!info) throw new TypeError("Failed to read a CryptoKey: the value is not one.");
        return info;
      };
      ['type', 'extractable', 'algorithm', 'usages'].forEach(function (name) {
        Object.defineProperty(CryptoKeyClass.prototype, name, { configurable: true, enumerable: true, get: function () { return infoOf(this)[name]; } });
      });
      try { Object.defineProperty(CryptoKeyClass.prototype, Symbol.toStringTag, { value: 'CryptoKey', configurable: true }); } catch (e) {}
      try { Object.defineProperty(SubtleCryptoClass.prototype, Symbol.toStringTag, { value: 'SubtleCrypto', configurable: true }); } catch (e) {}

      // A key the app no longer holds is let go of in the Worker, a few at a time.
      var released = [];
      var releasing = false;
      var release = function () {
        releasing = false;
        var ids = released.splice(0);
        if (ids.length > 0) bridge.call('subtle.drop', [JSON.stringify(ids)], function () {});
      };
      var watcher = typeof g.FinalizationRegistry === 'function'
        ? new g.FinalizationRegistry(function (id) {
            released.push(id);
            if (!releasing) { releasing = true; g.setTimeout(release, 0); }
          })
        : null;
      var keyFrom = function (told) {
        var key = Object.create(CryptoKeyClass.prototype);
        var usages = Array.isArray(told.usages) ? told.usages.map(String) : [];
        var info = { id: String(told.id), type: String(told.type), extractable: !!told.extractable, algorithm: fromHost(told.algorithm), usages: usages };
        if (keyInfo) keyInfo.set(key, info);
        else Object.defineProperty(key, '_softnKeyInfo', { value: info });
        if (watcher) watcher.register(key, info.id);
        return key;
      };
      // To the Worker: bytes as base64, a key by its id, the rest as it is.
      var forHost = function (value, depth) {
        if (depth > 16) throw new TypeError('An argument to crypto.subtle is nested too deeply.');
        if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
        if (value instanceof CryptoKeyClass) return { $k: infoOf(value).id };
        if (value instanceof ArrayBuffer) return { $b: toBase64(new Uint8Array(value)) };
        if (ArrayBuffer.isView(value)) return { $b: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
        if (Array.isArray(value)) return value.map(function (item) { return forHost(item, depth + 1); });
        var out = {};
        for (var name in value) if (name !== '__proto__') out[name] = forHost(value[name], depth + 1);
        return out;
      };
      // From it: bytes as numbers (an ArrayBuffer, or a Uint8Array where the browser gives one), a key it keeps.
      var fromHost = function (value) {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(fromHost);
        // Bytes come as base64, read a piece at a time (as numbers, two million and more were not taken in).
        if ('$b64' in value) return fromBase64(String(value.$b64)).slice().buffer;
        if ('$u64' in value) return fromBase64(String(value.$u64));
        if ('$b' in value) return new Uint8Array(value.$b).buffer;
        if ('$u' in value) return new Uint8Array(value.$u);
        if ('$k' in value) return keyFrom(value.$k);
        var out = {};
        for (var name in value) if (name !== '__proto__') out[name] = fromHost(value[name]);
        return out;
      };
      var ask = function (op, args) {
        return new Promise(function (resolve, reject) {
          var given = Array.prototype.slice.call(args);
          while (given.length > 0 && given[given.length - 1] === undefined) given.pop();
          var payload;
          try { payload = JSON.stringify({ op: op, args: given.map(function (arg) { return forHost(arg, 0); }) }); } catch (e) { reject(e); return; }
          if (payload.length > MAX_SUBTLE_CHARS) {
            reject(failure('crypto.subtle is given at most about 2.9 MB at a time in a web container, and this was more.', 'QuotaExceededError'));
            return;
          }
          bridge.call('subtle', [payload], function (reply) {
            if (reply && reply.ok) {
              try { resolve(fromHost(reply.value)); } catch (e) { reject(e); }
              return;
            }
            var why = reply && reply.error ? reply.error : {};
            var message = typeof why.message === 'string' ? why.message : 'The operation failed for an operation-specific reason';
            var name = typeof why.name === 'string' ? why.name : 'OperationError';
            reject(name === 'TypeError' ? new TypeError(message) : name === 'RangeError' ? new RangeError(message) : failure(message, name));
          });
        });
      };
      ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey'].forEach(function (op) {
        Object.defineProperty(SubtleCryptoClass.prototype, op, { configurable: true, writable: true, enumerable: true, value: function () { return ask(op, arguments); } });
      });
      var subtle = Object.create(SubtleCryptoClass.prototype);
      var placed = false;
      try { Object.defineProperty(g.crypto, 'subtle', { configurable: true, enumerable: true, get: function () { return subtle; } }); placed = g.crypto.subtle === subtle; } catch (e) {}
      if (!placed) {
        // A crypto that takes nothing new: one of the app's own that does what it did, and this.
        try {
          var plainCrypto = g.crypto;
          var withSubtle = Object.create(plainCrypto);
          Object.defineProperty(withSubtle, 'subtle', { configurable: true, enumerable: true, value: subtle });
          ['getRandomValues', 'randomUUID'].forEach(function (name) {
            if (typeof plainCrypto[name] === 'function') Object.defineProperty(withSubtle, name, { configurable: true, writable: true, value: function () { return plainCrypto[name].apply(plainCrypto, arguments); } });
          });
          Object.defineProperty(g, 'crypto', { configurable: true, enumerable: true, writable: true, value: withSubtle });
        } catch (e) {}
      }
      define('CryptoKey', CryptoKeyClass);
      define('SubtleCrypto', SubtleCryptoClass);
    })();
  }

  // ---------------------------------------------------------------------------
  // 12. structuredClone, for what the container makes
  // ---------------------------------------------------------------------------
  // The document's own copy made a blob or a file the app made a plain object of nothing, and a
  // CryptoKey {} (its secret lost without a word). A blob or a file is copied as one (sharing
  // what it holds, which no one can change); a key is refused, as nothing here copies it yet;
  // everything else is the document's own copy, a value that holds itself included.
  var documentClone = g.structuredClone;
  if (typeof documentClone === 'function') {
    var cloneOf = function (value, seen) {
      if (value === null || typeof value !== 'object') return documentClone(value);
      if (seen.has(value)) return seen.get(value);
      // Each key as the copy's own, a key named __proto__ too (assigned, it was the copy's prototype).
      var put = function (copy, key, item) { Object.defineProperty(copy, key, { value: item, writable: true, enumerable: true, configurable: true }); };
      var copy;
      if (isBlob(value)) {
        copy = typeof g.File === 'function' && value instanceof g.File
          ? new g.File([value], value.name, { type: value.type, lastModified: value.lastModified })
          : value.slice(0, value.size, value.type);
        seen.set(value, copy);
        return copy;
      }
      if (typeof g.CryptoKey === 'function' && value instanceof g.CryptoKey) throw failure('A CryptoKey could not be cloned here.', 'DataCloneError');
      var proto = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        copy = new Array(value.length);
        seen.set(value, copy);
        for (var i = 0; i < value.length; i++) if (i in value) copy[i] = cloneOf(value[i], seen);
        return copy;
      }
      if (typeof Map === 'function' && value instanceof Map) {
        copy = new Map();
        seen.set(value, copy);
        value.forEach(function (v, k) { copy.set(cloneOf(k, seen), cloneOf(v, seen)); });
        return copy;
      }
      if (typeof Set === 'function' && value instanceof Set) {
        copy = new Set();
        seen.set(value, copy);
        value.forEach(function (v) { copy.add(cloneOf(v, seen)); });
        return copy;
      }
      // A plain object (or one of a class of the app's, copied as a plain object, as a browser
      // copies it); anything else (a date, bytes, an error) the document's own copy makes, told
      // what is copied already (two views of one buffer share the copy of it), and an error's
      // cause copied here (a blob in it was a plain object of nothing).
      var kind = Object.prototype.toString.call(value);
      if (kind !== '[object Object]' || (proto !== null && proto !== Object.prototype && typeof value.nodeType === 'number')) {
        // An error's cause copied here first: the document's copy then finds it copied.
        var hasCause = value instanceof Error && Object.prototype.hasOwnProperty.call(value, 'cause');
        var cause = hasCause ? cloneOf(value.cause, seen) : undefined;
        copy = documentClone(value, seen);
        seen.set(value, copy);
        if (hasCause) put(copy, 'cause', cause);
        return copy;
      }
      copy = {};
      seen.set(value, copy);
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) put(copy, keys[k], cloneOf(value[keys[k]], seen));
      return copy;
    };
    g.structuredClone = function structuredClone(value) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.");
      return cloneOf(value, new Map());
    };
  }
})();
`;
