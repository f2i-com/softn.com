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

/** The functions the host calls, declared at the top of the logic. */
export const SHELL_INIT = '__softnDocInit';
export const SHELL_TAKE = '__softnDocTake';
export const SHELL_EVENT = '__softnDocEvent';
export const SHELL_SYNC = '__softnDocSync';
export const SHELL_READY = '__softnDocReady';

/** Names the shell declares at the top of the logic: none of them is the page's state. */
export const SHELL_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  '__softnShell',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLOptionElement',
  'HTMLFormElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLImageElement',
  'Text',
  'Comment',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'InputEvent',
  'FocusEvent',
  'SubmitEvent',
  'FormData',
  'getComputedStyle',
  'fetch',
  'Headers',
  'Response',
  'location',
  'URLSearchParams',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'structuredClone',
  'sessionStorage',
]);

/** Whether a name is the shell's own: a function the host calls, or one it declares. */
export function isShellName(name: string): boolean {
  return name.startsWith('__softnDoc') || SHELL_GLOBAL_NAMES.has(name);
}

/**
 * Whether a value read out of the engine holds a node of the document, or a
 * list or record of them: the engine's copy of `const list =
 * document.getElementById('list')`. Written back, it would replace the node
 * with a plain record, and the code's next `list.appendChild` would fail.
 */
export function holdsShellNode(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object' || depth > 3) return false;
  if (typeof (value as { __softnNode?: unknown }).__softnNode === 'number') return true;
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (let i = 0; i < items.length && i < 64; i++) if (holdsShellNode(items[i], depth + 1)) return true;
  return false;
}

/**
 * Whether code is written for a browser: it names `document`, or another of
 * the window's names the shell gives (`fetch(…)`, `location.…`,
 * `URLSearchParams`…) as a name of its own rather than a property
 * (`user.location` is not one). Read roughly, comments and strings
 * included; a page that only mentions one gets a document it does not use,
 * which costs a little and changes nothing.
 */
export function usesDocument(code: string): boolean {
  return (
    /\bdocument\s*[.[]/.test(code) ||
    /(?<![.\w$])(?:fetch\s*\(|location\s*[.=[]|URLSearchParams\b|requestAnimationFrame\b|queueMicrotask\b|structuredClone\b|sessionStorage\b)/.test(code)
  );
}

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
  function register(node, r) {
    STATE.set(node, r);
    BY_ID[r.id] = node;
    node.__softnNode = r.id;
    return node;
  }

  function newRecord(type, id) {
    return { id: id || nextId++, type: type, tag: '', attrs: [], parent: null, kids: [], text: '', island: false, listeners: {}, inline: {} };
  }

  function makeElement(tag, id, island) {
    var lower = String(tag).toLowerCase();
    var Ctor = ELEMENT_CLASSES[lower] || HTMLElement;
    var node = Object.create(Ctor.prototype);
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
    var p = rec(c.parent);
    var at = p.kids.indexOf(child);
    if (at >= 0) p.kids.splice(at, 1);
    c.parent = null;
    childrenChanged(p);
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
    for (var i = 0; i < old.length; i++) rec(old[i]).parent = null;
    p.kids = [];
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
        r.attrs[i][1] = value;
        attrChanged(r, name, value);
        return;
      }
    }
    r.attrs.push([name, value]);
    attrChanged(r, name, value);
  }

  function removeAttr(node, name) {
    var r = rec(node);
    name = String(name).toLowerCase();
    if (r.island) return;
    if (name.indexOf('on') === 0 && name.length > 2) { delete r.inline[name.slice(2)]; return; }
    for (var i = 0; i < r.attrs.length; i++) {
      if (r.attrs[i][0] === name) {
        r.attrs.splice(i, 1);
        attrChanged(r, name, null);
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
    });
    return r.dataset;
  }

  // ---------------------------------------------------------------- selectors

  var SELECTORS = {};

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
    return all ? found : found[0] || null;
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
      if (!VOID[tag] && !selfClosing) stack.push(el);
    }
    return rec(root).kids.slice();
  }

  function setInnerHTML(node, html) {
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
    listen(type);
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
      if (form) form.requestSubmit();
    }
  }

  // ---------------------------------------------------------------- classes

  class EventTarget {
    addEventListener(type, fn, options) { addListener(this, String(type), fn, options); }
    removeEventListener(type, fn, options) { removeListener(this, String(type), fn, options); }
    dispatchEvent(event) { return dispatch(this, event); }
  }

  class Node extends EventTarget {
    get nodeType() { return rec(this).type; }
    get parentNode() { return rec(this).parent; }
    get parentElement() { var p = rec(this).parent; return p && rec(p).type === 1 ? p : null; }
    get childNodes() { return rec(this).kids.slice(); }
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
      r.text = value === null || value === undefined ? '' : String(value);
      if (r.type === 3 && isConnected(r)) ops.push(['x', r.id, r.text]);
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
      for (var i = 0; i < r.attrs.length; i++) cr.attrs.push([r.attrs[i][0], r.attrs[i][1]]);
      if (r.value !== undefined) cr.value = r.value;
      if (r.checked !== undefined) cr.checked = r.checked;
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
    children: function () { return rec(this).kids.filter(function (n) { return rec(n).type === 1; }); },
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
    get innerHTML() { var r = rec(this); var out = ''; if (!r.island) for (var i = 0; i < r.kids.length; i++) out += serialize(rec(r.kids[i])); return out; }
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
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    getClientRects() { return []; }
    get offsetWidth() { return 0; }
    get offsetHeight() { return 0; }
    get offsetTop() { return 0; }
    get offsetLeft() { return 0; }
    get clientWidth() { return 0; }
    get clientHeight() { return 0; }
    get scrollWidth() { return 0; }
    get scrollHeight() { return 0; }
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
    get form() { return this.closest('form'); }
    select() {}
    setSelectionRange() {}
    checkValidity() { return true; }
    reportValidity() { return true; }
    setCustomValidity() {}
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
      return select ? select.selectedIndex === select.options.indexOf(this) : getAttr(rec(this), 'selected') !== null;
    }
    set selected(v) {
      var select = this.closest('select');
      if (select && v) select.selectedIndex = select.options.indexOf(this);
    }
    get index() { var select = this.closest('select'); return select ? select.options.indexOf(this) : 0; }
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
    set selectedIndex(i) { var r = rec(this); r.selectedIndex = Number(i); propChanged(r, 'selectedIndex', r.selectedIndex); }
    get selectedOptions() { var o = this.options[this.selectedIndex]; return o ? [o] : []; }
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

  class HTMLFormElement extends HTMLElement {
    get elements() { return query(this, 'input, select, textarea, button', true); }
    get length() { return this.elements.length; }
    submit() {}
    requestSubmit() {
      if (dispatch(this, new SubmitEvent('submit', { bubbles: true, cancelable: true }))) {
        warnOnce('form-submit', 'A form with nowhere to send what it holds is kept on the page.');
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
    checkValidity() { return true; }
    reportValidity() { return true; }
  }

  class HTMLButtonElement extends HTMLElement {
    get value() { return getAttr(rec(this), 'value') || ''; }
    set value(v) { setAttr(this, 'value', v); }
    get form() { return this.closest('form'); }
  }
  class HTMLAnchorElement extends HTMLElement {
    get text() { return this.textContent; }
  }
  class HTMLImageElement extends HTMLElement {
    get width() { return Number(getAttr(rec(this), 'width')) || 0; }
    get height() { return Number(getAttr(rec(this), 'height')) || 0; }
    get complete() { return true; }
  }

  var ELEMENT_CLASSES = {
    input: HTMLInputElement, textarea: HTMLTextAreaElement, select: HTMLSelectElement, option: HTMLOptionElement,
    form: HTMLFormElement, button: HTMLButtonElement, a: HTMLAnchorElement, img: HTMLImageElement,
  };

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
      var options = {};
      if (init && typeof init === 'object') {
        if (init.method) options.method = String(init.method).toUpperCase();
        if (init.headers) {
          var headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
          options.headers = {};
          headers.forEach(function (value, name) { options.headers[name] = value; });
        }
        if (init.body !== undefined && init.body !== null) options.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      }
      softn.net.fetch(url, options, function (result) {
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
      here = parseUrl(here.href.split('#')[0] + target);
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
    if (typeof init === 'string') {
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

  function queueMicrotask(fn) { Promise.resolve().then(fn); }
  function requestAnimationFrame(fn) { return setTimeout(function () { fn(Date.now()); }, 16); }
  function cancelAnimationFrame(id) { clearTimeout(id); }
  function structuredClone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

  // sessionStorage: for as long as the page is open.
  function Storage() { Object.defineProperty(this, '_items', { value: {}, writable: true, enumerable: false }); }
  Storage.prototype.getItem = function (key) { var v = this._items[String(key)]; return v === undefined ? null : v; };
  Storage.prototype.setItem = function (key, value) { this._items[String(key)] = String(value); };
  Storage.prototype.removeItem = function (key) { delete this._items[String(key)]; };
  Storage.prototype.clear = function () { this._items = {}; };
  Storage.prototype.key = function (i) { var keys = Object.keys(this._items); return i < keys.length ? keys[i] : null; };
  Object.defineProperty(Storage.prototype, 'length', { get: function () { return Object.keys(this._items).length; } });
  var sessionStorage = new Storage();

  // ---------------------------------------------------------------- the host's side

  function build(seed, parent) {
    var node;
    if (seed.x !== undefined) node = makeText(seed.x, seed.i);
    else if (seed.o && !seed.t) node = makeComment('', seed.i, true);
    else {
      node = makeElement(seed.t, seed.i, !!seed.o);
      var r = rec(node);
      for (var key in seed.a || {}) r.attrs.push([key, String(seed.a[key])]);
      if (seed.c) for (var i = 0; i < seed.c.length; i++) build(seed.c[i], node);
    }
    rec(node).parent = parent;
    rec(parent).kids.push(node);
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
    for (var i = 0; i < (seed.body || []).length; i++) build(seed.body[i], body);
    nextId = Math.max(nextId, seed.next || 2);
    if (seed.title) d.title = seed.title;
    here = parseUrl(seed.url || '');
    ops = [];
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
      var node = BY_ID[c[1]];
      var r = node && rec(node);
      if (!r) continue;
      if (c[0] === 'v') r.value = String(c[2]);
      else if (c[0] === 'k') r.checked = !!c[2];
      else if (c[0] === 's') r.selectedIndex = Number(c[2]);
    }
  }

  var EVENT_KINDS = {
    keydown: KeyboardEvent, keyup: KeyboardEvent, keypress: KeyboardEvent,
    click: MouseEvent, dblclick: MouseEvent, mousedown: MouseEvent, mouseup: MouseEvent, mousemove: MouseEvent,
    mouseover: MouseEvent, mouseout: MouseEvent, mouseenter: MouseEvent, mouseleave: MouseEvent, contextmenu: MouseEvent,
    input: InputEvent, focus: FocusEvent, blur: FocusEvent, focusin: FocusEvent, focusout: FocusEvent, submit: SubmitEvent,
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
    e.isTrusted = true;
    dispatch(target, e);
    return (e.defaultPrevented ? 1 : 0) | (e._stop ? 2 : 0);
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
        return engineAdd.call(win, type, fn, options);
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
    getComputedStyle: getComputedStyle, fetch: fetch, Headers: Headers, Response: Response, location: location,
    URLSearchParams: URLSearchParams, queueMicrotask: queueMicrotask, requestAnimationFrame: requestAnimationFrame,
    cancelAnimationFrame: cancelAnimationFrame, structuredClone: structuredClone, sessionStorage: sessionStorage,
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
 * The names of SHELL_GLOBAL_NAMES the page's code declares itself: a `class
 * Comment` of its own, or `let Event`. Those are left to it, since declaring
 * them again would keep the whole script from compiling. Read roughly, as a
 * name after a declaring word.
 */
export function namesDeclaredBy(code: string): Set<string> {
  const declared = new Set<string>();
  for (const name of SHELL_GLOBAL_NAMES) {
    const escaped = name.replace(/\$/g, '\\$');
    if (new RegExp('\\b(?:let|const|var|class|function)\\s+' + escaped + '\\b').test(code)) declared.add(name);
  }
  return declared;
}

/**
 * The globals the page's code reads, declared after the shell is set up
 * with its seed: what a browser gives a page by these names, but for any the
 * code declares itself (`own`).
 */
export function shellPrelude(seedJson: string, own: ReadonlySet<string> = new Set()): string {
  const names = [...SHELL_GLOBAL_NAMES].filter((name) => name !== '__softnShell' && name !== 'document' && !own.has(name));
  return (
    DOCUMENT_SHELL_SOURCE +
    '\n__softnShell.init(' + seedJson + ');\n' +
    'var document = __softnShell.document;\n' +
    names.map((name) => 'var ' + name + ' = __softnShell.' + name + ';').join('\n') +
    '\nif (typeof window !== "undefined" && window) { try { window.document = document; window.location = __softnShell.location; } catch (e) {} }\n'
  );
}
