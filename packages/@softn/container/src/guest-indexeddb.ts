/**
 * IndexedDB for a web container's app.
 *
 * The engine has none, and a library that keeps things (Dexie, idb, localForage, a query
 * cache's persister) asks for `indexedDB` first. This is one written for the app's side:
 * databases, versions and their upgrade, object stores with in-line or out-of-line keys and
 * key generators, indexes (unique, multi-entry), key ranges, cursors in the four directions,
 * and transactions that commit by themselves when nothing more is asked of them and roll
 * back whole when one is aborted.
 *
 * What is kept is kept through the Worker (`idb.*` on the app bridge), in the embedding
 * page's storage with everything else the app keeps and under the same quota: each store
 * as one text, written when a transaction that changed it commits. A commit the quota
 * refuses is an abort with QuotaExceededError, and what the transaction did is undone.
 * It is a place for an app's settings and its working data, of megabytes at most.
 *
 * A request is answered a turn after it is made, in the order requests were made. When
 * several are waiting they are answered one after another with the app's own promises
 * running between; when none is, the transaction waits one more turn for the app's code to
 * ask again, and commits if it does not.
 *
 * Evaluated in the app's VM after the web APIs (guest-web-apis.ts): it finds `Blob` and
 * `File` there. A raw template: no backticks and no dollar-brace inside it.
 */
export const GUEST_INDEXEDDB_SOURCE = String.raw`
(function (g) {
  'use strict';
  if (typeof g.indexedDB !== 'undefined') return;
  var bridge = typeof host !== 'undefined' ? host : null;
  if (!bridge || typeof bridge.callSync !== 'function') return;

  function failure(message, name) {
    var error = null;
    if (typeof g.DOMException === 'function') { try { error = new g.DOMException(message, name); } catch (e) { error = null; } }
    if (!error) { error = new Error(message); error.name = name; }
    return error;
  }
  function define(name, value) {
    try { Object.defineProperty(g, name, { value: value, configurable: true, writable: true, enumerable: false }); } catch (e) { g[name] = value; }
  }
  function hide(object, name, value) { Object.defineProperty(object, name, { value: value, writable: true, configurable: true, enumerable: false }); }
  // A turn later: from the Worker, which gives it while the app is not shown as well (the
  // app's own timers wait then, and a save made just before the app was hidden waited with
  // them, and was lost if the app was closed meanwhile).
  function later(fn) {
    if (bridge && typeof bridge.call === 'function') {
      try {
        bridge.call('idb.tick', [], function () { fn(); });
        return;
      } catch (e) {}
    }
    g.setTimeout(fn, 0);
  }
  function soon(fn) { Promise.resolve().then(fn); }
  // The most requests of a transaction answered one after another in a turn.
  var STEPS_A_TURN = 200;
  function report(error) { try { g.console.error(error); } catch (e) {} }

  // ---------------------------------------------------------------- what is kept, and where
  function fileKeys() { try { var keys = bridge.callSync('idb.keys'); return Array.isArray(keys) ? keys : []; } catch (e) { return []; } }
  // A part past what the bridge carries at once (4 million characters from here, 16 MB of
  // JSON to here) goes in pieces: a store of more than a few megabytes was never kept.
  var WRITE_PIECE = 3000000;
  function fileRead(name) {
    try {
      var text = bridge.callSync('idb.read', name);
      if (typeof text === 'string') return text;
      if (!text || typeof text.size !== 'number') return null;
      var pieces = [];
      for (var at = 0; at < text.size;) {
        var piece = bridge.callSync('idb.read', name, String(at));
        if (typeof piece !== 'string' || piece.length === 0) return null;
        pieces.push(piece);
        at += piece.length;
      }
      return pieces.join('');
    } catch (e) { return null; }
  }
  function fileWrite(name, text) {
    if (text.length <= WRITE_PIECE) { bridge.callSync('idb.write', name, text); return; }
    var count = Math.ceil(text.length / WRITE_PIECE);
    for (var i = 0; i < count; i++) bridge.callSync('idb.write', name, text.slice(i * WRITE_PIECE, (i + 1) * WRITE_PIECE), String(i), String(count));
  }
  function fileRemove(name) { try { bridge.callSync('idb.remove', name); } catch (e) {} }
  function metaFile(db) { return 'm' + JSON.stringify([db]); }
  function storeFile(db, store) { return 's' + JSON.stringify([db, store]); }
  function pageFile(db, store, id) { return 'p' + JSON.stringify([db, store, id]); }
  // The names every part of a store is kept under begin with: its pages.
  function pagePrefix(db, store) { return 'p' + JSON.stringify([db, store]).slice(0, -1) + ','; }

  // ---------------------------------------------------------------- keys
  // A key as it is kept: a number, a string, a date as { d: its time }, bytes as { b: [..] },
  // an endless number as { i: 1 or -1 }, an array of keys as an array. All of it is JSON.
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
  function isBuffer(v) { return v instanceof ArrayBuffer; }
  function isView(v) { return !!v && typeof v === 'object' && v.buffer instanceof ArrayBuffer && typeof v.byteLength === 'number'; }
  function bytesOf(v) { return isBuffer(v) ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength); }
  function rank(k) { return typeof k === 'number' ? 1 : typeof k === 'string' ? 3 : Array.isArray(k) ? 5 : k.d !== undefined ? 2 : k.b !== undefined ? 4 : 1; }
  function numberOf(k) { return typeof k === 'number' ? k : k.i > 0 ? Infinity : -Infinity; }
  function cmp(a, b) {
    var ra = rank(a);
    var rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra === 1) { var x = numberOf(a); var y = numberOf(b); return x < y ? -1 : x > y ? 1 : 0; }
    if (ra === 2) return a.d < b.d ? -1 : a.d > b.d ? 1 : 0;
    if (ra === 3) return a < b ? -1 : a > b ? 1 : 0;
    var p = ra === 4 ? a.b : a;
    var q = ra === 4 ? b.b : b;
    var n = Math.min(p.length, q.length);
    for (var i = 0; i < n; i++) {
      var c = ra === 4 ? (p[i] < q[i] ? -1 : p[i] > q[i] ? 1 : 0) : cmp(p[i], q[i]);
      if (c) return c;
    }
    return p.length < q.length ? -1 : p.length > q.length ? 1 : 0;
  }
  function toKey(v, seen) {
    if (typeof v === 'number') return v !== v ? undefined : v === Infinity ? { i: 1 } : v === -Infinity ? { i: -1 } : v === 0 ? 0 : v;
    if (typeof v === 'string') return v;
    if (isDate(v)) { var t = v.getTime(); return t !== t ? undefined : { d: t }; }
    if (isBuffer(v) || isView(v)) return { b: Array.prototype.slice.call(bytesOf(v)) };
    if (Array.isArray(v)) {
      var held = seen || [];
      if (held.indexOf(v) >= 0) return undefined;
      held.push(v);
      var out = [];
      for (var i = 0; i < v.length; i++) {
        if (!(i in v)) return undefined;
        var k = toKey(v[i], held);
        if (k === undefined) return undefined;
        out.push(k);
      }
      held.pop();
      return out;
    }
    return undefined;
  }
  function fromKey(k) {
    if (typeof k === 'number' || typeof k === 'string') return k;
    if (Array.isArray(k)) return k.map(fromKey);
    if (k.d !== undefined) return new Date(k.d);
    if (k.b !== undefined) return new Uint8Array(k.b).buffer;
    return k.i > 0 ? Infinity : -Infinity;
  }
  function needKey(v) {
    var k = toKey(v);
    if (k === undefined) throw failure('The parameter is not a valid key.', 'DataError');
    return k;
  }
  function keyId(k) { return JSON.stringify(k); }

  // ---------------------------------------------------------------- values
  // A value is kept as a copy made when it is put, and handed back as a new copy each time:
  // a tree of JSON, with what JSON has no word for under a mark.
  function mark(kind, value) { return { $idb: kind, v: value }; }
  function toBase64(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return g.btoa(text);
  }
  function fromBase64(text) {
    // Made by the Worker past a little: a stored file of a few megabytes made here a byte at a
    // time took more than a turn has, and get() stopped the app.
    if (typeof g.__softnBytesFrom64 === 'function') return g.__softnBytesFrom64(text);
    var bin = g.atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var VIEWS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView'];
  // Asked without making a blob's bytes (asking for them makes them, for one kept as parts).
  function isBlob(v) { return !!v && typeof v === 'object' && (v._softnB64 !== undefined || v._softnSegs !== undefined || v._softnBytes instanceof Uint8Array); }
  // What a browser will not copy, or what is not copied here yet (a CryptoKey): its name.
  var NOT_CLONED = ['CryptoKey', 'Worker', 'WebSocket', 'MessagePort', 'Request', 'Response', 'ReadableStream', 'AbortSignal', 'EventSource', 'XMLHttpRequest'];
  // Asked only of an object that is not a plain one: asked of every one, it took the time of
  // two fifths of what a turn copies.
  function notCloned(v) {
    for (var i = 0; i < NOT_CLONED.length; i++) {
      var C = g[NOT_CLONED[i]];
      try { if (typeof C === 'function' && v instanceof C) return NOT_CLONED[i]; } catch (e) {}
    }
    return '';
  }
  function pack(v, seen) {
    var kind = typeof v;
    if (v === null || kind === 'boolean' || kind === 'string') return v;
    if (kind === 'number') return v !== v ? mark('n', 'NaN') : v === Infinity ? mark('n', 'Infinity') : v === -Infinity ? mark('n', '-Infinity') : v === 0 && 1 / v < 0 ? mark('n', '-0') : v;
    if (kind === 'undefined') return mark('u', 0);
    if (kind === 'bigint') return mark('i', String(v));
    if (kind === 'function' || kind === 'symbol') throw failure('The value could not be cloned.', 'DataCloneError');
    if (seen.indexOf(v) >= 0) throw failure('A value that holds itself could not be cloned.', 'DataCloneError');
    seen.push(v);
    var out;
    if (isDate(v)) out = mark('d', v.getTime() === v.getTime() ? v.getTime() : 'NaN');
    else if (v instanceof RegExp) out = { $idb: 'r', s: v.source, f: v.flags };
    else if (isBuffer(v)) out = mark('b', toBase64(new Uint8Array(v)));
    else if (isView(v)) {
      var name = 'Uint8Array';
      for (var w = 0; w < VIEWS.length; w++) if (typeof g[VIEWS[w]] === 'function' && v instanceof g[VIEWS[w]]) name = VIEWS[w];
      out = { $idb: 't', c: name, v: toBase64(bytesOf(v)) };
    } else if (isBlob(v)) {
      out = { $idb: 'f', t: String(v.type || ''), v: v._softnB64 !== undefined && !(Object.getOwnPropertyDescriptor(v, '_softnBytes') || {}).value ? v._softnB64 : toBase64(v._softnBytes) };
      if (typeof v.name === 'string') { out.n = v.name; out.m = typeof v.lastModified === 'number' ? v.lastModified : 0; }
    } else if (typeof Map === 'function' && v instanceof Map) {
      var pairs = [];
      v.forEach(function (value, key) { pairs.push([pack(key, seen), pack(value, seen)]); });
      out = mark('m', pairs);
    } else if (typeof Set === 'function' && v instanceof Set) {
      var items = [];
      v.forEach(function (value) { items.push(pack(value, seen)); });
      out = mark('s', items);
    } else if (Array.isArray(v)) {
      out = [];
      for (var i = 0; i < v.length; i++) out.push(i in v ? pack(v[i], seen) : mark('h', 0));
    } else if (v instanceof Error) {
      out = { $idb: 'e', n: String(v.name), m: String(v.message) };
    } else if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') {
      throw failure('An element of the page could not be cloned.', 'DataCloneError');
    } else if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null && notCloned(v)) {
      // Held by the browser, a thread away (a key's secret is in the app's Worker), or not to
      // be copied at all: copied as an object it was {}, a key's secret lost without a word.
      throw failure('A ' + notCloned(v) + ' could not be cloned here.', 'DataCloneError');
    } else {
      var keys = Object.keys(v);
      // A key named $idb, or __proto__ (written into a plain object it is the object's prototype, not a key), is kept as a pair.
      var plain = keys.indexOf('$idb') < 0 && keys.indexOf('__proto__') < 0;
      out = plain ? {} : [];
      for (var k = 0; k < keys.length; k++) {
        var packed = pack(v[keys[k]], seen);
        if (plain) out[keys[k]] = packed;
        else out.push([keys[k], packed]);
      }
      if (!plain) out = mark('o', out);
    }
    seen.pop();
    return out;
  }
  function unpack(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      var list = new Array(v.length);
      for (var i = 0; i < v.length; i++) {
        if (v[i] && typeof v[i] === 'object' && v[i].$idb === 'h') continue;
        list[i] = unpack(v[i]);
      }
      return list;
    }
    var kind = v.$idb;
    if (kind === undefined) {
      var object = {};
      for (var key in v) object[key] = unpack(v[key]);
      return object;
    }
    if (kind === 'u') return undefined;
    if (kind === 'n') return v.v === 'NaN' ? NaN : v.v === 'Infinity' ? Infinity : v.v === '-Infinity' ? -Infinity : -0;
    if (kind === 'i') return typeof g.BigInt === 'function' ? g.BigInt(v.v) : Number(v.v);
    if (kind === 'd') return new Date(v.v === 'NaN' ? NaN : v.v);
    if (kind === 'r') return new RegExp(v.s, v.f);
    if (kind === 'b') return fromBase64(v.v).buffer;
    if (kind === 't') {
      var bytes = fromBase64(v.v);
      var View = g[v.c];
      if (typeof View !== 'function') return bytes;
      return v.c === 'DataView' ? new View(bytes.buffer) : new View(bytes.buffer, 0, Math.floor(bytes.length / (View.BYTES_PER_ELEMENT || 1)));
    }
    if (kind === 'f') {
      // Handed back as the text it is kept as, made bytes only when something reads them.
      if (typeof g.__softnKeptAsText === 'function') return g.__softnKeptAsText(v.v, v.t, v.n !== undefined ? v.n : null, v.m);
      var held = fromBase64(v.v);
      if (v.n !== undefined && typeof g.File === 'function') return new g.File([held], v.n, { type: v.t, lastModified: v.m });
      return typeof g.Blob === 'function' ? new g.Blob([held], { type: v.t }) : held;
    }
    if (kind === 'm') { var map = new Map(); for (var m = 0; m < v.v.length; m++) map.set(unpack(v.v[m][0]), unpack(v.v[m][1])); return map; }
    if (kind === 's') { var set = new Set(); for (var s = 0; s < v.v.length; s++) set.add(unpack(v.v[s])); return set; }
    if (kind === 'e') { var error = new Error(v.m); error.name = v.n; return error; }
    if (kind === 'o') { var own = {}; for (var o = 0; o < v.v.length; o++) Object.defineProperty(own, v.v[o][0], { value: unpack(v.v[o][1]), writable: true, enumerable: true, configurable: true }); return own; }
    return undefined;
  }
  function textOf(value) { return JSON.stringify(pack(value, [])); }
  function valueOf(text) { return unpack(JSON.parse(text)); }
  // The same copy, for a message to or from a Worker of the app's.
  g.__softnClone = { pack: textOf, unpack: valueOf };

  // ---------------------------------------------------------------- key paths
  var NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  function pathOk(path) {
    if (typeof path !== 'string') return false;
    if (path === '') return true;
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) if (!NAME.test(parts[i])) return false;
    return true;
  }
  function needPath(path) {
    if (Array.isArray(path)) {
      if (path.length === 0) throw failure('The keyPath argument contains an invalid key path.', 'SyntaxError');
      var list = [];
      for (var i = 0; i < path.length; i++) { if (!pathOk(String(path[i]))) throw failure('The keyPath argument contains an invalid key path.', 'SyntaxError'); list.push(String(path[i])); }
      return list;
    }
    var text = String(path);
    if (!pathOk(text)) throw failure('The keyPath argument contains an invalid key path.', 'SyntaxError');
    return text;
  }
  function readPath(value, path) {
    if (Array.isArray(path)) {
      var out = [];
      for (var i = 0; i < path.length; i++) {
        var part = readPath(value, path[i]);
        if (part === undefined) return undefined;
        out.push(part);
      }
      return out;
    }
    if (path === '') return value;
    var parts = path.split('.');
    var cur = value;
    for (var p = 0; p < parts.length; p++) {
      if (cur === null || cur === undefined) return undefined;
      if (typeof cur === 'string') { if (parts[p] !== 'length') return undefined; cur = cur.length; continue; }
      if (typeof cur !== 'object') return undefined;
      cur = cur[parts[p]];
    }
    return cur;
  }
  function writePath(value, path, key) {
    var parts = path.split('.');
    var cur = value;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === undefined) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = key;
  }
  // Whether a generated key can be put into a value by its key path: each step on the way an
  // object or not there yet, as a browser asks. (A step that was something else was written
  // over with an object, and the value kept was not the one put.)
  function canInject(value, path) {
    var parts = path.split('.');
    var cur = value;
    for (var i = 0; i < parts.length - 1; i++) {
      var next = cur[parts[i]];
      if (next === undefined) return true;
      if (next === null || typeof next !== 'object') return false;
      cur = next;
    }
    return true;
  }

  // ---------------------------------------------------------------- ranges
  function KeyRange(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = !!lowerOpen;
    this.upperOpen = !!upperOpen;
    hide(this, '_lo', lower === undefined ? undefined : needKey(lower));
    hide(this, '_hi', upper === undefined ? undefined : needKey(upper));
  }
  KeyRange.only = function (value) { needKey(value); return new KeyRange(value, value, false, false); };
  KeyRange.lowerBound = function (lower, open) { needKey(lower); return new KeyRange(lower, undefined, open, true); };
  KeyRange.upperBound = function (upper, open) { needKey(upper); return new KeyRange(undefined, upper, true, open); };
  KeyRange.bound = function (lower, upper, lowerOpen, upperOpen) {
    var c = cmp(needKey(lower), needKey(upper));
    if (c > 0 || (c === 0 && (lowerOpen || upperOpen))) throw failure('The lower key is greater than the upper key.', 'DataError');
    return new KeyRange(lower, upper, lowerOpen, upperOpen);
  };
  KeyRange.prototype.includes = function (value) { return inRange(this, needKey(value)); };
  function inRange(range, key) {
    if (!range) return true;
    if (range._lo !== undefined) { var c = cmp(key, range._lo); if (c < 0 || (c === 0 && range.lowerOpen)) return false; }
    if (range._hi !== undefined) { var d = cmp(key, range._hi); if (d > 0 || (d === 0 && range.upperOpen)) return false; }
    return true;
  }
  function rangeOf(query, optional) {
    if (query === undefined || query === null) {
      if (optional) return null;
      throw failure('No key or key range specified.', 'DataError');
    }
    if (query instanceof KeyRange) return query;
    needKey(query);
    return new KeyRange(query, query, false, false);
  }

  // ---------------------------------------------------------------- events
  var EventBase = typeof g.Event === 'function' ? g.Event.prototype : Object.prototype;
  function VersionChangeEvent(type, init) {
    var event = makeEvent(String(type), !!(init && init.bubbles), !!(init && init.cancelable), VersionChangeEvent.prototype);
    event.oldVersion = init && typeof init.oldVersion === 'number' ? init.oldVersion : 0;
    event.newVersion = init && typeof init.newVersion === 'number' ? init.newVersion : null;
    return event;
  }
  VersionChangeEvent.prototype = Object.create(EventBase);
  VersionChangeEvent.prototype.constructor = VersionChangeEvent;
  function makeEvent(type, bubbles, cancelable, proto) {
    var event = Object.create(proto || EventBase);
    var set = function (name, value) { Object.defineProperty(event, name, { value: value, writable: true, configurable: true, enumerable: true }); };
    set('type', type);
    set('bubbles', bubbles);
    set('cancelable', cancelable);
    set('defaultPrevented', false);
    set('target', null);
    set('currentTarget', null);
    set('timeStamp', Date.now());
    hide(event, '_stopped', false);
    hide(event, '_now', false);
    hide(event, 'preventDefault', function () { if (cancelable) event.defaultPrevented = true; });
    hide(event, 'stopPropagation', function () { event._stopped = true; });
    hide(event, 'stopImmediatePropagation', function () { event._stopped = true; event._now = true; });
    return event;
  }
  function versionEvent(type, oldVersion, newVersion) {
    var event = makeEvent(type, false, false, VersionChangeEvent.prototype);
    event.oldVersion = oldVersion;
    event.newVersion = newVersion;
    return event;
  }
  // What a request, a transaction and a database have in common: listeners, and a handler by name.
  function Emitter() {}
  Emitter.prototype.addEventListener = function (type, listener) {
    if (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function')) return;
    if (!this._listeners) hide(this, '_listeners', Object.create(null));
    var list = this._listeners[type] || (this._listeners[type] = []);
    if (list.indexOf(listener) < 0) list.push(listener);
  };
  Emitter.prototype.removeEventListener = function (type, listener) {
    var list = this._listeners && this._listeners[type];
    if (!list) return;
    var at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  };
  Emitter.prototype.dispatchEvent = function (event) { deliver(this, event); return !event.defaultPrevented; };
  // To one target: its handler, then its listeners. What one of them throws is said, and handed back.
  function deliver(target, event) {
    event.currentTarget = target;
    var threw = null;
    var handler = target['on' + event.type];
    if (typeof handler === 'function') { try { handler.call(target, event); } catch (e) { threw = threw || e; report(e); } }
    var list = target._listeners && target._listeners[event.type] ? target._listeners[event.type].slice() : [];
    for (var i = 0; i < list.length && !event._now; i++) {
      try {
        if (typeof list[i] === 'function') list[i].call(target, event);
        else list[i].handleEvent(event);
      } catch (e) { threw = threw || e; report(e); }
    }
    return threw;
  }
  // To a request, and on to its transaction and its database when the event is one that goes on.
  function fire(path, event) {
    event.target = path[0];
    var threw = null;
    for (var i = 0; i < path.length; i++) {
      if (!path[i]) continue;
      var t = deliver(path[i], event);
      threw = threw || t;
      if (!event.bubbles || event._stopped) break;
    }
    event.currentTarget = null;
    return threw;
  }
  function handlers(proto, names) {
    names.forEach(function (name) {
      Object.defineProperty(proto, 'on' + name, {
        configurable: true,
        enumerable: true,
        get: function () { return (this._on && this._on[name]) || null; },
        set: function (fn) { if (!this._on) hide(this, '_on', {}); this._on[name] = typeof fn === 'function' ? fn : null; },
      });
    });
  }

  // A list of names as a database and a store give one: an array with contains() and item().
  function nameList(names) {
    var list = names.slice().sort();
    hide(list, 'contains', function (name) { return list.indexOf(String(name)) >= 0; });
    hide(list, 'item', function (at) { return at >= 0 && at < list.length ? list[at] : null; });
    return list;
  }

  // ---------------------------------------------------------------- the data
  // databases[name] = { name, version, stores: { name: store }, conns: [open connections], waiting: [] }
  // store = { name, keyPath, autoIncrement, nextKey, recs (by key), indexes: { name: index }, rev, loaded }
  // rec = { k: key, v: the value's text, x: { index name: [its keys] } or null until asked }
  // index = { name, keyPath, unique, multiEntry, uniq: null or { key id: primary key id }, list, listRev }
  var databases = Object.create(null);
  function newStore(name, keyPath, autoIncrement, loaded) {
    return { name: name, keyPath: keyPath, autoIncrement: !!autoIncrement, nextKey: 1, recs: [], indexes: Object.create(null), rev: 0, loaded: !!loaded, gone: false, pages: null, nextPage: 1, dirtyPages: Object.create(null), gonePages: [] };
  }
  // Each index has a number of its own: what a record's keys in it are kept under. Kept under
  // its name, they outlived an index taken away and made again under that name (as Dexie does
  // when an index's flags change), and the new one answered from the old one's keys.
  var indexSerial = 0;
  function newIndex(name, keyPath, unique, multiEntry) {
    return { name: name, keyPath: keyPath, unique: !!unique, multiEntry: !!multiEntry, uniq: null, list: null, listRev: -1, gone: false, serial: ++indexSerial };
  }
  function loadDb(name) {
    if (databases[name]) return databases[name];
    // txs: the transactions not yet finished, in the order they were made.
    var db = { name: name, version: 0, stores: Object.create(null), conns: [], waiting: [], txs: [], afterUpgrade: [] };
    var meta = fileRead(metaFile(name));
    if (meta) {
      try {
        var parsed = JSON.parse(meta);
        db.version = typeof parsed.version === 'number' ? parsed.version : 0;
        var stores = Array.isArray(parsed.stores) ? parsed.stores : [];
        for (var i = 0; i < stores.length; i++) {
          var store = newStore(String(stores[i].name), stores[i].keyPath === undefined ? null : stores[i].keyPath, stores[i].autoIncrement, false);
          var indexes = Array.isArray(stores[i].indexes) ? stores[i].indexes : [];
          for (var k = 0; k < indexes.length; k++) store.indexes[indexes[k].name] = newIndex(String(indexes[k].name), indexes[k].keyPath, indexes[k].unique, indexes[k].multiEntry);
          db.stores[store.name] = store;
        }
      } catch (e) { db.version = 0; db.stores = Object.create(null); }
    }
    databases[name] = db;
    return db;
  }
  // A store is kept as pages of its records, by the range of keys each holds, and a list of
  // them: a commit writes the pages it changed and the list. (Kept as one text, every commit
  // wrote all of a store: one record put into a store of forty thousand took a fifth of a
  // second.) A page that has grown past twice its size is split; one left empty goes.
  var PAGE = 250;
  // What a store's pages are: { id, lo: the first key it holds, or null for the first page }.
  function readStoreParts(db, name) {
    var text = fileRead(storeFile(db, name));
    if (!text) return null;
    var head = JSON.parse(text);
    var rows = [];
    var pages = [];
    if (Array.isArray(head.r)) rows = head.r;
    else if (Array.isArray(head.p)) {
      for (var i = 0; i < head.p.length; i++) {
        var page = { id: head.p[i][0], lo: i === 0 ? null : head.p[i][1] };
        pages.push(page);
        var part = fileRead(pageFile(db, name, page.id));
        if (!part) continue;
        var held = JSON.parse(part);
        if (Array.isArray(held)) for (var r = 0; r < held.length; r++) rows.push(held[r]);
      }
    }
    return { n: typeof head.n === 'number' ? head.n : 1, np: typeof head.np === 'number' ? head.np : pages.length + 1, pages: Array.isArray(head.p) ? pages : null, rows: rows };
  }
  function loadRecs(db, store) {
    if (store.loaded) return;
    store.loaded = true;
    store.pages = null;
    storeKept(store);
    try {
      var kept = readStoreParts(db.name, store.name);
      if (!kept) return;
      store.nextKey = kept.n;
      store.nextPage = kept.np;
      store.pages = kept.pages;
      for (var i = 0; i < kept.rows.length; i++) store.recs.push({ k: kept.rows[i][0], v: kept.rows[i][1], x: null });
    } catch (e) { store.recs = []; store.pages = null; }
  }
  // The page a key is in: the last whose first key is not after it.
  function pageAt(store, key) {
    var lo = 1;
    var hi = store.pages.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cmp(store.pages[mid].lo, key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
  // A record put, replaced or taken out: the page it is in is to be written.
  function pageChanged(store, key) {
    if (!store.pages || !store.dirtyPages) return;
    store.dirtyPages[store.pages[pageAt(store, key)].id] = true;
  }
  function allPagesChanged(store) {
    if (!store.pages || !store.dirtyPages) return;
    for (var i = 0; i < store.pages.length; i++) store.dirtyPages[store.pages[i].id] = true;
  }
  function saveStore(db, store) {
    if (!store.dirtyPages) store.dirtyPages = Object.create(null);
    if (!store.gonePages) store.gonePages = [];
    if (!store.nextPage) store.nextPage = 1;
    if (!store.pages) {
      // Pages made from all of it (a new store, or one kept as one text before).
      store.pages = [{ id: store.nextPage++, lo: null }];
      allPagesChanged(store);
    }
    var starts = [];
    var i;
    for (i = 0; i < store.pages.length; i++) starts.push(i === 0 ? 0 : find(store.recs, store.pages[i].lo));
    starts.push(store.recs.length);
    var pages = [];
    for (i = 0; i < store.pages.length; i++) {
      var page = store.pages[i];
      var from = starts[i];
      var to = starts[i + 1];
      if (!store.dirtyPages[page.id]) { pages.push(page); continue; }
      // Left empty: gone (its keys are the page's before it now), but never the first.
      if (to === from && i > 0) { store.gonePages.push(page.id); continue; }
      // Grown past twice its size: split, a page's worth each.
      for (var at = from; at === from || at < to; at += PAGE) {
        var piece = at === from ? page : { id: store.nextPage++, lo: store.recs[at].k };
        // Written until a commit keeps it: one refused leaves it to the next.
        store.dirtyPages[piece.id] = true;
        if (to - at <= 2 * PAGE) {
          pages.push(piece);
          writePage(db, store, piece, at, to);
          break;
        }
        pages.push(piece);
        writePage(db, store, piece, at, at + PAGE);
      }
    }
    store.pages = pages;
    for (var g = 0; g < store.gonePages.length; g++) fileRemove(pageFile(db.name, store.name, store.gonePages[g]));
    var list = [];
    for (i = 0; i < pages.length; i++) list.push(i === 0 ? [pages[i].id] : [pages[i].id, pages[i].lo]);
    fileWrite(storeFile(db.name, store.name), JSON.stringify({ n: store.nextKey, np: store.nextPage, p: list }));
  }
  function writePage(db, store, page, from, to) {
    var rows = [];
    for (var i = from; i < to; i++) rows.push([store.recs[i].k, store.recs[i].v]);
    fileWrite(pageFile(db.name, store.name, page.id), JSON.stringify(rows));
  }
  // Kept: the pages written are not to be written again until they change.
  function storeKept(store) {
    store.dirtyPages = Object.create(null);
    store.gonePages = [];
  }
  // All of a store's parts, for a store deleted (or made again under its name).
  function removeStoreParts(db, name) {
    fileRemove(storeFile(db, name));
    var prefix = pagePrefix(db, name);
    var files = fileKeys();
    for (var f = 0; f < files.length; f++) if (String(files[f]).indexOf(prefix) === 0) fileRemove(files[f]);
  }
  function saveMeta(db) {
    var stores = [];
    for (var name in db.stores) {
      var store = db.stores[name];
      var indexes = [];
      for (var key in store.indexes) indexes.push({ name: key, keyPath: store.indexes[key].keyPath, unique: store.indexes[key].unique, multiEntry: store.indexes[key].multiEntry });
      stores.push({ name: name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: indexes });
    }
    fileWrite(metaFile(db.name), JSON.stringify({ version: db.version, stores: stores }));
  }
  // The first record whose key is not before the key given.
  function find(recs, key) {
    var lo = 0;
    var hi = recs.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cmp(recs[mid].k, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  // The keys a value has in an index: none, one, or one for each element where the index takes each.
  function entryKeys(index, value) {
    var raw = readPath(value, index.keyPath);
    if (raw === undefined) return [];
    if (index.multiEntry && Array.isArray(raw)) {
      var out = [];
      var seen = Object.create(null);
      for (var i = 0; i < raw.length; i++) {
        var k = toKey(raw[i]);
        if (k === undefined) continue;
        var id = keyId(k);
        if (seen[id]) continue;
        seen[id] = true;
        out.push(k);
      }
      return out;
    }
    var key = toKey(raw);
    return key === undefined ? [] : [key];
  }
  function keysIn(store, rec, name) {
    var index = store.indexes[name];
    if (!rec.x) rec.x = {};
    if (rec.x[index.serial] === undefined) rec.x[index.serial] = entryKeys(index, valueOf(rec.v));
    return rec.x[index.serial];
  }
  // An index's entries, by its key and then by the record's own: made when asked for, again after a change.
  function entriesOf(store, index) {
    if (index.list && index.listRev === store.rev) return index.list;
    var list = [];
    for (var i = 0; i < store.recs.length; i++) {
      var keys = keysIn(store, store.recs[i], index.name);
      for (var k = 0; k < keys.length; k++) list.push({ k: keys[k], p: store.recs[i].k, r: store.recs[i] });
    }
    list.sort(function (a, b) { return cmp(a.k, b.k) || cmp(a.p, b.p); });
    index.list = list;
    index.listRev = store.rev;
    return list;
  }
  function uniqOf(store, index) {
    if (index.uniq) return index.uniq;
    var map = Object.create(null);
    for (var i = 0; i < store.recs.length; i++) {
      var keys = keysIn(store, store.recs[i], index.name);
      for (var k = 0; k < keys.length; k++) map[keyId(keys[k])] = keyId(store.recs[i].k);
    }
    index.uniq = map;
    return map;
  }
  function forgetIn(store, rec) {
    for (var name in store.indexes) {
      var index = store.indexes[name];
      if (!index.unique || !index.uniq) continue;
      var keys = keysIn(store, rec, name);
      for (var k = 0; k < keys.length; k++) delete index.uniq[keyId(keys[k])];
    }
  }
  // An index's entries are kept up to date with each change where they are made already. Made
  // again from all the records after every write (and sorted), an index cursor that updated a
  // thousand records, or a thousand puts read through an index, took more than a turn has.
  function currentIndexes(store) {
    var current = [];
    for (var name in store.indexes) {
      var index = store.indexes[name];
      if (index.list && index.listRev === store.rev) current.push(index);
    }
    return current;
  }
  function entryAt(list, k, p) {
    var lo = 0;
    var hi = list.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if ((cmp(list[mid].k, k) || cmp(list[mid].p, p)) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function dropEntries(store, current, rec) {
    for (var i = 0; i < current.length; i++) {
      var list = current[i].list;
      var keys = keysIn(store, rec, current[i].name);
      for (var k = 0; k < keys.length; k++) {
        var at = entryAt(list, keys[k], rec.k);
        if (at < list.length && list[at].r === rec) list.splice(at, 1);
      }
    }
  }
  function addEntries(store, current, rec) {
    for (var i = 0; i < current.length; i++) {
      var list = current[i].list;
      var keys = keysIn(store, rec, current[i].name);
      for (var k = 0; k < keys.length; k++) list.splice(entryAt(list, keys[k], rec.k), 0, { k: keys[k], p: rec.k, r: rec });
    }
  }
  function stillCurrent(store, current) {
    for (var i = 0; i < current.length; i++) current[i].listRev = store.rev;
  }

  // ---------------------------------------------------------------- requests
  function Request(source, transaction) {
    this.result = undefined;
    this.error = null;
    this.source = source || null;
    this.transaction = transaction || null;
    this.readyState = 'pending';
  }
  Request.prototype = Object.create(Emitter.prototype);
  Request.prototype.constructor = Request;
  handlers(Request.prototype, ['success', 'error']);
  function OpenRequest() { Request.call(this, null, null); }
  OpenRequest.prototype = Object.create(Request.prototype);
  OpenRequest.prototype.constructor = OpenRequest;
  handlers(OpenRequest.prototype, ['blocked', 'upgradeneeded']);

  // ---------------------------------------------------------------- transactions
  function Transaction(conn, names, mode) {
    this.db = conn;
    this.mode = mode;
    this.error = null;
    this.durability = 'default';
    this.objectStoreNames = nameList(names);
    hide(this, '_data', conn._data);
    hide(this, '_queue', []);
    hide(this, '_state', 'active');
    hide(this, '_running', false);
    hide(this, '_committing', false);
    hide(this, '_dirty', Object.create(null));
    hide(this, '_undo', Object.create(null));
    hide(this, '_handles', Object.create(null));
    hide(this, '_done', null);
    // Started: no transaction made before it and not yet finished shares a store with it
    // while either of them writes. They ran side by side, and one's undoing took back the
    // other's kept writes, or one's commit kept the other's that were then undone.
    hide(this, '_started', false);
    hide(this, '_ticked', false);
    hide(this, '_inRow', 0);
    hide(this, '_waitKept', false);
    this._data.txs.push(this);
    var tx = this;
    // Nothing asked of it by the time the code that made it is done: it is over.
    later(function () { tx._tick(); });
  }
  Transaction.prototype = Object.create(Emitter.prototype);
  Transaction.prototype.constructor = Transaction;
  handlers(Transaction.prototype, ['complete', 'error', 'abort']);
  Transaction.prototype.objectStore = function (name) {
    if (this._state !== 'active') throw failure('The transaction has finished.', 'InvalidStateError');
    var key = String(name);
    var store = this._data.stores[key];
    if (!store || this.objectStoreNames.indexOf(key) < 0) throw failure('The specified object store was not found.', 'NotFoundError');
    if (!this._handles[key] || this._handles[key]._store !== store) this._handles[key] = new ObjectStore(this, store);
    return this._handles[key];
  };
  Transaction.prototype.abort = function () {
    if (this._state !== 'active' || this._waitKept) throw failure('The transaction has finished.', 'InvalidStateError');
    this._abort(null);
  };
  Transaction.prototype.commit = function () {
    if (this._state !== 'active' || this._committing) throw failure('The transaction has finished.', 'InvalidStateError');
    this._committing = true;
    this._kick();
  };
  // A request joins the line, and the line is started if it is standing still.
  Transaction.prototype._push = function (request, work) {
    if (this._state !== 'active' || this._committing) throw failure('The transaction is not active.', 'TransactionInactiveError');
    this._queue.push({ request: request, work: work });
    this._kick();
  };
  // What another tab kept for the same app: the part named is read again from what is kept,
  // now if nothing here is using it, else when what uses it is over. A description changed
  // there (a new version) is read again when the database is next opened here, if it is not
  // open here; while it is, this tab keeps the one it opened.
  function storeInUse(db, store) {
    // Started: one still waiting to start has read nothing, and starts from what is kept now.
    for (var i = 0; i < db.txs.length; i++) if (db.txs[i]._started && db.txs[i]._state === 'active' && db.txs[i].objectStoreNames.indexOf(store.name) >= 0) return true;
    return false;
  }

  // One tab at a time. The app's database is the same in every tab the app is open in, so
  // what writes to it (a transaction that writes, an upgrade, a deletion) runs while this tab
  // holds it, and starts from what the other tabs kept: the page reads that again when it
  // gives this tab the hold, and keeps what was written when it is let go of. (Two tabs that
  // wrote at once each wrote from what they had read: a record one made with a key it
  // generated was written away by the other's, made with the same key.)
  var holds = Object.create(null);
  function holdOf(name) { return holds[name] || (holds[name] = { held: false, asking: false, waiting: [], users: 0 }); }
  function hold(name, then) {
    var h = holdOf(name);
    if (h.held) { then(); return; }
    h.waiting.push(then);
    if (h.asking) return;
    h.asking = true;
    var given = function () {
      h.asking = false;
      h.held = true;
      var list = h.waiting.splice(0);
      for (var i = 0; i < list.length; i++) list[i]();
      mayLetGo(name);
    };
    if (typeof bridge.call !== 'function') { given(); return; }
    try { bridge.call('idb.hold', [name], given); } catch (e) { given(); }
  }
  function writing(data) {
    for (var i = 0; i < data.txs.length; i++) if (data.txs[i].mode !== 'readonly' && data.txs[i]._state === 'active') return true;
    return false;
  }
  // Let go of once nothing here writes to it, a turn later: a transaction made just after
  // another one ends does not ask for it again.
  function mayLetGo(name) {
    var h = holds[name];
    if (!h || !h.held || h.users > 0 || h.waiting.length > 0) return;
    if (databases[name] && writing(databases[name])) return;
    h.held = false;
    if (typeof bridge.call === 'function') { try { bridge.call('idb.release', [name], function () {}); } catch (e) {} }
  }
  function letGoSoon(name) { later(function () { mayLetGo(name); }); }
  // At a commit, a store another tab wrote while this transaction used it: what the other tab
  // kept, with what this transaction took away and put over it. (Written as this tab had it,
  // the other tab's records were written away.)
  function mergeTheirs(tx, db, store) {
    store.stale = false;
    var undo = tx._undo[store.name];
    if (!undo) return;
    var theirs = { n: 1, r: [] };
    try {
      var parts = readStoreParts(db.name, store.name);
      if (parts) {
        theirs = { n: parts.n, r: parts.rows };
        // Pages the other tab made that this one does not list go (their records are in the
        // merge), and pages made from here on are numbered after theirs.
        var ours = Object.create(null);
        if (store.pages) for (var o = 0; o < store.pages.length; o++) ours[store.pages[o].id] = true;
        if (parts.pages) for (var q = 0; q < parts.pages.length; q++) if (!ours[parts.pages[q].id]) store.gonePages.push(parts.pages[q].id);
        store.nextPage = Math.max(store.nextPage || 1, parts.np);
      }
    } catch (e) {}
    var text = null;
    var started = Object.create(null);
    for (var i = 0; i < undo.recs.length; i++) started[keyId(undo.recs[i].k)] = undo.recs[i].v;
    var now = Object.create(null);
    for (var j = 0; j < store.recs.length; j++) now[keyId(store.recs[j].k)] = store.recs[j];
    var merged = Object.create(null);
    for (var k = 0; k < theirs.r.length; k++) merged[keyId(theirs.r[k][0])] = { k: theirs.r[k][0], v: theirs.r[k][1], x: null };
    for (var gone in started) if (!(gone in now)) delete merged[gone];
    for (var put in now) if (!(put in started) || started[put] !== now[put].v) merged[put] = now[put];
    var recs = [];
    for (var id in merged) recs.push(merged[id]);
    recs.sort(function (a, b) { return cmp(a.k, b.k); });
    store.recs = recs;
    allPagesChanged(store);
    store.nextKey = Math.max(store.nextKey, theirs.n);
    store.rev++;
    for (var key in store.indexes) { store.indexes[key].uniq = null; store.indexes[key].list = null; }
    if (!tx._merged) hide(tx, '_merged', []);
    tx._merged.push({ store: store, text: text });
  }
  function readAgain(store) {
    store.stale = false;
    store.loaded = false;
    store.pages = null;
    store.recs = [];
    store.nextKey = 1;
    store.rev++;
    for (var key in store.indexes) { store.indexes[key].uniq = null; store.indexes[key].list = null; }
  }
  g.__softnIdbChanged = function (name) {
    var text = String(name);
    var parsed;
    try { parsed = JSON.parse(text.slice(1)); } catch (e) { return; }
    if (!Array.isArray(parsed)) return;
    var name = String(parsed[0]);
    var db = databases[name];
    if (!db) return;
    if (text.charAt(0) === 'm') {
      // Another tab gave the database a new version: this tab's open connections are told, as
      // a browser tells them (an app closes then, and opens it again at the new version), and
      // the description is read again once none is open.
      var meta = null;
      try { meta = JSON.parse(fileRead(metaFile(name)) || 'null'); } catch (e) { meta = null; }
      var newer = meta && typeof meta.version === 'number' && meta.version > db.version ? meta.version : null;
      var open = db.conns.filter(function (conn) { return !conn._closed; });
      if (open.length === 0 && db.txs.length === 0) { delete databases[name]; return; }
      db.outdated = true;
      if (!meta && db.version > 0) {
        // Deleted in another tab: told as a browser tells a connection before it deletes its
        // database, and written to no more (a write would have kept a part nothing describes).
        db.deleted = true;
        for (var d = 0; d < open.length; d++) fire([open[d]], versionEvent('versionchange', db.version, null));
        return;
      }
      if (newer !== null) for (var c = 0; c < open.length; c++) fire([open[c]], versionEvent('versionchange', db.version, newer));
      return;
    }
    var store = db.stores[String(parsed[1])];
    if (!store || !store.loaded) return;
    if (storeInUse(db, store)) {
      store.stale = true;
      // Its keys generated from here on come after the other tab's.
      try { var kept = JSON.parse(fileRead(storeFile(name, store.name)) || 'null'); if (kept && typeof kept.n === 'number' && kept.n > store.nextKey) store.nextKey = kept.n; if (kept && typeof kept.np === 'number' && kept.np > store.nextPage) store.nextPage = kept.np; } catch (e) {}
    } else readAgain(store);
  };
  // Whether two transactions may not run side by side: they share a store and one writes.
  Transaction.prototype._conflicts = function (other) {
    if (this.mode === 'versionchange' || other.mode === 'versionchange') return true;
    if (this.mode === 'readonly' && other.mode === 'readonly') return false;
    for (var i = 0; i < this.objectStoreNames.length; i++) if (other.objectStoreNames.indexOf(this.objectStoreNames[i]) >= 0) return true;
    return false;
  };
  Transaction.prototype._canStart = function () {
    var txs = this._data.txs;
    for (var i = 0; i < txs.length && txs[i] !== this; i++) {
      if (txs[i]._state === 'active' && this._conflicts(txs[i])) return false;
    }
    return true;
  };
  // And one that writes, once this tab holds the database: asked for, it starts when given.
  Transaction.prototype._mayStart = function () {
    if (!this._canStart()) return false;
    if (this.mode === 'readonly' || holdOf(this._data.name).held) return true;
    var tx = this;
    hold(this._data.name, function () {
      if (tx._state !== 'active' || tx._started) return;
      if (tx._queue.length || tx._committing) tx._kick();
      else if (tx._ticked) tx._tick();
    });
    return false;
  };
  Transaction.prototype._kick = function () {
    if (this._running || this._state !== 'active') return;
    if (!this._started) {
      if (!this._mayStart()) return;
      this._started = true;
    }
    this._running = true;
    var tx = this;
    later(function () { tx._step(); });
  };
  Transaction.prototype._tick = function () {
    this._ticked = true;
    if (this._running || this._state !== 'active' || this._queue.length !== 0) return;
    if (!this._started) {
      if (!this._mayStart()) return;
      this._started = true;
    }
    this._commit();
  };
  // Finished: out of the line, and the transactions waiting on it that may now start do.
  Transaction.prototype._finish = function () {
    var txs = this._data.txs;
    var at = txs.indexOf(this);
    if (at >= 0) txs.splice(at, 1);
    // A store another tab wrote while this one was using it is read again now that it is not.
    for (var s = 0; s < this.objectStoreNames.length; s++) {
      var touched = this._data.stores[this.objectStoreNames[s]];
      if (touched && touched.stale && !storeInUse(this._data, touched)) readAgain(touched);
    }
    var waiting = txs.slice();
    for (var i = 0; i < waiting.length; i++) {
      var tx = waiting[i];
      if (tx._state !== 'active' || tx._started || !tx._canStart()) continue;
      if (tx._queue.length || tx._committing) tx._kick();
      else if (tx._ticked) tx._tick();
    }
    if (this.mode !== 'readonly') letGoSoon(this._data.name);
    // An upgrade or a deletion waiting for the transactions before it.
    var held = this._data.waiting.splice(0);
    for (var h = 0; h < held.length; h++) held[h]();
    // Openings and deletions that waited for this upgrade go on, from what it left.
    if (this.mode === 'versionchange' && this._data.afterUpgrade && this._data.afterUpgrade.length) {
      var name = this._data.name;
      var next = this._data.afterUpgrade.splice(0);
      for (var n = 0; n < next.length; n++) (function (attempt) { later(function () { hold(name, attempt); }); })(next[n]);
    }
  };
  function upgrading(data) {
    for (var i = 0; i < data.txs.length; i++) if (data.txs[i].mode === 'versionchange' && data.txs[i]._state === 'active') return true;
    return false;
  }
  Transaction.prototype._step = function () {
    var tx = this;
    if (tx._state !== 'active') { tx._running = false; return; }
    var job = tx._queue.shift();
    if (!job) { tx._running = false; tx._commit(); return; }
    var request = job.request;
    var value;
    var failed = null;
    try { value = job.work(); } catch (e) { failed = e || failure('The request failed.', 'UnknownError'); }
    request.readyState = 'done';
    if (!failed) {
      request.result = value;
      request.error = null;
      var threw = fire([request], makeEvent('success', false, false));
      // A handler that throws ends the transaction, as it does in a browser.
      if (threw && tx._state === 'active') { tx._abort(failure('A request handler threw.', 'AbortError')); return; }
    } else {
      request.result = undefined;
      request.error = failed;
      var event = makeEvent('error', true, true);
      fire([request, tx, tx.db], event);
      if (!event.defaultPrevented && tx._state === 'active') { tx._abort(failed); return; }
    }
    if (tx._state !== 'active') { tx._running = false; return; }
    // More is asked already: answered next, with the app's own promises between, a share of
    // them a turn (a bulk put of tens of thousands, answered in one turn, took more than a turn
    // has). Nothing is: one turn is waited for the app's code to ask again.
    if (tx._queue.length && ++tx._inRow < STEPS_A_TURN) soon(function () { tx._step(); });
    else { tx._inRow = 0; later(function () { tx._step(); }); }
  };
  Transaction.prototype._touch = function (store) {
    if (this._undo[store.name]) return;
    this._undo[store.name] = { store: store, recs: store.recs.slice(), nextKey: store.nextKey };
  };
  Transaction.prototype._changed = function (store) {
    store.rev++;
    this._dirty[store.name] = true;
  };
  Transaction.prototype._rollback = function () {
    for (var name in this._undo) {
      var undo = this._undo[name];
      undo.store.recs = undo.recs;
      undo.store.nextKey = undo.nextKey;
      undo.store.rev++;
      for (var key in undo.store.indexes) undo.store.indexes[key].uniq = null;
    }
    this._undo = Object.create(null);
  };
  Transaction.prototype._abort = function (error) {
    if (this._state !== 'active') return;
    this._state = 'finished';
    this._running = false;
    this.error = error || null;
    this._rollback();
    if (this._restore) this._restore();
    var left = this._queue.splice(0);
    var tx = this;
    // Said in a task of its own, as a browser says it: an onabort set just after abort() is
    // heard. The transactions waiting on this one start after that.
    later(function () {
      for (var i = 0; i < left.length; i++) {
        left[i].request.readyState = 'done';
        left[i].request.result = undefined;
        left[i].request.error = failure('The transaction was aborted.', 'AbortError');
        fire([left[i].request, tx, tx.db], makeEvent('error', true, true));
      }
      fire([tx, tx.db], makeEvent('abort', true, false));
      tx._finish();
      if (tx._done) tx._done(false);
    });
  };
  Transaction.prototype._commit = function () {
    if (this._state !== 'active' || this._waitKept) return;
    var db = this._data;
    if (db.deleted && this.mode !== 'versionchange') {
      this._abort(failure('The database was deleted (here or in another tab): this connection is to be closed.', 'AbortError'));
      return;
    }
    // A connection at a version another tab has moved the database on from (and that this tab
    // has since opened at the new one): a browser would have closed it first. Its write would
    // be laid out by what it read then, over what is kept now.
    if (db.replaced) {
      this._abort(failure('The database has a newer version, opened since: this connection is to be closed.', 'AbortError'));
      return;
    }
    // Given a new version by another tab while this connection was open at the old one: a
    // browser would have held that upgrade back until this one closed; here it was made, and
    // what this connection writes would be laid out by the old description.
    if (db.outdated && this.mode !== 'versionchange') {
      var kept = null;
      try { kept = JSON.parse(fileRead(metaFile(db.name)) || 'null'); } catch (e) { kept = null; }
      if (!kept || kept.version !== db.version) {
        this._abort(failure('The database has a newer version from another tab: this connection is to be closed.', 'AbortError'));
        return;
      }
    }
    // Kept whole or not at all: the Worker keeps what a commit writes when it ends, and none of
    // it if the quota would be passed. (Each part was kept as it was written, and on a refusal
    // what had been written was written back a part at a time: the first part refused again
    // stopped that, and a store an upgrade had made again under its old name was deleted.)
    var staged = false;
    // Each store laid out again for it (its pages, which go, which are new): saved before it is.
    var saved = [];
    try {
      bridge.callSync('idb.begin');
      staged = true;
      if (this.mode === 'versionchange') {
        // A store deleted (and perhaps made again under its name): all its parts go first.
        for (var gone in this._dropped) removeStoreParts(db.name, gone);
        saveMeta(db);
        for (var name in db.stores) {
          var store = db.stores[name];
          if (store.loaded && (this._dirty[name] || this._made[name])) { saved.push(store); saveStore(db, store); }
        }
      } else {
        for (var changed in this._dirty) {
          if (!db.stores[changed]) continue;
          if (db.stores[changed].stale) mergeTheirs(this, db, db.stores[changed]);
          saved.push(db.stores[changed]);
          saveStore(db, db.stores[changed]);
        }
      }
      staged = false;
      var ended = bridge.callSync('idb.end');
      // The batch its writes went into: none, when it wrote nothing (and waits for nothing).
      var batch = ended && typeof ended === 'object' && typeof ended.batch === 'number' ? ended.batch : 0;
    } catch (e) {
      if (staged) { try { bridge.callSync('idb.end', 'cancel'); } catch (again) {} }
      // Nothing of it was kept. Each store it laid out again is read again from what is kept
      // once this is over: undone, its records were back, but laid out as the commit had them,
      // and the next commit wrote that layout, records restored here and all, over what was kept.
      for (var u = 0; u < saved.length; u++) saved[u].stale = true;
      if (this._merged) for (var mg = 0; mg < this._merged.length; mg++) this._merged[mg].store.stale = true;
      this._abort(failure('The quota has been exceeded.', 'QuotaExceededError'));
      return;
    }
    // Complete once the page has kept it too, as a browser's transaction is complete once what
    // it wrote is on disk. (It said complete before the page had written it: a write the
    // page's storage then refused was lost, and the app was never told.) Until then nothing
    // more is asked of it, and a transaction that would use its stores waits.
    var tx = this;
    this._committing = true;
    this._waitKept = true;
    var settle = function (ok) {
      tx._waitKept = false;
      if (!ok) {
        // Not kept: undone, and its stores read again from what is kept.
        for (var u = 0; u < saved.length; u++) saved[u].stale = true;
        tx._abort(failure('The page could not keep what the transaction wrote: its storage is full, or closed to it.', 'QuotaExceededError'));
        return;
      }
      for (var s = 0; s < saved.length; s++) storeKept(saved[s]);
      tx._state = 'finished';
      tx._undo = Object.create(null);
      fire([tx], makeEvent('complete', false, false));
      tx._finish();
      if (tx._done) tx._done(true);
    };
    if (!batch || typeof bridge.call !== 'function') { settle(true); return; }
    try { bridge.call('idb.kept', [String(batch)], function (answer) { settle(!answer || answer.ok !== false); }); } catch (e) { settle(true); }
  };

  // ---------------------------------------------------------------- object stores
  function ObjectStore(tx, store) {
    this.transaction = tx;
    hide(this, '_store', store);
    hide(this, '_indexes', Object.create(null));
  }
  Object.defineProperty(ObjectStore.prototype, 'name', { configurable: true, enumerable: true, get: function () { return this._store.name; } });
  Object.defineProperty(ObjectStore.prototype, 'keyPath', { configurable: true, enumerable: true, get: function () { var path = this._store.keyPath; return Array.isArray(path) ? path.slice() : path; } });
  Object.defineProperty(ObjectStore.prototype, 'autoIncrement', { configurable: true, enumerable: true, get: function () { return this._store.autoIncrement; } });
  Object.defineProperty(ObjectStore.prototype, 'indexNames', { configurable: true, enumerable: true, get: function () { return nameList(Object.keys(this._store.indexes)); } });
  ObjectStore.prototype._ok = function (write) {
    var tx = this.transaction;
    if (this._store.gone) throw failure('The object store has been deleted.', 'InvalidStateError');
    if (tx._state !== 'active' || tx._committing) throw failure('The transaction is not active.', 'TransactionInactiveError');
    if (write && tx.mode === 'readonly') throw failure('The transaction is read-only.', 'ReadOnlyError');
  };
  ObjectStore.prototype._ask = function (work) {
    var request = new Request(this, this.transaction);
    this.transaction._push(request, work);
    return request;
  };
  function putInto(os, value, key, noOverwrite) {
    os._ok(true);
    var store = os._store;
    var tx = os.transaction;
    // The value as it is now: what is kept is this copy, whatever becomes of the object after.
    var text = textOf(value);
    var k;
    var inject = false;
    if (store.keyPath !== null) {
      if (key !== undefined) throw failure('The object store uses in-line keys and the key parameter was provided.', 'DataError');
      var raw = readPath(value, store.keyPath);
      if (raw !== undefined) k = needKey(raw);
      else if (!store.autoIncrement) throw failure('Evaluating the object store key path did not yield a value.', 'DataError');
      else {
        if (Array.isArray(store.keyPath) || value === null || typeof value !== 'object' || !canInject(value, store.keyPath)) throw failure('A generated key could not be put into the value.', 'DataError');
        inject = true;
      }
    } else if (key !== undefined) k = needKey(key);
    else if (!store.autoIncrement) throw failure('The object store uses out-of-line keys and has no key generator and the key parameter was not provided.', 'DataError');
    // Its keys in each index, read now for the same reason.
    var x = {};
    for (var name in store.indexes) x[store.indexes[name].serial] = entryKeys(store.indexes[name], value);
    return os._ask(function () {
      loadRecs(tx._data, store);
      tx._touch(store);
      var keyNow = k;
      var textNow = text;
      var keysNow = x;
      if (keyNow === undefined) {
        if (store.nextKey > 9007199254740991) throw failure('The key generator has no more keys.', 'ConstraintError');
        keyNow = store.nextKey++;
        if (inject) {
          var copy = valueOf(text);
          writePath(copy, store.keyPath, keyNow);
          textNow = textOf(copy);
          keysNow = {};
          for (var made in store.indexes) keysNow[store.indexes[made].serial] = entryKeys(store.indexes[made], copy);
        }
      } else if (store.autoIncrement && typeof keyNow === 'number' && keyNow >= store.nextKey) {
        store.nextKey = Math.floor(keyNow) + 1;
      }
      var at = find(store.recs, keyNow);
      var existing = at < store.recs.length && cmp(store.recs[at].k, keyNow) === 0 ? store.recs[at] : null;
      if (existing && noOverwrite) throw failure('Key already exists in the object store.', 'ConstraintError');
      var mine = keyId(keyNow);
      for (var unique in store.indexes) {
        var index = store.indexes[unique];
        if (keysNow[index.serial] === undefined) keysNow[index.serial] = entryKeys(index, valueOf(textNow));
        if (!index.unique) continue;
        var owners = uniqOf(store, index);
        for (var u = 0; u < keysNow[index.serial].length; u++) {
          var owner = owners[keyId(keysNow[index.serial][u])];
          if (owner !== undefined && owner !== mine) throw failure("Unable to add key to index '" + unique + "': at least one key does not satisfy the uniqueness requirements.", 'ConstraintError');
        }
      }
      var rec = { k: keyNow, v: textNow, x: keysNow };
      var current = currentIndexes(store);
      if (existing) { forgetIn(store, existing); dropEntries(store, current, existing); store.recs[at] = rec; }
      else store.recs.splice(at, 0, rec);
      pageChanged(store, keyNow);
      addEntries(store, current, rec);
      for (var added in store.indexes) {
        var into = store.indexes[added];
        if (!into.unique || !into.uniq) continue;
        for (var a = 0; a < keysNow[into.serial].length; a++) into.uniq[keyId(keysNow[into.serial][a])] = mine;
      }
      tx._changed(store);
      stillCurrent(store, current);
      return fromKey(keyNow);
    });
  }
  ObjectStore.prototype.put = function (value, key) { return putInto(this, value, key, false); };
  ObjectStore.prototype.add = function (value, key) { return putInto(this, value, key, true); };
  // The records of a store in a range, from the first: the place to begin, and how far.
  function startOf(recs, range) {
    if (!range || range._lo === undefined) return 0;
    var at = find(recs, range._lo);
    while (range.lowerOpen && at < recs.length && cmp(recs[at].k, range._lo) === 0) at++;
    return at;
  }
  function countLimit(count) {
    if (count === undefined || count === null || count === 0) return Infinity;
    var n = Number(count);
    if (!(n >= 0) || n !== n) throw new TypeError('The count is not a number a list can be as long as.');
    return n === 0 ? Infinity : Math.floor(n);
  }
  ObjectStore.prototype.get = function (query) {
    this._ok(false);
    var range = rangeOf(query, false);
    var store = this._store;
    var data = this.transaction._data;
    return this._ask(function () {
      loadRecs(data, store);
      var at = startOf(store.recs, range);
      return at < store.recs.length && inRange(range, store.recs[at].k) ? valueOf(store.recs[at].v) : undefined;
    });
  };
  ObjectStore.prototype.getKey = function (query) {
    this._ok(false);
    var range = rangeOf(query, false);
    var store = this._store;
    var data = this.transaction._data;
    return this._ask(function () {
      loadRecs(data, store);
      var at = startOf(store.recs, range);
      return at < store.recs.length && inRange(range, store.recs[at].k) ? fromKey(store.recs[at].k) : undefined;
    });
  };
  function allOf(os, query, count, keys) {
    os._ok(false);
    var range = rangeOf(query, true);
    var limit = countLimit(count);
    var store = os._store;
    var data = os.transaction._data;
    return os._ask(function () {
      loadRecs(data, store);
      var out = [];
      for (var at = startOf(store.recs, range); at < store.recs.length && out.length < limit; at++) {
        if (!inRange(range, store.recs[at].k)) break;
        out.push(keys ? fromKey(store.recs[at].k) : valueOf(store.recs[at].v));
      }
      return out;
    });
  }
  ObjectStore.prototype.getAll = function (query, count) { return allOf(this, query, count, false); };
  ObjectStore.prototype.getAllKeys = function (query, count) { return allOf(this, query, count, true); };
  ObjectStore.prototype.count = function (query) {
    this._ok(false);
    var range = rangeOf(query, true);
    var store = this._store;
    var data = this.transaction._data;
    return this._ask(function () {
      loadRecs(data, store);
      if (!range) return store.recs.length;
      var n = 0;
      for (var at = startOf(store.recs, range); at < store.recs.length && inRange(range, store.recs[at].k); at++) n++;
      return n;
    });
  };
  function removeRange(tx, store, range) {
    loadRecs(tx._data, store);
    var from = startOf(store.recs, range);
    var to = from;
    while (to < store.recs.length && inRange(range, store.recs[to].k)) to++;
    if (to === from) return;
    tx._touch(store);
    var current = currentIndexes(store);
    for (var i = from; i < to; i++) { forgetIn(store, store.recs[i]); dropEntries(store, current, store.recs[i]); pageChanged(store, store.recs[i].k); }
    store.recs.splice(from, to - from);
    tx._changed(store);
    stillCurrent(store, current);
  }
  ObjectStore.prototype.delete = function (query) {
    this._ok(true);
    var range = rangeOf(query, false);
    var store = this._store;
    var tx = this.transaction;
    return this._ask(function () { removeRange(tx, store, range); return undefined; });
  };
  ObjectStore.prototype.clear = function () {
    this._ok(true);
    var store = this._store;
    var tx = this.transaction;
    return this._ask(function () {
      loadRecs(tx._data, store);
      tx._touch(store);
      var current = currentIndexes(store);
      allPagesChanged(store);
      store.recs = [];
      for (var name in store.indexes) store.indexes[name].uniq = null;
      for (var c = 0; c < current.length; c++) current[c].list = [];
      tx._changed(store);
      stillCurrent(store, current);
      return undefined;
    });
  };
  ObjectStore.prototype.openCursor = function (query, direction) { return openCursor(this, this, null, query, direction, false); };
  ObjectStore.prototype.openKeyCursor = function (query, direction) { return openCursor(this, this, null, query, direction, true); };
  ObjectStore.prototype.index = function (name) {
    if (this._store.gone) throw failure('The object store has been deleted.', 'InvalidStateError');
    if (this.transaction._state !== 'active') throw failure('The transaction has finished.', 'InvalidStateError');
    var key = String(name);
    var index = this._store.indexes[key];
    if (!index) throw failure('The specified index was not found.', 'NotFoundError');
    if (!this._indexes[key] || this._indexes[key]._index !== index) this._indexes[key] = new Index(this, index);
    return this._indexes[key];
  };
  ObjectStore.prototype.createIndex = function (name, keyPath, options) {
    var tx = this.transaction;
    if (tx.mode !== 'versionchange') throw failure('An index is made when a database is upgraded.', 'InvalidStateError');
    this._ok(true);
    var key = String(name);
    if (this._store.indexes[key]) throw failure('An index with the specified name already exists.', 'ConstraintError');
    var path = needPath(keyPath);
    var multiEntry = !!(options && options.multiEntry);
    if (Array.isArray(path) && multiEntry) throw failure('An index of several key paths cannot take each element.', 'InvalidAccessError');
    var store = this._store;
    loadRecs(tx._data, store);
    var index = newIndex(key, path, options && options.unique, multiEntry);
    store.indexes[key] = index;
    // What is in the store already must fit an index that allows each key once.
    if (index.unique) {
      var seen = Object.create(null);
      for (var i = 0; i < store.recs.length; i++) {
        var keys = keysIn(store, store.recs[i], key);
        for (var k = 0; k < keys.length; k++) {
          var id = keyId(keys[k]);
          if (seen[id]) { delete store.indexes[key]; tx._abort(failure("The index '" + key + "' allows each key once, and the store holds one twice.", 'ConstraintError')); throw failure('The transaction was aborted.', 'AbortError'); }
          seen[id] = true;
        }
      }
    }
    tx._schema = true;
    return this.index(key);
  };
  ObjectStore.prototype.deleteIndex = function (name) {
    var tx = this.transaction;
    if (tx.mode !== 'versionchange') throw failure('An index is deleted when a database is upgraded.', 'InvalidStateError');
    this._ok(true);
    var key = String(name);
    var index = this._store.indexes[key];
    if (!index) throw failure('The specified index was not found.', 'NotFoundError');
    index.gone = true;
    delete this._store.indexes[key];
    delete this._indexes[key];
    tx._schema = true;
  };

  // ---------------------------------------------------------------- indexes
  function Index(os, index) {
    this.objectStore = os;
    hide(this, '_index', index);
  }
  Object.defineProperty(Index.prototype, 'name', { configurable: true, enumerable: true, get: function () { return this._index.name; } });
  Object.defineProperty(Index.prototype, 'keyPath', { configurable: true, enumerable: true, get: function () { var path = this._index.keyPath; return Array.isArray(path) ? path.slice() : path; } });
  Object.defineProperty(Index.prototype, 'unique', { configurable: true, enumerable: true, get: function () { return this._index.unique; } });
  Object.defineProperty(Index.prototype, 'multiEntry', { configurable: true, enumerable: true, get: function () { return this._index.multiEntry; } });
  Index.prototype._ok = function () {
    if (this._index.gone || this.objectStore._store.gone) throw failure('The index has been deleted.', 'InvalidStateError');
    this.objectStore._ok(false);
  };
  Index.prototype._ask = function (work) {
    var request = new Request(this, this.objectStore.transaction);
    this.objectStore.transaction._push(request, work);
    return request;
  };
  // The first entry of an index whose key is not before the key given.
  function findEntry(list, key) {
    var lo = 0;
    var hi = list.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cmp(list[mid].k, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function startOfEntries(list, range) {
    if (!range || range._lo === undefined) return 0;
    var at = findEntry(list, range._lo);
    while (range.lowerOpen && at < list.length && cmp(list[at].k, range._lo) === 0) at++;
    return at;
  }
  function fromIndex(ix, query, count, what, one) {
    ix._ok();
    var range = rangeOf(query, !one);
    var limit = one ? 1 : countLimit(count);
    var store = ix.objectStore._store;
    var index = ix._index;
    var data = ix.objectStore.transaction._data;
    return ix._ask(function () {
      loadRecs(data, store);
      var list = entriesOf(store, index);
      var out = [];
      for (var at = startOfEntries(list, range); at < list.length && out.length < limit; at++) {
        if (!inRange(range, list[at].k)) break;
        out.push(what === 'value' ? valueOf(list[at].r.v) : fromKey(list[at].p));
      }
      return one ? out[0] : out;
    });
  }
  Index.prototype.get = function (query) { return fromIndex(this, query, 1, 'value', true); };
  Index.prototype.getKey = function (query) { return fromIndex(this, query, 1, 'key', true); };
  Index.prototype.getAll = function (query, count) { return fromIndex(this, query, count, 'value', false); };
  Index.prototype.getAllKeys = function (query, count) { return fromIndex(this, query, count, 'key', false); };
  Index.prototype.count = function (query) {
    this._ok();
    var range = rangeOf(query, true);
    var store = this.objectStore._store;
    var index = this._index;
    var data = this.objectStore.transaction._data;
    return this._ask(function () {
      loadRecs(data, store);
      var list = entriesOf(store, index);
      if (!range) return list.length;
      var n = 0;
      for (var at = startOfEntries(list, range); at < list.length && inRange(range, list[at].k); at++) n++;
      return n;
    });
  };
  Index.prototype.openCursor = function (query, direction) { this._ok(); return openCursor(this, this.objectStore, this._index, query, direction, false); };
  Index.prototype.openKeyCursor = function (query, direction) { this._ok(); return openCursor(this, this.objectStore, this._index, query, direction, true); };

  // ---------------------------------------------------------------- cursors
  var DIRECTIONS = ['next', 'nextunique', 'prev', 'prevunique'];
  function Cursor(source, os, index, request, range, direction, keyOnly) {
    this.source = source;
    this.direction = direction;
    this.request = request;
    hide(this, '_os', os);
    hide(this, '_ix', index);
    hide(this, '_range', range);
    hide(this, '_keyOnly', keyOnly);
    hide(this, '_key', undefined);
    hide(this, '_primary', undefined);
    hide(this, '_rec', null);
    hide(this, '_got', false);
    hide(this, '_value', undefined);
    hide(this, '_read', false);
  }
  Object.defineProperty(Cursor.prototype, 'key', { configurable: true, enumerable: true, get: function () { return this._key === undefined ? undefined : fromKey(this._key); } });
  Object.defineProperty(Cursor.prototype, 'primaryKey', { configurable: true, enumerable: true, get: function () { return this._primary === undefined ? undefined : fromKey(this._primary); } });
  function CursorWithValue() { Cursor.apply(this, arguments); }
  CursorWithValue.prototype = Object.create(Cursor.prototype);
  CursorWithValue.prototype.constructor = CursorWithValue;
  Object.defineProperty(CursorWithValue.prototype, 'value', {
    configurable: true,
    enumerable: true,
    get: function () {
      if (!this._read) { this._value = this._rec ? valueOf(this._rec.v) : undefined; this._read = true; }
      return this._value;
    },
  });
  // The entries a cursor walks, as they are now: a store's records, or an index's entries.
  function walked(cursor) {
    var store = cursor._os._store;
    loadRecs(cursor._os.transaction._data, store);
    return cursor._ix ? entriesOf(store, cursor._ix) : store.recs;
  }
  function primaryOf(cursor, item) { return cursor._ix ? item.p : item.k; }
  function recOf(cursor, item) { return cursor._ix ? item.r : item; }
  // Whether an entry is after (forward) or before (backward) the place given: by its key, and by its record's own key when the keys are the same.
  function order(cursor, item, key, primary) {
    var c = cmp(item.k, key);
    if (c !== 0 || primary === undefined) return c;
    return cmp(primaryOf(cursor, item), primary);
  }
  // Move the cursor on: past where it is, to the key asked for if one was, as many steps as asked.
  function move(cursor, steps, toKey, toPrimary) {
    var list = walked(cursor);
    var range = cursor._range;
    var forward = cursor.direction === 'next' || cursor.direction === 'nextunique';
    var unique = cursor.direction === 'nextunique' || cursor.direction === 'prevunique';
    var at;
    var found = null;
    for (var step = 0; step < steps; step++) {
      found = null;
      if (forward) {
        // The first entry after the place the cursor is at.
        at = 0;
        if (cursor._key !== undefined) {
          var lo = 0;
          var hi = list.length;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (order(cursor, list[mid], cursor._key, unique && cursor._ix ? undefined : cursor._primary) <= 0) lo = mid + 1;
            else hi = mid;
          }
          at = lo;
          // With keys taken once each, every entry of the key the cursor is at is behind it.
          if (unique && cursor._ix) while (at < list.length && cmp(list[at].k, cursor._key) === 0) at++;
        } else {
          at = cursor._ix ? startOfEntries(list, range) : startOf(list, range);
        }
        if (toKey !== undefined && step === 0) {
          while (at < list.length && order(cursor, list[at], toKey, toPrimary) < 0) at++;
        }
        if (at < list.length && inRange(range, list[at].k)) found = list[at];
      } else {
        // The last entry before the place the cursor is at.
        at = list.length - 1;
        if (cursor._key !== undefined) {
          var low = 0;
          var high = list.length;
          while (low < high) {
            var middle = (low + high) >> 1;
            if (order(cursor, list[middle], cursor._key, unique && cursor._ix ? undefined : cursor._primary) < 0) low = middle + 1;
            else high = middle;
          }
          at = low - 1;
        } else if (range && range._hi !== undefined) {
          while (at >= 0 && (cmp(list[at].k, range._hi) > 0 || (range.upperOpen && cmp(list[at].k, range._hi) === 0))) at--;
        }
        if (toKey !== undefined && step === 0) {
          while (at >= 0 && order(cursor, list[at], toKey, toPrimary) > 0) at--;
        }
        if (at >= 0 && inRange(range, list[at].k)) {
          // With keys taken once each, the entry for a key is its first.
          if (unique && cursor._ix) while (at > 0 && cmp(list[at - 1].k, list[at].k) === 0) at--;
          found = list[at];
        }
      }
      if (!found) break;
      cursor._key = found.k;
      cursor._primary = primaryOf(cursor, found);
    }
    cursor._read = false;
    cursor._value = undefined;
    if (!found) {
      cursor._rec = null;
      cursor._got = false;
      cursor._key = undefined;
      cursor._primary = undefined;
      return null;
    }
    cursor._rec = recOf(cursor, found);
    cursor._got = true;
    return cursor;
  }
  function openCursor(source, os, index, query, direction, keyOnly) {
    os._ok(false);
    var range = rangeOf(query, true);
    var way = direction === undefined ? 'next' : String(direction);
    if (DIRECTIONS.indexOf(way) < 0) throw new TypeError("The direction '" + way + "' is not one a cursor goes in.");
    var tx = os.transaction;
    var request = new Request(source, tx);
    var cursor = keyOnly ? new Cursor(source, os, index, request, range, way, true) : new CursorWithValue(source, os, index, request, range, way, false);
    tx._push(request, function () { return move(cursor, 1, undefined, undefined); });
    return request;
  }
  Cursor.prototype._again = function (steps, key, primary) {
    var tx = this._os.transaction;
    if (tx._state !== 'active' || tx._committing) throw failure('The transaction is not active.', 'TransactionInactiveError');
    if (!this._got) throw failure('The cursor is being moved, or has gone past its end.', 'InvalidStateError');
    this._got = false;
    var cursor = this;
    this.request.readyState = 'pending';
    tx._push(this.request, function () { return move(cursor, steps, key, primary); });
  };
  Cursor.prototype.continue = function (key) {
    var k;
    if (key !== undefined) {
      k = needKey(key);
      if (this._got) {
        var c = cmp(k, this._key);
        var forward = this.direction === 'next' || this.direction === 'nextunique';
        if ((forward && c <= 0) || (!forward && c >= 0)) throw failure('The key is not further on than the cursor is.', 'DataError');
      }
    }
    this._again(1, k, undefined);
  };
  Cursor.prototype.advance = function (count) {
    var n = Number(count);
    if (!(n > 0) || Math.floor(n) !== n) throw new TypeError('A cursor is moved on by a whole number of places, one or more.');
    this._again(n, undefined, undefined);
  };
  Cursor.prototype.continuePrimaryKey = function (key, primaryKey) {
    if (!this._ix) throw failure('Only the cursor of an index goes on by a record key.', 'InvalidAccessError');
    if (this.direction === 'nextunique' || this.direction === 'prevunique') throw failure('A cursor that takes each key once does not go on by a record key.', 'InvalidAccessError');
    var k = needKey(key);
    var p = needKey(primaryKey);
    // Only on, as a browser has it: by the key, or by the record's own key where the key is the same.
    if (this._got) {
      var c = cmp(k, this._key);
      var forward = this.direction === 'next';
      if ((forward && c < 0) || (!forward && c > 0)) throw failure('The key is not further on than the cursor is.', 'DataError');
      var q = c === 0 ? cmp(p, this._primary) : 0;
      if (c === 0 && ((forward && q <= 0) || (!forward && q >= 0))) throw failure('The record key is not further on than the cursor is.', 'DataError');
    }
    this._again(1, k, p);
  };
  Cursor.prototype.update = function (value) {
    var os = this._os;
    os._ok(true);
    if (!this._got || this._keyOnly) throw failure('The cursor is not at a record with a value.', 'InvalidStateError');
    var store = os._store;
    if (store.keyPath !== null) {
      var raw = readPath(value, store.keyPath);
      var k = raw === undefined ? undefined : toKey(raw);
      if (k === undefined || cmp(k, this._primary) !== 0) throw failure('The value has another key than the record the cursor is at.', 'DataError');
      return putInto(os, value, undefined, false);
    }
    return putInto(os, value, fromKey(this._primary), false);
  };
  Cursor.prototype.delete = function () {
    var os = this._os;
    os._ok(true);
    if (!this._got || this._keyOnly) throw failure('The cursor is not at a record with a value.', 'InvalidStateError');
    var store = os._store;
    var tx = os.transaction;
    var key = this._primary;
    var only = { _lo: key, _hi: key, lowerOpen: false, upperOpen: false };
    return os._ask(function () { removeRange(tx, store, only); return undefined; });
  };

  // ---------------------------------------------------------------- databases
  function Database(data) {
    this.name = data.name;
    this.version = data.version;
    hide(this, '_data', data);
    hide(this, '_closed', false);
    hide(this, '_upgrade', null);
  }
  Database.prototype = Object.create(Emitter.prototype);
  Database.prototype.constructor = Database;
  handlers(Database.prototype, ['abort', 'close', 'error', 'versionchange']);
  Object.defineProperty(Database.prototype, 'objectStoreNames', { configurable: true, enumerable: true, get: function () { return nameList(Object.keys(this._data.stores)); } });
  Database.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    var conns = this._data.conns;
    var at = conns.indexOf(this);
    if (at >= 0) conns.splice(at, 1);
    // Given a new version by another tab: read again when it is next opened here.
    if (this._data.outdated && conns.length === 0 && databases[this._data.name] === this._data) delete databases[this._data.name];
    // An upgrade or a deletion that was waiting for this one may go on.
    var waiting = this._data.waiting.splice(0);
    for (var i = 0; i < waiting.length; i++) waiting[i]();
  };
  Database.prototype.transaction = function (names, mode, options) {
    if (this._closed) throw failure('The database connection is closing.', 'InvalidStateError');
    if (this._upgrade && this._upgrade._state === 'active') throw failure('A version change transaction is running.', 'InvalidStateError');
    var list = typeof names === 'string' ? [names] : Array.prototype.slice.call(names || []).map(String);
    var seen = Object.create(null);
    list = list.filter(function (name) { if (seen[name]) return false; seen[name] = true; return true; });
    if (list.length === 0) throw failure('The storeNames parameter was empty.', 'InvalidAccessError');
    for (var i = 0; i < list.length; i++) if (!this._data.stores[list[i]]) throw failure('One of the specified object stores was not found.', 'NotFoundError');
    var way = mode === undefined ? 'readonly' : String(mode);
    if (way !== 'readonly' && way !== 'readwrite') throw new TypeError("The mode '" + way + "' is not one a transaction is made in.");
    var tx = new Transaction(this, list, way);
    if (options && typeof options.durability === 'string') tx.durability = options.durability;
    return tx;
  };
  Database.prototype.createObjectStore = function (name, options) {
    var tx = this._upgrade;
    if (!tx) throw failure('An object store is made when a database is upgraded.', 'InvalidStateError');
    if (tx._state !== 'active') throw failure('The transaction is not active.', 'TransactionInactiveError');
    var key = String(name);
    if (this._data.stores[key]) throw failure('An object store with the specified name already exists.', 'ConstraintError');
    var keyPath = options && options.keyPath !== undefined && options.keyPath !== null ? needPath(options.keyPath) : null;
    var autoIncrement = !!(options && options.autoIncrement);
    if (autoIncrement && (keyPath === '' || Array.isArray(keyPath))) throw failure('A store that makes its own keys takes one key path, and not an empty one.', 'InvalidAccessError');
    var store = newStore(key, keyPath, autoIncrement, true);
    this._data.stores[key] = store;
    tx._made[key] = true;
    tx._schema = true;
    tx.objectStoreNames = nameList(Object.keys(this._data.stores));
    return tx.objectStore(key);
  };
  Database.prototype.deleteObjectStore = function (name) {
    var tx = this._upgrade;
    if (!tx) throw failure('An object store is deleted when a database is upgraded.', 'InvalidStateError');
    if (tx._state !== 'active') throw failure('The transaction is not active.', 'TransactionInactiveError');
    var key = String(name);
    var store = this._data.stores[key];
    if (!store) throw failure('The specified object store was not found.', 'NotFoundError');
    store.gone = true;
    delete this._data.stores[key];
    delete tx._handles[key];
    delete tx._made[key];
    tx._dropped[key] = true;
    tx._schema = true;
    tx.objectStoreNames = nameList(Object.keys(this._data.stores));
  };

  // ---------------------------------------------------------------- the factory
  function Factory() {}
  function needVersion(version) {
    if (version === undefined) return undefined;
    var n = Number(version);
    if (!(n >= 1) || Math.floor(n) !== n || n > 9007199254740991) throw new TypeError('The version is a whole number, one or more.');
    return n;
  }
  // What a database is, kept aside while it is upgraded, to put back if the upgrade is undone.
  function snapshot(data) {
    var stores = Object.create(null);
    for (var name in data.stores) {
      var store = data.stores[name];
      var indexes = Object.create(null);
      for (var key in store.indexes) indexes[key] = store.indexes[key];
      stores[name] = { store: store, indexes: indexes };
    }
    return { version: data.version, stores: stores };
  }
  function restore(data, snap) {
    data.version = snap.version;
    data.stores = Object.create(null);
    for (var name in snap.stores) {
      var kept = snap.stores[name];
      kept.store.gone = false;
      kept.store.indexes = Object.create(null);
      for (var key in kept.indexes) { kept.indexes[key].gone = false; kept.indexes[key].uniq = null; kept.indexes[key].list = null; kept.store.indexes[key] = kept.indexes[key]; }
      kept.store.rev++;
      data.stores[name] = kept.store;
    }
  }
  // Ask the connections that are open to close for a change of version; go on once they have.
  function whenAlone(data, mine, oldVersion, newVersion, request, go) {
    var others = data.conns.filter(function (conn) { return conn !== mine && !conn._closed; });
    for (var i = 0; i < others.length; i++) fire([others[i]], versionEvent('versionchange', oldVersion, newVersion));
    var open = function () { return data.conns.some(function (conn) { return conn !== mine && !conn._closed; }); };
    // And the transactions of connections closed meanwhile, which finish first, as in a browser:
    // a deletion went on under a transaction still writing, which wrote after it.
    var busy = function () { return open() || data.txs.some(function (tx) { return tx.db !== mine && tx._state === 'active'; }); };
    if (!busy()) { go(); return; }
    // Waiting before blocked is told: a blocked handler that closes the other connection then
    // lets this go on. (Told first, the close found no one waiting, and nothing went on.)
    var wait = function () {
      if (busy()) data.waiting.push(wait);
      else later(go);
    };
    data.waiting.push(wait);
    if (open()) fire([request], versionEvent('blocked', oldVersion, newVersion));
  }
  Factory.prototype.open = function (name, version) {
    if (arguments.length === 0) throw new TypeError('A database is opened by its name.');
    var wanted = needVersion(version);
    var key = String(name);
    var request = new OpenRequest();
    // Opened while this tab holds the database: what version it is at is what the other tabs
    // left it at, and an upgrade one of them is making is over first.
    var h = holdOf(key);
    h.users++;
    var over = function () { h.users--; letGoSoon(key); };
    var attempt = function () {
      // An upgrade under way here: this waits for it, and reads what it left. (Opened during
      // it, a connection had the version it was making and none of its stores, and was never
      // asked to upgrade once it was undone.)
      if (databases[key] && upgrading(databases[key])) { databases[key].afterUpgrade.push(attempt); return; }
      var data;
      // Given a new version (or deleted) by another tab since it was read here: read again, what
      // this opening is decided by. Connections still open here at the old version keep the old
      // description (they were told versionchange) and write to it no more. (Decided by the
      // old one, a second upgrade wrote over the stores another tab had made and filled.)
      var stale = databases[key];
      if (stale && stale.outdated) {
        if (stale.conns.length > 0 || stale.txs.length > 0) stale.replaced = true;
        delete databases[key];
      }
      try { data = loadDb(key); } catch (e) { request.readyState = 'done'; request.error = failure('The database could not be read.', 'UnknownError'); fire([request], makeEvent('error', true, true)); over(); return; }
      var target = wanted === undefined ? (data.version || 1) : wanted;
      if (target < data.version) {
        request.readyState = 'done';
        request.error = failure('The requested version (' + target + ') is less than the existing version (' + data.version + ').', 'VersionError');
        fire([request], makeEvent('error', true, true));
        over();
        return;
      }
      var conn = new Database(data);
      var succeed = function () {
        conn.version = data.version;
        data.conns.push(conn);
        request.readyState = 'done';
        request.result = conn;
        request.error = null;
        request.transaction = null;
        fire([request], makeEvent('success', false, false));
      };
      if (target === data.version) { succeed(); over(); return; }
      whenAlone(data, conn, data.version, target, request, function () {
        var oldVersion = data.version;
        var snap = snapshot(data);
        data.version = target;
        conn.version = target;
        data.conns.push(conn);
        var tx = new Transaction(conn, Object.keys(data.stores), 'versionchange');
        hide(tx, '_made', Object.create(null));
        hide(tx, '_dropped', Object.create(null));
        hide(tx, '_schema', false);
        hide(tx, '_restore', function () { restore(data, snap); });
        conn._upgrade = tx;
        tx._done = function (ok) {
          conn._upgrade = null;
          request.transaction = null;
          if (ok && !conn._closed) {
            var at = data.conns.indexOf(conn);
            if (at >= 0) data.conns.splice(at, 1);
            succeed();
            return;
          }
          // Undone, or closed while it ran: the database is as it was, and this opening failed.
          conn.version = data.version;
          conn.close();
          request.readyState = 'done';
          request.result = undefined;
          request.error = failure('The upgrade of the database was aborted.', 'AbortError');
          fire([request], makeEvent('error', true, true));
        };
        request.readyState = 'done';
        request.result = conn;
        request.transaction = tx;
        var threw = fire([request], versionEvent('upgradeneeded', oldVersion, target));
        if (threw && tx._state === 'active') tx._abort(failure('The upgrade threw.', 'AbortError'));
        // The upgrade keeps the hold until it is over.
        over();
      });
    };
    later(function () { hold(key, attempt); });
    return request;
  };
  Factory.prototype.deleteDatabase = function (name) {
    if (arguments.length === 0) throw new TypeError('A database is deleted by its name.');
    var key = String(name);
    var request = new OpenRequest();
    var h = holdOf(key);
    h.users++;
    var attempt = function () {
      if (databases[key] && upgrading(databases[key])) { databases[key].afterUpgrade.push(attempt); return; }
      var stale = databases[key];
      if (stale && stale.outdated) {
        if (stale.conns.length > 0 || stale.txs.length > 0) stale.replaced = true;
        delete databases[key];
      }
      var data = loadDb(key);
      var oldVersion = data.version;
      whenAlone(data, null, oldVersion, null, request, function () {
        // Written to no more, by a connection that missed being closed.
        data.deleted = true;
        // Every store kept under its name, not only the ones its description lists: a store
        // kept by an upgrade that was then undone is not listed, and was kept for good.
        var prefix = 's' + JSON.stringify([key]).slice(0, -1) + ',';
        var pages = 'p' + JSON.stringify([key]).slice(0, -1) + ',';
        var files = fileKeys();
        for (var f = 0; f < files.length; f++) if (String(files[f]).indexOf(prefix) === 0 || String(files[f]).indexOf(pages) === 0) fileRemove(files[f]);
        for (var store in data.stores) fileRemove(storeFile(key, store));
        fileRemove(metaFile(key));
        delete databases[key];
        h.users--;
        letGoSoon(key);
        request.readyState = 'done';
        request.result = undefined;
        fire([request], versionEvent('success', oldVersion, null));
      });
    };
    later(function () { hold(key, attempt); });
    return request;
  };
  Factory.prototype.databases = function () {
    return new Promise(function (resolve) {
      var out = [];
      var keys = fileKeys();
      var seen = Object.create(null);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].charAt(0) !== 'm') continue;
        try {
          var name = JSON.parse(keys[i].slice(1))[0];
          if (typeof name !== 'string' || seen[name]) continue;
          seen[name] = true;
          out.push({ name: name, version: loadDb(name).version });
        } catch (e) {}
      }
      for (var open in databases) if (!seen[open] && databases[open].version > 0) out.push({ name: open, version: databases[open].version });
      resolve(out);
    });
  };
  Factory.prototype.cmp = function (first, second) { return cmp(needKey(first), needKey(second)); };

  define('indexedDB', new Factory());
  define('IDBFactory', Factory);
  define('IDBDatabase', Database);
  define('IDBTransaction', Transaction);
  define('IDBObjectStore', ObjectStore);
  define('IDBIndex', Index);
  define('IDBCursor', Cursor);
  define('IDBCursorWithValue', CursorWithValue);
  define('IDBKeyRange', KeyRange);
  define('IDBRequest', Request);
  define('IDBOpenDBRequest', OpenRequest);
  define('IDBVersionChangeEvent', VersionChangeEvent);
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
