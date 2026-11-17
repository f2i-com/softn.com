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
      // An app that makes an address for a blob may put it on a link to save it by.
      if (typeof g.__softnWatchSaves === 'function') g.__softnWatchSaves();
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
          return new File([fromBase64(String(file.base64 || ''))], String(file.name || ''), { type: String(file.type || ''), lastModified: Number(file.lastModified) || 0 });
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
          if (told.refused && !warned) {
            warned = true;
            g.console.warn('[SoftN] A file was picked, and this app has not been allowed to read files: declare "files" in permission.json. input.files is empty.');
          }
          var files = Array.isArray(told.files) ? told.files : [];
          // A field says both input and change of one choice: the same files, told twice, are kept once.
          var mark = JSON.stringify([files.map(function (file) { return [file.name, file.lastModified, String(file.base64 || '').length]; }), told.skipped || 0]);
          var before = given.get(change[1]);
          if (before && before.mark === mark) continue;
          if (told.skipped) g.console.warn('[SoftN] ' + told.skipped + ' of the files picked were left out: a file field hands an app 1.5 MB at a time here, and they were past it.');
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
    if (typeof g.FileList === 'undefined') {
      var FileListClass = function () { throw new TypeError('Illegal constructor'); };
      try { Object.defineProperty(FileListClass, Symbol.hasInstance, { value: function (value) { return !!value && value._softnFileList === true; } }); } catch (e) {}
      define('FileList', FileListClass);
    }
    // A form's data has the files of its file fields in it.
    var FormBase = g.FormData;
    if (typeof FormBase === 'function' && !FormBase._softnPicked) {
      var FormWithFiles = function (form) {
        var data = form === undefined ? new FormBase() : new FormBase(form);
        if (form && typeof form.querySelectorAll === 'function') {
          var fileFields = form.querySelectorAll('input[name]');
          for (var i = 0; i < fileFields.length; i++) {
            if (String(fileFields[i].type || '').toLowerCase() !== 'file') continue;
            var files = filesOf(fileFields[i]);
            var name = fileFields[i].getAttribute('name');
            data.delete(name);
            if (!files || files.length === 0) data.append(name, new File([], '', { type: 'application/octet-stream' }));
            else for (var f = 0; f < files.length; f++) data.append(name, files[f]);
          }
        }
        return data;
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
      // The end, however it came: once.
      var settle = function (error) {
        if (over) return;
        over = true;
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
        signal.addEventListener('abort', function () { stop(stopped()); });
      }
      inTurn.push(function () {
        if (over) return;
        began = true;
        openRequests++;
        awaited = true;
        unanswered++;
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
          g.setTimeout(function () { self._open(); }, self._wait);
        });
      }
      close() {
        this.readyState = 2;
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
      var id = this.__softnNode;
      if (!(typeof id === 'number' && id > 0) || this.isConnected === false) { later(function () { callback(null); }); return; }
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
})();
`;
