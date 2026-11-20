/**
 * The global scope of a Worker of the app's own (`new Worker(url)` in its script).
 *
 * The app's Worker runs in an engine of its own in the container's Worker, with the same
 * layers as the app's page (fetch, Blob, timers, crypto), and this one last: it makes the
 * global what a dedicated worker's is. There is no document, window, storage or animation
 * frame (a library tells a worker by their absence); `self` is the global; `postMessage`,
 * `onmessage` and `addEventListener('message')` talk to the Worker object in the app's page
 * script; `importScripts` runs the app's own script files; `close()` ends it.
 *
 * Messages are copied as structured clone copies them (`__softnClone`, the IndexedDB layer's
 * copy): JSON, and dates, maps, sets, typed arrays, ArrayBuffers, blobs and files. A value
 * that holds itself, a function, an element of the page, a MessagePort, cannot be.
 */
export const GUEST_WORKER_SCOPE_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var bridge = typeof host !== 'undefined' ? host : null;
  var spec = g.__softnWorkerSpec || {};
  function failure(message, name) {
    return typeof g.DOMException === 'function' ? new g.DOMException(message, name) : new Error(message);
  }

  // What a page has and a worker does not.
  ['document', 'window', 'Image', 'localStorage', 'sessionStorage', 'indexedDB', 'IDBFactory', 'customElements',
    'alert', 'confirm', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame', 'Worker', 'parent', 'top', 'frames',
    'opener', 'matchMedia', 'getComputedStyle', 'scrollTo', 'scrollBy', 'scroll'].forEach(function (name) {
    try { delete g[name]; } catch (e) {}
    if (name in g) { try { g[name] = undefined; } catch (e) {} }
  });
  g.self = g;

  // Its own events: a message from the app's page, and an error of its own.
  var listeners = Object.create(null);
  g.addEventListener = function (type, listener, options) {
    if (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function')) return;
    var list = listeners[type] || (listeners[type] = []);
    for (var i = 0; i < list.length; i++) if (list[i].fn === listener) return;
    list.push({ fn: listener, once: !!(options && typeof options === 'object' && options.once) });
  };
  g.removeEventListener = function (type, listener) {
    var list = listeners[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) if (list[i].fn === listener) { list.splice(i, 1); return; }
  };
  function tellError(error) {
    var message = error && error.message ? String(error.message) : String(error);
    try { g.console.error('[SoftN] In a Worker of the app' + String.fromCharCode(8217) + 's: ' + (error && error.stack ? error.stack : message)); } catch (e) {}
    if (bridge) { try { bridge.call('worker.error', [message], function () {}); } catch (e) {} }
  }
  g.dispatchEvent = function (event) {
    var type = event && event.type;
    try { if (!event.target) Object.defineProperty(event, 'target', { value: g, configurable: true }); } catch (e) {}
    try { if (!event.currentTarget) Object.defineProperty(event, 'currentTarget', { value: g, configurable: true }); } catch (e) {}
    var handler = g['on' + type];
    if (typeof handler === 'function') { try { handler.call(g, event); } catch (e) { tellError(e); } }
    var list = (listeners[type] || []).slice();
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (entry.once) g.removeEventListener(type, entry.fn);
      try {
        if (typeof entry.fn === 'function') entry.fn.call(g, event);
        else entry.fn.handleEvent(event);
      } catch (e) { tellError(e); }
    }
    return !event.defaultPrevented;
  };
  g.onmessage = null;
  g.onmessageerror = null;
  g.onerror = null;

  // To the Worker object in the app's page script.
  g.postMessage = function (data) {
    if (!bridge) return;
    if (arguments.length === 0) throw new TypeError("Failed to execute 'postMessage' on 'DedicatedWorkerGlobalScope': 1 argument required, but only 0 present.");
    var packed = g.__softnClone.pack(data);
    bridge.call('worker.post', [packed], function () {});
  };
  g.close = function () {
    if (bridge) bridge.call('worker.close', [], function () {});
  };
  g.name = typeof spec.name === 'string' ? spec.name : '';
  // Where it is: the address of its script, under the app's own.
  if (typeof g.URL === 'function' && typeof spec.href === 'string') {
    try {
      var here = new g.URL(spec.href);
      g.location = { href: here.href, origin: here.origin, protocol: here.protocol, host: here.host, hostname: here.hostname, port: here.port, pathname: here.pathname, search: here.search, hash: here.hash, toString: function () { return here.href; } };
    } catch (e) {}
  }

  // A script file of the app's, run in this scope: one named in the script as text was
  // compiled with it (whatever its size); another is read and run by eval, which takes 64 KB.
  g.importScripts = function () {
    for (var i = 0; i < arguments.length; i++) {
      var address = String(arguments[i]);
      var full = typeof g.URL === 'function' ? new g.URL(address, g.location ? g.location.href : undefined).href : address;
      var made = g.__softnImportedScripts && g.__softnImportedScripts[full];
      if (typeof made === 'function') { made.call(g); continue; }
      var answer = null;
      try { answer = bridge ? bridge.callSync('vfs.fetch', full, g.location ? g.location.pathname : '/index.html') : null; } catch (e) { answer = null; }
      if (!answer || !answer.ok || typeof answer.body !== 'string') throw failure("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '" + full + "' failed to load.", 'NetworkError');
      var text = answer.body;
      var size = 0;
      for (var k = 0; k < text.length && size <= 60000; k++) { var c = text.charCodeAt(k); size += c < 0x80 ? 1 : c < 0x800 ? 2 : 3; }
      if (size > 60000) throw failure("Failed to execute 'importScripts': '" + full + "' is more than an app compiles at once while it runs (64 KB); name it as text in the Worker's script (importScripts('" + address + "')) to have it compiled with it.", 'NetworkError');
      (0, eval)(text);
    }
  };

  // What a worker's global scope is, by name: self instanceof DedicatedWorkerGlobalScope.
  var Scope = function WorkerGlobalScope() { throw new TypeError('Illegal constructor'); };
  var Dedicated = function DedicatedWorkerGlobalScope() { throw new TypeError('Illegal constructor'); };
  try { Object.defineProperty(Scope, Symbol.hasInstance, { value: function (v) { return v === g; } }); } catch (e) {}
  try { Object.defineProperty(Dedicated, Symbol.hasInstance, { value: function (v) { return v === g; } }); } catch (e) {}
  g.WorkerGlobalScope = Scope;
  g.DedicatedWorkerGlobalScope = Dedicated;

  // A message from the app's page script.
  g.__softnWorkerIncoming = function (packed) {
    var data;
    try { data = g.__softnClone.unpack(packed); } catch (e) {
      g.dispatchEvent(makeEvent('messageerror', null));
      return;
    }
    g.dispatchEvent(makeEvent('message', data));
  };
  function makeEvent(type, data) {
    var MessageEventClass = g.MessageEvent;
    var event;
    try { event = typeof MessageEventClass === 'function' ? new MessageEventClass(type, { data: data }) : null; } catch (e) { event = null; }
    if (!event) event = { type: type, data: data, defaultPrevented: false, preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () {}, stopImmediatePropagation: function () {} };
    try { if (event.data !== data) Object.defineProperty(event, 'data', { value: data, configurable: true }); } catch (e) {}
    try { Object.defineProperty(event, 'ports', { value: [], configurable: true }); } catch (e) {}
    return event;
  }
  g.__softnWorkerFailed = tellError;
})();
`;
