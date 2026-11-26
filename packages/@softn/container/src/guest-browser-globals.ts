/**
 * What a browser gives a page that a framework's production build takes for granted, set up
 * in the guest after the document (core's shell) and the container's own extensions.
 *
 * The app's script runs against a DOM written for it, not a browser's, and that DOM was
 * enough for code written by hand: `document.getElementById`, a listener, `fetch`. A
 * bundle of React is written against a browser as a whole, and stopped on three things that
 * no hand-written page had asked for:
 *
 *   - `window` was an object of the engine's own, beside the global object. React reads its
 *     constructors from it (`element instanceof window.HTMLIFrameElement`, in every commit),
 *     and a great deal of code sets a name on one and reads it from the other. Here `window`
 *     is the global object, with what the engine's object had (its listeners) put on it, and
 *     `self`, `top`, `parent` and `frames` are that object too, as they are in a page that
 *     is in no frame.
 *   - Constructors a build names in `instanceof` and never calls: `Document`, `ShadowRoot`,
 *     `HTMLIFrameElement`, `HTMLDivElement`. An undefined one is not "no": it throws. Each
 *     is defined so that the check answers as a browser's would (by the element's tag, where
 *     the document makes every element of one class).
 *   - `navigator.userAgent`, which builds read as a string without asking whether it is one,
 *     and `getSelection()`, which they call before and after every update to keep the caret.
 *
 * And what the libraries an app of any size is built with ask for:
 *
 *   - `style.sheet.insertRule()`: emotion and styled-components (and MUI, Chakra and the rest
 *     built on them) write their rules this way in production, never as text. The rules are
 *     kept as text and written into the `<style>` once a turn, so the host reads them before
 *     the page does, as it reads every stylesheet.
 *   - `window.scrollTo()` (a router calls it on every page it shows) and an element's
 *     `scrollTop`: each scrolls inside the app's box, never the page the app is drawn in.
 *   - The event classes a build makes with `new` or asks about with `instanceof`
 *     (`PopStateEvent`, `ErrorEvent`, `TransitionEvent`…), `NodeList`, `DOMRect`,
 *     `requestIdleCallback`, and a document's `cookie` (always empty), `visibilityState`
 *     and `fonts`.
 *
 * Everything is defined only where it is missing, so an engine or a shell that gains one of
 * these keeps its own.
 */
export const GUEST_BROWSER_GLOBALS_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var doc = g.document;

  // ---------------------------------------------------------------------------
  // 1. window is the global object
  // ---------------------------------------------------------------------------
  var engineWindow = typeof g.window !== 'undefined' && g.window ? g.window : null;
  if (engineWindow && engineWindow !== g) {
    var own = Object.getOwnPropertyNames(engineWindow);
    for (var i = 0; i < own.length; i++) {
      var key = own[i];
      if (key in g) continue;
      try {
        var value = engineWindow[key];
        // A method of the engine's window keeps the object it was written for; a constructor is itself.
        g[key] = typeof value === 'function' && !/^[A-Z]/.test(key) ? value.bind(engineWindow) : value;
      } catch (e) {}
    }
    try { g.window = g; } catch (e) {}
    // The document reads a handler set as a property (window.onhashchange = …, as a router
    // written by hand sets it) from the engine's object, where the page's code set it until
    // now. It is kept on the window the page's code has, and read from there.
    ['onpopstate', 'onhashchange'].forEach(function (name) {
      try {
        Object.defineProperty(engineWindow, name, { configurable: true, get: function () { return g[name]; }, set: function (handler) { g[name] = handler; } });
      } catch (e) {}
    });
  }
  ['self', 'top', 'parent', 'frames'].forEach(function (name) {
    if (typeof g[name] === 'undefined') { try { g[name] = g; } catch (e) {} }
  });

  // What happens on the page ends at the window, as in a browser: a click anywhere, a key
  // pressed (a menu that closes on a click outside it, a shortcut, a drag followed by its
  // mousemove). The engine's window hears only what is sent to it, and here nothing sends it
  // the page's events, so a listener on the window is the document's too, after its own.
  // (The few the document keeps for the window itself are left to it.)
  var windowAdd = g.addEventListener;
  var windowRemove = g.removeEventListener;
  var KEPT_BY_DOCUMENT = { load: 1, DOMContentLoaded: 1, hashchange: 1, popstate: 1, resize: 1 };
  if (doc && typeof windowAdd === 'function' && typeof doc.addEventListener === 'function') {
    g.addEventListener = function (type, listener, options) {
      if (!KEPT_BY_DOCUMENT[type]) { try { doc.addEventListener(type, listener, options); } catch (e) {} }
      return windowAdd(type, listener, options);
    };
    g.removeEventListener = function (type, listener, options) {
      if (!KEPT_BY_DOCUMENT[type]) { try { doc.removeEventListener(type, listener, options); } catch (e) {} }
      return typeof windowRemove === 'function' ? windowRemove(type, listener, options) : undefined;
    };
  }

  function define(name, value) {
    if (typeof g[name] !== 'undefined') return;
    try { g[name] = value; } catch (e) {}
  }
  /** A constructor a page may name and may not call, as a browser's interfaces are. */
  function named(name) {
    var C = function () { throw new TypeError('Illegal constructor'); };
    try { Object.defineProperty(C, 'name', { value: name, configurable: true }); } catch (e) {}
    return C;
  }
  /** An interface nothing in this document is an instance of. */
  function absent(name) {
    if (typeof g[name] !== 'undefined') return;
    var C = named(name);
    try { Object.defineProperty(C, Symbol.hasInstance, { value: function () { return false; } }); } catch (e) {}
    define(name, C);
  }

  // ---------------------------------------------------------------------------
  // 2. The document's own class, and the window's
  // ---------------------------------------------------------------------------
  if (doc && typeof doc.constructor === 'function') {
    define('Document', doc.constructor);
    define('HTMLDocument', doc.constructor);
    // The window a document belongs to is the one above.
    try { Object.defineProperty(doc.constructor.prototype, 'defaultView', { configurable: true, get: function () { return g; } }); } catch (e) {}
  }
  if (typeof g.Window === 'undefined') {
    var WindowClass = named('Window');
    try { Object.defineProperty(WindowClass, Symbol.hasInstance, { value: function (o) { return o === g; } }); } catch (e) {}
    define('Window', WindowClass);
  }
  ['ShadowRoot', 'HTMLFrameElement', 'HTMLFrameSetElement', 'HTMLObjectElement', 'HTMLEmbedElement', 'HTMLUnknownElement', 'MathMLElement', 'CDATASection', 'ProcessingInstruction', 'DocumentType', 'Attr'].forEach(absent);

  // ---------------------------------------------------------------------------
  // 3. An element's interface, by its tag
  // ---------------------------------------------------------------------------
  // The document makes every element it has no class for an HTMLElement. A browser gives a
  // div the interface HTMLDivElement, and code asks (el instanceof HTMLCanvasElement). Each
  // is HTMLElement's own prototype under another name, answering by the tag.
  var HTML = g.HTMLElement;
  function byTag(name, tags) {
    if (typeof g[name] !== 'undefined' || typeof HTML !== 'function') return;
    var C = named(name);
    C.prototype = HTML.prototype;
    try {
      Object.defineProperty(C, Symbol.hasInstance, {
        value: function (o) {
          if (!(o instanceof HTML)) return false;
          var tag = String(o.localName || o.tagName || '').toLowerCase();
          return tags.indexOf(tag) >= 0;
        },
      });
    } catch (e) {}
    define(name, C);
  }
  var TAGS = {
    HTMLDivElement: ['div'], HTMLSpanElement: ['span'], HTMLParagraphElement: ['p'],
    HTMLHeadingElement: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    HTMLUListElement: ['ul'], HTMLOListElement: ['ol'], HTMLLIElement: ['li'], HTMLDListElement: ['dl'],
    HTMLLabelElement: ['label'], HTMLFieldSetElement: ['fieldset'], HTMLLegendElement: ['legend'],
    HTMLTableElement: ['table'], HTMLTableRowElement: ['tr'], HTMLTableCellElement: ['td', 'th'],
    HTMLTableSectionElement: ['thead', 'tbody', 'tfoot'], HTMLTableCaptionElement: ['caption'], HTMLTableColElement: ['col', 'colgroup'],
    HTMLPreElement: ['pre'], HTMLBRElement: ['br'], HTMLHRElement: ['hr'], HTMLQuoteElement: ['blockquote', 'q'],
    HTMLCanvasElement: ['canvas'], HTMLVideoElement: ['video'], HTMLAudioElement: ['audio'], HTMLMediaElement: ['video', 'audio'],
    HTMLPictureElement: ['picture'], HTMLSourceElement: ['source'], HTMLTrackElement: ['track'],
    HTMLIFrameElement: ['iframe'], HTMLScriptElement: ['script'], HTMLStyleElement: ['style'], HTMLLinkElement: ['link'],
    HTMLMetaElement: ['meta'], HTMLTitleElement: ['title'], HTMLBaseElement: ['base'],
    HTMLBodyElement: ['body'], HTMLHeadElement: ['head'], HTMLHtmlElement: ['html'],
    HTMLProgressElement: ['progress'], HTMLMeterElement: ['meter'], HTMLDetailsElement: ['details'],
    HTMLDataListElement: ['datalist'], HTMLOptGroupElement: ['optgroup'], HTMLSlotElement: ['slot'],
    HTMLMenuElement: ['menu'], HTMLTimeElement: ['time'], HTMLDataElement: ['data'],
  };
  Object.keys(TAGS).forEach(function (name) { byTag(name, TAGS[name]); });

  // What a node says it is. Object.prototype.toString.call(node) said "[object Object]", as
  // a plain object does. Vue asks exactly that before it makes a value reactive, and took
  // every element held in a ref for a plain object: it wrapped the element in a proxy, and
  // the element's own methods, called through the proxy, did not know it. inputRef.value
  // .focus() did nothing, and neither did a scrollTop set on a ref.
  var NodeClass = g.Node;
  if (typeof NodeClass === 'function' && typeof Symbol === 'function' && Symbol.toStringTag && !(Symbol.toStringTag in NodeClass.prototype)) {
    var interfaceOf = {};
    Object.keys(TAGS).forEach(function (name) { TAGS[name].forEach(function (tag) { if (!interfaceOf[tag]) interfaceOf[tag] = name; }); });
    try {
      Object.defineProperty(NodeClass.prototype, Symbol.toStringTag, {
        configurable: true,
        get: function () {
          try {
            var type = this.nodeType;
            if (type === 1) {
              var own = this.constructor && this.constructor.name;
              if (own && own !== 'HTMLElement' && own !== 'Element') return own;
              return (own === 'HTMLElement' && interfaceOf[String(this.localName || '').toLowerCase()]) || own || 'Element';
            }
            return type === 3 ? 'Text' : type === 8 ? 'Comment' : type === 9 ? 'HTMLDocument' : type === 11 ? 'DocumentFragment' : 'Node';
          } catch (e) {
            return 'Node';
          }
        },
      });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 4. navigator, as text
  // ---------------------------------------------------------------------------
  // Not the embedding page's: what the app is told is the same wherever it runs.
  if (typeof g.navigator === 'undefined' || !g.navigator) { try { g.navigator = {}; } catch (e) {} }
  var nav = g.navigator;
  function about(name, value) {
    try { if (nav && typeof nav[name] === 'undefined') nav[name] = value; } catch (e) {}
  }
  about('userAgent', 'Mozilla/5.0 (SoftN Web Container) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  about('appVersion', '5.0 (SoftN Web Container)');
  about('appName', 'Netscape');
  about('product', 'Gecko');
  about('vendor', '');
  about('platform', '');
  about('language', 'en-US');
  about('languages', ['en-US', 'en']);
  about('onLine', true);
  about('cookieEnabled', false);
  about('maxTouchPoints', 0);
  about('hardwareConcurrency', 1);

  // ---------------------------------------------------------------------------
  // 5. The selection: there is none
  // ---------------------------------------------------------------------------
  // The page's caret is the embedding page's to keep (it draws the field). A build asks for
  // the selection around every update, to put it back; it is told there is nothing selected.
  if (typeof g.getSelection !== 'function') {
    var nothing = function () {};
    var selection = {
      anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
      isCollapsed: true, rangeCount: 0, type: 'None',
      addRange: nothing, removeRange: nothing, removeAllRanges: nothing, empty: nothing,
      collapse: nothing, collapseToStart: nothing, collapseToEnd: nothing, extend: nothing,
      selectAllChildren: nothing, setBaseAndExtent: nothing, deleteFromDocument: nothing,
      containsNode: function () { return false; },
      getRangeAt: function () { throw new RangeError('There is no range at that index.'); },
      toString: function () { return ''; },
    };
    g.getSelection = function () { return selection; };
  }
  if (doc && typeof doc.getSelection !== 'function') {
    try { doc.getSelection = g.getSelection; } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 6. A <style>'s sheet, written a rule at a time
  // ---------------------------------------------------------------------------
  // Code that styles components from script (emotion, styled-components, and what is built
  // on them: MUI, Chakra) writes its rules in production with
  // style.sheet.insertRule(rule, index), never as text. A stylesheet is the host's to read
  // before the page does, as text; so a sheet here is its rules as text, written into the
  // <style> as one text node of its own, once a turn, and it reaches the page by the rule
  // every stylesheet does.
  var sheets = typeof WeakMap === 'function' ? new WeakMap() : null;
  var dirty = [];
  function failure(message, name) {
    return typeof g.DOMException === 'function' ? new g.DOMException(message, name) : new Error(message);
  }
  function ruleType(text) {
    if (text.charAt(0) !== '@') return 1;
    var at = /^@([\w-]+)/.exec(text);
    var kind = at ? at[1].toLowerCase().replace(/^-\w+-/, '') : '';
    return kind === 'import' ? 3 : kind === 'media' ? 4 : kind === 'font-face' ? 5 : kind === 'keyframes' ? 7 : kind === 'supports' ? 12 : 0;
  }
  function Sheet(owner) {
    this.ownerNode = owner;
    this.cssRules = [];
    this.disabled = false;
    this.type = 'text/css';
    this.href = null;
    this.parentStyleSheet = null;
    this._text = null;
    this._due = false;
  }
  Sheet.prototype.insertRule = function (rule, index) {
    var text = String(rule).trim();
    var at = index === undefined ? 0 : Number(index);
    if (!(at >= 0 && at <= this.cssRules.length)) throw failure('The index provided (' + index + ') is larger than the maximum index (' + this.cssRules.length + ').', 'IndexSizeError');
    // As a browser refuses what is not a rule: its braces must pair, or it is an at-rule that ends where it stands.
    var open = text.split('{').length - 1;
    if (!text || open !== text.split('}').length - 1 || (open === 0 && !/^@(?:import|charset|namespace|layer)\b[^{}]*;?$/i.test(text))) {
      throw failure("Failed to parse the rule '" + text.slice(0, 80) + "'.", 'SyntaxError');
    }
    var brace = text.indexOf('{');
    this.cssRules.splice(at, 0, { cssText: text, type: ruleType(text), selectorText: brace > 0 && text.charAt(0) !== '@' ? text.slice(0, brace).trim() : undefined, parentStyleSheet: this, style: {} });
    touch(this);
    return at;
  };
  Sheet.prototype.deleteRule = function (index) {
    var at = Number(index);
    if (!(at >= 0 && at < this.cssRules.length)) throw failure('The index provided (' + index + ') is larger than the maximum index (' + (this.cssRules.length - 1) + ').', 'IndexSizeError');
    this.cssRules.splice(at, 1);
    touch(this);
  };
  Sheet.prototype.addRule = function (selector, style, index) {
    this.insertRule(selector + '{' + style + '}', index === undefined ? this.cssRules.length : index);
    return -1;
  };
  Sheet.prototype.removeRule = function (index) { this.deleteRule(index === undefined ? 0 : index); };
  try { Object.defineProperty(Sheet.prototype, 'rules', { configurable: true, get: function () { return this.cssRules; } }); } catch (e) {}
  function touch(sheet) {
    if (sheet._due) return;
    sheet._due = true;
    dirty.push(sheet);
  }
  function writeSheets() {
    if (dirty.length === 0) return;
    var list = dirty;
    dirty = [];
    for (var i = 0; i < list.length; i++) {
      var sheet = list[i];
      sheet._due = false;
      var text = '';
      for (var k = 0; k < sheet.cssRules.length; k++) text += sheet.cssRules[k].cssText + '\n';
      try {
        if (!sheet._text) sheet._text = doc.createTextNode('');
        if (sheet._text.parentNode !== sheet.ownerNode) sheet.ownerNode.appendChild(sheet._text);
        sheet._text.nodeValue = text;
      } catch (e) {}
    }
  }
  function isStyle(node) {
    return !!node && String(node.localName || '').toLowerCase() === 'style' && String(node.namespaceURI || '').indexOf('svg') < 0;
  }
  if (sheets && doc && typeof HTML === 'function' && !('sheet' in HTML.prototype)) {
    try {
      Object.defineProperty(HTML.prototype, 'sheet', {
        configurable: true,
        get: function () {
          if (!isStyle(this)) return undefined;
          var sheet = sheets.get(this);
          if (!sheet) { sheet = new Sheet(this); sheets.set(this, sheet); }
          return sheet;
        },
      });
      if (!('styleSheets' in doc)) {
        Object.defineProperty(doc.constructor.prototype, 'styleSheets', {
          configurable: true,
          get: function () {
            var found = this.querySelectorAll('style');
            var out = [];
            for (var i = 0; i < found.length; i++) out.push(found[i].sheet);
            out.item = function (n) { return out[n] || null; };
            return out;
          },
        });
      }
      define('CSSStyleSheet', Sheet);
      define('StyleSheet', Sheet);
      // With the turn's other changes: the rules written in it reach the page with what they style.
      var take = g.__softnDocTake;
      if (typeof take === 'function') g.__softnDocTake = function (failed) { writeSheets(); return take(failed); };
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 7. Events a build names
  // ---------------------------------------------------------------------------
  // Made with new (a router's PopStateEvent, React's ErrorEvent for an error nobody
  // caught) or asked about with instanceof. Each carries what it was made with.
  function eventClass(name, base, fields) {
    var Base = g[base];
    if (typeof g[name] !== 'undefined' || typeof Base !== 'function') return;
    var C = class extends Base {
      constructor(type, init) {
        super(type, init);
        var given = init || {};
        for (var key in fields) this[key] = key in given ? given[key] : fields[key];
      }
    };
    try { Object.defineProperty(C, 'name', { value: name, configurable: true }); } catch (e) {}
    define(name, C);
  }
  eventClass('UIEvent', 'Event', { detail: 0, view: null });
  eventClass('WheelEvent', 'MouseEvent', { deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0 });
  eventClass('TouchEvent', 'UIEvent', { touches: [], targetTouches: [], changedTouches: [], altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
  eventClass('ClipboardEvent', 'Event', { clipboardData: null });
  eventClass('AnimationEvent', 'Event', { animationName: '', elapsedTime: 0, pseudoElement: '' });
  eventClass('TransitionEvent', 'Event', { propertyName: '', elapsedTime: 0, pseudoElement: '' });
  eventClass('ErrorEvent', 'Event', { message: '', filename: '', lineno: 0, colno: 0, error: null });
  eventClass('PromiseRejectionEvent', 'Event', { promise: null, reason: undefined });
  eventClass('HashChangeEvent', 'Event', { oldURL: '', newURL: '' });
  eventClass('PopStateEvent', 'Event', { state: null });
  eventClass('StorageEvent', 'Event', { key: null, oldValue: null, newValue: null, url: '', storageArea: null });
  eventClass('ProgressEvent', 'Event', { lengthComputable: false, loaded: 0, total: 0 });
  eventClass('MessageEvent', 'Event', { data: null, origin: '', lastEventId: '', source: null, ports: [] });
  eventClass('CloseEvent', 'Event', { code: 0, reason: '', wasClean: false });

  // A list of nodes is an array here: asked whether it is a NodeList, it says what it is.
  ['NodeList', 'HTMLCollection'].forEach(function (name) {
    if (typeof g[name] !== 'undefined') return;
    var C = named(name);
    try { Object.defineProperty(C, Symbol.hasInstance, { value: function (o) { return Array.isArray(o) && typeof o.item === 'function'; } }); } catch (e) {}
    define(name, C);
  });

  if (typeof g.DOMRect === 'undefined') {
    var Rect = function (x, y, width, height) {
      this.x = Number(x) || 0; this.y = Number(y) || 0; this.width = Number(width) || 0; this.height = Number(height) || 0;
      this.left = this.x; this.top = this.y; this.right = this.x + this.width; this.bottom = this.y + this.height;
    };
    Rect.prototype.toJSON = function () { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }; };
    Rect.fromRect = function (r) { r = r || {}; return new Rect(r.x, r.y, r.width, r.height); };
    define('DOMRect', Rect);
    define('DOMRectReadOnly', Rect);
  }

  // ---------------------------------------------------------------------------
  // 8. Scrolling, inside the app's box
  // ---------------------------------------------------------------------------
  // The window does not scroll: the embedding page's does, and that is not the app's to
  // move. window.scrollTo (a router's "back to the top" on every page it shows) scrolls the
  // app's own box, and an element's scrollTop, scrollLeft and scrollTo() scroll that element
  // on the page. Where the person has scrolled to is told by the page with the next event the
  // app hears and once the scrolling stops, and read back here (a list that draws only the
  // rows in view reads scrollTop as it scrolls; before, it read what it had last written).
  var push = typeof g.__softnPushExtraOp === 'function' ? g.__softnPushExtraOp : null;
  var scrolled = typeof WeakMap === 'function' ? new WeakMap() : null;
  function scrollOf(el) {
    var at = scrolled && scrolled.get(el);
    if (!at && scrolled) { at = { top: 0, left: 0 }; scrolled.set(el, at); }
    return at || { top: 0, left: 0 };
  }
  function scrollNode(el, axis, value) {
    var n = Number(value);
    if (!(n === n) || !push) return;
    n = Math.max(0, n);
    // "To the end", as a chat does it after every message (el.scrollTop = el.scrollHeight).
    // What the element holds is known from when the page last measured it, a moment ago;
    // at or past the end of that is the end, however much the element holds by now.
    if (el !== doc.body && el !== doc.documentElement) {
      var held = Number(axis === 'top' ? el.scrollHeight : el.scrollWidth) || 0;
      var shown = Number(axis === 'top' ? el.clientHeight : el.clientWidth) || 0;
      if (held > shown && n >= held - shown) {
        scrollOf(el)[axis] = held - shown;
        var endId = el.__softnNode;
        if (typeof endId === 'number' && endId > 0 && el.isConnected !== false) push(['p', endId, axis === 'top' ? 'scrollTop' : 'scrollLeft', 1e9]);
        return;
      }
    }
    scrollOf(el)[axis] = n;
    var id = el === doc.body || el === doc.documentElement ? 1 : el.__softnNode;
    if (typeof id === 'number' && id > 0 && el.isConnected !== false) push(['p', id, axis === 'top' ? 'scrollTop' : 'scrollLeft', n]);
  }
  // localStorage changed by another tab, or by another of the same app in this page: a storage
  // event at the window, as a browser sends one (and window.onstorage, set as a property).
  g.__softnStorageChanged = function (key, oldValue, newValue) {
    if (!doc || typeof g.StorageEvent !== 'function') return;
    var e = new g.StorageEvent('storage', { key: key, oldValue: oldValue, newValue: newValue, url: g.location ? String(g.location.href) : '', storageArea: g.localStorage || null });
    try { doc.dispatchEvent(e); } catch (error) { g.console.error('[SoftN] A storage listener failed: ' + (error && error.message ? error.message : error)); }
    if (typeof g.onstorage === 'function') {
      try { g.onstorage.call(g, e); } catch (error) { g.console.error('[SoftN] A storage listener failed: ' + (error && error.message ? error.message : error)); }
    }
  };
  var shellApi = typeof __softnShell !== 'undefined' ? __softnShell : null;
  var plainScrollSync = g.__softnDocSync;
  if (typeof plainScrollSync === 'function') {
    g.__softnDocSync = function (changes) {
      var rest = [];
      for (var i = 0; i < changes.length; i++) {
        var c = changes[i];
        if (!c || c[0] !== 'Y') { rest.push(c); continue; }
        // The app's page (the box it scrolls in) is its document's: window.scrollY.
        var el = c[1] === 1 ? doc && doc.body : shellApi && typeof shellApi.byId === 'function' ? shellApi.byId(c[1]) : null;
        if (!el) continue;
        var at = scrollOf(el);
        var top = Number(c[2]);
        var left = Number(c[3]);
        if (top === top) at.top = Math.max(0, top);
        if (left === left) at.left = Math.max(0, left);
      }
      return plainScrollSync(rest);
    };
  }
  function scrollArgs(el, a, b, by) {
    var top = a && typeof a === 'object' ? a.top : b;
    var left = a && typeof a === 'object' ? a.left : a;
    var at = scrollOf(el);
    if (top !== undefined) scrollNode(el, 'top', by ? at.top + Number(top) : top);
    if (left !== undefined) scrollNode(el, 'left', by ? at.left + Number(left) : left);
  }
  var ElementClass = g.Element;
  if (typeof ElementClass === 'function' && push) {
    var proto = ElementClass.prototype;
    ['Top', 'Left'].forEach(function (side) {
      var name = 'scroll' + side;
      if (name in proto) return;
      try {
        Object.defineProperty(proto, name, {
          configurable: true,
          get: function () { return scrollOf(this)[side.toLowerCase()]; },
          set: function (value) { scrollNode(this, side.toLowerCase(), value); },
        });
      } catch (e) {}
    });
    if (typeof proto.scrollTo !== 'function') proto.scrollTo = proto.scroll = function (a, b) { scrollArgs(this, a, b, false); };
    if (typeof proto.scrollBy !== 'function') proto.scrollBy = function (a, b) { scrollArgs(this, a, b, true); };
  }
  if (typeof g.scrollTo !== 'function' && doc) {
    g.scrollTo = g.scroll = function (a, b) { if (doc.body) scrollArgs(doc.body, a, b, false); };
    g.scrollBy = function (a, b) { if (doc.body) scrollArgs(doc.body, a, b, true); };
  }
  ['scrollX', 'scrollY', 'pageXOffset', 'pageYOffset'].forEach(function (name) {
    if (name in g) return;
    try {
      Object.defineProperty(g, name, { configurable: true, enumerable: true, get: function () { return doc && doc.body ? scrollOf(doc.body)[/X/.test(name) ? 'left' : 'top'] : 0; } });
    } catch (e) {}
  });

  // ---------------------------------------------------------------------------
  // 9. Small things read without asking whether they are there
  // ---------------------------------------------------------------------------
  if (typeof g.requestIdleCallback !== 'function') {
    g.requestIdleCallback = function (callback) {
      return g.setTimeout(function () {
        // The idle time is counted from when the callback is called: counted from when it was
        // asked for, a callback that came late (after a long turn, or the app hidden) had none,
        // and work that takes its turns by it did nothing.
        var started = Date.now();
        callback({ didTimeout: false, timeRemaining: function () { return Math.max(0, 50 - (Date.now() - started)); } });
      }, 1);
    };
    g.cancelIdleCallback = function (id) { g.clearTimeout(id); };
  }
  if (typeof g.screen === 'undefined') {
    var screen = { colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } };
    ['width', 'availWidth'].forEach(function (name) { Object.defineProperty(screen, name, { enumerable: true, get: function () { return g.innerWidth || 0; } }); });
    ['height', 'availHeight'].forEach(function (name) { Object.defineProperty(screen, name, { enumerable: true, get: function () { return g.innerHeight || 0; } }); });
    define('screen', screen);
  }
  ['outerWidth', 'outerHeight'].forEach(function (name) {
    if (name in g) return;
    try { Object.defineProperty(g, name, { configurable: true, enumerable: true, get: function () { return g[name === 'outerWidth' ? 'innerWidth' : 'innerHeight'] || 0; } }); } catch (e) {}
  });
  if (doc) {
    var docProto = doc.constructor && doc.constructor.prototype;
    var says = function (name, get, set) {
      if (name in doc || !docProto) return;
      try { Object.defineProperty(docProto, name, { configurable: true, get: get, set: set || function () {} }); } catch (e) {}
    };
    // Shown or not is the host's to say (an app behind another tab is paused, not told).
    says('visibilityState', function () { return 'visible'; });
    says('hidden', function () { return false; });
    // No cookies: what an app keeps, it keeps in localStorage. Written ones are dropped.
    says('cookie', function () { return ''; });
    says('referrer', function () { return ''; });
    says('characterSet', function () { return 'UTF-8'; });
    says('compatMode', function () { return 'CSS1Compat'; });
    says('contentType', function () { return 'text/html'; });
    says('currentScript', function () { return null; });
    says('scrollingElement', function () { return this.documentElement || null; });
    says('URL', function () { return g.location ? String(g.location.href) : ''; });
    says('baseURI', function () { return g.location ? String(g.location.href) : ''; });
    says('fonts', function () {
      return { status: 'loaded', ready: Promise.resolve(), check: function () { return true; }, load: function () { return Promise.resolve([]); }, addEventListener: function () {}, removeEventListener: function () {} };
    });
    if (typeof doc.elementFromPoint !== 'function') { try { docProto.elementFromPoint = function () { return null; }; } catch (e) {} }
    if (typeof doc.execCommand !== 'function') { try { docProto.execCommand = function () { return false; }; } catch (e) {} }
  }
})();
`;
