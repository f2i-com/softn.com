/**
 * The document a page's own code is given: `document`, its elements and
 * events, written in JavaScript and compiled into the page's logic, so code
 * written for a browser runs as it would in one, inside the sandbox.
 *
 * The page's plain HTML is this document's tree from the start (the host
 * hands it over as a seed, see seed.ts), so `document.getElementById` finds
 * an element written above the script as a browser finds it. What the code
 * changes is recorded as it happens and taken by the host after each turn
 * of the engine (load, an event, a timer): a short list of operations on
 * nodes by id, which the host's mirror applies and SoftN draws through the
 * same renderer and the same checks as markup (mirror.ts). The browser's
 * events come back in by the id of the element they happened on and are
 * dispatched here, capture, target and bubble, along this tree.
 *
 * What the page's markup gives to SoftN rather than to the page \u2014 a
 * component, a `{\u2026}` value, an `#if` or `#each` \u2014 is an island here: an
 * element or a placeholder whose inside this document does not see. The code
 * can find it, move it and take it out, and SoftN goes on drawing it.
 *
 * Layout is not known here: `offsetWidth`, `getBoundingClientRect()` and the
 * like are zero.
 *
 * Written as plain JavaScript in a raw string: no template literals in it,
 * and no `${`.
 */
import { SHELL_GLOBAL_NAMES } from './names';

export const DOCUMENT_SHELL_SOURCE = String.raw`
var __softnShell = (function (win) {
  var STATE = new WeakMap();
  var BY_ID = {};
  var nextId = 2;
  var ops = [];
  var listening = {};
  var warned = {};
  var doc = null;
  var activeId = 0;

  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
  var RAW_TEXT = { script: 1, style: 1, textarea: 1, title: 1 };

  function warnOnce(key, message) {
    if (warned[key]) return;
    warned[key] = true;
    console.warn('[SoftN] ' + message);
  }

  function rec(node) { return node ? STATE.get(node) : undefined; }

  function isConnected(r) {
    while (r) {
      if (r.type === 9) return true;
      r = r.parent ? rec(r.parent) : null;
    }
    return false;
  }

  // ---------------------------------------------------------------- operations

  function attrsOf(r) {
    var out = {};
    for (var i = 0; i < r.attrs.length; i++) out[r.attrs[i][0]] = r.attrs[i][1];
    return out;
  }

  // A subtree that joins the document is told to the host whole, as it is
  // now: what was done to it while it was apart was told to no one.
  function announce(r) {
    if (!r.island) BY_ID[r.id] = r.node;
    if (r.type === 1 && !r.island) {
      ops.push(['e', r.id, r.tag, attrsOf(r)]);
      for (var i = 0; i < r.kids.length; i++) announce(rec(r.kids[i]));
      ops.push(['c', r.id, kidIds(r)]);
      if (r.value !== undefined) ops.push(['p', r.id, 'value', r.value]);
      if (r.checked !== undefined) ops.push(['p', r.id, 'checked', r.checked]);
    } else if (r.type === 3) {
      ops.push(['x', r.id, r.text]);
    } else if (r.type === 8 && !r.island) {
      ops.push(['m', r.id]);
    }
  }

  function kidIds(r) {
    var ids = [];
    for (var i = 0; i < r.kids.length; i++) ids.push(rec(r.kids[i]).id);
    return ids;
  }

  function childrenChanged(r) {
    if (isConnected(r)) ops.push(['c', r.id, kidIds(r)]);
  }

  function attrChanged(r, name, value) {
    if (isConnected(r)) ops.push(['a', r.id, name, value]);
  }

  function propChanged(r, name, value) {
    if (isConnected(r)) ops.push(['p', r.id, name, value]);
  }

  function listen(type) {
    if (listening[type]) return;
    listening[type] = true;
    ops.push(['l', type]);
  }

  // ---------------------------------------------------------------- the tree

  // Each node carries its id where the host can see it: a page's state that
  // holds a node (const list = document.getElementById('list')) is read out
  // as { __softnNode: id }, and the host knows not to write that copy back
  // over the node.
  // Only a node on the page is in BY_ID, where the host's events find it: a
  // node made and dropped, or taken off the page, is not kept alive by it.
  function register(node, r) {
    STATE.set(node, r);
    r.node = node;
    node.__softnNode = r.id;
    return node;
  }

  function forget(r) {
    if (BY_ID[r.id] === r.node) delete BY_ID[r.id];
    for (var i = 0; i < r.kids.length; i++) forget(rec(r.kids[i]));
  }

  function newRecord(type, id) {
    return { id: id || nextId++, type: type, tag: '', attrs: [], parent: null, kids: [], text: '', island: false, listeners: {}, inline: {} };
  }

  function makeElement(tag, id, island) {
    var lower = String(tag).toLowerCase();
    var Ctor = ELEMENT_CLASSES[lower] || HTMLElement;
    var node = Object.create(Ctor.prototype);
    if (lower === 'form') node = new Proxy(node, FORM_FIELDS);
    var r = newRecord(1, id);
    r.tag = lower;
    r.island = !!island;
    return register(node, r);
  }

  function makeText(text, id) {
    var node = Object.create(Text.prototype);
    var r = newRecord(3, id);
    r.text = String(text);
    return register(node, r);
  }

  function makeComment(text, id, island) {
    var node = Object.create(Comment.prototype);
    var r = newRecord(8, id);
    r.text = String(text || '');
    r.island = !!island;
    return register(node, r);
  }

  function makeFragment() {
    var node = Object.create(DocumentFragment.prototype);
    return register(node, newRecord(11));
  }

  function detach(child) {
    var c = rec(child);
    if (!c.parent) return;
    var parent = c.parent;
    var p = rec(parent);
    var was = isConnected(p);
    var at = p.kids.indexOf(child);
    if (at >= 0) p.kids.splice(at, 1);
    c.parent = null;
    if (was) forget(c);
    childrenChanged(p);
    mutated({ type: 'childList', target: parent, removedNodes: [child], previousSibling: p.kids[at - 1] || null, nextSibling: p.kids[at] || null });
  }

  function nodesFrom(args) {
    var list = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a === null || a === undefined) continue;
      if (typeof a === 'object' && rec(a)) list.push(a);
      else list.push(makeText(String(a)));
    }
    return list;
  }

  function contains(ancestor, node) {
    for (var n = node; n; n = rec(n).parent) if (n === ancestor) return true;
    return false;
  }

  // Put nodes into parent before ref (or at the end), a fragment's children
  // in its place, each taken from where it was first.
  function insert(parent, nodes, ref) {
    var p = rec(parent);
    if (p.type !== 1 && p.type !== 9 && p.type !== 11) throw new Error('This node cannot have children');
    if (p.island) {
      warnOnce('island-children', 'A part of the page SoftN draws (a component, a {value}, an #if or #each) cannot be given children by the page\u2019s code.');
      return;
    }
    var flat = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var nr = rec(n);
      if (nr.type === 11) {
        var inner = nr.kids.slice();
        for (var j = 0; j < inner.length; j++) { rec(inner[j]).parent = null; flat.push(inner[j]); }
        nr.kids = [];
      } else {
        if (contains(n, parent)) throw new Error('A node cannot be put inside itself');
        flat.push(n);
      }
    }
    for (var k = 0; k < flat.length; k++) {
      if (flat[k] === ref) ref = rec(ref).parent === parent ? nextSiblingOf(ref, flat) : ref;
      detach(flat[k]);
    }
    var at = ref ? p.kids.indexOf(ref) : -1;
    if (at < 0) at = p.kids.length;
    for (var m = 0; m < flat.length; m++) {
      rec(flat[m]).parent = parent;
      p.kids.splice(at + m, 0, flat[m]);
    }
    if (isConnected(p)) {
      for (var q = 0; q < flat.length; q++) announce(rec(flat[q]));
      ops.push(['c', p.id, kidIds(p)]);
    }
    if (flat.length > 0) {
      mutated({ type: 'childList', target: parent, addedNodes: flat, previousSibling: p.kids[at - 1] || null, nextSibling: p.kids[at + flat.length] || null });
    }
  }

  function nextSiblingOf(node, skipping) {
    var r = rec(node);
    var p = rec(r.parent);
    for (var i = p.kids.indexOf(node) + 1; i < p.kids.length; i++) {
      if (skipping.indexOf(p.kids[i]) < 0) return p.kids[i];
    }
    return null;
  }

  function replaceAllChildren(parent, nodes) {
    var p = rec(parent);
    var old = p.kids.slice();
    var was = isConnected(p);
    for (var i = 0; i < old.length; i++) {
      rec(old[i]).parent = null;
      if (was) forget(rec(old[i]));
    }
    p.kids = [];
    if (old.length > 0) mutated({ type: 'childList', target: parent, removedNodes: old });
    if (nodes.length > 0) insert(parent, nodes, null);
    else childrenChanged(p);
  }

  function textOf(r) {
    if (r.type === 3) return r.text;
    if (r.seen) return r.text;
    if (r.type === 8 || r.island) return '';
    var out = '';
    for (var i = 0; i < r.kids.length; i++) out += textOf(rec(r.kids[i]));
    return out;
  }

  function walk(r, visit) {
    for (var i = 0; i < r.kids.length; i++) {
      var child = r.kids[i];
      var c = rec(child);
      if (c.type === 1) {
        if (visit(child, c) === false) return false;
        if (!c.island && walk(c, visit) === false) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- attributes

  function getAttr(r, name) {
    name = String(name).toLowerCase();
    for (var i = 0; i < r.attrs.length; i++) if (r.attrs[i][0] === name) return r.attrs[i][1];
    return null;
  }

  function setAttr(node, name, value) {
    var r = rec(node);
    name = String(name).toLowerCase();
    value = String(value);
    if (r.island) {
      warnOnce('island-attrs', 'A component\u2019s attributes are SoftN\u2019s: the page\u2019s code can read them, not change them.');
      return;
    }
    if (name.indexOf('on') === 0 && name.length > 2) {
      r.inline[name.slice(2)] = inlineHandler(value);
      listen(name.slice(2));
      return;
    }
    for (var i = 0; i < r.attrs.length; i++) {
      if (r.attrs[i][0] === name) {
        if (r.attrs[i][1] === value) return;
        var was = r.attrs[i][1];
        r.attrs[i][1] = value;
        attrChanged(r, name, value);
        mutated({ type: 'attributes', target: node, attributeName: name, oldValue: was });
        return;
      }
    }
    r.attrs.push([name, value]);
    attrChanged(r, name, value);
    mutated({ type: 'attributes', target: node, attributeName: name, oldValue: null });
  }

  function removeAttr(node, name) {
    var r = rec(node);
    name = String(name).toLowerCase();
    if (r.island) return;
    if (name.indexOf('on') === 0 && name.length > 2) { delete r.inline[name.slice(2)]; return; }
    for (var i = 0; i < r.attrs.length; i++) {
      if (r.attrs[i][0] === name) {
        var was = r.attrs[i][1];
        r.attrs.splice(i, 1);
        attrChanged(r, name, null);
        mutated({ type: 'attributes', target: node, attributeName: name, oldValue: was });
        return;
      }
    }
  }

  // onclick="..." in HTML the code wrote: its code, run as a browser runs a
  // handler attribute, with the element as this and the event as event, in
  // the page's global scope. Compiled once for each text: the engine keeps
  // what it compiles for as long as it runs, so a list redrawn every second
  // must not compile its handlers every second.
  var HANDLERS = {};
  var handlerCount = 0;
  function inlineHandler(code) {
    if (Object.prototype.hasOwnProperty.call(HANDLERS, code)) return HANDLERS[code];
    var fn = null;
    try {
      fn = (0, eval)('(function (event) {\n' + code + '\n})');
    } catch (error) {
      warnOnce('inline:' + code, 'on...="' + code + '" written by the page\u2019s code is not JavaScript: ' + (error && error.message ? error.message : error));
      HANDLERS[code] = null;
      return null;
    }
    var handler = function (event) {
      if (fn.call(this, event) === false) event.preventDefault();
    };
    if (++handlerCount > 500) { HANDLERS = {}; handlerCount = 1; }
    HANDLERS[code] = handler;
    return handler;
  }

  // ---------------------------------------------------------------- style and lists

  function kebab(name) {
    if (name.indexOf('--') === 0) return name;
    return String(name).replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
  }

  function parseStyle(text) {
    var out = [];
    var parts = String(text || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var at = parts[i].indexOf(':');
      if (at <= 0) continue;
      var name = parts[i].slice(0, at).trim();
      var value = parts[i].slice(at + 1).trim();
      if (name && value) out.push([name.indexOf('--') === 0 ? name : name.toLowerCase(), value]);
    }
    return out;
  }

  function styleText(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) parts.push(list[i][0] + ': ' + list[i][1]);
    return parts.join('; ');
  }

  function styleOf(node) {
    var r = rec(node);
    if (r.style) return r.style;
    function read() { return parseStyle(getAttr(r, 'style')); }
    function write(list) {
      if (list.length === 0) removeAttr(node, 'style');
      else setAttr(node, 'style', styleText(list));
    }
    function setOne(name, value) {
      var list = read();
      var key = kebab(name);
      var found = false;
      var text = value === null || value === undefined ? '' : String(value);
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === key) {
          found = true;
          if (text === '') list.splice(i, 1);
          else list[i][1] = text;
          break;
        }
      }
      if (!found && text !== '') list.push([key, text]);
      write(list);
    }
    function getOne(name) {
      var key = kebab(name);
      var list = read();
      for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i][1];
      return '';
    }
    var methods = {
      setProperty: function (name, value) { setOne(name, value); },
      getPropertyValue: function (name) { return getOne(name); },
      removeProperty: function (name) { var was = getOne(name); setOne(name, ''); return was; },
    };
    r.style = new Proxy({}, {
      get: function (target, key) {
        if (key === 'cssText') return getAttr(r, 'style') || '';
        if (key === 'length') return read().length;
        if (methods[key]) return methods[key];
        if (typeof key !== 'string') return undefined;
        return getOne(key);
      },
      set: function (target, key, value) {
        if (key === 'cssText') { write(parseStyle(value)); return true; }
        setOne(key, value);
        return true;
      },
    });
    return r.style;
  }

  function classesOf(r) {
    var text = getAttr(r, 'class');
    return text ? text.split(/\s+/).filter(function (c) { return c !== ''; }) : [];
  }

  function classListOf(node) {
    var r = rec(node);
    if (r.classList) return r.classList;
    function write(list) { setAttr(node, 'class', list.join(' ')); }
    r.classList = {
      add: function () {
        var list = classesOf(r);
        for (var i = 0; i < arguments.length; i++) if (list.indexOf(String(arguments[i])) < 0) list.push(String(arguments[i]));
        write(list);
      },
      remove: function () {
        var list = classesOf(r);
        for (var i = 0; i < arguments.length; i++) {
          var at = list.indexOf(String(arguments[i]));
          if (at >= 0) list.splice(at, 1);
        }
        write(list);
      },
      toggle: function (name, force) {
        var list = classesOf(r);
        var at = list.indexOf(String(name));
        var on = force === undefined ? at < 0 : !!force;
        if (on && at < 0) list.push(String(name));
        if (!on && at >= 0) list.splice(at, 1);
        write(list);
        return on;
      },
      contains: function (name) { return classesOf(r).indexOf(String(name)) >= 0; },
      replace: function (a, b) {
        var list = classesOf(r);
        var at = list.indexOf(String(a));
        if (at < 0) return false;
        list[at] = String(b);
        write(list);
        return true;
      },
      item: function (i) { var list = classesOf(r); return i < list.length ? list[i] : null; },
      forEach: function (fn) { classesOf(r).forEach(fn); },
      toString: function () { return getAttr(r, 'class') || ''; },
    };
    Object.defineProperty(r.classList, 'length', { get: function () { return classesOf(r).length; } });
    r.classList[Symbol.iterator] = function () { return classesOf(r)[Symbol.iterator](); };
    r.classList.entries = function () { return classesOf(r).entries(); };
    r.classList.values = function () { return classesOf(r).values(); };
    r.classList.keys = function () { return classesOf(r).keys(); };
    Object.defineProperty(r.classList, 'value', { get: function () { return getAttr(r, 'class') || ''; } });
    return r.classList;
  }

  function dataName(key) { return 'data-' + String(key).replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }

  function datasetOf(node) {
    var r = rec(node);
    if (r.dataset) return r.dataset;
    r.dataset = new Proxy({}, {
      get: function (target, key) {
        if (typeof key !== 'string') return undefined;
        var value = getAttr(r, dataName(key));
        return value === null ? undefined : value;
      },
      set: function (target, key, value) { setAttr(node, dataName(key), value); return true; },
      deleteProperty: function (target, key) { removeAttr(node, dataName(key)); return true; },
      has: function (target, key) { return typeof key === 'string' && getAttr(r, dataName(key)) !== null; },
      // Object.keys(el.dataset), for…in and {...el.dataset} see what is set.
      ownKeys: function () {
        return r.attrs.filter(function (a) { return a[0].indexOf('data-') === 0; }).map(function (a) {
          return a[0].slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
        });
      },
      getOwnPropertyDescriptor: function (target, key) {
        var value = typeof key === 'string' ? getAttr(r, dataName(key)) : null;
        return value === null ? undefined : { value: value, writable: true, enumerable: true, configurable: true };
      },
    });
    return r.dataset;
  }

  // ---------------------------------------------------------------- selectors

  var SELECTORS = {};
  var selectorCount = 0;

  function parseSelectors(text) {
    if (SELECTORS[text]) return SELECTORS[text];
    var groups = [];
    var i = 0;
    var s = String(text);
    function skipSpace() { var start = i; while (i < s.length && /\s/.test(s.charAt(i))) i++; return i > start; }
    function ident() {
      var start = i;
      while (i < s.length && (/[\w\-]/.test(s.charAt(i)) || s.charCodeAt(i) > 127)) i++;
      if (start === i) throw new Error('"' + s + '" is not a selector this document reads');
      return s.slice(start, i);
    }
    function balanced() {
      var depth = 1;
      var start = i;
      while (i < s.length && depth > 0) {
        var ch = s.charAt(i);
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      return s.slice(start, i - 1);
    }
    function compound() {
      var c = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
      var any = false;
      while (i < s.length) {
        var ch = s.charAt(i);
        if (ch === '*') { i++; any = true; }
        else if (ch === '#') { i++; c.id = ident(); any = true; }
        else if (ch === '.') { i++; c.classes.push(ident()); any = true; }
        else if (ch === '[') {
          i++;
          skipSpace();
          var name = ident().toLowerCase();
          skipSpace();
          var op = null;
          var value = null;
          var m = /^([~|^$*]?=)/.exec(s.slice(i));
          if (m) {
            op = m[1];
            i += op.length;
            skipSpace();
            var q = s.charAt(i);
            if (q === '"' || q === "'") {
              var end = s.indexOf(q, i + 1);
              value = s.slice(i + 1, end);
              i = end + 1;
            } else {
              value = ident();
            }
            skipSpace();
          }
          var insensitive = false;
          if (op && (s.charAt(i) === 'i' || s.charAt(i) === 'I')) { insensitive = true; i++; skipSpace(); }
          if (s.charAt(i) !== ']') throw new Error('"' + s + '" is not a selector this document reads');
          i++;
          c.attrs.push({ name: name, op: op, value: value, i: insensitive });
          any = true;
        } else if (ch === ':') {
          i++;
          if (s.charAt(i) === ':') i++;
          var pseudo = ident().toLowerCase();
          var arg = null;
          if (s.charAt(i) === '(') { i++; arg = balanced(); }
          c.pseudos.push({ name: pseudo, arg: arg });
          any = true;
        } else if (/[\w\-]/.test(ch)) {
          c.tag = ident().toLowerCase();
          any = true;
        } else break;
      }
      if (!any) throw new Error('"' + s + '" is not a selector this document reads');
      return c;
    }
    var current = [];
    skipSpace();
    while (i < s.length) {
      current.push({ compound: compound(), combinator: null });
      var spaced = skipSpace();
      var ch = s.charAt(i);
      if (ch === ',') {
        i++;
        skipSpace();
        groups.push(current);
        current = [];
        continue;
      }
      if (i >= s.length) break;
      if (ch === '>' || ch === '+' || ch === '~') {
        current[current.length - 1].combinator = ch;
        i++;
        skipSpace();
      } else if (spaced) {
        current[current.length - 1].combinator = ' ';
      } else {
        throw new Error('"' + s + '" is not a selector this document reads');
      }
    }
    if (current.length > 0) groups.push(current);
    if (++selectorCount > 500) { SELECTORS = {}; selectorCount = 1; }
    SELECTORS[text] = groups;
    return groups;
  }

  function elementSiblings(r) {
    if (!r.parent) return [];
    var p = rec(r.parent);
    var out = [];
    for (var i = 0; i < p.kids.length; i++) if (rec(p.kids[i]).type === 1) out.push(p.kids[i]);
    return out;
  }

  function nth(arg, index) {
    var a = String(arg).replace(/\s+/g, '').toLowerCase();
    if (a === 'odd') return index % 2 === 1;
    if (a === 'even') return index % 2 === 0;
    var m = /^([+-]?\d*)n([+-]\d+)?$/.exec(a);
    if (!m) return index === Number(a);
    var step = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    var offset = m[2] ? Number(m[2]) : 0;
    if (step === 0) return index === offset;
    var k = (index - offset) / step;
    return k >= 0 && Math.floor(k) === k;
  }

  function matchesCompound(node, c) {
    var r = rec(node);
    if (!r || r.type !== 1) return false;
    if (c.tag && c.tag !== r.tag) return false;
    if (c.id !== null && getAttr(r, 'id') !== c.id) return false;
    if (c.classes.length > 0) {
      var list = classesOf(r);
      for (var i = 0; i < c.classes.length; i++) if (list.indexOf(c.classes[i]) < 0) return false;
    }
    for (var j = 0; j < c.attrs.length; j++) {
      var a = c.attrs[j];
      var value = getAttr(r, a.name);
      if (value === null) return false;
      if (!a.op) continue;
      var want = a.value;
      if (a.i) { value = value.toLowerCase(); want = want.toLowerCase(); }
      if (a.op === '=' && value !== want) return false;
      if (a.op === '~=' && value.split(/\s+/).indexOf(want) < 0) return false;
      if (a.op === '^=' && (want === '' || value.indexOf(want) !== 0)) return false;
      if (a.op === '$=' && (want === '' || value.slice(-want.length) !== want)) return false;
      if (a.op === '*=' && (want === '' || value.indexOf(want) < 0)) return false;
      if (a.op === '|=' && value !== want && value.indexOf(want + '-') !== 0) return false;
    }
    for (var k = 0; k < c.pseudos.length; k++) {
      var p = c.pseudos[k];
      var siblings;
      switch (p.name) {
        case 'not': if (matchesAny(node, parseSelectors(p.arg))) return false; break;
        case 'is': case 'where': if (!matchesAny(node, parseSelectors(p.arg))) return false; break;
        case 'first-child': siblings = elementSiblings(r); if (siblings[0] !== node) return false; break;
        case 'last-child': siblings = elementSiblings(r); if (siblings[siblings.length - 1] !== node) return false; break;
        case 'only-child': if (elementSiblings(r).length !== 1) return false; break;
        case 'nth-child': siblings = elementSiblings(r); if (!nth(p.arg, siblings.indexOf(node) + 1)) return false; break;
        case 'nth-last-child': siblings = elementSiblings(r); if (!nth(p.arg, siblings.length - siblings.indexOf(node))) return false; break;
        case 'first-of-type': case 'last-of-type': case 'only-of-type':
          siblings = elementSiblings(r).filter(function (n) { return rec(n).tag === r.tag; });
          if (p.name === 'first-of-type' && siblings[0] !== node) return false;
          if (p.name === 'last-of-type' && siblings[siblings.length - 1] !== node) return false;
          if (p.name === 'only-of-type' && siblings.length !== 1) return false;
          break;
        case 'checked': if (!(node.checked || (r.tag === 'option' && node.selected))) return false; break;
        case 'disabled': if (getAttr(r, 'disabled') === null) return false; break;
        case 'enabled': if (getAttr(r, 'disabled') !== null) return false; break;
        case 'required': if (getAttr(r, 'required') === null) return false; break;
        case 'empty': if (r.kids.length > 0 || r.island) return false; break;
        case 'focus': if (activeId !== r.id) return false; break;
        case 'root': if (!r.parent || rec(r.parent).type !== 9) return false; break;
        case 'scope': if (node !== scopeNode) return false; break;
        case 'hover': case 'active': case 'visited': case 'focus-visible': case 'focus-within': return false;
        case 'link': if (r.tag !== 'a' || getAttr(r, 'href') === null) return false; break;
        default: throw new Error(':' + p.name + ' is not a selector this document reads');
      }
    }
    return true;
  }

  function matchesComplex(node, parts, at) {
    if (!matchesCompound(node, parts[at].compound)) return false;
    if (at === 0) return true;
    var combinator = parts[at - 1].combinator;
    var r = rec(node);
    if (combinator === '>') {
      var parent = r.parent;
      return !!parent && rec(parent).type === 1 && matchesComplex(parent, parts, at - 1);
    }
    if (combinator === ' ') {
      for (var up = r.parent; up && rec(up).type === 1; up = rec(up).parent) {
        if (matchesComplex(up, parts, at - 1)) return true;
      }
      return false;
    }
    var siblings = elementSiblings(r);
    var index = siblings.indexOf(node);
    if (combinator === '+') return index > 0 && matchesComplex(siblings[index - 1], parts, at - 1);
    if (combinator === '~') {
      for (var b = index - 1; b >= 0; b--) if (matchesComplex(siblings[b], parts, at - 1)) return true;
      return false;
    }
    return false;
  }

  function matchesAny(node, groups) {
    for (var i = 0; i < groups.length; i++) if (matchesComplex(node, groups[i], groups[i].length - 1)) return true;
    return false;
  }

  // The element a search was asked of, for :scope.
  var scopeNode = null;

  // A list the document hands back, which answers to item() as a NodeList does.
  function nodeList(list) {
    Object.defineProperty(list, 'item', { value: function (i) { return this[i] || null; }, enumerable: false, configurable: true });
    return list;
  }

  function query(root, selector, all) {
    var groups = parseSelectors(selector);
    var found = [];
    var outer = scopeNode;
    scopeNode = rec(root).type === 1 ? root : null;
    try {
      walk(rec(root), function (node) {
        if (matchesAny(node, groups)) {
          found.push(node);
          if (!all) return false;
        }
        return true;
      });
    } finally {
      scopeNode = outer;
    }
    return all ? nodeList(found) : found[0] || null;
  }

  // ---------------------------------------------------------------- HTML

  var ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
    bull: '\u2022', middot: '\u00b7', times: '\u00d7', divide: '\u00f7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
    cent: '\u00a2', deg: '\u00b0', plusmn: '\u00b1', laquo: '\u00ab', raquo: '\u00bb', larr: '\u2190', rarr: '\u2192',
    uarr: '\u2191', darr: '\u2193', hearts: '\u2665', check: '\u2713', star: '\u2606', starf: '\u2605', para: '\u00b6', sect: '\u00a7',
  };

  function fromCodePoint(code) {
    if (code < 0x10000) return String.fromCharCode(code);
    code -= 0x10000;
    return String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
  }

  function decode(text) {
    return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (whole, name) {
      if (name.charAt(0) === '#') {
        var code = name.charAt(1) === 'x' || name.charAt(1) === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return isFinite(code) && code > 0 && code < 0x110000 ? fromCodePoint(code) : whole;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole;
    });
  }

  function escapeText(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;'); }
  function escapeAttr(text) { return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;'); }

  function serialize(r) {
    if (r.type === 3) return escapeText(r.text);
    if (r.type === 8) return r.island ? '' : '<!--' + r.text + '-->';
    var inner = '';
    if (!r.island) for (var i = 0; i < r.kids.length; i++) inner += serialize(rec(r.kids[i]));
    if (r.type !== 1) return inner;
    var open = '<' + r.tag;
    for (var a = 0; a < r.attrs.length; a++) open += ' ' + r.attrs[a][0] + '="' + escapeAttr(r.attrs[a][1]) + '"';
    open += '>';
    if (VOID[r.tag]) return open;
    return open + inner + '</' + r.tag + '>';
  }

  // HTML as a browser reads a fragment of it, near enough for what code
  // writes into innerHTML: tags, attributes, text, comments, the elements
  // that have no end, the text of a <textarea>, and an <li> or <option> or
  // <p> that ends where the next begins.
  var CLOSES = { li: { li: 1 }, option: { option: 1 }, dt: { dt: 1, dd: 1 }, dd: { dt: 1, dd: 1 }, tr: { tr: 1 }, td: { td: 1, th: 1 }, th: { td: 1, th: 1 } };
  var FOREIGN = { svg: 1, path: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1, rect: 1, use: 1, stop: 1, image: 1, g: 1, math: 1 };
  var BLOCKS = { p: 1, div: 1, ul: 1, ol: 1, table: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, section: 1, article: 1, header: 1, footer: 1, form: 1, pre: 1, blockquote: 1, hr: 1 };

  function parseHTML(html) {
    var root = makeFragment();
    var stack = [root];
    var s = String(html);
    var i = 0;
    function top() { return stack[stack.length - 1]; }
    function append(node) {
      var parent = top();
      var pr = rec(parent);
      rec(node).parent = parent;
      pr.kids.push(node);
    }
    while (i < s.length) {
      var lt = s.indexOf('<', i);
      if (lt < 0) lt = s.length;
      if (lt > i) { append(makeText(decode(s.slice(i, lt)))); i = lt; continue; }
      if (s.slice(i, i + 4) === '<!--') {
        var end = s.indexOf('-->', i + 4);
        if (end < 0) end = s.length;
        append(makeComment(s.slice(i + 4, end)));
        i = end + 3;
        continue;
      }
      if (s.charAt(i + 1) === '!' || s.charAt(i + 1) === '?') {
        var close = s.indexOf('>', i);
        i = close < 0 ? s.length : close + 1;
        continue;
      }
      if (s.charAt(i + 1) === '/') {
        var m = /^<\/\s*([A-Za-z][\w\-]*)\s*>/.exec(s.slice(i));
        if (!m) { append(makeText('<')); i++; continue; }
        var name = m[1].toLowerCase();
        for (var d = stack.length - 1; d > 0; d--) {
          if (rec(stack[d]).tag === name) { stack.length = d; break; }
        }
        i += m[0].length;
        continue;
      }
      var tagMatch = /^<([A-Za-z][\w\-]*)/.exec(s.slice(i));
      if (!tagMatch) { append(makeText('<')); i++; continue; }
      var tag = tagMatch[1].toLowerCase();
      i += tagMatch[0].length;
      var attrs = [];
      var selfClosing = false;
      while (i < s.length) {
        while (i < s.length && /\s/.test(s.charAt(i))) i++;
        if (s.charAt(i) === '>') { i++; break; }
        if (s.slice(i, i + 2) === '/>') { selfClosing = true; i += 2; break; }
        var an = /^[^\s"'>\/=]+/.exec(s.slice(i));
        if (!an) { i++; continue; }
        i += an[0].length;
        while (i < s.length && /\s/.test(s.charAt(i))) i++;
        var value = '';
        if (s.charAt(i) === '=') {
          i++;
          while (i < s.length && /\s/.test(s.charAt(i))) i++;
          var q = s.charAt(i);
          if (q === '"' || q === "'") {
            var qe = s.indexOf(q, i + 1);
            if (qe < 0) qe = s.length;
            value = decode(s.slice(i + 1, qe));
            i = qe + 1;
          } else {
            var uv = /^[^\s>]+/.exec(s.slice(i));
            value = uv ? decode(uv[0]) : '';
            i += uv ? uv[0].length : 0;
          }
        }
        attrs.push([an[0].toLowerCase(), value]);
      }
      var closes = CLOSES[tag];
      if (closes && closes[rec(top()).tag]) stack.pop();
      if (BLOCKS[tag] && rec(top()).tag === 'p') stack.pop();
      // A row written straight into a table is in a <tbody> the browser adds.
      if (tag === 'tr' && rec(top()).tag === 'table') {
        var tbody = makeElement('tbody');
        append(tbody);
        stack.push(tbody);
      }
      var el = makeElement(tag);
      for (var k = 0; k < attrs.length; k++) setAttr(el, attrs[k][0], attrs[k][1]);
      append(el);
      if (RAW_TEXT[tag]) {
        var rawEnd = s.toLowerCase().indexOf('</' + tag, i);
        if (rawEnd < 0) rawEnd = s.length;
        var raw = s.slice(i, rawEnd);
        if (raw !== '') {
          var t = makeText(tag === 'textarea' || tag === 'title' ? decode(raw) : raw);
          rec(t).parent = el;
          rec(el).kids.push(t);
        }
        var gt = s.indexOf('>', rawEnd);
        i = gt < 0 ? s.length : gt + 1;
        continue;
      }
      if (!VOID[tag] && !(selfClosing && FOREIGN[tag])) stack.push(el);
    }
    return rec(root).kids.slice();
  }

  function setInnerHTML(node, html) {
    if (rec(node).tag === 'template') {
      var content = node.content;
      replaceAllChildren(content, parseHTML(html).map(function (n) { rec(n).parent = null; return n; }));
      return;
    }
    var nodes = parseHTML(html);
    for (var i = 0; i < nodes.length; i++) rec(nodes[i]).parent = null;
    replaceAllChildren(node, nodes);
  }

  // ---------------------------------------------------------------- events

  function Event(type, init) {
    init = init || {};
    this.type = String(type);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.composed = !!init.composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.isTrusted = false;
    this.timeStamp = Date.now();
    this.detail = init.detail === undefined ? null : init.detail;
    Object.defineProperty(this, '_stop', { value: 0, writable: true, enumerable: false });
    Object.defineProperty(this, '_captureStop', { value: false, writable: true, enumerable: false });
  }
  Event.prototype.preventDefault = function () { if (this.cancelable) this.defaultPrevented = true; };
  Event.prototype.stopPropagation = function () { if (this._stop < 1) this._stop = 1; };
  Event.prototype.stopImmediatePropagation = function () { this._stop = 2; };
  Event.prototype.composedPath = function () {
    var path = [];
    for (var n = this.target; n; n = rec(n).parent) path.push(n);
    return path;
  };
  function subEvent(defaults) {
    function E(type, init) {
      Event.call(this, type, init);
      init = init || {};
      for (var key in defaults) this[key] = init[key] === undefined ? defaults[key] : init[key];
    }
    E.prototype = Object.create(Event.prototype);
    E.prototype.constructor = E;
    return E;
  }
  var CustomEvent = subEvent({});
  var KeyboardEvent = subEvent({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false });
  var MouseEvent = subEvent({ clientX: 0, clientY: 0, pageX: 0, pageY: 0, button: 0, buttons: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
  var PointerEvent = subEvent({ clientX: 0, clientY: 0, pageX: 0, pageY: 0, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0, width: 1, height: 1, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
  var DragEvent = subEvent({ clientX: 0, clientY: 0, dataTransfer: null });
  var InputEvent = subEvent({ data: null, inputType: '' });
  var FocusEvent = subEvent({ relatedTarget: null });
  var SubmitEvent = subEvent({ submitter: null });

  function addListener(node, type, fn, options) {
    if (fn === null || fn === undefined) return;
    var r = rec(node);
    var capture = options === true || !!(options && options.capture);
    var once = !!(options && options.once);
    var list = r.listeners[type] || (r.listeners[type] = []);
    for (var i = 0; i < list.length; i++) if (list[i].fn === fn && list[i].capture === capture) return;
    list.push({ fn: fn, capture: capture, once: once });
    if (r.type !== 0) listen(type);
  }

  function removeListener(node, type, fn, options) {
    var r = rec(node);
    var capture = options === true || !!(options && options.capture);
    var list = r.listeners[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i].fn === fn && list[i].capture === capture) { list.splice(i, 1); return; }
    }
  }

  function invoke(node, event, phase) {
    var r = rec(node);
    event.currentTarget = node;
    var list = (r.listeners[event.type] || []).slice();
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (phase === 1 && !l.capture) continue;
      if (phase === 3 && l.capture) continue;
      // Taken off by a listener before it, during this event: not run.
      if ((r.listeners[event.type] || []).indexOf(l) < 0) continue;
      if (l.once) removeListener(node, event.type, l.fn, l.capture);
      try {
        if (typeof l.fn === 'function') l.fn.call(node, event);
        else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(event);
      } catch (error) {
        console.error('[SoftN] A ' + event.type + ' listener failed: ' + (error && error.message ? error.message : error));
      }
      if (event._stop === 2) return;
    }
    var inline = phase !== 1 ? r.inline[event.type] : null;
    if (inline) {
      try { inline.call(node, event); } catch (error) {
        console.error('[SoftN] An on' + event.type + ' handler failed: ' + (error && error.message ? error.message : error));
      }
    }
  }

  function dispatch(target, event) {
    var path = [];
    for (var n = target; n; n = rec(n).parent) path.push(n);
    event.target = target;
    event._stop = 0;
    for (var i = path.length - 1; i > 0 && event._stop === 0; i--) { event.eventPhase = 1; invoke(path[i], event, 1); }
    event._captureStop = event._stop !== 0;
    if (event._stop === 0) { event.eventPhase = 2; invoke(target, event, 2); }
    if (event.bubbles) for (var j = 1; j < path.length && event._stop === 0; j++) { event.eventPhase = 3; invoke(path[j], event, 3); }
    event.eventPhase = 0;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }

  // What a click does after its listeners, for a click the code made: a box
  // is ticked, and a form's button sends its form.
  function clickDefault(node) {
    var r = rec(node);
    var type = (getAttr(r, 'type') || '').toLowerCase();
    if (r.tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      node.checked = type === 'radio' ? true : !node.checked;
      dispatch(node, new Event('input', { bubbles: true }));
      dispatch(node, new Event('change', { bubbles: true }));
    } else if ((r.tag === 'button' && type !== 'button' && type !== 'reset') || (r.tag === 'input' && type === 'submit')) {
      var form = node.closest('form');
      if (form) {
        form.requestSubmit(node);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- classes

  class EventTarget {
    // One of the page's own (new EventTarget(), an AbortSignal): listeners,
    // with no place in the document.
    constructor() { if (!rec(this)) STATE.set(this, newRecord(0, -1)); }
    addEventListener(type, fn, options) { addListener(this, String(type), fn, options); }
    removeEventListener(type, fn, options) { removeListener(this, String(type), fn, options); }
    dispatchEvent(event) { return dispatch(this, event); }
  }

  class Node extends EventTarget {
    get nodeType() { return rec(this).type; }
    get parentNode() { return rec(this).parent; }
    get parentElement() { var p = rec(this).parent; return p && rec(p).type === 1 ? p : null; }
    get childNodes() { return nodeList(rec(this).kids.slice()); }
    get firstChild() { var k = rec(this).kids; return k.length ? k[0] : null; }
    get lastChild() { var k = rec(this).kids; return k.length ? k[k.length - 1] : null; }
    get nextSibling() { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; return k[k.indexOf(this) + 1] || null; }
    get previousSibling() { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; var at = k.indexOf(this); return at > 0 ? k[at - 1] : null; }
    get ownerDocument() { return doc; }
    get isConnected() { return isConnected(rec(this)); }
    get textContent() { return textOf(rec(this)); }
    set textContent(value) {
      var r = rec(this);
      if (r.type === 3 || r.type === 8) { this.nodeValue = value; return; }
      var text = value === null || value === undefined ? '' : String(value);
      replaceAllChildren(this, text === '' ? [] : [makeText(text)]);
    }
    get nodeValue() { var r = rec(this); return r.type === 3 || r.type === 8 ? r.text : null; }
    set nodeValue(value) {
      var r = rec(this);
      if (r.type !== 3 && r.type !== 8) return;
      var was = r.text;
      r.text = value === null || value === undefined ? '' : String(value);
      if (r.type === 3 && isConnected(r)) ops.push(['x', r.id, r.text]);
      if (was !== r.text) mutated({ type: 'characterData', target: this, oldValue: was });
    }
    appendChild(child) { insert(this, [child], null); return child; }
    insertBefore(child, ref) { insert(this, [child], ref || null); return child; }
    removeChild(child) {
      if (!child || rec(child).parent !== this) throw new Error('The node to remove is not a child of this node');
      detach(child);
      return child;
    }
    replaceChild(child, old) { insert(this, [child], old); if (rec(old).parent === this) detach(old); return old; }
    hasChildNodes() { return rec(this).kids.length > 0; }
    contains(other) { return !!other && contains(this, other); }
    getRootNode() { var n = this; while (rec(n).parent) n = rec(n).parent; return n; }
    cloneNode(deep) { return clone(this, !!deep); }
    isSameNode(other) { return other === this; }
    normalize() {}
  }
  Node.ELEMENT_NODE = 1;
  Node.TEXT_NODE = 3;
  Node.COMMENT_NODE = 8;
  Node.DOCUMENT_NODE = 9;
  Node.DOCUMENT_FRAGMENT_NODE = 11;

  function clone(node, deep) {
    var r = rec(node);
    var copy;
    if (r.type === 3) return makeText(r.text);
    if (r.type === 8) return makeComment(r.text);
    if (r.type === 11) copy = makeFragment();
    else {
      if (r.island) warnOnce('island-clone', 'A part of the page SoftN draws is copied as an empty element of its kind.');
      copy = makeElement(r.tag);
      var cr = rec(copy);
      for (var i = 0; i < r.attrs.length; i++) if (!/^on/i.test(r.attrs[i][0])) cr.attrs.push([r.attrs[i][0], r.attrs[i][1]]);
      for (var type in r.inline) cr.inline[type] = r.inline[type];
      if (r.value !== undefined) cr.value = r.value;
      if (r.checked !== undefined) cr.checked = r.checked;
      if (deep && r.content) cr.content = clone(r.content, true);
    }
    if (deep && !r.island) {
      for (var k = 0; k < r.kids.length; k++) {
        var child = clone(r.kids[k], true);
        rec(child).parent = copy;
        rec(copy).kids.push(child);
      }
    }
    return copy;
  }

  // The methods an element, a fragment and the document share for finding
  // what is in them and putting things in them.
  var PARENT_METHODS = {
    querySelector: function (selector) { return query(this, selector, false); },
    querySelectorAll: function (selector) { return query(this, selector, true); },
    getElementsByTagName: function (tag) { return tag === '*' ? query(this, '*', true) : query(this, String(tag).toLowerCase(), true); },
    getElementsByClassName: function (names) {
      var want = String(names).split(/\s+/).filter(function (c) { return c !== ''; });
      var found = [];
      walk(rec(this), function (node, r) {
        var list = classesOf(r);
        for (var i = 0; i < want.length; i++) if (list.indexOf(want[i]) < 0) return true;
        found.push(node);
        return true;
      });
      return found;
    },
    append: function () { insert(this, nodesFrom(arguments), null); },
    prepend: function () { insert(this, nodesFrom(arguments), rec(this).kids[0] || null); },
    replaceChildren: function () { replaceAllChildren(this, nodesFrom(arguments)); },
  };
  function mix(proto, methods) { for (var key in methods) proto[key] = methods[key]; }
  function defineGetters(proto, getters) {
    for (var key in getters) Object.defineProperty(proto, key, { get: getters[key], configurable: true });
  }
  var PARENT_GETTERS = {
    children: function () { return nodeList(rec(this).kids.filter(function (n) { return rec(n).type === 1; })); },
    childElementCount: function () { return this.children.length; },
    firstElementChild: function () { return this.children[0] || null; },
    lastElementChild: function () { var c = this.children; return c[c.length - 1] || null; },
  };

  class Element extends Node {
    get tagName() { return rec(this).tag.toUpperCase(); }
    get nodeName() { return rec(this).tag.toUpperCase(); }
    get localName() { return rec(this).tag; }
    get id() { return getAttr(rec(this), 'id') || ''; }
    set id(value) { setAttr(this, 'id', value); }
    get className() { return getAttr(rec(this), 'class') || ''; }
    set className(value) { setAttr(this, 'class', value); }
    get classList() { return classListOf(this); }
    get dataset() { return datasetOf(this); }
    get style() { return styleOf(this); }
    set style(value) { setAttr(this, 'style', value); }
    get attributes() {
      return rec(this).attrs.map(function (a) { return { name: a[0], value: a[1] }; });
    }
    get innerHTML() {
      var r = rec(this);
      var from = r.tag === 'template' ? rec(this.content) : r;
      var out = '';
      if (!r.island || r.tag === 'template') for (var i = 0; i < from.kids.length; i++) out += serialize(rec(from.kids[i]));
      return out;
    }
    set innerHTML(html) {
      if (rec(this).island) { warnOnce('island-children', 'A part of the page SoftN draws cannot be given children by the page\u2019s code.'); return; }
      setInnerHTML(this, html === null || html === undefined ? '' : html);
    }
    get outerHTML() { return serialize(rec(this)); }
    get innerText() { return this.textContent; }
    set innerText(value) { this.textContent = value; }
    get nextElementSibling() { var s = elementSiblings(rec(this)); return s[s.indexOf(this) + 1] || null; }
    get previousElementSibling() { var s = elementSiblings(rec(this)); var at = s.indexOf(this); return at > 0 ? s[at - 1] : null; }
    getAttribute(name) { return getAttr(rec(this), name); }
    setAttribute(name, value) { setAttr(this, name, value); }
    removeAttribute(name) { removeAttr(this, name); }
    hasAttribute(name) { return getAttr(rec(this), name) !== null; }
    hasAttributes() { return rec(this).attrs.length > 0; }
    toggleAttribute(name, force) {
      var has = this.hasAttribute(name);
      var on = force === undefined ? !has : !!force;
      if (on && !has) setAttr(this, name, '');
      if (!on && has) removeAttr(this, name);
      return on;
    }
    getAttributeNames() { return rec(this).attrs.map(function (a) { return a[0]; }); }
    matches(selector) { return matchesAny(this, parseSelectors(selector)); }
    closest(selector) {
      var groups = parseSelectors(selector);
      for (var n = this; n && rec(n).type === 1; n = rec(n).parent) if (matchesAny(n, groups)) return n;
      return null;
    }
    remove() { if (rec(this).parent) detach(this); }
    before() { var r = rec(this); if (r.parent) insert(r.parent, nodesFrom(arguments), this); }
    after() { var r = rec(this); if (r.parent) insert(r.parent, nodesFrom(arguments), nextSiblingOf(this, [])); }
    replaceWith() {
      var r = rec(this);
      if (!r.parent) return;
      var parent = r.parent;
      var nodes = nodesFrom(arguments);
      insert(parent, nodes, this);
      if (rec(this).parent === parent) detach(this);
    }
    insertAdjacentElement(position, node) { adjacent(this, position, [node]); return node; }
    insertAdjacentText(position, text) { adjacent(this, position, [makeText(text)]); }
    insertAdjacentHTML(position, html) { adjacent(this, position, parseHTML(html).map(function (n) { rec(n).parent = null; return n; })); }
    focus() { var r = rec(this); activeId = r.id; propChanged(r, 'focus', true); }
    blur() { var r = rec(this); if (activeId === r.id) activeId = 0; propChanged(r, 'blur', true); }
    click() {
      var event = new MouseEvent('click', { bubbles: true, cancelable: true });
      if (dispatch(this, event)) clickDefault(this);
    }
    scrollIntoView() { propChanged(rec(this), 'scrollIntoView', true); }
    // The pointer is the host's to hold; a drag that leaves the element is
    // still heard, by the window's own listeners.
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() { return false; }
    getBoundingClientRect() { return boxRect(measured(this)); }
    getClientRects() { var box = measured(this); return box ? [boxRect(box)] : []; }
    get offsetWidth() { var box = measured(this); return box ? Math.round(box.w) : 0; }
    get offsetHeight() { var box = measured(this); return box ? Math.round(box.h) : 0; }
    get offsetTop() { var box = measured(this); return box ? Math.round(box.y) : 0; }
    get offsetLeft() { var box = measured(this); return box ? Math.round(box.x) : 0; }
    get clientWidth() { var box = measured(this); return box ? Math.round(box.w) : 0; }
    get clientHeight() { var box = measured(this); return box ? Math.round(box.h) : 0; }
    get scrollWidth() { var box = measured(this); return box ? Math.round(box.w) : 0; }
    get scrollHeight() { var box = measured(this); return box ? Math.round(box.h) : 0; }
  }
  mix(Element.prototype, PARENT_METHODS);
  defineGetters(Element.prototype, PARENT_GETTERS);

  function adjacent(node, position, nodes) {
    var r = rec(node);
    var where = String(position).toLowerCase();
    if (where === 'beforebegin') { if (r.parent) insert(r.parent, nodes, node); }
    else if (where === 'afterbegin') insert(node, nodes, r.kids[0] || null);
    else if (where === 'beforeend') insert(node, nodes, null);
    else if (where === 'afterend') { if (r.parent) insert(r.parent, nodes, nextSiblingOf(node, [])); }
    else throw new Error(position + ' is not a position');
  }

  class HTMLElement extends Element {}

  // Attributes an element shows as properties of the same name.
  function reflect(proto, names) {
    names.forEach(function (pair) {
      var prop = pair[0];
      var attr = pair[1];
      Object.defineProperty(proto, prop, {
        configurable: true,
        get: function () { var v = getAttr(rec(this), attr); return v === null ? '' : v; },
        set: function (value) { setAttr(this, attr, value); },
      });
    });
  }
  function reflectBoolean(proto, names) {
    names.forEach(function (pair) {
      var prop = pair[0];
      var attr = pair[1];
      Object.defineProperty(proto, prop, {
        configurable: true,
        get: function () { return getAttr(rec(this), attr) !== null; },
        set: function (value) { if (value) setAttr(this, attr, ''); else removeAttr(this, attr); },
      });
    });
  }
  reflect(HTMLElement.prototype, [
    ['title', 'title'], ['lang', 'lang'], ['dir', 'dir'], ['name', 'name'], ['placeholder', 'placeholder'],
    ['href', 'href'], ['src', 'src'], ['alt', 'alt'], ['rel', 'rel'], ['target', 'target'], ['action', 'action'],
    ['method', 'method'], ['min', 'min'], ['max', 'max'], ['step', 'step'], ['pattern', 'pattern'], ['role', 'role'],
    ['htmlFor', 'for'], ['accept', 'accept'], ['autocomplete', 'autocomplete'], ['download', 'download'], ['label', 'label'],
  ]);
  reflectBoolean(HTMLElement.prototype, [
    ['hidden', 'hidden'], ['disabled', 'disabled'], ['required', 'required'], ['readOnly', 'readonly'],
    ['multiple', 'multiple'], ['autofocus', 'autofocus'], ['open', 'open'], ['defaultChecked', 'checked'],
  ]);
  Object.defineProperty(HTMLElement.prototype, 'tabIndex', {
    configurable: true,
    get: function () { var v = getAttr(rec(this), 'tabindex'); return v === null ? -1 : Number(v); },
    set: function (value) { setAttr(this, 'tabindex', String(value)); },
  });
  Object.defineProperty(HTMLElement.prototype, 'type', {
    configurable: true,
    get: function () {
      var r = rec(this);
      var v = getAttr(r, 'type');
      if (v !== null) return v.toLowerCase();
      if (r.tag === 'input') return 'text';
      if (r.tag === 'button') return 'submit';
      if (r.tag === 'select') return getAttr(r, 'multiple') !== null ? 'select-multiple' : 'select-one';
      return '';
    },
    set: function (value) { setAttr(this, 'type', value); },
  });

  // on<type> = fn: one handler of each kind, as a browser keeps it.
  ['click', 'dblclick', 'input', 'change', 'submit', 'reset', 'keydown', 'keyup', 'keypress', 'focus', 'blur',
    'mousedown', 'mouseup', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'mousemove', 'contextmenu',
    'pointerdown', 'pointerup', 'pointermove', 'wheel', 'scroll', 'toggle', 'load', 'error', 'focusin', 'focusout'].forEach(function (type) {
    Object.defineProperty(HTMLElement.prototype, 'on' + type, {
      configurable: true,
      get: function () { return rec(this).inline[type] || null; },
      set: function (fn) {
        var r = rec(this);
        if (typeof fn === 'function') { r.inline[type] = fn; listen(type); }
        else delete r.inline[type];
      },
    });
  });

  // A field's value is the field's, not its attribute's: the attribute is
  // where it starts. What is typed comes in from the host (__softnDocSync).
  function fieldValue(r) {
    if (r.value !== undefined) return r.value;
    if (r.tag === 'textarea') return textOf(r);
    var v = getAttr(r, 'value');
    return v === null ? '' : v;
  }

  // What a form's checks say of a field: its validity, as a browser works it
  // out from required, type, pattern, minlength, maxlength, min, max and
  // step, and what setCustomValidity() said.
  var EMAIL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_\x60{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  var NOT_CHECKED = { hidden: 1, button: 1, submit: 1, reset: 1, image: 1 };
  var VALIDITY_MESSAGES = [
    ['valueMissing', 'Please fill in this field.'], ['typeMismatch', 'Please enter a valid value.'],
    ['patternMismatch', 'Please match the requested format.'], ['tooLong', 'Please shorten this text.'],
    ['tooShort', 'Please lengthen this text.'], ['rangeUnderflow', 'The value is too low.'],
    ['rangeOverflow', 'The value is too high.'], ['stepMismatch', 'Please enter a valid value.'],
    ['badInput', 'Please enter a number.'],
  ];
  function willValidate(r) {
    if (r.tag !== 'input' && r.tag !== 'select' && r.tag !== 'textarea') return false;
    if (getAttr(r, 'disabled') !== null || getAttr(r, 'readonly') !== null) return false;
    return !NOT_CHECKED[(getAttr(r, 'type') || '').toLowerCase()];
  }
  function inputNumber(type, text) {
    if (text === '' || text === null) return NaN;
    if (type === 'number' || type === 'range') return Number(text);
    return Date.parse(type === 'time' ? '1970-01-01T' + text + 'Z' : text);
  }
  function radioGroup(radio) {
    var name = getAttr(rec(radio), 'name');
    if (!name) return [radio];
    var scope = radio.closest('form') || doc;
    return query(scope, 'input[type="radio"]', true).filter(function (o) { return getAttr(rec(o), 'name') === name; });
  }
  function validityOf(node) {
    var r = rec(node);
    var v = {
      valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false,
      rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: !!r.customValidity, valid: true,
    };
    if (willValidate(r)) {
      var type = (getAttr(r, 'type') || '').toLowerCase();
      var required = getAttr(r, 'required') !== null;
      if (r.tag === 'input' && type === 'checkbox') v.valueMissing = required && !node.checked;
      else if (r.tag === 'input' && type === 'radio') {
        var group = radioGroup(node);
        if (group.some(function (o) { return getAttr(rec(o), 'required') !== null; })) v.valueMissing = !group.some(function (o) { return o.checked; });
      } else {
        var value = node.value;
        if (required && value === '') v.valueMissing = true;
        if (value !== '' && r.tag === 'input') {
          if (type === 'email') {
            var addresses = getAttr(r, 'multiple') !== null ? value.split(',') : [value];
            v.typeMismatch = addresses.some(function (a) { return !EMAIL.test(a.trim()); });
          }
          if (type === 'url') v.typeMismatch = !/^[a-z][a-z0-9+.-]*:\S+$/i.test(value);
          var pattern = getAttr(r, 'pattern');
          if (pattern !== null && /^(?:text|search|url|tel|email|password|)$/.test(type)) {
            try { v.patternMismatch = !new RegExp('^(?:' + pattern + ')$', 'v').test(value); } catch (e) {
              try { v.patternMismatch = !new RegExp('^(?:' + pattern + ')$', 'u').test(value); } catch (e2) { v.patternMismatch = false; }
            }
          }
          var n = inputNumber(type, value);
          if (/^(?:number|range|date|month|time|datetime-local)$/.test(type)) {
            if (isNaN(n)) v.badInput = type === 'number';
            else {
              var low = inputNumber(type, getAttr(r, 'min'));
              var high = inputNumber(type, getAttr(r, 'max'));
              if (!isNaN(low) && n < low) v.rangeUnderflow = true;
              if (!isNaN(high) && n > high) v.rangeOverflow = true;
              var step = getAttr(r, 'step');
              if ((type === 'number' || type === 'range') && step !== null && step !== 'any' && Number(step) > 0) {
                var steps = (n - (isNaN(low) ? 0 : low)) / Number(step);
                v.stepMismatch = Math.abs(steps - Math.round(steps)) > 1e-9;
              }
            }
          }
        }
        if (value !== '' && (r.tag === 'input' || r.tag === 'textarea')) {
          var maxLength = getAttr(r, 'maxlength');
          var minLength = getAttr(r, 'minlength');
          if (maxLength !== null && value.length > Number(maxLength)) v.tooLong = true;
          if (minLength !== null && value.length < Number(minLength)) v.tooShort = true;
        }
      }
    }
    v.valid = !(v.valueMissing || v.typeMismatch || v.patternMismatch || v.tooLong || v.tooShort ||
      v.rangeUnderflow || v.rangeOverflow || v.stepMismatch || v.badInput || v.customError);
    return v;
  }
  // A field's own checks, for an input, a select and a textarea alike.
  var FIELD_CHECKS = {
    checkValidity: function () {
      if (validityOf(this).valid) return true;
      dispatch(this, new Event('invalid', { cancelable: true }));
      return false;
    },
    reportValidity: function () {
      var valid = this.checkValidity();
      if (!valid) this.focus();
      return valid;
    },
    setCustomValidity: function (message) { rec(this).customValidity = message === undefined || message === null ? '' : String(message); },
  };
  var FIELD_CHECK_GETTERS = {
    validity: function () { return validityOf(this); },
    willValidate: function () { return willValidate(rec(this)); },
    validationMessage: function () {
      var r = rec(this);
      if (!willValidate(r)) return '';
      if (r.customValidity) return r.customValidity;
      var v = validityOf(this);
      for (var i = 0; i < VALIDITY_MESSAGES.length; i++) if (v[VALIDITY_MESSAGES[i][0]]) return VALIDITY_MESSAGES[i][1];
      return '';
    },
    labels: function () {
      var id = getAttr(rec(this), 'id');
      var found = id ? query(doc, 'label[for="' + id.replace(/"/g, '') + '"]', true) : [];
      var around = this.closest('label');
      if (around && found.indexOf(around) < 0) found.push(around);
      return nodeList(found);
    },
  };

  class HTMLInputElement extends HTMLElement {
    get value() { return fieldValue(rec(this)); }
    set value(v) { var r = rec(this); r.value = v === null || v === undefined ? '' : String(v); propChanged(r, 'value', r.value); }
    get defaultValue() { return getAttr(rec(this), 'value') || ''; }
    set defaultValue(v) { setAttr(this, 'value', v); }
    get checked() { var r = rec(this); return r.checked !== undefined ? r.checked : getAttr(r, 'checked') !== null; }
    set checked(v) {
      var r = rec(this);
      r.checked = !!v;
      propChanged(r, 'checked', r.checked);
      if (r.checked && (getAttr(r, 'type') || '').toLowerCase() === 'radio') uncheckGroup(this);
    }
    get valueAsNumber() { var n = parseFloat(this.value); return isNaN(n) ? NaN : n; }
    set valueAsNumber(n) { this.value = String(n); }
    get valueAsDate() {
      var type = (getAttr(rec(this), 'type') || '').toLowerCase();
      var t = /^(?:date|month|week|time)$/.test(type) ? inputNumber(type, this.value) : NaN;
      return isNaN(t) ? null : new Date(t);
    }
    set valueAsDate(date) {
      var type = (getAttr(rec(this), 'type') || '').toLowerCase();
      if (date === null) { this.value = ''; return; }
      var iso = new Date(date.getTime()).toISOString();
      this.value = type === 'time' ? iso.slice(11, 16) : type === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
    }
    get form() { return this.closest('form'); }
    select() {}
    setSelectionRange() {}
  }

  function uncheckGroup(radio) {
    var r = rec(radio);
    var name = getAttr(r, 'name');
    if (!name) return;
    var scope = radio.closest('form') || doc;
    var others = query(scope, 'input[type="radio"]', true);
    for (var i = 0; i < others.length; i++) {
      var o = rec(others[i]);
      if (others[i] !== radio && getAttr(o, 'name') === name && others[i].checked) {
        o.checked = false;
        propChanged(o, 'checked', false);
      }
    }
  }

  class HTMLTextAreaElement extends HTMLElement {
    get value() { return fieldValue(rec(this)); }
    set value(v) { var r = rec(this); r.value = v === null || v === undefined ? '' : String(v); propChanged(r, 'value', r.value); }
    get defaultValue() { return textOf(rec(this)); }
    set defaultValue(v) { this.textContent = v; }
    get form() { return this.closest('form'); }
    select() {}
    setSelectionRange() {}
  }

  class HTMLOptionElement extends HTMLElement {
    get value() { var v = getAttr(rec(this), 'value'); return v === null ? this.textContent.trim() : v; }
    set value(v) { setAttr(this, 'value', v); }
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
    get selected() {
      var select = this.closest('select');
      if (!select) return getAttr(rec(this), 'selected') !== null;
      return chosenIndexes(select).indexOf(select.options.indexOf(this)) >= 0;
    }
    set selected(v) {
      var select = this.closest('select');
      if (!select) return;
      var at = select.options.indexOf(this);
      if (getAttr(rec(select), 'multiple') === null) { if (v) select.selectedIndex = at; return; }
      var chosen = chosenIndexes(select).filter(function (i) { return i !== at; });
      if (v) chosen.push(at);
      choose(select, chosen.sort(function (a, b) { return a - b; }));
    }
    get index() { var select = this.closest('select'); return select ? select.options.indexOf(this) : 0; }
  }

  // What a select holds chosen: for one with multiple, every option chosen,
  // as the page shows them; for any other, the one at selectedIndex.
  function chosenIndexes(select) {
    var r = rec(select);
    if (getAttr(r, 'multiple') === null) { var i = select.selectedIndex; return i < 0 ? [] : [i]; }
    if (r.chosen !== undefined) return r.chosen.slice();
    var options = select.options;
    var out = [];
    for (var k = 0; k < options.length; k++) if (getAttr(rec(options[k]), 'selected') !== null) out.push(k);
    return out;
  }
  function choose(select, indexes) {
    var r = rec(select);
    r.chosen = indexes;
    r.selectedIndex = indexes.length ? indexes[0] : -1;
    propChanged(r, 'chosen', indexes);
  }

  class HTMLSelectElement extends HTMLElement {
    get options() { return query(this, 'option', true); }
    get selectedIndex() {
      var r = rec(this);
      if (r.selectedIndex !== undefined) return r.selectedIndex;
      var options = this.options;
      for (var i = 0; i < options.length; i++) if (getAttr(rec(options[i]), 'selected') !== null) return i;
      return options.length > 0 ? 0 : -1;
    }
    set selectedIndex(i) {
      var r = rec(this);
      if (getAttr(r, 'multiple') !== null) { choose(this, Number(i) < 0 ? [] : [Number(i)]); return; }
      r.selectedIndex = Number(i);
      propChanged(r, 'selectedIndex', r.selectedIndex);
    }
    get selectedOptions() {
      var options = this.options;
      return nodeList(chosenIndexes(this).map(function (i) { return options[i]; }).filter(Boolean));
    }
    get value() { var o = this.options[this.selectedIndex]; return o ? o.value : ''; }
    set value(v) {
      var options = this.options;
      for (var i = 0; i < options.length; i++) if (options[i].value === String(v)) { this.selectedIndex = i; return; }
      this.selectedIndex = -1;
    }
    get length() { return this.options.length; }
    get form() { return this.closest('form'); }
    add(option) { this.appendChild(option); }
  }

  // A form's fields, each also under its name and its id (a list of them
  // where several share one, as radio buttons do), as form.elements has them.
  function formFields(form) {
    var list = nodeList(query(form, 'input, select, textarea, button, fieldset, output', true));
    var named = {};
    for (var i = 0; i < list.length; i++) {
      var r = rec(list[i]);
      var keys = [getAttr(r, 'name'), getAttr(r, 'id')];
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (!key || /^\d+$/.test(key) || key in Array.prototype) continue;
        if (!named[key]) named[key] = [];
        if (named[key].indexOf(list[i]) < 0) named[key].push(list[i]);
      }
    }
    for (var name in named) {
      var found = named[name];
      Object.defineProperty(list, name, { value: found.length === 1 ? found[0] : radioNodeList(found), enumerable: false, configurable: true });
    }
    Object.defineProperty(list, 'namedItem', { value: function (n) { return this[n] && Object.prototype.hasOwnProperty.call(named, n) ? this[n] : null; }, enumerable: false, configurable: true });
    return list;
  }
  function radioNodeList(nodes) {
    var list = nodeList(nodes.slice());
    Object.defineProperty(list, 'value', {
      enumerable: false,
      get: function () { for (var i = 0; i < this.length; i++) if (this[i].checked) return this[i].value; return ''; },
      set: function (value) { for (var i = 0; i < this.length; i++) if (this[i].value === String(value)) { this[i].checked = true; return; } },
    });
    return list;
  }
  // form.email, as a browser has it: a form answers to its fields' names.
  var FORM_FIELDS = {
    get: function (target, key, receiver) {
      if (typeof key === 'string' && !(key in target)) {
        var field = formFields(receiver)[key];
        if (field) return field;
      }
      return Reflect.get(target, key, receiver);
    },
  };

  class HTMLFormElement extends HTMLElement {
    get elements() { return formFields(this); }
    get length() { return this.elements.length; }
    get noValidate() { return getAttr(rec(this), 'novalidate') !== null; }
    set noValidate(v) { if (v) setAttr(this, 'novalidate', ''); else removeAttr(this, 'novalidate'); }
    submit() {}
    requestSubmit(submitter) {
      // As a browser sends it: checked first, unless the form or the button says not to.
      var skip = this.noValidate || (submitter && getAttr(rec(submitter), 'formnovalidate') !== null);
      if (!skip && !this.reportValidity()) return;
      if (dispatch(this, new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null }))) {
        var dialog = (getAttr(rec(this), 'method') || '').toLowerCase() === 'dialog' ? this.closest('dialog') : null;
        if (dialog) dialog.close(submitter ? submitter.value : undefined);
        else warnOnce('form-submit', 'A form with nowhere to send what it holds is kept on the page.');
      }
    }
    reset() {
      var fields = this.elements;
      for (var i = 0; i < fields.length; i++) {
        var r = rec(fields[i]);
        if (r.value !== undefined) { delete r.value; propChanged(r, 'value', fieldValue(r)); }
        if (r.checked !== undefined) { delete r.checked; propChanged(r, 'checked', getAttr(r, 'checked') !== null); }
      }
      dispatch(this, new Event('reset', { bubbles: true }));
    }
    checkValidity() {
      var fields = this.elements;
      var valid = true;
      for (var i = 0; i < fields.length; i++) if (typeof fields[i].checkValidity === 'function' && !fields[i].checkValidity()) valid = false;
      return valid;
    }
    reportValidity() {
      var fields = this.elements;
      var first = null;
      for (var i = 0; i < fields.length; i++) {
        if (typeof fields[i].checkValidity === 'function' && !fields[i].checkValidity() && !first) first = fields[i];
      }
      if (first) first.focus();
      return !first;
    }
  }

  class HTMLButtonElement extends HTMLElement {
    get value() { return getAttr(rec(this), 'value') || ''; }
    set value(v) { setAttr(this, 'value', v); }
    get form() { return this.closest('form'); }
  }
  // An address an element names, as a browser gives it: whole, against where the page is.
  function addressOf(node, attr) {
    var v = getAttr(rec(node), attr);
    if (v === null) return '';
    try { return new URL(v, here.href || undefined).href; } catch (e) { return v; }
  }
  class HTMLAnchorElement extends HTMLElement {
    get text() { return this.textContent; }
    get href() { return addressOf(this, 'href'); }
    set href(v) { setAttr(this, 'href', v); }
    toString() { return this.href; }
  }
  ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(function (part) {
    Object.defineProperty(HTMLAnchorElement.prototype, part, {
      configurable: true,
      get: function () { var href = this.href; try { return href ? new URL(href)[part] : ''; } catch (e) { return ''; } },
    });
  });
  // <template>: what it holds is not on the page but in its content, a
  // fragment the page's code copies from.
  class HTMLTemplateElement extends HTMLElement {
    get content() { var r = rec(this); return r.content || (r.content = makeFragment()); }
  }

  // <dialog>: open, shown by show() where it is and by showModal() over the
  // rest of the app, closed with a returnValue. It is never put in the
  // browser's top layer, where the host's own controls could be covered:
  // modal, it is drawn over the app inside the app's box.
  class HTMLDialogElement extends HTMLElement {
    get returnValue() { var v = rec(this).returnValue; return v === undefined ? '' : v; }
    set returnValue(v) { rec(this).returnValue = String(v); }
    show() { if (!this.open) { setAttr(this, 'open', ''); heedDialogs(); } }
    showModal() {
      if (this.open) return;
      heedDialogs();
      setAttr(this, 'open', '');
      setAttr(this, 'data-softn-modal', '');
      var first = this.querySelector('[autofocus]') || this.querySelector('button, input, select, textarea, a[href], [tabindex]');
      if (first) first.focus();
    }
    close(value) {
      if (!this.open) return;
      if (value !== undefined) this.returnValue = value;
      removeAttr(this, 'open');
      removeAttr(this, 'data-softn-modal');
      dispatch(this, new Event('close'));
    }
    requestClose(value) {
      if (!this.open) return;
      if (dispatch(this, new Event('cancel', { cancelable: true }))) this.close(value);
    }
  }
  // What closes a dialog comes from the page: its form sent, Escape pressed.
  function heedDialogs() { listen('submit'); listen('keydown'); }

  // The modal dialog open now, if any: Escape asks it to close.
  function openModal() {
    var found = null;
    walk(rec(doc), function (node, r) {
      if (r.tag === 'dialog' && getAttr(r, 'data-softn-modal') !== null && getAttr(r, 'open') !== null) found = node;
      return true;
    });
    return found;
  }

  class HTMLOutputElement extends HTMLElement {
    get value() { return this.textContent; }
    set value(v) { this.textContent = v; }
    get defaultValue() { return this.textContent; }
    get form() { return this.closest('form'); }
  }
  class HTMLImageElement extends HTMLElement {
    get src() { return addressOf(this, 'src'); }
    set src(v) { setAttr(this, 'src', v); }
    get width() { return Number(getAttr(rec(this), 'width')) || 0; }
    get height() { return Number(getAttr(rec(this), 'height')) || 0; }
    get complete() { return true; }
  }

  var ELEMENT_CLASSES = {
    input: HTMLInputElement, textarea: HTMLTextAreaElement, select: HTMLSelectElement, option: HTMLOptionElement,
    form: HTMLFormElement, button: HTMLButtonElement, a: HTMLAnchorElement, img: HTMLImageElement, output: HTMLOutputElement,
    template: HTMLTemplateElement, dialog: HTMLDialogElement,
  };
  [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement].forEach(function (Field) {
    mix(Field.prototype, FIELD_CHECKS);
    defineGetters(Field.prototype, FIELD_CHECK_GETTERS);
  });

  class Text extends Node {
    get nodeName() { return '#text'; }
    get data() { return rec(this).text; }
    set data(value) { this.nodeValue = value; }
    get length() { return rec(this).text.length; }
    get wholeText() { return rec(this).text; }
    remove() { if (rec(this).parent) detach(this); }
  }

  class Comment extends Node {
    get nodeName() { return '#comment'; }
    get data() { return rec(this).text; }
    set data(value) { this.nodeValue = value; }
    remove() { if (rec(this).parent) detach(this); }
  }

  class DocumentFragment extends Node {
    get nodeName() { return '#document-fragment'; }
  }
  mix(DocumentFragment.prototype, PARENT_METHODS);
  defineGetters(DocumentFragment.prototype, PARENT_GETTERS);

  class Document extends Node {
    get nodeName() { return '#document'; }
    get documentElement() { return rec(this).kids[0] || null; }
    get head() { return rec(rec(this).kids[0]).kids[0]; }
    get body() { return rec(rec(this).kids[0]).kids[1]; }
    get title() { return rec(this).title || ''; }
    set title(value) { var r = rec(this); r.title = String(value); ops.push(['t', r.title]); }
    get readyState() { return rec(this).ready || 'loading'; }
    get activeElement() { return BY_ID[activeId] || this.body; }
    get defaultView() { return win; }
    get location() { return win && win.location; }
    getElementById(id) {
      var want = String(id);
      var found = null;
      walk(rec(this), function (node, r) {
        if (getAttr(r, 'id') === want) { found = node; return false; }
        return true;
      });
      return found;
    }
    getElementsByName(name) { return query(this, '[name="' + String(name).replace(/"/g, '') + '"]', true); }
    createElement(tag) { return makeElement(tag); }
    createElementNS(ns, tag) { return makeElement(tag); }
    createTextNode(text) { return makeText(text === undefined ? '' : text); }
    createComment(text) { return makeComment(text); }
    createDocumentFragment() { return makeFragment(); }
    createEvent() { return new Event(''); }
    hasFocus() { return true; }
    importNode(node, deep) { return clone(node, !!deep); }
    adoptNode(node) { if (rec(node).parent) detach(node); return node; }
  }
  mix(Document.prototype, PARENT_METHODS);
  defineGetters(Document.prototype, PARENT_GETTERS);

  // A form's fields by name, as sending it would give them.
  function FormData(form) {
    Object.defineProperty(this, '_entries', { value: [], writable: true, enumerable: false });
    if (!form) return;
    var fields = query(form, 'input, select, textarea', true);
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var r = rec(f);
      var name = getAttr(r, 'name');
      if (!name || getAttr(r, 'disabled') !== null) continue;
      var type = (getAttr(r, 'type') || '').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && !f.checked) continue;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file') continue;
      if (r.tag === 'select' && getAttr(r, 'multiple') !== null) {
        var chosen = f.selectedOptions;
        for (var c = 0; c < chosen.length; c++) this._entries.push([name, chosen[c].value]);
        continue;
      }
      this._entries.push([name, type === 'checkbox' || type === 'radio' ? (getAttr(r, 'value') || 'on') : f.value]);
    }
  }
  FormData.prototype.get = function (name) { for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] === name) return this._entries[i][1]; return null; };
  FormData.prototype.getAll = function (name) { return this._entries.filter(function (e) { return e[0] === name; }).map(function (e) { return e[1]; }); };
  FormData.prototype.has = function (name) { return this.get(name) !== null; };
  FormData.prototype.set = function (name, value) { this.delete(name); this._entries.push([String(name), String(value)]); };
  FormData.prototype.append = function (name, value) { this._entries.push([String(name), String(value)]); };
  FormData.prototype.delete = function (name) { this._entries = this._entries.filter(function (e) { return e[0] !== name; }); };
  FormData.prototype.entries = function () { return this._entries.slice(); };
  FormData.prototype.keys = function () { return this._entries.map(function (e) { return e[0]; }); };
  FormData.prototype.values = function () { return this._entries.map(function (e) { return e[1]; }); };
  FormData.prototype.forEach = function (fn) { for (var i = 0; i < this._entries.length; i++) fn(this._entries[i][1], this._entries[i][0], this); };
  FormData.prototype[Symbol.iterator] = function () { return this.entries()[Symbol.iterator](); };

  function getComputedStyle(node) { return node && rec(node) && rec(node).type === 1 ? styleOf(node) : {}; }

  // ---------------------------------------------------------------- the rest of the window

  // fetch, through softn.net.fetch: the app's permission.json says which
  // hosts it may reach, as it does for every request the app makes.
  function Headers(init) {
    Object.defineProperty(this, '_map', { value: {}, writable: true, enumerable: false });
    if (init && typeof init === 'object') {
      if (typeof init.forEach === 'function' && !Array.isArray(init)) {
        var self = this;
        init.forEach(function (value, name) { self.set(name, value); });
      } else if (Array.isArray(init)) {
        for (var i = 0; i < init.length; i++) this.set(init[i][0], init[i][1]);
      } else {
        for (var key in init) this.set(key, init[key]);
      }
    }
  }
  Headers.prototype.get = function (name) { var v = this._map[String(name).toLowerCase()]; return v === undefined ? null : v; };
  Headers.prototype.has = function (name) { return this._map[String(name).toLowerCase()] !== undefined; };
  Headers.prototype.set = function (name, value) { this._map[String(name).toLowerCase()] = String(value); };
  Headers.prototype.append = function (name, value) { var k = String(name).toLowerCase(); this._map[k] = this._map[k] === undefined ? String(value) : this._map[k] + ', ' + String(value); };
  Headers.prototype.delete = function (name) { delete this._map[String(name).toLowerCase()]; };
  Headers.prototype.forEach = function (fn) { for (var k in this._map) fn(this._map[k], k, this); };
  Headers.prototype.entries = function () { var out = []; for (var k in this._map) out.push([k, this._map[k]]); return out; };
  Headers.prototype.keys = function () { return Object.keys(this._map); };
  Headers.prototype.values = function () { var m = this._map; return Object.keys(m).map(function (k) { return m[k]; }); };
  Headers.prototype[Symbol.iterator] = function () { return this.entries()[Symbol.iterator](); };

  function Response(result, url) {
    var body = result.body === undefined || result.body === null ? '' : String(result.body);
    this.ok = !!result.ok;
    this.status = Number(result.status) || 0;
    this.statusText = result.statusText || '';
    this.url = url;
    this.headers = new Headers(result.headers || {});
    this.bodyUsed = false;
    Object.defineProperty(this, '_body', { value: body, enumerable: false });
  }
  Response.prototype.text = function () { this.bodyUsed = true; return Promise.resolve(this._body); };
  Response.prototype.json = function () {
    this.bodyUsed = true;
    var body = this._body;
    return new Promise(function (resolve) { resolve(JSON.parse(body)); });
  };

  function fetch(input, init) {
    return new Promise(function (resolve, reject) {
      if (typeof softn === 'undefined' || !softn || !softn.net) {
        reject(new TypeError('fetch is not available to this page'));
        return;
      }
      var url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      var signal = init && init.signal;
      if (signal && signal.aborted) { reject(signal.reason); return; }
      var settled = false;
      if (signal) signal.addEventListener('abort', function () { if (!settled) { settled = true; reject(signal.reason); } });
      var options = {};
      if (init && typeof init === 'object') {
        if (init.method) options.method = String(init.method).toUpperCase();
        if (init.headers) {
          var headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
          options.headers = {};
          headers.forEach(function (value, name) { options.headers[name] = value; });
        }
        if (init.body !== undefined && init.body !== null) {
          var body = init.body;
          if (body instanceof FormData) body = new URLSearchParams(body);
          if (body instanceof URLSearchParams) {
            options.body = body.toString();
            options.headers = options.headers || {};
            if (!options.headers['content-type']) options.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
          } else {
            options.body = typeof body === 'string' ? body : JSON.stringify(body);
          }
        }
      }
      // An address of the page's own ('data.json', './list.json'): the app's
      // own file, read where its markup would find it, with no network.
      var own = !/^[a-zA-Z][a-zA-Z0-9+.-]*:|^[\\\/]{2}/.test(url) && (!options.method || options.method === 'GET');
      var read = own
        ? function (done) { host.call('bundle.read', [url], done); }
        : function (done) { softn.net.fetch(url, options, done); };
      read(function (result) {
        if (settled) return;
        settled = true;
        if (!result || result.error) reject(new TypeError(result && result.error ? String(result.error) : 'Failed to fetch'));
        else resolve(new Response(result, url));
      });
    });
  }

  // location: where the page is, and going to another of the app's pages.
  // The host takes the address as a link: another page of the app is shown;
  // anywhere else is refused, so a page's code cannot send the person to
  // another site on its own.
  var here = parseUrl('');
  function parseUrl(href) {
    var m = /^(([a-z][a-z0-9+.-]*:)\/\/([^\/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(String(href)) || [];
    var host = m[3] || '';
    var port = /:(\d+)$/.exec(host);
    return {
      href: String(href), protocol: m[2] || '', host: host, hostname: port ? host.slice(0, -port[0].length) : host,
      port: port ? port[1] : '', pathname: m[4] || '', search: m[5] || '', hash: m[6] || '', origin: m[1] || '',
    };
  }
  function navigate(url) {
    var target = String(url);
    if (target.charAt(0) === '#') {
      var href = here.href.split('#')[0] + target;
      if (href === here.href) return;
      entries = entries.slice(0, entryAt + 1);
      entries.push({ href: href, state: null });
      entryAt = entries.length - 1;
      moveTo(href, null, true);
      return;
    }
    ops.push(['n', target]);
  }
  var location = {
    assign: function (url) { navigate(url); },
    replace: function (url) { navigate(url); },
    reload: function () { warnOnce('reload', 'location.reload() does nothing here: the page is drawn again as its state changes.'); },
    toString: function () { return here.href; },
  };
  ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'origin'].forEach(function (key) {
    // here is parsed roughly; a URL reads it whole.
    Object.defineProperty(location, key, { enumerable: true, get: function () { return here[key]; } });
  });
  Object.defineProperty(location, 'href', { enumerable: true, get: function () { return here.href; }, set: function (url) { navigate(url); } });
  Object.defineProperty(location, 'hash', {
    enumerable: true,
    get: function () { return here.hash; },
    set: function (value) { var v = String(value); navigate(v.charAt(0) === '#' ? v : '#' + v); },
  });

  function URLSearchParams(init) {
    Object.defineProperty(this, '_list', { value: [], writable: true, enumerable: false });
    if (init instanceof URLSearchParams || init instanceof FormData) {
      var self = this;
      init.forEach(function (value, name) { self._list.push([String(name), String(value)]); });
    } else if (typeof init === 'string') {
      var text = init.charAt(0) === '?' ? init.slice(1) : init;
      var pairs = text === '' ? [] : text.split('&');
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i] === '') continue;
        var at = pairs[i].indexOf('=');
        this._list.push([unquery(at < 0 ? pairs[i] : pairs[i].slice(0, at)), unquery(at < 0 ? '' : pairs[i].slice(at + 1))]);
      }
    } else if (init && typeof init === 'object') {
      if (Array.isArray(init)) for (var j = 0; j < init.length; j++) this._list.push([String(init[j][0]), String(init[j][1])]);
      else for (var key in init) this._list.push([key, String(init[key])]);
    }
  }
  function unquery(text) { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch (error) { return text; } }
  function queryText(text) { return encodeURIComponent(text).replace(/%20/g, '+'); }
  URLSearchParams.prototype.get = function (name) { for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === name) return this._list[i][1]; return null; };
  URLSearchParams.prototype.getAll = function (name) { return this._list.filter(function (e) { return e[0] === name; }).map(function (e) { return e[1]; }); };
  URLSearchParams.prototype.has = function (name) { return this.get(name) !== null; };
  URLSearchParams.prototype.append = function (name, value) { this._list.push([String(name), String(value)]); };
  URLSearchParams.prototype.set = function (name, value) { this.delete(name); this.append(name, value); };
  URLSearchParams.prototype.delete = function (name) { this._list = this._list.filter(function (e) { return e[0] !== name; }); };
  URLSearchParams.prototype.forEach = function (fn) { for (var i = 0; i < this._list.length; i++) fn(this._list[i][1], this._list[i][0], this); };
  URLSearchParams.prototype.keys = function () { return this._list.map(function (e) { return e[0]; }); };
  URLSearchParams.prototype.values = function () { return this._list.map(function (e) { return e[1]; }); };
  URLSearchParams.prototype.entries = function () { return this._list.map(function (e) { return [e[0], e[1]]; }); };
  URLSearchParams.prototype.toString = function () { return this._list.map(function (e) { return queryText(e[0]) + '=' + queryText(e[1]); }).join('&'); };
  URLSearchParams.prototype.sort = function () { this._list.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); };
  URLSearchParams.prototype[Symbol.iterator] = function () { return this.entries()[Symbol.iterator](); };
  Object.defineProperty(URLSearchParams.prototype, 'size', { get: function () { return this._list.length; } });

  // alert(): shown by the host once the code's turn is over, since nothing
  // waits on it. confirm() and prompt() wait for an answer, which code in the
  // sandbox cannot do; they say what to use instead rather than answer no.
  function alert(message) {
    var text = message === undefined ? '' : String(message);
    if (typeof host !== 'undefined' && host && typeof host.call === 'function') host.call('dialog.alert', [text], function () {});
    else console.log(text);
  }
  function confirm() {
    throw new Error('confirm() cannot wait for an answer here: ask with a <Confirm> component, or buttons the page shows.');
  }
  function prompt() {
    throw new Error('prompt() cannot wait for an answer here: ask with an <input> on the page, or a <Dialog>.');
  }

  function queueMicrotask(fn) { Promise.resolve().then(fn); }
  function requestAnimationFrame(fn) { return setTimeout(function () { fn(Date.now()); }, 16); }
  function cancelAnimationFrame(id) { clearTimeout(id); }
  // A copy as a browser makes one: dates, maps, sets, typed arrays and a
  // value that holds itself, which a round trip through JSON loses.
  function structuredClone(value, seen) {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') throw new DOMException(String(value) + ' could not be cloned.', 'DataCloneError');
      return value;
    }
    seen = seen || new Map();
    if (seen.has(value)) return seen.get(value);
    if (rec(value)) throw new DOMException('A node of the document could not be cloned.', 'DataCloneError');
    var out;
    if (value instanceof Date) out = new Date(value.getTime());
    else if (value instanceof RegExp) out = new RegExp(value.source, value.flags);
    else if (ArrayBuffer.isView(value)) out = value.slice();
    else if (value instanceof ArrayBuffer) out = value.slice(0);
    else if (value instanceof Map) {
      out = new Map();
      seen.set(value, out);
      value.forEach(function (v, k) { out.set(structuredClone(k, seen), structuredClone(v, seen)); });
      return out;
    } else if (value instanceof Set) {
      out = new Set();
      seen.set(value, out);
      value.forEach(function (v) { out.add(structuredClone(v, seen)); });
      return out;
    } else if (value instanceof Error) {
      out = new Error(value.message);
      out.name = value.name;
    } else {
      out = Array.isArray(value) ? [] : {};
      seen.set(value, out);
      for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = structuredClone(value[key], seen);
      return out;
    }
    seen.set(value, out);
    return out;
  }

  // sessionStorage: for as long as the page is open.
  function Storage() { Object.defineProperty(this, '_items', { value: {}, writable: true, enumerable: false }); }
  Storage.prototype.getItem = function (key) { var v = this._items[String(key)]; return v === undefined ? null : v; };
  Storage.prototype.setItem = function (key, value) { this._items[String(key)] = String(value); };
  Storage.prototype.removeItem = function (key) { delete this._items[String(key)]; };
  Storage.prototype.clear = function () { this._items = {}; };
  Storage.prototype.key = function (i) { var keys = Object.keys(this._items); return i < keys.length ? keys[i] : null; };
  Object.defineProperty(Storage.prototype, 'length', { get: function () { return Object.keys(this._items).length; } });
  var sessionStorage = new Storage();


  // ---------------------------------------------------------------- more of the window

  // DOMException, as a browser's errors are made.
  class DOMException extends Error {
    constructor(message, name) {
      super(message === undefined ? '' : String(message));
      this.name = name === undefined ? 'Error' : String(name);
    }
  }

  // AbortController and its signal: what fetch, and a page's own code, are told to stop by.
  class AbortSignal extends EventTarget {
    get aborted() { return !!rec(this).aborted; }
    get reason() { return rec(this).reason; }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static abort(reason) { var signal = new AbortSignal(); abortWith(signal, reason); return signal; }
    static timeout(ms) {
      var signal = new AbortSignal();
      setTimeout(function () { abortWith(signal, new DOMException('The operation timed out.', 'TimeoutError')); }, Number(ms) || 0);
      return signal;
    }
    static any(signals) {
      var signal = new AbortSignal();
      for (var i = 0; i < signals.length; i++) {
        if (signals[i].aborted) { abortWith(signal, signals[i].reason); break; }
        signals[i].addEventListener('abort', function (e) { abortWith(signal, e.target.reason); });
      }
      return signal;
    }
  }
  function abortWith(signal, reason) {
    var r = rec(signal);
    if (r.aborted) return;
    r.aborted = true;
    r.reason = reason === undefined ? new DOMException('signal is aborted without reason', 'AbortError') : reason;
    var e = new Event('abort');
    dispatch(signal, e);
    if (typeof signal.onabort === 'function') signal.onabort(e);
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) { abortWith(this.signal, reason); }
  }

  // URL: an address, taken apart and put together as a browser does it.
  var DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
  function cleanPath(path) {
    var out = [];
    var parts = path.split('/');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '..') { if (out.length > 1) out.pop(); if (i === parts.length - 1) out.push(''); }
      else if (part === '.') { if (i === parts.length - 1) out.push(''); }
      else out.push(part);
    }
    return out.join('/');
  }
  function absoluteParts(text) {
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/([^\/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(text);
    if (!m) return null;
    var protocol = m[1].toLowerCase();
    var special = DEFAULT_PORTS[protocol] !== undefined || protocol === 'file:';
    var authority = m[3] || '';
    var at = authority.lastIndexOf('@');
    var user = at >= 0 ? authority.slice(0, at) : '';
    var hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    var hp = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(hostPort);
    if (!hp) return null;
    var hostname = hp[1].toLowerCase();
    if (special && protocol !== 'file:' && m[2] !== undefined && hostname === '') return null;
    var port = hp[2] || '';
    if (port !== '' && DEFAULT_PORTS[protocol] === String(Number(port))) port = '';
    var path = (m[4] || '').replace(special ? /\\/g : /$^/g, '/');
    if (special && path === '') path = '/';
    return {
      protocol: protocol, username: user.split(':')[0] || '', password: user.indexOf(':') >= 0 ? user.slice(user.indexOf(':') + 1) : '',
      hostname: hostname, port: port, pathname: special ? cleanPath(path) : path,
      search: m[5] && m[5] !== '?' ? m[5] : '', hash: m[6] && m[6] !== '#' ? m[6] : '', opaque: !special && m[2] === undefined,
    };
  }
  function resolveParts(ref, base) {
    var text = String(ref).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
      var whole = absoluteParts(text);
      if (whole) return whole;
    }
    if (!base || base.opaque) return null;
    var out = { protocol: base.protocol, username: base.username, password: base.password, hostname: base.hostname, port: base.port, pathname: base.pathname, search: base.search, hash: '', opaque: false };
    text = text.replace(/\\/g, '/');
    if (text.slice(0, 2) === '//') return absoluteParts(base.protocol + text);
    var hashAt = text.indexOf('#');
    var hash = hashAt >= 0 ? text.slice(hashAt) : '';
    if (hashAt >= 0) text = text.slice(0, hashAt);
    out.hash = hash === '#' ? '' : hash;
    if (text === '') return out;
    var queryAt = text.indexOf('?');
    out.search = queryAt >= 0 ? (text.slice(queryAt) === '?' ? '' : text.slice(queryAt)) : '';
    var path = queryAt >= 0 ? text.slice(0, queryAt) : text;
    if (path === '') return out;
    out.pathname = cleanPath(path.charAt(0) === '/' ? path : base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1) + path);
    return out;
  }
  class URL {
    constructor(url, base) {
      var baseParts = null;
      if (base !== undefined) {
        baseParts = absoluteParts(String(base instanceof URL ? base.href : base));
        if (!baseParts) throw new TypeError('Invalid base URL: ' + base);
      }
      var parts = resolveParts(url instanceof URL ? url.href : String(url), baseParts);
      if (!parts) throw new TypeError('Invalid URL: ' + url);
      Object.defineProperty(this, '_p', { value: parts, writable: true, enumerable: false });
      Object.defineProperty(this, '_q', { value: null, writable: true, enumerable: false });
    }
    static canParse(url, base) { try { new URL(url, base); return true; } catch (e) { return false; } }
    get protocol() { return this._p.protocol; }
    set protocol(v) { var p = String(v).replace(/:?$/, ':').toLowerCase(); if (/^[a-z][a-z0-9+.-]*:$/.test(p)) this._p.protocol = p; }
    get username() { return this._p.username; }
    set username(v) { this._p.username = String(v); }
    get password() { return this._p.password; }
    set password(v) { this._p.password = String(v); }
    get hostname() { return this._p.hostname; }
    set hostname(v) { this._p.hostname = String(v).toLowerCase(); }
    get port() { return this._p.port; }
    set port(v) { var n = String(v); this._p.port = DEFAULT_PORTS[this._p.protocol] === n ? '' : n; }
    get host() { return this._p.hostname + (this._p.port ? ':' + this._p.port : ''); }
    set host(v) { var m = /^([^:]*)(?::(\d*))?$/.exec(String(v)); if (m) { this.hostname = m[1]; this.port = m[2] || ''; } }
    get origin() { return DEFAULT_PORTS[this._p.protocol] !== undefined ? this._p.protocol + '//' + this.host : 'null'; }
    get pathname() { return this._p.pathname; }
    set pathname(v) { var path = String(v); this._p.pathname = cleanPath(path.charAt(0) === '/' ? path : '/' + path); }
    get search() { return this._q ? (this._q.toString() ? '?' + this._q.toString() : '') : this._p.search; }
    set search(v) { var t = String(v); this._p.search = t === '' || t === '?' ? '' : t.charAt(0) === '?' ? t : '?' + t; this._q = null; }
    get searchParams() {
      if (!this._q) {
        this._q = new URLSearchParams(this._p.search);
        var self = this;
        // Changed through searchParams, the address changes with it.
        Object.defineProperty(this._q, '_url', { value: self, enumerable: false });
      }
      return this._q;
    }
    get hash() { return this._p.hash; }
    set hash(v) { var t = String(v); this._p.hash = t === '' || t === '#' ? '' : t.charAt(0) === '#' ? t : '#' + t; }
    get href() {
      var p = this._p;
      if (p.opaque) return p.protocol + p.pathname + this.search + p.hash;
      var user = p.username ? p.username + (p.password ? ':' + p.password : '') + '@' : '';
      return p.protocol + '//' + user + this.host + p.pathname + this.search + p.hash;
    }
    set href(v) { var parts = absoluteParts(String(v)); if (!parts) throw new TypeError('Invalid URL: ' + v); this._p = parts; this._q = null; }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }

  // base64, of text whose characters are bytes, as a browser's are.
  var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(text) {
    text = String(text);
    var out = '';
    for (var i = 0; i < text.length; i += 3) {
      var a = text.charCodeAt(i);
      var b = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      var c = i + 2 < text.length ? text.charCodeAt(i + 2) : -1;
      if (a > 255 || b > 255 || c > 255) throw new DOMException('The string to be encoded contains characters outside of the Latin1 range.', 'InvalidCharacterError');
      out += BASE64.charAt(a >> 2) + BASE64.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));
      out += b < 0 ? '==' : BASE64.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6)) + (c < 0 ? '=' : BASE64.charAt(c & 63));
    }
    return out;
  }
  function atob(text) {
    var clean = String(text).replace(/[\t\n\f\r ]/g, '');
    if (clean.length % 4 === 0) clean = clean.replace(/==?$/, '');
    if (clean.length % 4 === 1 || /[^A-Za-z0-9+\/]/.test(clean)) throw new DOMException('The string to be decoded is not correctly encoded.', 'InvalidCharacterError');
    var out = '';
    var bits = 0;
    var count = 0;
    for (var i = 0; i < clean.length; i++) {
      bits = (bits << 6) | BASE64.indexOf(clean.charAt(i));
      count += 6;
      if (count >= 8) { count -= 8; out += String.fromCharCode((bits >> count) & 255); }
    }
    return out;
  }

  // Text as UTF-8 bytes, and back.
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(text) {
      var input = text === undefined ? '' : String(text);
      var bytes = [];
      for (var i = 0; i < input.length; i++) {
        var code = input.codePointAt(i);
        if (code > 0xffff) i++;
        if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
      return new Uint8Array(bytes);
    }
  }
  class TextDecoder {
    constructor(label) {
      var name = label === undefined ? 'utf-8' : String(label).toLowerCase();
      if (name !== 'utf-8' && name !== 'utf8') throw new RangeError('Only UTF-8 is read here, not ' + label);
    }
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (input === undefined) return '';
      var bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : input;
      var out = '';
      for (var i = 0; i < bytes.length; ) {
        var b = bytes[i++];
        var code;
        var more;
        if (b < 0x80) { code = b; more = 0; }
        else if (b >= 0xc2 && b < 0xe0) { code = b & 31; more = 1; }
        else if (b >= 0xe0 && b < 0xf0) { code = b & 15; more = 2; }
        else if (b >= 0xf0 && b < 0xf5) { code = b & 7; more = 3; }
        else { out += String.fromCharCode(0xfffd); continue; }
        var ok = true;
        for (var k = 0; k < more; k++) {
          if (i >= bytes.length || (bytes[i] & 0xc0) !== 0x80) { ok = false; break; }
          code = (code << 6) | (bytes[i++] & 63);
        }
        out += ok ? String.fromCodePoint(code) : String.fromCharCode(0xfffd);
      }
      return out;
    }
  }

  // crypto: random numbers a page can rely on. The engine has none of its
  // own; these are ChaCha20's keystream (RFC 8439), keyed by bytes the host's
  // own crypto gave this page and no one else.
  var randomKey = null;
  var randomBlock = new Uint8Array(64);
  var randomUsed = 64;
  var randomCounter = 0;
  function rotl(v, c) { return (v << c) | (v >>> (32 - c)); }
  function quarter(x, a, b, c, d) {
    x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 16);
    x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 8);
    x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 7);
  }
  function nextRandomBlock() {
    if (!randomKey) throw new DOMException('This page was given no random numbers.', 'OperationError');
    var state = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
    for (var i = 0; i < 8; i++) state.push(randomKey[4 * i] | (randomKey[4 * i + 1] << 8) | (randomKey[4 * i + 2] << 16) | (randomKey[4 * i + 3] << 24));
    state.push(randomCounter++ | 0, 0, 0, 0);
    var x = state.slice();
    for (var round = 0; round < 10; round++) {
      quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13); quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
      quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12); quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
    }
    for (var j = 0; j < 16; j++) {
      var word = (x[j] + state[j]) | 0;
      randomBlock[4 * j] = word & 255; randomBlock[4 * j + 1] = (word >>> 8) & 255;
      randomBlock[4 * j + 2] = (word >>> 16) & 255; randomBlock[4 * j + 3] = (word >>> 24) & 255;
    }
    randomUsed = 0;
  }
  function randomByte() {
    if (randomUsed === 64) nextRandomBlock();
    return randomBlock[randomUsed++];
  }
  var crypto = {
    getRandomValues: function (array) {
      if (!ArrayBuffer.isView(array) || array instanceof Float32Array || array instanceof Float64Array) {
        throw new DOMException('The array is not an integer array.', 'TypeMismatchError');
      }
      if (array.byteLength > 65536) throw new DOMException('At most 65536 bytes are asked for at once.', 'QuotaExceededError');
      var bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (var i = 0; i < bytes.length; i++) bytes[i] = randomByte();
      return array;
    },
    randomUUID: function () {
      var b = [];
      for (var i = 0; i < 16; i++) b.push(randomByte());
      b[6] = (b[6] & 15) | 64;
      b[8] = (b[8] & 63) | 128;
      var hex = b.map(function (n) { return (n < 16 ? '0' : '') + n.toString(16); }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    },
  };

  // MutationObserver: told of what changes in the document, as the page's
  // code changes it, once the code's turn is over.
  var mutationObservers = [];
  var mutationsDue = false;
  function mutated(record) {
    if (mutationObservers.length === 0) return;
    for (var i = 0; i < mutationObservers.length; i++) {
      var o = mutationObservers[i];
      for (var j = 0; j < o._targets.length; j++) {
        var t = o._targets[j];
        var opts = t.options;
        if (t.node !== record.target && !(opts.subtree && contains(t.node, record.target))) continue;
        if (record.type === 'childList' && !opts.childList) continue;
        if (record.type === 'attributes' && (!opts.attributes || (opts.attributeFilter && opts.attributeFilter.indexOf(record.attributeName) < 0))) continue;
        if (record.type === 'characterData' && !opts.characterData) continue;
        var copy = {
          type: record.type, target: record.target, addedNodes: nodeList(record.addedNodes || []), removedNodes: nodeList(record.removedNodes || []),
          previousSibling: record.previousSibling || null, nextSibling: record.nextSibling || null,
          attributeName: record.attributeName || null, attributeNamespace: null,
          oldValue: (record.type === 'attributes' && opts.attributeOldValue) || (record.type === 'characterData' && opts.characterDataOldValue) ? record.oldValue : null,
        };
        o._records.push(copy);
        break;
      }
    }
    if (!mutationsDue) {
      mutationsDue = true;
      Promise.resolve().then(deliverMutations);
    }
  }
  function deliverMutations() {
    mutationsDue = false;
    var due = mutationObservers.slice();
    for (var i = 0; i < due.length; i++) {
      var o = due[i];
      if (o._records.length === 0) continue;
      var records = o._records;
      o._records = [];
      try { o._callback.call(o, records, o); } catch (error) {
        console.error('[SoftN] A MutationObserver failed: ' + (error && error.message ? error.message : error));
      }
    }
  }
  class MutationObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError('MutationObserver needs a function');
      this._callback = callback;
      this._targets = [];
      this._records = [];
    }
    observe(node, options) {
      var o = Object.assign({}, options || {});
      if (o.attributeOldValue || o.attributeFilter) o.attributes = o.attributes !== false;
      if (o.characterDataOldValue) o.characterData = o.characterData !== false;
      if (!o.childList && !o.attributes && !o.characterData) throw new TypeError('observe() needs childList, attributes or characterData');
      this._targets = this._targets.filter(function (t) { return t.node !== node; });
      this._targets.push({ node: node, options: o });
      if (mutationObservers.indexOf(this) < 0) mutationObservers.push(this);
    }
    disconnect() {
      this._targets = [];
      this._records = [];
      var at = mutationObservers.indexOf(this);
      if (at >= 0) mutationObservers.splice(at, 1);
    }
    takeRecords() { var records = this._records; this._records = []; return records; }
  }

  // Layout, as far as it is known here: the size and place of an element
  // whose size the page asked about, as the host measured it on the page.
  // The first ask has nothing to go on and reads zero; the host measures
  // the element then and again whenever it changes size, and from then on
  // this is what it says, and a ResizeObserver hears of each change.
  function measured(node) {
    var r = rec(node);
    if (!r || r.type !== 1) return null;
    if (!r.measured && isConnected(r)) { r.measured = true; propChanged(r, 'measure', true); }
    return r.box || null;
  }
  function boxRect(box) {
    var x = box ? box.x : 0;
    var y = box ? box.y : 0;
    var w = box ? box.w : 0;
    var h = box ? box.h : 0;
    return { x: x, y: y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: function () { return this; } };
  }
  var resizeObservers = [];
  class ResizeObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError('ResizeObserver needs a function');
      this._callback = callback;
      this._nodes = [];
    }
    observe(node) {
      if (this._nodes.indexOf(node) >= 0) return;
      this._nodes.push(node);
      if (resizeObservers.indexOf(this) < 0) resizeObservers.push(this);
      var box = measured(node);
      // As a browser does: once on observe, with the size it has.
      if (box) this._tell([node]);
    }
    unobserve(node) { this._nodes = this._nodes.filter(function (n) { return n !== node; }); }
    disconnect() {
      this._nodes = [];
      var at = resizeObservers.indexOf(this);
      if (at >= 0) resizeObservers.splice(at, 1);
    }
    _tell(nodes) {
      var entries = nodes.map(function (node) {
        var box = rec(node).box;
        var rect = boxRect(box ? { x: 0, y: 0, w: box.w, h: box.h } : null);
        var size = [{ inlineSize: rect.width, blockSize: rect.height }];
        return { target: node, contentRect: rect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
      });
      try { this._callback.call(this, entries, this); } catch (error) {
        console.error('[SoftN] A ResizeObserver failed: ' + (error && error.message ? error.message : error));
      }
    }
  }
  // Sizes the host measured, by id: [id, x, y, width, height].
  function boxesMeasured(list) {
    var changed = [];
    for (var i = 0; i < list.length; i++) {
      var node = BY_ID[list[i][0]];
      var r = node && rec(node);
      if (!r) continue;
      r.box = { x: list[i][1], y: list[i][2], w: list[i][3], h: list[i][4] };
      changed.push(node);
    }
    for (var o = 0; o < resizeObservers.slice().length; o++) {
      var observer = resizeObservers[o];
      var seen = changed.filter(function (n) { return observer._nodes.indexOf(n) >= 0; });
      if (seen.length > 0) observer._tell(seen);
    }
  }

  // IntersectionObserver: where an element is against the window is not
  // known here, so whatever is observed is taken to be in view, once: content
  // waiting to be seen is shown, rather than never.
  class IntersectionObserver {
    constructor(callback, options) {
      if (typeof callback !== 'function') throw new TypeError('IntersectionObserver needs a function');
      this._callback = callback;
      this._nodes = [];
      this.root = (options && options.root) || null;
      this.rootMargin = (options && options.rootMargin) || '0px';
      this.thresholds = [].concat((options && options.threshold) || 0);
    }
    observe(node) {
      if (this._nodes.indexOf(node) >= 0) return;
      this._nodes.push(node);
      var self = this;
      Promise.resolve().then(function () {
        if (self._nodes.indexOf(node) < 0) return;
        var rect = boxRect(rec(node).box);
        try {
          self._callback.call(self, [{ target: node, isIntersecting: true, intersectionRatio: 1, boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: Date.now() }], self);
        } catch (error) {
          console.error('[SoftN] An IntersectionObserver failed: ' + (error && error.message ? error.message : error));
        }
      });
    }
    unobserve(node) { this._nodes = this._nodes.filter(function (n) { return n !== node; }); }
    disconnect() { this._nodes = []; }
    takeRecords() { return []; }
  }

  // The window's size and the person's settings, as the host reports them:
  // innerWidth and innerHeight, devicePixelRatio, and matchMedia() for the
  // queries a page asks (widths, heights, orientation, colour scheme,
  // reduced motion, hover and pointer).
  var viewport = { w: 0, h: 0, dark: false, reduced: false, ratio: 1, coarse: false };
  function mediaFeature(feature) {
    var m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+?)\s*)?\)$/.exec(feature.trim());
    if (!m) return false;
    var name = m[1];
    var value = m[2] === undefined ? null : m[2];
    var px = function (v) {
      var n = parseFloat(v);
      return /em$/.test(v) ? n * 16 : n;
    };
    switch (name) {
      case 'min-width': return viewport.w >= px(value);
      case 'max-width': return viewport.w <= px(value);
      case 'min-height': return viewport.h >= px(value);
      case 'max-height': return viewport.h <= px(value);
      case 'width': return value === null ? true : viewport.w === px(value);
      case 'orientation': return value === (viewport.w >= viewport.h ? 'landscape' : 'portrait');
      case 'prefers-color-scheme': return value === (viewport.dark ? 'dark' : 'light');
      case 'prefers-reduced-motion': return value === null ? viewport.reduced : value === (viewport.reduced ? 'reduce' : 'no-preference');
      case 'hover': return value === null ? !viewport.coarse : value === (viewport.coarse ? 'none' : 'hover');
      case 'any-hover': return value === null ? !viewport.coarse : value === (viewport.coarse ? 'none' : 'hover');
      case 'pointer': case 'any-pointer': return value === (viewport.coarse ? 'coarse' : 'fine');
      case 'min-resolution': return viewport.ratio * 96 >= px(value) * (/dppx|x$/.test(value) ? 96 : 1);
      case 'prefers-contrast': return value === 'no-preference';
      default: return false;
    }
  }
  function mediaMatches(query) {
    var any = String(query).split(',');
    for (var i = 0; i < any.length; i++) {
      var text = any[i].trim().toLowerCase();
      var negate = /^not\s+/.test(text);
      text = text.replace(/^(?:not|only)\s+/, '').replace(/^(?:all|screen)\s*(?:and\s*)?/, '');
      if (text === 'print') { if (negate) return true; continue; }
      var parts = text === '' ? [] : text.split(/\s+and\s+/);
      var all = parts.every(mediaFeature);
      if (negate ? !all : all) return true;
    }
    return false;
  }
  var mediaLists = [];
  function matchMedia(query) {
    var list = new EventTarget();
    var text = String(query);
    var matches = mediaMatches(text);
    Object.defineProperty(list, 'media', { value: text, enumerable: true });
    Object.defineProperty(list, 'matches', { get: function () { return matches; }, enumerable: true });
    list.onchange = null;
    list.addListener = function (fn) { list.addEventListener('change', fn); };
    list.removeListener = function (fn) { list.removeEventListener('change', fn); };
    list._recheck = function () {
      var now = mediaMatches(text);
      if (now === matches) return;
      matches = now;
      var e = new Event('change');
      e.matches = now;
      e.media = text;
      dispatch(list, e);
      if (typeof list.onchange === 'function') list.onchange(e);
    };
    mediaLists.push(list);
    // Told when the window changes, so a list can say it changed.
    listen('softn:viewport');
    return list;
  }
  function viewportChanged(v) {
    var resized = v[0] !== viewport.w || v[1] !== viewport.h;
    viewport = { w: v[0], h: v[1], dark: !!v[2], reduced: !!v[3], ratio: v[4] || 1, coarse: !!v[5] };
    for (var i = 0; i < mediaLists.length; i++) mediaLists[i]._recheck();
    return resized;
  }

  // history, and where the page is: in this document's own keeping. Going
  // back and forward, a hash and pushState move between the page's own
  // states and say so with popstate and hashchange, as in a browser; the
  // host's address is not changed.
  var entries = [];
  var entryAt = 0;
  var windowListeners = { hashchange: [], popstate: [] };
  function toWindow(type, e) {
    var list = windowListeners[type].slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(win, e); } catch (error) {
        console.error('[SoftN] A ' + type + ' listener failed: ' + (error && error.message ? error.message : error));
      }
    }
    var inline = win && win['on' + type];
    if (typeof inline === 'function') {
      try { inline.call(win, e); } catch (error) { console.error('[SoftN] An on' + type + ' handler failed: ' + (error && error.message ? error.message : error)); }
    }
  }
  function moveTo(href, state, hashOnly) {
    var before = here.href;
    here = parseUrl(href);
    if (hashOnly && before !== here.href) {
      var e = new Event('hashchange');
      e.oldURL = before;
      e.newURL = here.href;
      setTimeout(function () { toWindow('hashchange', e); }, 0);
    }
  }
  var history = {
    get length() { return entries.length; },
    get state() { return entries[entryAt] ? entries[entryAt].state : null; },
    scrollRestoration: 'auto',
    pushState: function (state, title, url) {
      var href = url === undefined || url === null ? here.href : new URL(String(url), here.href || undefined).href;
      entries = entries.slice(0, entryAt + 1);
      entries.push({ href: href, state: state === undefined ? null : structuredClone(state) });
      entryAt = entries.length - 1;
      moveTo(href, state, false);
    },
    replaceState: function (state, title, url) {
      var href = url === undefined || url === null ? here.href : new URL(String(url), here.href || undefined).href;
      entries[entryAt] = { href: href, state: state === undefined ? null : structuredClone(state) };
      moveTo(href, state, false);
    },
    go: function (delta) {
      var to = entryAt + (Number(delta) || 0);
      if (to < 0 || to >= entries.length || to === entryAt) return;
      var from = entries[entryAt].href;
      entryAt = to;
      var entry = entries[to];
      setTimeout(function () {
        here = parseUrl(entry.href);
        var pop = new Event('popstate');
        pop.state = entry.state;
        toWindow('popstate', pop);
        if (from.split('#')[0] === entry.href.split('#')[0] && from !== entry.href) {
          var hash = new Event('hashchange');
          hash.oldURL = from;
          hash.newURL = entry.href;
          toWindow('hashchange', hash);
        }
      }, 0);
    },
    back: function () { history.go(-1); },
    forward: function () { history.go(1); },
  };

  // ---------------------------------------------------------------- the host's side

  function build(seed, parent, inert) {
    var node;
    if (seed.x !== undefined) node = makeText(seed.x, seed.i);
    else if (seed.o && !seed.t) node = makeComment('', seed.i, true);
    else {
      node = makeElement(seed.t, seed.i, !!seed.o && !seed.tpl);
      var r = rec(node);
      for (var key in seed.a || {}) {
        // A handler written in the markup as code is the page's to run, with
        // the element as this and the event as event, as a browser runs it.
        // One SoftN reads (onclick="save()") is SoftN's, and is not here.
        if (/^on/i.test(key)) {
          var type = key.slice(2).toLowerCase();
          var handler = inlineHandler(String(seed.a[key]));
          if (handler) { r.inline[type] = handler; listen(type); }
          continue;
        }
        r.attrs.push([key, String(seed.a[key])]);
      }
      if (seed.c) for (var i = 0; i < seed.c.length; i++) build(seed.c[i], node, inert);
      if (seed.tpl) for (var t = 0; t < seed.tpl.length; t++) build(seed.tpl[t], node.content, true);
      if (r.tag === 'dialog' && !inert) heedDialogs();
    }
    rec(node).parent = parent;
    rec(parent).kids.push(node);
    if (!inert) BY_ID[seed.i] = node;
    return node;
  }

  function init(seed) {
    doc = Object.create(Document.prototype);
    var d = newRecord(9, -1);
    register(doc, d);
    var html = makeElement('html', -2);
    var head = makeElement('head', -3);
    var body = makeElement('body', 1);
    rec(html).parent = doc; d.kids.push(html);
    rec(head).parent = html; rec(html).kids.push(head);
    rec(body).parent = html; rec(html).kids.push(body);
    BY_ID[1] = body;
    for (var i = 0; i < (seed.body || []).length; i++) build(seed.body[i], body);
    nextId = Math.max(nextId, seed.next || 2);
    if (seed.title) d.title = seed.title;
    here = parseUrl(seed.url || '');
    entries = [{ href: here.href, state: null }];
    entryAt = 0;
    if (seed.r && seed.r.length >= 32) randomKey = seed.r.slice(0, 32);
    if (seed.v) viewportChanged(seed.v);
    ops = [];
    // What the markup itself listens for: its handlers, its dialogs.
    for (var heard in listening) ops.push(['l', heard]);
    api.document = doc;
  }

  function take() {
    if (ops.length === 0) return null;
    var out = ops;
    ops = [];
    return out;
  }

  // What the person did to the page, in by id: a field's value, a box, a
  // choice, and which element has focus. Not told back: the page already
  // shows it.
  function sync(changes) {
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i];
      if (c[0] === 'f') { activeId = c[1] || 0; continue; }
      if (c[0] === 'W') { viewportChanged(c[1]); continue; }
      if (c[0] === 'B') { boxesMeasured(c[1]); continue; }
      var node = BY_ID[c[1]];
      var r = node && rec(node);
      if (!r) continue;
      if (c[0] === 'v') r.value = String(c[2]);
      else if (c[0] === 'k') r.checked = !!c[2];
      else if (c[0] === 's') r.selectedIndex = Number(c[2]);
      else if (c[0] === 'S') { r.chosen = c[2].slice(); r.selectedIndex = r.chosen.length ? r.chosen[0] : -1; }
      else if (c[0] === 'A') {
        // An attribute SoftN draws from a {value}: told as the page shows it,
        // so classList.add on class={cls} adds to what is there.
        var at = -1;
        for (var a = 0; a < r.attrs.length; a++) if (r.attrs[a][0] === c[2]) at = a;
        if (c[3] === null) { if (at >= 0) r.attrs.splice(at, 1); }
        else if (at >= 0) r.attrs[at][1] = String(c[3]);
        else r.attrs.push([c[2], String(c[3])]);
      }
    }
  }

  var EVENT_KINDS = {
    keydown: KeyboardEvent, keyup: KeyboardEvent, keypress: KeyboardEvent,
    click: MouseEvent, dblclick: MouseEvent, mousedown: MouseEvent, mouseup: MouseEvent, mousemove: MouseEvent,
    mouseover: MouseEvent, mouseout: MouseEvent, mouseenter: MouseEvent, mouseleave: MouseEvent, contextmenu: MouseEvent,
    input: InputEvent, focus: FocusEvent, blur: FocusEvent, focusin: FocusEvent, focusout: FocusEvent, submit: SubmitEvent,
    pointerdown: PointerEvent, pointerup: PointerEvent, pointermove: PointerEvent, pointerover: PointerEvent, pointerout: PointerEvent,
    pointerenter: PointerEvent, pointerleave: PointerEvent, pointercancel: PointerEvent,
    dragstart: DragEvent, drag: DragEvent, dragend: DragEvent, dragenter: DragEvent, dragover: DragEvent, dragleave: DragEvent, drop: DragEvent,
  };
  var OWN_EVENT_FIELDS = { type: 1, target: 1, currentTarget: 1, bubbles: 1, cancelable: 1, defaultPrevented: 1, eventPhase: 1, isTrusted: 1, timeStamp: 1, srcElement: 1 };
  var NOT_BUBBLING = { focus: 1, blur: 1, mouseenter: 1, mouseleave: 1, load: 1, error: 1, scroll: 1, toggle: 1, invalid: 1 };

  // An event that happened on the page, on the element with this id (or on
  // the document): 1 when it was cancelled, 2 when it went no further.
  // An element SoftN drew, inside the one of the document's an event
  // happened in: the item of an #each, the button of a component. Seen as
  // the page shows it (its tag, attributes, text, a field's value), to be
  // read and matched, as event.target and its ancestors are when a list's
  // clicks are handled on the list; never changed, and gone after the event.
  function seenElement(seen, parent) {
    var tag = String(seen.t || 'div').toLowerCase();
    var Ctor = ELEMENT_CLASSES[tag] || HTMLElement;
    var node = Object.create(Ctor.prototype);
    var r = newRecord(1, 0);
    r.tag = tag;
    r.island = true;
    r.seen = true;
    r.text = String(seen.x || '');
    for (var key in seen.a || {}) r.attrs.push([key, String(seen.a[key])]);
    if (seen.v !== undefined) r.value = String(seen.v);
    if (seen.k !== undefined) r.checked = !!seen.k;
    r.parent = parent;
    STATE.set(node, r);
    node.__softnNode = 0;
    return node;
  }

  function event(id, type, props, path) {
    if (type === 'softn:viewport') {
      // innerWidth and matchMedia() follow; a resize is heard as one.
      if (viewportChanged(props.v)) toResize();
      return 0;
    }
    if (type === 'softn:boxes') { boxesMeasured(props.boxes); return 0; }
    var target = id === -1 ? doc : BY_ID[id];
    if (!target) return 0;
    if (path && path.length) {
      // Built from the outside in: each one's parent is the one around it.
      for (var p = path.length - 1; p >= 0; p--) target = seenElement(path[p], target);
    }
    var Kind = EVENT_KINDS[type] || Event;
    var e = new Kind(type, { bubbles: !NOT_BUBBLING[type], cancelable: true });
    for (var key in props || {}) {
      if (OWN_EVENT_FIELDS[key]) continue;
      e[key] = props[key];
    }
    if (type === 'submit') e.submitter = typeof props.submitter === 'number' ? BY_ID[props.submitter] || null : null;
    if (/^drag|^drop$/.test(type)) {
      if (type === 'dragstart' || !dragging) dragging = new DataTransfer();
      e.dataTransfer = dragging;
    }
    e.isTrusted = true;
    dispatch(target, e);
    // A form of a dialog's (method="dialog") closes it, with its button's value.
    if (type === 'submit' && !e.defaultPrevented && rec(target) && (getAttr(rec(target), 'method') || '').toLowerCase() === 'dialog') {
      var dialog = target.closest('dialog');
      if (dialog) dialog.close(e.submitter ? e.submitter.value : undefined);
      e.defaultPrevented = true;
    }
    if (type === 'drop' || type === 'dragend') dragging = null;
    // Escape asks the modal dialog to close, as it does in a browser.
    if (type === 'keydown' && props.key === 'Escape' && !e.defaultPrevented) {
      var modal = openModal();
      if (modal) modal.requestClose();
    }
    // A link to a place on this page, followed: the page's hash moves with it.
    if (type === 'click' && !e.defaultPrevented) {
      var link = target && typeof target.closest === 'function' ? target.closest('a[href^="#"]') : null;
      if (link) navigate(getAttr(rec(link), 'href'));
    }
    return (e.defaultPrevented ? 1 : 0) | (e._stop ? 2 : 0) | (e._captureStop ? 4 : 0);
  }
  var resizeListeners = [];

  // What is being dragged: data by type, as setData() put it.
  var dragging = null;
  function DataTransfer() {
    Object.defineProperty(this, '_data', { value: {}, writable: true, enumerable: false });
    this.dropEffect = 'none';
    this.effectAllowed = 'all';
    this.files = [];
  }
  DataTransfer.prototype.setData = function (format, data) { this._data[String(format).toLowerCase()] = String(data); };
  DataTransfer.prototype.getData = function (format) { var v = this._data[String(format).toLowerCase()]; return v === undefined ? '' : v; };
  DataTransfer.prototype.clearData = function (format) { if (format === undefined) this._data = {}; else delete this._data[String(format).toLowerCase()]; };
  DataTransfer.prototype.setDragImage = function () {};
  Object.defineProperty(DataTransfer.prototype, 'types', { get: function () { return Object.keys(this._data); } });
  function toResize() {
    var list = resizeListeners.slice();
    var e = new Event('resize');
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(win, e); } catch (error) { console.error('[SoftN] A resize listener failed: ' + (error && error.message ? error.message : error)); }
    }
  }

  // DOMContentLoaded and load, once the page has been drawn, as a browser
  // sends them after it has read the page and its scripts have run.
  var windowLoad = [];
  function ready() {
    var d = rec(doc);
    if (d.ready === 'complete') return;
    d.ready = 'interactive';
    dispatch(doc, new Event('DOMContentLoaded', { bubbles: true }));
    d.ready = 'complete';
    var fire = windowLoad.slice();
    windowLoad = [];
    for (var i = 0; i < fire.length; i++) {
      try { fire[i].call(win, new Event('load')); } catch (error) {
        console.error('[SoftN] A load listener failed: ' + (error && error.message ? error.message : error));
      }
    }
  }

  // The window SoftN's engine gives logic keeps its own listeners for the
  // browser's events; load and DOMContentLoaded are this document's.
  if (win && typeof win.addEventListener === 'function') {
    var engineAdd = win.addEventListener;
    try {
      win.addEventListener = function (type, fn, options) {
        if (type === 'load') { windowLoad.push(fn); return; }
        if (type === 'DOMContentLoaded') { addListener(doc, type, fn, options); return; }
        if (type === 'hashchange' || type === 'popstate') { windowListeners[type].push(fn); return; }
        if (type === 'resize') { resizeListeners.push(fn); listen('softn:viewport'); return; }
        return engineAdd.call(win, type, fn, options);
      };
      var engineRemove = win.removeEventListener;
      win.removeEventListener = function (type, fn, options) {
        var list = type === 'resize' ? resizeListeners : windowListeners[type];
        if (list) { var at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); return; }
        if (typeof engineRemove === 'function') return engineRemove.call(win, type, fn, options);
      };
    } catch (error) {
      warnOnce('window-load', 'window.addEventListener("load") is not heard on this engine; use document.addEventListener("DOMContentLoaded").');
    }
  }

  var api = {
    init: init, take: take, sync: sync, event: event, ready: ready,
    document: null,
    Node: Node, Element: Element, HTMLElement: HTMLElement, HTMLInputElement: HTMLInputElement,
    HTMLTextAreaElement: HTMLTextAreaElement, HTMLSelectElement: HTMLSelectElement, HTMLOptionElement: HTMLOptionElement,
    HTMLFormElement: HTMLFormElement, HTMLButtonElement: HTMLButtonElement, HTMLAnchorElement: HTMLAnchorElement,
    HTMLImageElement: HTMLImageElement, Text: Text, Comment: Comment, DocumentFragment: DocumentFragment,
    Event: Event, CustomEvent: CustomEvent, KeyboardEvent: KeyboardEvent, MouseEvent: MouseEvent,
    InputEvent: InputEvent, FocusEvent: FocusEvent, SubmitEvent: SubmitEvent, FormData: FormData,
    PointerEvent: PointerEvent, DragEvent: DragEvent,
    getComputedStyle: getComputedStyle, fetch: fetch, Headers: Headers, Response: Response, location: location,
    URLSearchParams: URLSearchParams, queueMicrotask: queueMicrotask, requestAnimationFrame: requestAnimationFrame,
    cancelAnimationFrame: cancelAnimationFrame, structuredClone: structuredClone, sessionStorage: sessionStorage,
    alert: alert, confirm: confirm, prompt: prompt,
    EventTarget: EventTarget, DOMException: DOMException, AbortController: AbortController, AbortSignal: AbortSignal,
    URL: URL, btoa: btoa, atob: atob, TextEncoder: TextEncoder, TextDecoder: TextDecoder, crypto: crypto,
    MutationObserver: MutationObserver, ResizeObserver: ResizeObserver, IntersectionObserver: IntersectionObserver,
    matchMedia: matchMedia, history: history, HTMLOutputElement: HTMLOutputElement,
    HTMLTemplateElement: HTMLTemplateElement, HTMLDialogElement: HTMLDialogElement, DataTransfer: DataTransfer,
    viewport: function () { return viewport; },
  };
  return api;
})(typeof window !== 'undefined' ? window : null);

function __softnDocInit(seed) { __softnShell.init(seed); }
function __softnDocTake() { return __softnShell.take(); }
function __softnDocSync(changes) { __softnShell.sync(changes); }
function __softnDocEvent(id, type, props, path) { return __softnShell.event(id, type, props, path); }
function __softnDocReady() { __softnShell.ready(); }
`;

/**
 * The globals the page's code reads, set up with the shell's seed: what a
 * browser gives a page by these names. They are properties of the global
 * object, not declarations, as a browser's are: a page's own `let location`,
 * `const { Text } = …` or `class Comment` shadows one with no clash, and a
 * page's own `function alert()`, which is on the global object before this
 * runs, is left as it is.
 */
export function shellPrelude(seedJson: string): string {
  const names = [...SHELL_GLOBAL_NAMES].filter((name) => name !== '__softnShell');
  return (
    DOCUMENT_SHELL_SOURCE +
    '\n__softnShell.init(' + seedJson + ');\n' +
    names.map((name) => 'if (typeof globalThis.' + name + ' === "undefined") globalThis.' + name + ' = __softnShell.' + name + ';').join('\n') +
    '\nif (typeof window !== "undefined" && window) { try { window.document = __softnShell.document; window.location = __softnShell.location; } catch (e) {} }\n' +
    // The engine's window is an object of its own: window.matchMedia(),
    // window.history and the rest are there too, where the engine has none.
    'if (typeof window !== "undefined" && window) { ' +
    names.map((name) => 'if (typeof window.' + name + ' === "undefined") window.' + name + ' = __softnShell.' + name + ';').join(' ') +
    ' }\n' +
    // The window's size, read as it is now.
    '[["innerWidth", "w"], ["innerHeight", "h"], ["devicePixelRatio", "ratio"]].forEach(function (p) { ' +
    '[globalThis, typeof window !== "undefined" ? window : null].forEach(function (o) { ' +
    'if (o && typeof o[p[0]] === "undefined") { try { Object.defineProperty(o, p[0], { configurable: true, get: function () { return __softnShell.viewport()[p[1]]; } }); } catch (e) {} } }); });\n'
  );
}
