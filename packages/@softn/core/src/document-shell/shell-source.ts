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
 * and no `${`. The table of character references is put in where the
 * source says @ENTITIES@.
 */
import { HTML_ENTITIES, LEGACY_ENTITIES } from '../parser/html-entities';
import { SHELL_GLOBAL_NAMES } from './names';

/**
 * The character references SoftN's own parser reads (parser/html-entities),
 * for the shell's innerHTML: each name and its character's code point in
 * base 36, marked ! where HTML reads it without its `;`. Short, as the
 * shell's source is handed to every page that uses the document.
 */
function entityTable(): string {
  return Object.keys(HTML_ENTITIES)
    .map((name) => name + ' ' + (LEGACY_ENTITIES.has(name) ? '!' : '') + HTML_ENTITIES[name].codePointAt(0)!.toString(36))
    .join(' ');
}

export const DOCUMENT_SHELL_SOURCE = String.raw`
var __softnShell = (function (win) {
  // Tables looked up by a name the page's code chooses (a tag, an event's
  // type, a selector) have no prototype: 'constructor' and 'toString' are
  // names like any other there, not Object's.
  function set(text) {
    var t = Object.create(null);
    var names = text.split(' ');
    for (var i = 0; i < names.length; i++) t[names[i]] = 1;
    return t;
  }
  function dict(o) {
    var t = Object.create(null);
    for (var k in o) t[k] = o[k];
    return t;
  }

  var STATE = new WeakMap();
  var BY_ID = Object.create(null);
  var nextId = 2;
  var ops = [];
  var listening = Object.create(null);
  var warned = Object.create(null);
  var doc = null;
  var activeId = 0;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MATH_NS = 'http://www.w3.org/1998/Math/MathML';
  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var VOID = set('area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr');
  // Elements whose text is not escaped when written out as HTML.
  var RAW_TEXT = set('script style xmp iframe noembed noframes noscript plaintext');

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

  // A handler written as an attribute (onclick="…") is the page's to run,
  // here; the host, which draws no handler from one, is never told of it
  // (hostName).
  function isHandlerName(name) { return name.length > 2 && name.charAt(0) === 'o' && name.charAt(1) === 'n'; }

  // What the host is told a name is: an HTML element's as it is; a
  // drawing's in lower case, as all names were told before a drawing's kept
  // their case, but for SVG's own (viewBox, linearGradient), which the page
  // draws only so. No on… name, in any case, is told.
  function hostName(r, name) {
    if (/^on/i.test(name)) return null;
    if (!r.ns) return name;
    var lower = name.toLowerCase();
    return r.ns === 'svg' ? SVG_ATTRS[lower] || lower : lower;
  }
  function hostTag(r) {
    if (!r.ns) return r.tag;
    var lower = r.tag.toLowerCase();
    return r.ns === 'svg' ? SVG_TAGS[lower] || lower : lower;
  }

  function attrsOf(r) {
    var out = {};
    for (var i = 0; i < r.attrs.length; i++) {
      var name = hostName(r, r.attrs[i][0]);
      if (name !== null) out[name] = r.attrs[i][1];
    }
    return out;
  }

  // A subtree that joins the document is told to the host whole, as it is
  // now: what was done to it while it was apart was told to no one.
  function announce(r) {
    if (!r.island) BY_ID[r.id] = r.node;
    if (r.type === 1) {
      var id = getAttr(r, 'id');
      if (id) idIndex(id, r.node, true);
    }
    if (r.type === 1 && !r.island) {
      ops.push(['e', r.id, hostTag(r), attrsOf(r)]);
      for (var i = 0; i < r.kids.length; i++) announce(rec(r.kids[i]));
      childrenChanged(r);
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

  // A parent whose children changed is told once a turn, with its children
  // as they are when the turn is over. Told whole after every change, a list
  // filled a row at a time came to two million ids by its two thousandth
  // row, more than the engine can hand the host at once.
  var due = [];
  function childrenChanged(r) {
    if (r.due || !isConnected(r)) return;
    r.due = true;
    due.push(r);
  }
  // Told even of a parent taken off the page since: the host knows it, and
  // lets go of what it then holds with it.
  function tellChildren() {
    var list = due;
    due = [];
    for (var i = 0; i < list.length; i++) {
      list[i].due = false;
      ops.push(['c', list[i].id, kidIds(list[i])]);
    }
  }

  function attrChanged(r, name, value) {
    attrVersion++;
    var told = hostName(r, name);
    if (told !== null && isConnected(r)) ops.push(['a', r.id, told, value]);
  }

  // Elements on the page by their id, for getElementById: a page that looked
  // its elements up by id on every change walked the whole page each time.
  var IDS = new Map();
  function idIndex(id, node, on) {
    if (id === '' || id === null) return;
    var list = IDS.get(id);
    if (on) {
      if (!list) IDS.set(id, [node]);
      else if (list.indexOf(node) < 0) list.push(node);
    } else if (list) {
      var at = list.indexOf(node);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) IDS.delete(id);
    }
  }

  // How the tree and its attributes have changed, for the lists a browser
  // keeps live (children, getElementsByTagName…): each is read again only
  // when what it depends on has changed since.
  var treeVersion = 0;
  var attrVersion = 0;
  function kidsChanged(r) {
    r.kidsVersion = (r.kidsVersion || 0) + 1;
    treeVersion++;
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
    if (r.type === 1) {
      var id = getAttr(r, 'id');
      if (id) idIndex(id, r.node, false);
    }
    for (var i = 0; i < r.kids.length; i++) forget(rec(r.kids[i]));
  }

  function newRecord(type, id) {
    return {
      id: id || nextId++, type: type, tag: '', ns: '', attrs: [], parent: null, kids: [], text: '', island: false,
      listeners: Object.create(null), inline: Object.create(null),
    };
  }

  // An element of HTML, or (ns 'svg' or 'math') of a drawing or a formula,
  // whose names keep their case: a linearGradient, a viewBox.
  function makeElement(tag, id, island, ns) {
    var name = ns ? String(tag) : String(tag).toLowerCase();
    var Ctor = ns === 'svg' ? SVGElement : ns ? Element : ELEMENT_CLASSES[name] || HTMLElement;
    var node = Object.create(Ctor.prototype);
    if (!ns && name === 'form') node = new Proxy(node, FORM_FIELDS);
    var r = newRecord(1, id);
    r.tag = name;
    r.ns = ns || '';
    r.island = !!island;
    return register(node, r);
  }

  function domError(name, message) { return new DOMException(message, name); }

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
    kidsChanged(p);
    if (was) forget(c);
    childrenChanged(p);
    mutated({ type: 'childList', target: parent, removedNodes: [child], previousSibling: p.kids[at - 1] || null, nextSibling: p.kids[at] || null });
  }

  function nodesFrom(args) {
    var list = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'object' && a !== null && rec(a)) list.push(a);
      else list.push(makeText(String(a)));
    }
    return list;
  }

  function contains(ancestor, node) {
    for (var n = node; n; n = rec(n).parent) if (n === ancestor) return true;
    return false;
  }

  // Put nodes into parent before ref (or at the end), a fragment's children
  // in its place, each taken from where it was first. What a browser refuses
  // is refused with its DOMException: a node put inside itself, children of
  // a text, a ref that is not the parent's child.
  function checkInsert(parent, nodes) {
    var p = rec(parent);
    if (p.type !== 1 && p.type !== 9 && p.type !== 11) throw domError('HierarchyRequestError', 'This node cannot have children.');
    for (var v = 0; v < nodes.length; v++) {
      var vr = nodes[v] !== null && typeof nodes[v] === 'object' ? rec(nodes[v]) : null;
      if (!vr || vr.type === 0) throw new TypeError('The node to insert is not a Node.');
      if (vr.type === 9 || contains(nodes[v], parent)) throw domError('HierarchyRequestError', 'The new child element contains the parent.');
    }
  }

  function insert(parent, nodes, ref, quiet) {
    var p = rec(parent);
    checkInsert(parent, nodes);
    if (ref && rec(ref).parent !== parent) throw domError('NotFoundError', 'The node before which the new node is to be inserted is not a child of this node.');
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
        kidsChanged(nr);
        if (inner.length > 0) mutated({ type: 'childList', target: n, removedNodes: inner });
      } else {
        flat.push(n);
      }
    }
    for (var k = 0; k < flat.length; k++) {
      if (flat[k] === ref) ref = nextSiblingOf(ref, flat);
      detach(flat[k]);
    }
    var at = ref ? p.kids.indexOf(ref) : -1;
    if (at < 0) at = p.kids.length;
    for (var m = 0; m < flat.length; m++) {
      rec(flat[m]).parent = parent;
      p.kids.splice(at + m, 0, flat[m]);
    }
    kidsChanged(p);
    if (isConnected(p)) {
      for (var q = 0; q < flat.length; q++) announce(rec(flat[q]));
      childrenChanged(p);
    }
    if (flat.length > 0 && !quiet) {
      mutated({ type: 'childList', target: parent, addedNodes: flat, previousSibling: p.kids[at - 1] || null, nextSibling: p.kids[at + flat.length] || null });
    }
    return flat;
  }

  function nextSiblingOf(node, skipping) {
    var r = rec(node);
    var p = rec(r.parent);
    for (var i = p.kids.indexOf(node) + 1; i < p.kids.length; i++) {
      if (skipping.indexOf(p.kids[i]) < 0) return p.kids[i];
    }
    return null;
  }

  // innerHTML, textContent and replaceChildren(): what was there out, what
  // is given in, as one change (one MutationRecord, as a browser makes).
  function replaceAllChildren(parent, nodes) {
    var p = rec(parent);
    var old = p.kids.slice();
    var was = isConnected(p);
    for (var i = 0; i < old.length; i++) {
      rec(old[i]).parent = null;
      if (was) forget(rec(old[i]));
    }
    p.kids = [];
    kidsChanged(p);
    var added = nodes.length > 0 ? insert(parent, nodes, null, true) : [];
    childrenChanged(p);
    if (old.length > 0 || added.length > 0) mutated({ type: 'childList', target: parent, removedNodes: old, addedNodes: added });
  }

  function textOf(r) {
    if (r.type === 3) return r.text;
    if (r.seen) return r.text;
    if (r.type === 8 || r.island) return '';
    var out = '';
    for (var i = 0; i < r.kids.length; i++) out += textOf(rec(r.kids[i]));
    return out;
  }

  // innerText, as far as it does not need layout: a <br> is a line break.
  function innerTextOf(r) {
    if (r.type === 3) return r.text;
    if (r.seen) return r.text;
    if (r.type !== 1 && r.type !== 11 || r.island) return '';
    if (r.tag === 'br' && !r.ns) return '\n';
    var out = '';
    for (var i = 0; i < r.kids.length; i++) out += innerTextOf(rec(r.kids[i]));
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

  // An HTML element's attribute names are read in lower case; a drawing's
  // keep theirs (viewBox).
  function attrName(r, name) { return r.ns ? String(name) : String(name).toLowerCase(); }

  function getAttr(r, name) {
    name = attrName(r, name);
    for (var i = 0; i < r.attrs.length; i++) if (r.attrs[i][0] === name) return r.attrs[i][1];
    return null;
  }

  // A name setAttribute() refuses, as a browser does: empty, or with a space, /, = or >.
  function checkAttrName(name) {
    if (name === '' || /[\t\n\f\r \x00\/=>]/.test(name)) throw domError('InvalidCharacterError', '\'' + name + '\' is not a valid attribute name.');
  }

  function setAttr(node, name, value) {
    var r = rec(node);
    name = attrName(r, name);
    value = String(value);
    if (r.island) {
      warnOnce('island-attrs', 'A component\u2019s attributes are SoftN\u2019s: the page\u2019s code can read them, not change them.');
      return;
    }
    var was = null;
    var at = -1;
    for (var i = 0; i < r.attrs.length; i++) if (r.attrs[i][0] === name) { at = i; was = r.attrs[i][1]; break; }
    // A handler written as an attribute: code the page runs, where a
    // listener added at the same time would run.
    if (isHandlerName(name)) setInline(r, name.slice(2), inlineHandler(value), value);
    if (at >= 0) {
      if (was !== value) {
        r.attrs[at][1] = value;
        if (name === 'id' && isConnected(r)) { idIndex(was, node, false); idIndex(value, node, true); }
        attrChanged(r, name, value);
      }
    } else {
      r.attrs.push([name, value]);
      if (name === 'id' && isConnected(r)) idIndex(value, node, true);
      attrChanged(r, name, value);
    }
    // Told to an observer even when it is the value it was, as a browser tells it.
    mutated({ type: 'attributes', target: node, attributeName: name, oldValue: was });
  }

  function removeAttr(node, name) {
    var r = rec(node);
    name = attrName(r, name);
    if (r.island) return;
    for (var i = 0; i < r.attrs.length; i++) {
      if (r.attrs[i][0] === name) {
        var was = r.attrs[i][1];
        r.attrs.splice(i, 1);
        if (isHandlerName(name)) setInline(r, name.slice(2), null);
        if (name === 'id' && isConnected(r)) idIndex(was, node, false);
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
    var handler = function (event) { return fn.call(this, event); };
    if (++handlerCount > 500) { HANDLERS = {}; handlerCount = 1; }
    HANDLERS[code] = handler;
    return handler;
  }

  // ---------------------------------------------------------------- style and lists

  // A property's name as CSS writes it: backgroundColor is background-color,
  // cssFloat is float, and webkitTransform is transform, as a browser takes
  // the -webkit- names it has standard ones for.
  var WEBKIT_ALIASES = set(
    'transform transform-origin transform-style transition transition-property transition-duration ' +
    'transition-timing-function transition-delay animation animation-name animation-duration animation-timing-function ' +
    'animation-delay animation-iteration-count animation-direction animation-fill-mode animation-play-state perspective ' +
    'perspective-origin backface-visibility box-shadow border-radius border-top-left-radius border-top-right-radius ' +
    'border-bottom-left-radius border-bottom-right-radius box-sizing flex flex-direction flex-wrap flex-flow flex-grow ' +
    'flex-shrink flex-basis align-items align-self align-content justify-content order filter appearance opacity'
  );
  function cssName(name) {
    if (name.indexOf('--') === 0) return name;
    name = name.toLowerCase();
    return name.indexOf('-webkit-') === 0 && WEBKIT_ALIASES[name.slice(8)] ? name.slice(8) : name;
  }
  function kebab(name) {
    name = String(name);
    if (name.indexOf('-') >= 0) return cssName(name);
    if (name === 'cssFloat') return 'float';
    if (/^(?:webkit|moz|ms)[A-Z]/.test(name)) name = '-' + name;
    return cssName(name.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }));
  }

  // A declaration list as CSS reads one: a ; in quotes or brackets (a
  // url("data:…;base64,…")) does not end a declaration, !important is its
  // priority, and of a property written twice the later is kept.
  function parseStyle(text) {
    var out = [];
    var s = String(text || '');
    var start = 0;
    var depth = 0;
    var quote = '';
    function declaration(part) {
      var at = part.indexOf(':');
      if (at <= 0) return;
      var name = part.slice(0, at).trim();
      var value = part.slice(at + 1).trim();
      var important = /!\s*important$/i.exec(value);
      if (important) value = value.slice(0, important.index).trim();
      if (!name || !value) return;
      name = cssName(name);
      for (var k = 0; k < out.length; k++) if (out[k][0] === name) { out.splice(k, 1); break; }
      out.push([name, value, !!important]);
    }
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\\') i++;
      else if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
      else if (ch === ';' && depth === 0) { declaration(s.slice(start, i)); start = i + 1; }
    }
    declaration(s.slice(start));
    return out;
  }

  function styleText(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) parts.push(list[i][0] + ': ' + list[i][1] + (list[i][2] ? ' !important' : '') + ';');
    return parts.join(' ');
  }

  function styleOf(node) {
    var r = rec(node);
    if (r.style) return r.style;
    function read() { return parseStyle(getAttr(r, 'style')); }
    // Emptied, the attribute stays, empty, as a browser leaves it.
    function write(list) { setAttr(node, 'style', styleText(list)); }
    function setOne(name, value, priority) {
      var list = read();
      var key = kebab(name);
      var found = false;
      var text = value === null || value === undefined ? '' : String(value).trim();
      var important = String(priority || '').toLowerCase() === 'important';
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === key) {
          found = true;
          if (text === '') list.splice(i, 1);
          else { list[i][1] = text; list[i][2] = important; }
          break;
        }
      }
      if (!found && text === '') return;
      if (!found) list.push([key, text, important]);
      write(list);
    }
    function find(name) {
      var key = kebab(name);
      var list = read();
      for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i];
      return null;
    }
    function getOne(name) { var d = find(name); return d ? d[1] : ''; }
    var methods = {
      setProperty: function (name, value, priority) { setOne(name, value, priority); },
      getPropertyValue: function (name) { return getOne(name); },
      getPropertyPriority: function (name) { var d = find(name); return d && d[2] ? 'important' : ''; },
      removeProperty: function (name) { var was = getOne(name); if (was !== '') setOne(name, ''); return was; },
      item: function (i) { var list = read(); return list[i] ? list[i][0] : ''; },
    };
    r.style = new Proxy({}, {
      get: function (target, key) {
        if (key === 'cssText') return styleText(read());
        if (key === 'length') return read().length;
        if (key === 'cssFloat') return getOne('float');
        if (typeof key !== 'string') return undefined;
        if (methods[key] && Object.prototype.hasOwnProperty.call(methods, key)) return methods[key];
        if (/^\d+$/.test(key)) return methods.item(Number(key));
        return getOne(key);
      },
      set: function (target, key, value) {
        if (key === 'cssText') { write(parseStyle(value)); return true; }
        if (typeof key === 'string') setOne(key, value);
        return true;
      },
    });
    return r.style;
  }

  function classesOf(r) {
    var text = getAttr(r, 'class');
    return text ? text.split(/[\t\n\f\r ]+/).filter(function (c) { return c !== ''; }) : [];
  }

  // The class list as a browser keeps it: each class once, in order, read
  // by index (classList[0]), and an element with no class attribute given
  // none by taking away what it does not have.
  function tokenSet(r) {
    var list = classesOf(r);
    return list.filter(function (c, i) { return list.indexOf(c) === i; });
  }
  function checkToken(token) {
    token = String(token);
    if (token === '') throw domError('SyntaxError', 'The token provided must not be empty.');
    if (/[\t\n\f\r ]/.test(token)) throw domError('InvalidCharacterError', 'The token provided (\'' + token + '\') contains HTML space characters, which are not valid in tokens.');
    return token;
  }

  function classListOf(node) {
    var r = rec(node);
    if (r.classList) return r.classList;
    function write(list, always) {
      if (!always && getAttr(r, 'class') === null && list.length === 0) return;
      setAttr(node, 'class', list.join(' '));
    }
    var methods = {
      // add() writes the attribute even given nothing, as a browser does.
      add: function () {
        var tokens = Array.prototype.map.call(arguments, checkToken);
        var list = tokenSet(r);
        for (var i = 0; i < tokens.length; i++) if (list.indexOf(tokens[i]) < 0) list.push(tokens[i]);
        write(list, true);
      },
      remove: function () {
        var tokens = Array.prototype.map.call(arguments, checkToken);
        var list = tokenSet(r);
        for (var i = 0; i < tokens.length; i++) {
          var at = list.indexOf(tokens[i]);
          if (at >= 0) list.splice(at, 1);
        }
        write(list);
      },
      toggle: function (name, force) {
        name = checkToken(name);
        var list = tokenSet(r);
        var at = list.indexOf(name);
        var on = force === undefined ? at < 0 : !!force;
        if (on === (at >= 0)) return on;
        if (on) list.push(name);
        else list.splice(at, 1);
        write(list);
        return on;
      },
      contains: function (name) { return classesOf(r).indexOf(String(name)) >= 0; },
      replace: function (a, b) {
        a = checkToken(a);
        b = checkToken(b);
        var list = tokenSet(r);
        var at = list.indexOf(a);
        if (at < 0) return false;
        var other = list.indexOf(b);
        if (other >= 0 && other !== at) list.splice(Math.max(at, other), 1);
        list[Math.min(at, other < 0 ? at : other)] = b;
        write(list);
        return true;
      },
      supports: function () { throw new TypeError('classList has no supported tokens.'); },
      item: function (i) { var list = tokenSet(r); return i >= 0 && i < list.length ? list[i] : null; },
      forEach: function (fn, self) { var list = tokenSet(r); for (var i = 0; i < list.length; i++) fn.call(self, list[i], i, r.classList); },
      toString: function () { return getAttr(r, 'class') || ''; },
      entries: function () { return tokenSet(r).entries(); },
      values: function () { return tokenSet(r).values(); },
      keys: function () { return tokenSet(r).keys(); },
    };
    methods[Symbol.iterator] = methods.values;
    r.classList = new Proxy(methods, {
      get: function (target, key) {
        if (key === 'length') return tokenSet(r).length;
        if (key === 'value') return getAttr(r, 'class') || '';
        if (typeof key === 'string' && /^\d+$/.test(key)) { var list = tokenSet(r); return list[Number(key)]; }
        return target[key];
      },
      set: function (target, key, value) {
        if (key === 'value') setAttr(node, 'class', value);
        return true;
      },
      has: function (target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) return Number(key) < tokenSet(r).length;
        return key === 'length' || key === 'value' || key in target;
      },
    });
    return r.classList;
  }

  function dataName(key) {
    key = String(key);
    // dataset['a-b'] names no attribute: a browser refuses it.
    if (/-[a-z]/.test(key)) throw domError('SyntaxError', '\'' + key + '\' is not a valid property name.');
    return 'data-' + key.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
  }

  function datasetOf(node) {
    var r = rec(node);
    if (r.dataset) return r.dataset;
    r.dataset = new Proxy({}, {
      get: function (target, key) {
        if (typeof key !== 'string' || /-[a-z]/.test(key)) return undefined;
        var value = getAttr(r, dataName(key));
        return value === null ? undefined : value;
      },
      set: function (target, key, value) { setAttr(node, dataName(key), value); return true; },
      deleteProperty: function (target, key) { if (typeof key === 'string' && !/-[a-z]/.test(key)) removeAttr(node, dataName(key)); return true; },
      has: function (target, key) { return typeof key === 'string' && !/-[a-z]/.test(key) && getAttr(r, dataName(key)) !== null; },
      // Object.keys(el.dataset), for…in and {...el.dataset} see what is set.
      ownKeys: function () {
        return r.attrs.filter(function (a) { return a[0].indexOf('data-') === 0; }).map(function (a) {
          return a[0].slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
        });
      },
      getOwnPropertyDescriptor: function (target, key) {
        var value = typeof key === 'string' && !/-[a-z]/.test(key) ? getAttr(r, dataName(key)) : null;
        return value === null ? undefined : { value: value, writable: true, enumerable: true, configurable: true };
      },
    });
    return r.dataset;
  }

  // ---------------------------------------------------------------- selectors

  // Selectors as CSS reads them: escapes (.md\:flex), quoted strings, :is(),
  // :not() and :has() of any selector, :nth-child(2n+1 of .x), and the
  // pseudo-classes a page asks of a document. What CSS would not read is
  // refused with a SyntaxError, as a browser's querySelector refuses it.
  var SELECTORS = Object.create(null);
  var selectorCount = 0;
  var NTH = set('nth-child nth-last-child nth-of-type nth-last-of-type');
  var PSEUDO_CLASSES = set(
    'root scope empty first-child last-child only-child first-of-type last-of-type only-of-type checked disabled enabled ' +
    'required optional read-only read-write placeholder-shown default indeterminate valid invalid in-range out-of-range ' +
    'user-valid user-invalid focus focus-within focus-visible hover active visited link any-link local-link target ' +
    'target-within defined modal open popover-open autofill fullscreen picture-in-picture playing paused seeking ' +
    'buffering stalled muted volume-locked blank'
  );
  var PSEUDO_ELEMENTS = set(
    'before after first-line first-letter marker placeholder selection backdrop file-selector-button cue ' +
    'grammar-error spelling-error target-text highlight part slotted details-content'
  );
  // The old pseudo-elements CSS still reads with one colon.
  var OLD_PSEUDO_ELEMENTS = set('before after first-line first-letter');
  var ANCHOR = { anchor: true };

  function parseSelectors(text) {
    var s = String(text);
    var cached = SELECTORS[s];
    if (cached) return cached;
    var i = 0;
    function fail() { throw domError('SyntaxError', '\'' + s + '\' is not a valid selector.'); }
    function space() { var start = i; while (i < s.length && /[\t\n\f\r ]/.test(s.charAt(i))) i++; return i > start; }
    function nameStart(ch) { return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80; }
    function nameChar(ch) { return /[A-Za-z0-9_\-]/.test(ch) || ch.charCodeAt(0) >= 0x80; }
    // After the backslash: a code point in hex and the space after it, or
    // the next character as itself.
    function escape() {
      i++;
      if (i >= s.length) return '\ufffd';
      var hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i, i + 6));
      if (hex) {
        i += hex[0].length;
        if (s.charAt(i) === '\r' && s.charAt(i + 1) === '\n') i += 2;
        else if (/[\t\n\f\r ]/.test(s.charAt(i))) i++;
        var code = parseInt(hex[0], 16);
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
      }
      var cp = s.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      return String.fromCodePoint(cp);
    }
    function startsIdent() {
      var a = s.charAt(i);
      var b = s.charAt(i + 1);
      if (a === '-') return nameStart(b) || b === '-' || (b === '\\' && s.charAt(i + 2) !== '\n');
      if (a === '\\') return b !== '\n';
      return a !== '' && nameStart(a);
    }
    function ident() {
      if (!startsIdent()) fail();
      var out = '';
      while (i < s.length) {
        var ch = s.charAt(i);
        if (ch === '\\' && s.charAt(i + 1) !== '\n') out += escape();
        else if (nameChar(ch)) { out += ch; i++; }
        else break;
      }
      return out;
    }
    function string() {
      var quote = s.charAt(i++);
      var out = '';
      while (i < s.length) {
        var ch = s.charAt(i);
        if (ch === quote) { i++; return out; }
        if (ch === '\n') fail();
        if (ch === '\\') {
          if (i + 1 >= s.length) i++;
          else if (s.charAt(i + 1) === '\n') i += 2;
          else out += escape();
        } else { out += ch; i++; }
      }
      // A string the end of the selector closes.
      return out;
    }
    // A namespace prefix: *| (any) and | (none) are read; a named one has no
    // @namespace here to name, as in a browser's querySelector.
    function prefix() {
      if (s.charAt(i) === '|' && s.charAt(i + 1) !== '=') { i++; return 'none'; }
      if (s.charAt(i) === '*' && s.charAt(i + 1) === '|' && s.charAt(i + 2) !== '=') { i += 2; return 'any'; }
      return '';
    }
    // An attribute of the page's is in no namespace: [|x] and [*|x] are [x].
    function attribute() {
      space();
      prefix();
      var name = ident();
      if (s.charAt(i) === '|' && s.charAt(i + 1) !== '=') fail();
      space();
      var a = { name: name, lower: name.toLowerCase(), op: null, value: null, flag: '' };
      var op = /^[~|^$*]?=/.exec(s.slice(i, i + 2));
      if (op) {
        a.op = op[0];
        i += op[0].length;
        space();
        var q = s.charAt(i);
        a.value = q === '"' || q === "'" ? string() : ident();
        space();
        // [x=y i], in any case; Chrome reads no s.
        if (/[iI]/.test(s.charAt(i)) && !nameChar(s.charAt(i + 1) || ' ')) { a.flag = 'i'; i++; space(); }
      }
      close(']');
      return a;
    }
    function nth(p, of) {
      var rest = s.slice(i);
      var m = /^(odd|even)(?![\w-])/i.exec(rest);
      if (m) { p.a = 2; p.b = m[1].toLowerCase() === 'odd' ? 1 : 0; }
      else if ((m = /^([+-]?)(\d*)n(?:[\t\n\f\r ]*([+-])[\t\n\f\r ]*(\d+))?/i.exec(rest))) {
        p.a = m[2] === '' ? (m[1] === '-' ? -1 : 1) : Number(m[1] + m[2]);
        p.b = m[3] ? Number(m[3] + m[4]) : 0;
      } else if ((m = /^[+-]?\d+/.exec(rest))) { p.a = 0; p.b = Number(m[0]); }
      else fail();
      i += m[0].length;
      space();
      if (of && /^of[\t\n\f\r ]/i.test(s.slice(i, i + 3))) { i += 2; space(); p.list = list(')', false, false); }
    }
    function langs() {
      var out = [];
      for (;;) {
        var q = s.charAt(i);
        out.push((q === '"' || q === "'" ? string() : ident()).toLowerCase());
        space();
        if (s.charAt(i) !== ',') return out;
        i++;
        space();
      }
    }
    // A functional pseudo-element's argument (::part(x)), read past.
    function skipArgument() {
      var depth = 1;
      while (i < s.length && depth > 0) {
        var ch = s.charAt(i);
        if (ch === '\\') i += 2;
        else if (ch === '"' || ch === "'") string();
        else { if (ch === '(') depth++; else if (ch === ')') depth--; i++; }
      }
    }
    // A selector or a block the end of the text leaves open is closed, as
    // CSS closes it (p[a="b, p:not(.x).
    function close(ch) {
      if (s.charAt(i) === ch) i++;
      else if (i < s.length) fail();
    }
    function pseudo(c, nested) {
      if (s.charAt(i) === ':') {
        i++;
        var element = ident().toLowerCase();
        // No pseudo-element in :not(), :is() or :has().
        if (nested || (!PSEUDO_ELEMENTS[element] && element.indexOf('-webkit-') !== 0)) fail();
        if (s.charAt(i) === '(') { i++; skipArgument(); }
        c.element = true;
        c.pseudos.push({ name: '::' });
        return;
      }
      var name = ident().toLowerCase();
      if (OLD_PSEUDO_ELEMENTS[name]) {
        if (nested) fail();
        c.element = true;
        c.pseudos.push({ name: '::' });
        return;
      }
      var p = { name: name };
      if (s.charAt(i) === '(') {
        i++;
        space();
        if (NTH[name]) nth(p, name === 'nth-child' || name === 'nth-last-child');
        else if (name === 'not') p.list = list(')', false, false);
        else if (name === 'is' || name === 'where') p.list = list(')', false, true);
        else if (name === 'has') p.list = list(')', true, false);
        else if (name === 'lang') p.langs = langs();
        else if (name === 'dir') { p.dir = ident().toLowerCase(); space(); }
        else fail();
        close(')');
      } else if (!PSEUDO_CLASSES[name] && name.indexOf('-webkit-') !== 0) fail();
      c.pseudos.push(p);
    }
    function compound(nested) {
      var c = { tag: null, lower: null, none: false, id: null, classes: [], attrs: [], pseudos: [], element: false };
      var any = false;
      // |p is a p in no namespace, which no element of the page is.
      var ns = prefix();
      c.none = ns === 'none';
      if (s.charAt(i) === '*') { i++; any = true; }
      else if (startsIdent()) { c.tag = ident(); c.lower = c.tag.toLowerCase(); any = true; }
      else if (ns) fail();
      if (any && s.charAt(i) === '|' && s.charAt(i + 1) !== '=') {
        if (c.tag !== null || ns) fail();
        i++;
        if (s.charAt(i) === '*') i++;
        else { c.tag = ident(); c.lower = c.tag.toLowerCase(); }
      }
      while (i < s.length) {
        var ch = s.charAt(i);
        // After a pseudo-element, only pseudo-classes.
        if (c.element && ch !== ':') break;
        if (ch === '#') { i++; c.id = ident(); }
        else if (ch === '.') { i++; c.classes.push(ident()); }
        else if (ch === '[') { i++; c.attrs.push(attribute()); }
        else if (ch === ':') { i++; pseudo(c, nested); }
        else break;
        any = true;
      }
      if (!any) fail();
      return c;
    }
    // One selector: compounds and the combinators between them, as parts
    // [{ compound, combinator to the next }]. Relative (in :has()), it starts
    // from the element :has() is asked of.
    function complex(end, relative) {
      var parts = [];
      if (relative) {
        var lead = ' ';
        if (/[>+~]/.test(s.charAt(i))) { lead = s.charAt(i++); space(); }
        parts.push({ compound: ANCHOR, combinator: lead });
      }
      for (;;) {
        parts.push({ compound: compound(!!end), combinator: null });
        var spaced = space();
        var ch = s.charAt(i);
        if (i >= s.length || ch === ',' || (end && ch === end)) return parts;
        if (ch === '>' || ch === '+' || ch === '~') {
          i++;
          space();
          parts[parts.length - 1].combinator = ch;
        } else if (spaced) parts[parts.length - 1].combinator = ' ';
        else fail();
      }
    }
    // Past a selector :is() could not read, to the , or ) after it.
    function skipComplex(end) {
      var depth = 0;
      while (i < s.length) {
        var ch = s.charAt(i);
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"' || ch === "'") { string(); continue; }
        if (depth === 0 && (ch === ',' || ch === end)) return;
        if (ch === '(' || ch === '[') depth++;
        else if ((ch === ')' || ch === ']') && depth > 0) depth--;
        i++;
      }
    }
    // A list of selectors; forgiving (:is() and :where()), one it cannot
    // read is left out rather than refused.
    function list(end, relative, forgiving) {
      var groups = [];
      for (;;) {
        space();
        if (forgiving) {
          var start = i;
          try {
            groups.push(complex(end, relative));
          } catch (error) {
            if (!(error instanceof DOMException)) throw error;
            i = start;
            skipComplex(end);
          }
        } else groups.push(complex(end, relative));
        space();
        if (s.charAt(i) === ',') { i++; continue; }
        if (i >= s.length || (end && s.charAt(i) === end)) return groups;
        fail();
      }
    }
    var groups = list('', false, false);
    if (++selectorCount > 500) { SELECTORS = Object.create(null); selectorCount = 1; }
    SELECTORS[s] = groups;
    return groups;
  }

  // Attributes whose values HTML compares in any case: [type=checkbox]
  // finds type="CHECKBOX".
  var ANY_CASE_VALUES = set(
    'accept accept-charset align alink axis bgcolor charset checked clear codetype color compact declare defer dir ' +
    'direction disabled enctype face frame hreflang http-equiv lang language link media method multiple nohref ' +
    'noresize noshade nowrap readonly rel rev rules scope scrolling selected shape target text type valign valuetype vlink'
  );

  // The element :has() is asked of, which its selectors start from.
  var hasAnchor = null;

  // Its place, counted from 1, among its parent's elements (of its own type,
  // or that match an of S list), from the start or from the end; 0 when it
  // is not one of those counted.
  function nthIndex(node, r, p, last, ofType) {
    var siblings = r.parent ? rec(r.parent).kids : [node];
    var n = 0;
    for (var i = last ? siblings.length - 1 : 0; i >= 0 && i < siblings.length; i += last ? -1 : 1) {
      var o = rec(siblings[i]);
      if (o.type !== 1 || (ofType && (o.tag !== r.tag || o.ns !== r.ns))) continue;
      if (p && p.list && !matchesAny(siblings[i], p.list)) continue;
      n++;
      if (siblings[i] === node) return n;
    }
    return 0;
  }
  function nthMatches(p, index) {
    if (index === 0) return false;
    if (p.a === 0) return index === p.b;
    var k = (index - p.b) / p.a;
    return k >= 0 && Math.floor(k) === k;
  }

  // A selector's attribute names, like its tag names, are read in any case,
  // a drawing's too ([viewbox] finds viewBox), as Chrome reads them.
  function matchesAttr(r, a) {
    var value = null;
    for (var i = 0; i < r.attrs.length; i++) if (r.attrs[i][0].toLowerCase() === a.lower) { value = r.attrs[i][1]; break; }
    if (value === null) return false;
    if (!a.op) return true;
    var want = a.value;
    if (a.flag === 'i' || (!r.ns && ANY_CASE_VALUES[a.lower])) {
      value = value.toLowerCase();
      want = want.toLowerCase();
    }
    switch (a.op) {
      case '=': return value === want;
      case '~=': return want !== '' && !/[\t\n\f\r ]/.test(want) && value.split(/[\t\n\f\r ]+/).indexOf(want) >= 0;
      case '|=': return value === want || value.indexOf(want + '-') === 0;
      case '^=': return want !== '' && value.indexOf(want) === 0;
      case '$=': return want !== '' && value.length >= want.length && value.slice(value.length - want.length) === want;
      default: return want !== '' && value.indexOf(want) >= 0;
    }
  }

  function matchesCompound(node, c) {
    if (c.anchor) return node === hasAnchor;
    var r = rec(node);
    if (!r || r.type !== 1 || c.none) return false;
    if (c.tag !== null && c.lower !== (r.ns ? r.tag.toLowerCase() : r.tag)) return false;
    if (c.id !== null && getAttr(r, 'id') !== c.id) return false;
    if (c.classes.length > 0) {
      var list = classesOf(r);
      for (var i = 0; i < c.classes.length; i++) if (list.indexOf(c.classes[i]) < 0) return false;
    }
    for (var j = 0; j < c.attrs.length; j++) if (!matchesAttr(r, c.attrs[j])) return false;
    for (var k = 0; k < c.pseudos.length; k++) if (!matchesPseudo(node, r, c.pseudos[k])) return false;
    return true;
  }

  function matchesPseudo(node, r, p) {
    var html = !r.ns;
    switch (p.name) {
      case 'not': return !matchesAny(node, p.list);
      case 'is': case 'where': return matchesAny(node, p.list);
      case 'has': return hasMatch(node, p.list);
      case 'first-child': return nthIndex(node, r, null, false, false) === 1;
      case 'last-child': return nthIndex(node, r, null, true, false) === 1;
      case 'only-child': return nthIndex(node, r, null, false, false) === 1 && nthIndex(node, r, null, true, false) === 1;
      case 'first-of-type': return nthIndex(node, r, null, false, true) === 1;
      case 'last-of-type': return nthIndex(node, r, null, true, true) === 1;
      case 'only-of-type': return nthIndex(node, r, null, false, true) === 1 && nthIndex(node, r, null, true, true) === 1;
      case 'nth-child': return nthMatches(p, nthIndex(node, r, p, false, false));
      case 'nth-last-child': return nthMatches(p, nthIndex(node, r, p, true, false));
      case 'nth-of-type': return nthMatches(p, nthIndex(node, r, p, false, true));
      case 'nth-last-of-type': return nthMatches(p, nthIndex(node, r, p, true, true));
      case 'checked':
        if (!html) return false;
        if (r.tag === 'input') { var kind = inputType(r); return (kind === 'checkbox' || kind === 'radio') && checkedOf(r); }
        return r.tag === 'option' && node.selected;
      case 'disabled': return html && !!CAN_DISABLE[r.tag] && isDisabled(r);
      case 'enabled': return html && !!CAN_DISABLE[r.tag] && !isDisabled(r);
      case 'required': return html && isRequired(r);
      case 'optional': return html && (!!FIELDS[r.tag] || r.tag === 'button') && !isRequired(r);
      case 'read-write': return isWritable(r);
      case 'read-only': return !isWritable(r);
      case 'placeholder-shown':
        return html && (r.tag === 'input' || r.tag === 'textarea') && getAttr(r, 'placeholder') !== null && fieldValue(r) === '';
      case 'default': return html && isDefault(node, r);
      case 'indeterminate': return html && isIndeterminate(node, r);
      case 'valid': case 'invalid': {
        var valid = validState(node, r);
        return valid !== null && valid === (p.name === 'valid');
      }
      case 'in-range': case 'out-of-range': {
        var inRange = rangeState(node, r);
        return inRange !== null && inRange === (p.name === 'in-range');
      }
      case 'empty':
        if (r.island) return false;
        for (var e = 0; e < r.kids.length; e++) {
          var kid = rec(r.kids[e]);
          if (kid.type === 1 || (kid.type === 3 && kid.text !== '')) return false;
        }
        return true;
      case 'root': return !!r.parent && rec(r.parent).type === 9;
      case 'scope': return node === scopeNode;
      case 'focus': return activeId !== 0 && activeId === r.id;
      case 'focus-within': { var active = activeId ? BY_ID[activeId] : null; return !!active && contains(node, active); }
      case 'link': case 'any-link': return (r.tag === 'a' || r.tag === 'area') && getAttr(r, 'href') !== null;
      case 'target': {
        var hash = here && here.hash ? unescapeHash(here.hash.slice(1)) : '';
        return hash !== '' && getAttr(r, 'id') === hash;
      }
      case 'lang': return langMatches(r, p.langs);
      case 'dir': return dirOf(r) === p.dir;
      case 'defined': return !html || r.tag.indexOf('-') < 0;
      case 'modal': return r.tag === 'dialog' && getAttr(r, 'data-softn-modal') !== null && getAttr(r, 'open') !== null;
      case 'open': return (r.tag === 'details' || r.tag === 'dialog') && getAttr(r, 'open') !== null;
      // A pseudo-element, and what needs a pointer, a screen or a history
      // this document does not have: hover, visited, autofill and the rest.
      default: return false;
    }
  }

  function unescapeHash(text) { try { return decodeURIComponent(text); } catch (e) { return text; } }

  // required, where it applies: not to a button, nor to an input that holds
  // no value of the person's (hidden, range, color, a button).
  var NOT_REQUIRED = set('hidden range color submit image reset button');
  function isRequired(r) {
    if (!FIELDS[r.tag] || getAttr(r, 'required') === null) return false;
    return r.tag !== 'input' || !NOT_REQUIRED[inputType(r)];
  }

  function langMatches(r, langs) {
    for (var n = r; n && n.type === 1; n = n.parent ? rec(n.parent) : null) {
      var lang = getAttr(n, 'lang');
      if (lang === null) continue;
      lang = lang.toLowerCase();
      for (var i = 0; i < langs.length; i++) if (lang === langs[i] || lang.indexOf(langs[i] + '-') === 0) return true;
      return false;
    }
    return false;
  }

  function dirOf(r) {
    for (var n = r; n && n.type === 1; n = n.parent ? rec(n.parent) : null) {
      var dir = (getAttr(n, 'dir') || '').toLowerCase();
      if (dir === 'ltr' || dir === 'rtl') return dir;
    }
    return 'ltr';
  }

  // Whether an element that has :has() has an element its selector finds:
  // below it (> and the space), or after it among its siblings (+ and ~).
  function hasMatch(node, groups) {
    var outer = hasAnchor;
    hasAnchor = node;
    try {
      for (var g = 0; g < groups.length; g++) {
        var parts = groups[g];
        var found = false;
        var test = function (candidate) {
          if (matchesComplex(candidate, parts, parts.length - 1)) { found = true; return false; }
          return true;
        };
        var lead = parts[0].combinator;
        if (lead === ' ' || lead === '>') walk(rec(node), test);
        else {
          var r = rec(node);
          var kids = r.parent ? rec(r.parent).kids : [];
          for (var k = kids.indexOf(node) + 1; k < kids.length && !found; k++) {
            var kr = rec(kids[k]);
            if (kr.type === 1 && test(kids[k]) && !kr.island) walk(kr, test);
          }
        }
        if (found) return true;
      }
      return false;
    } finally {
      hasAnchor = outer;
    }
  }

  function matchesComplex(node, parts, at) {
    if (!matchesCompound(node, parts[at].compound)) return false;
    if (at === 0) return true;
    var combinator = parts[at - 1].combinator;
    var r = rec(node);
    if (combinator === '>') return !!r.parent && matchesComplex(r.parent, parts, at - 1);
    if (combinator === ' ') {
      for (var up = r.parent; up; up = rec(up).parent) if (matchesComplex(up, parts, at - 1)) return true;
      return false;
    }
    if (!r.parent) return false;
    var kids = rec(r.parent).kids;
    for (var b = kids.indexOf(node) - 1; b >= 0; b--) {
      if (rec(kids[b]).type !== 1) continue;
      if (matchesComplex(kids[b], parts, at - 1)) return true;
      if (combinator === '+') return false;
    }
    return false;
  }

  function matchesAny(node, groups) {
    for (var i = 0; i < groups.length; i++) if (matchesComplex(node, groups[i], groups[i].length - 1)) return true;
    return false;
  }

  // The node a search was asked of, for :scope.
  var scopeNode = null;

  function withScope(node, run) {
    var outer = scopeNode;
    scopeNode = node;
    try { return run(); } finally { scopeNode = outer; }
  }

  // A list the document hands back, which answers to item() as a NodeList does.
  function nodeList(list) {
    Object.defineProperty(list, 'item', { value: function (i) { return this[i] || null; }, enumerable: false, configurable: true });
    return list;
  }

  // A list a browser keeps live (children, childNodes, getElementsBy…):
  // read again whenever what it depends on (stamp) has changed since it was
  // last read, so a loop that takes items off it as it goes comes to an end.
  // An HTMLCollection (named) answers to its elements' ids and names too
  // (namedItem, list.someId); lookup, given, finds what a name stands for.
  function liveList(compute, stamp, named, lookup) {
    var list = nodeList([]);
    var at = null;
    function fresh() {
      var now = stamp();
      if (now === at) return;
      var items = compute();
      list.length = 0;
      for (var i = 0; i < items.length; i++) list[i] = items[i];
      at = now;
    }
    if (named) {
      lookup = function (name) {
        for (var i = 0; i < list.length; i++) {
          var r = rec(list[i]);
          if (name !== '' && (getAttr(r, 'id') === name || (!r.ns && getAttr(r, 'name') === name))) return list[i];
        }
        return undefined;
      };
      Object.defineProperty(list, 'namedItem', {
        enumerable: false,
        configurable: true,
        value: function (name) { fresh(); var found = lookup(String(name)); return found === undefined ? null : found; },
      });
    } else if (lookup) {
      Object.defineProperty(list, 'getNamedItem', {
        enumerable: false,
        configurable: true,
        value: function (name) { var found = lookup(String(name)); return found === undefined ? null : found; },
      });
    }
    return new Proxy(list, {
      get: function (target, key, receiver) {
        fresh();
        if (lookup && typeof key === 'string' && !(key in target)) {
          var found = lookup(key);
          if (found !== undefined) return found;
        }
        return Reflect.get(target, key, receiver);
      },
      has: function (target, key) { fresh(); return Reflect.has(target, key); },
      ownKeys: function (target) { fresh(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: function (target, key) { fresh(); return Reflect.getOwnPropertyDescriptor(target, key); },
      set: function () { return true; },
      deleteProperty: function () { return true; },
    });
  }
  function cachedList(node, key, make) {
    var r = rec(node);
    var lists = r.lists || (r.lists = Object.create(null));
    return lists[key] || (lists[key] = make(r));
  }
  function structureStamp() { return treeVersion; }
  function structureAndAttrStamp() { return treeVersion + ':' + attrVersion; }

  function elementsIn(root, keep) {
    var found = [];
    walk(rec(root), function (node, r) {
      if (keep(r)) found.push(node);
      return true;
    });
    return found;
  }

  // :scope is the element searched in; searching the document, its root
  // element; searching a fragment, nothing.
  function query(root, selector, all) {
    var groups = parseSelectors(selector);
    var found = [];
    withScope(rec(root).type === 9 ? rec(root).kids[0] || null : root, function () {
      walk(rec(root), function (node) {
        if (matchesAny(node, groups)) {
          found.push(node);
          if (!all) return false;
        }
        return true;
      });
    });
    return all ? nodeList(found) : found[0] || null;
  }

  // ---------------------------------------------------------------- HTML

  // Character references, read as HTML reads them and as SoftN's own parser
  // reads them (decodeHtmlEntities, parser/ast.ts), from its table: HTML 4's
  // names, and the old ones HTML still reads without a ; (marked !).
  var ENTITIES = Object.create(null);
  var OLD_ENTITIES = Object.create(null);
  (function () {
    var table = '@ENTITIES@'.split(' ');
    for (var i = 0; i < table.length; i += 2) {
      var old = table[i + 1].charAt(0) === '!';
      ENTITIES[table[i]] = String.fromCodePoint(parseInt(old ? table[i + 1].slice(1) : table[i + 1], 36));
      if (old) OLD_ENTITIES[table[i]] = 1;
    }
  })();
  // What &#128; to &#159; name: windows-1252's characters there, as HTML has them.
  var C1 = [
    0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
  ];
  function referenced(code) {
    if (code >= 0x80 && code <= 0x9f) code = C1[code - 0x80];
    if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(code);
  }

  // A numeric reference may leave out its ;, and so may an old name, read
  // where it begins a word (&notit; is ¬it;), but not in an attribute's value
  // when a letter, digit or = follows: a link's ?a=1&copy=2 stays as written.
  function decode(text, inAttribute) {
    if (text.indexOf('&') < 0) return text;
    return text.replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, function (match, decimal, hex, named, semicolon, offset) {
      if (decimal) return referenced(parseInt(decimal, 10));
      if (hex) return referenced(parseInt(hex, 16));
      if (semicolon && ENTITIES[named] !== undefined) return ENTITIES[named];
      for (var length = Math.min(named.length, 6); length >= 2; length--) {
        var name = named.slice(0, length);
        if (!OLD_ENTITIES[name]) continue;
        var rest = named.slice(length);
        if (inAttribute && (rest !== '' || (!semicolon && text.charAt(offset + match.length) === '='))) return match;
        return ENTITIES[name] + rest + semicolon;
      }
      return match;
    });
  }

  function escapeText(text) { return String(text).replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // As a browser writes HTML out: the text of a <style> or <script> as it
  // is, a <template>'s content inside it, a drawing's names in their case.
  function serialize(r) {
    if (r.type === 3) {
      var p = r.parent ? rec(r.parent) : null;
      return p && p.type === 1 && !p.ns && RAW_TEXT[p.tag] ? r.text : escapeText(r.text);
    }
    if (r.type === 8) return r.island ? '' : '<!--' + r.text + '-->';
    var from = r.type === 1 && r.tag === 'template' && !r.ns && r.content ? rec(r.content) : r;
    var inner = '';
    if (!r.island || from !== r) for (var i = 0; i < from.kids.length; i++) inner += serialize(rec(from.kids[i]));
    if (r.type !== 1) return inner;
    var open = '<' + r.tag;
    for (var a = 0; a < r.attrs.length; a++) open += ' ' + r.attrs[a][0] + '="' + escapeAttr(r.attrs[a][1]) + '"';
    open += '>';
    if (!r.ns && VOID[r.tag]) return open;
    return open + inner + '</' + r.tag + '>';
  }

  // HTML as a browser reads a fragment of it for innerHTML: tags, attributes
  // (the first of two of one name), text and its character references,
  // comments, the elements with no end, the text of a <script>, <style>,
  // <textarea> and their like up to their own end tag, the newline a <pre> or
  // <textarea> starts with, a <p> the next block ends, an <li>, <dt>, <option>,
  // cell or row that ends where the next begins, the <tbody> and <tr> a
  // browser adds in a table, a <template>'s content, and the drawings and
  // formulas in <svg> and <math>, whose names keep their case and whose />
  // ends them. Misnested formatting (<b><i></b>) is not mended as a browser
  // mends it.
  var RAW_TEXT_TAGS = set('script style xmp iframe noembed noframes noscript');
  var RCDATA_TAGS = set('textarea title');
  var CLOSES_P = set(
    'address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre listing search section summary table ul xmp plaintext li dd dt'
  );
  var SPECIAL = set(
    'address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup ' +
    'dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header ' +
    'hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ' +
    'ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot ' +
    'th thead title tr track ul wbr xmp'
  );
  var SCOPE = set('applet caption html table td th marquee object template');
  var LIST_SCOPE = set('ol ul');
  var BUTTON_SCOPE = set('button');
  var TABLE_SCOPE = set('html table template');
  // Where HTML is read again inside a drawing or a formula.
  var FOREIGN_POINTS = set('foreignObject desc title mi mo mn ms mtext annotation-xml');
  var HEADINGS = set('h1 h2 h3 h4 h5 h6');
  var LIST_ITEMS = set('li');
  var DEFINITIONS = set('dd dt');
  // An HTML tag in a drawing ends the drawing, and is read as HTML.
  var BREAKOUT = set(
    'b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta ' +
    'nobr ol p pre ruby s small span strong strike sub sup table tt u ul var'
  );
  var TABLE_RANK = dict({ table: 0, caption: 1, colgroup: 1, tbody: 1, thead: 1, tfoot: 1, tr: 2, td: 3, th: 3 });
  var TABLE_PARENT = dict({ td: 'tr', th: 'tr', tr: 'tbody', tbody: 'table', thead: 'table', tfoot: 'table', caption: 'table', colgroup: 'table', col: 'colgroup' });
  var ROW_GROUPS = set('tbody thead tfoot');
  // SVG's names, which HTML reads in lower case, as SVG spells them.
  var SVG_TAGS = Object.create(null);
  var SVG_ATTRS = Object.create(null);
  (
    'altGlyph altGlyphDef altGlyphItem animateColor animateMotion animateTransform clipPath feBlend feColorMatrix ' +
    'feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow ' +
    'feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset ' +
    'fePointLight feSpecularLighting feSpotLight feTile feTurbulence foreignObject glyphRef linearGradient radialGradient textPath'
  ).split(' ').forEach(function (name) { SVG_TAGS[name.toLowerCase()] = name; });
  (
    'attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits diffuseConstant edgeMode filterUnits ' +
    'glyphRef gradientTransform gradientUnits kernelMatrix kernelUnitLength keyPoints keySplines keyTimes lengthAdjust ' +
    'limitingConeAngle markerHeight markerUnits markerWidth maskContentUnits maskUnits numOctaves pathLength ' +
    'patternContentUnits patternTransform patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio ' +
    'primitiveUnits refX refY repeatCount repeatDur requiredExtensions requiredFeatures specularConstant specularExponent ' +
    'spreadMethod startOffset stdDeviation stitchTiles surfaceScale systemLanguage tableValues targetX targetY textLength ' +
    'viewBox viewTarget xChannelSelector yChannelSelector zoomAndPan'
  ).split(' ').forEach(function (name) { SVG_ATTRS[name.toLowerCase()] = name; });
  var SPACE_CHARS = '\t\n\f\r ';

  // An attribute an element is made with: a handler is the page's to run.
  function initAttr(el, name, value) {
    var r = rec(el);
    r.attrs.push([name, value]);
    if (isHandlerName(name)) setInline(r, name.slice(2), inlineHandler(value), value);
  }

  // The nodes the HTML makes, read where context (the element given it) is:
  // a <tr>'s cells, a drawing's shapes, a <style>'s text.
  function parseHTML(html, context) {
    var cr = context ? rec(context) : null;
    var contextTag = cr && cr.type === 1 ? cr.tag : '';
    var contextNs = cr && cr.type === 1 ? cr.ns : '';
    var root = makeFragment();
    var stack = [root];
    var s = String(html).replace(/\r\n?/g, '\n');
    var lower = null;
    var i = 0;
    function top() { return stack[stack.length - 1]; }
    function entryTag(n) { return n === root ? contextTag : rec(n).type === 11 ? 'template' : rec(n).tag; }
    function entryNs(n) { return n === root ? contextNs : rec(n).ns; }
    function topHtmlTag() { return stack.length > 1 && !entryNs(top()) ? entryTag(top()) : ''; }
    function append(node) {
      var parent = top();
      rec(node).parent = parent;
      rec(parent).kids.push(node);
    }
    function text(t) {
      if (t === '') return;
      var kids = rec(top()).kids;
      var last = kids.length ? rec(kids[kids.length - 1]) : null;
      if (last && last.type === 3) last.text += t;
      else append(makeText(t));
    }
    function nameEnd(j) {
      while (j < s.length && '\t\n\f\r />'.indexOf(s.charAt(j)) < 0) j++;
      return j;
    }
    // The open element of this name nearest the top, unless a boundary of
    // its scope (a table, a cell, a button…) comes first; -1 if none.
    function inScope(name, extra) {
      for (var d = stack.length - 1; d > 0; d--) {
        var tag = entryTag(stack[d]);
        var ns = entryNs(stack[d]);
        if (!ns && tag === name) return d;
        if (rec(stack[d]).type === 11) return -1;
        if (ns ? FOREIGN_POINTS[tag] : extra === TABLE_SCOPE ? TABLE_SCOPE[tag] : SCOPE[tag] || (extra && extra[tag])) return -1;
      }
      return -1;
    }
    function closeP() {
      var d = inScope('p', BUTTON_SCOPE);
      if (d > 0) stack.length = d;
    }
    function formOpen() {
      for (var d = stack.length - 1; d >= 0; d--) {
        if (entryTag(stack[d]) === 'template') return false;
        if (entryTag(stack[d]) === 'form' && !entryNs(stack[d])) return true;
      }
      return false;
    }
    // An <li> (or a <dt>, <dd>) ends the one open before it, unless another
    // block began since.
    function closeItem(names) {
      for (var d = stack.length - 1; d > 0; d--) {
        var tag = entryTag(stack[d]);
        if (entryNs(stack[d]) || rec(stack[d]).type === 11) return;
        if (names[tag]) { stack.length = d; return; }
        if (SPECIAL[tag] && tag !== 'address' && tag !== 'div' && tag !== 'p') return;
      }
    }
    // The table part nearest the top, -1 if there is none (or a template's
    // content or a drawing comes first).
    function tableAt() {
      for (var d = stack.length - 1; d >= 0; d--) {
        var tag = entryTag(stack[d]);
        if (entryNs(stack[d])) return -1;
        if (TABLE_RANK[tag] !== undefined) return d;
        if (tag === 'template' || d === 0) return -1;
      }
      return -1;
    }
    // A cell goes in a row, a row in a row group, a row group in a table:
    // what is open that it ends is closed, and what a browser adds between
    // (a <tbody>, a <tr>) is added. Outside a table it is kept as written.
    function placeInTable(name) {
      var want = TABLE_PARENT[name];
      for (;;) {
        var d = tableAt();
        if (d < 0) return;
        var tag = entryTag(stack[d]);
        if (tag === want || (want === 'tbody' && ROW_GROUPS[tag])) { stack.length = d + 1; return; }
        var add = tag === 'table' ? (want === 'tr' ? 'tbody' : want === 'tbody' || want === 'colgroup' ? want : null)
          : ROW_GROUPS[tag] && want === 'tr' ? 'tr' : null;
        if (add) {
          stack.length = d + 1;
          var wrapper = makeElement(add);
          append(wrapper);
          stack.push(wrapper);
          continue;
        }
        if (d === 0) return;
        stack.length = d;
      }
    }
    function rawEnd(name, from) {
      if (lower === null) lower = s.toLowerCase();
      for (var at = lower.indexOf('</' + name, from); at >= 0; at = lower.indexOf('</' + name, at + 1)) {
        var after = s.charAt(at + 2 + name.length);
        if (after === '' || '\t\n\f\r />'.indexOf(after) >= 0) return at;
      }
      return s.length;
    }
    function startTag(name, attrs, selfClosing) {
      var parentNs = entryNs(top());
      var parentTag = entryTag(top());
      var foreign = !!parentNs && !FOREIGN_POINTS[parentTag];
      if (foreign && (BREAKOUT[name] || (name === 'font' && attrs.some(function (a) { return /^(?:color|face|size)$/.test(a[0]); })))) {
        while (stack.length > 1 && entryNs(top()) && !FOREIGN_POINTS[entryTag(top())]) stack.pop();
        foreign = false;
      }
      var ns = foreign ? parentNs : name === 'svg' ? 'svg' : name === 'math' ? 'math' : '';
      if (ns) {
        var el = makeElement(ns === 'svg' ? SVG_TAGS[name] || name : name, undefined, false, ns);
        for (var a = 0; a < attrs.length; a++) {
          var an = attrs[a][0];
          initAttr(el, ns === 'svg' ? SVG_ATTRS[an] || an : an === 'definitionurl' ? 'definitionURL' : an, attrs[a][1]);
        }
        append(el);
        if (!selfClosing) stack.push(el);
        return;
      }
      if (name === 'html' || name === 'head' || name === 'body' || name === 'frameset') return;
      if (name === 'image') name = 'img';
      if (CLOSES_P[name]) closeP();
      if (HEADINGS[name] && HEADINGS[topHtmlTag()]) stack.pop();
      if (name === 'li') closeItem(LIST_ITEMS);
      else if (name === 'dd' || name === 'dt') closeItem(DEFINITIONS);
      else if (name === 'option' || name === 'optgroup') {
        if (topHtmlTag() === 'option') stack.pop();
        if (name === 'optgroup' && topHtmlTag() === 'optgroup') stack.pop();
      } else if (TABLE_PARENT[name]) placeInTable(name);
      // A form in a form is left out.
      if (name === 'form' && formOpen()) return;
      var node = makeElement(name);
      for (var k = 0; k < attrs.length; k++) initAttr(node, attrs[k][0], attrs[k][1]);
      append(node);
      if (RAW_TEXT_TAGS[name] || RCDATA_TAGS[name] || name === 'plaintext') {
        var end = name === 'plaintext' ? s.length : rawEnd(name, i);
        var raw = s.slice(i, end);
        if (name === 'textarea' && raw.charAt(0) === '\n') raw = raw.slice(1);
        if (raw !== '') {
          var t = makeText(RCDATA_TAGS[name] ? decode(raw, false) : raw);
          rec(t).parent = node;
          rec(node).kids.push(t);
        }
        var gt = end < s.length ? s.indexOf('>', end) : -1;
        i = gt < 0 ? s.length : gt + 1;
        return;
      }
      if (VOID[name]) return;
      if (name === 'template') {
        var content = node.content;
        rec(content).templateOf = node;
        stack.push(content);
        return;
      }
      stack.push(node);
      if ((name === 'pre' || name === 'listing') && s.charAt(i) === '\n') i++;
    }
    function endTag(name) {
      if (name === 'br' && !entryNs(top())) { startTag('br', [], false); return; }
      if (name === 'p' && !entryNs(top()) && inScope('p', BUTTON_SCOPE) < 0) startTag('p', [], false);
      if (SPECIAL[name]) {
        var scope = name === 'li' ? LIST_SCOPE : name === 'p' ? BUTTON_SCOPE : TABLE_RANK[name] !== undefined ? TABLE_SCOPE : null;
        var at = inScope(name, scope);
        if (at > 0) stack.length = at;
        return;
      }
      for (var d = stack.length - 1; d > 0; d--) {
        var r = rec(stack[d]);
        if (r.type !== 1) return;
        if (r.tag.toLowerCase() === name) { stack.length = d; return; }
        if (!r.ns && SPECIAL[r.tag]) return;
      }
    }
    // What a <style> or <textarea> is given is its text.
    if (!contextNs && (RAW_TEXT_TAGS[contextTag] || RCDATA_TAGS[contextTag] || contextTag === 'plaintext')) {
      text(RCDATA_TAGS[contextTag] ? decode(s, false) : s);
      s = '';
    }
    while (i < s.length) {
      var lt = s.indexOf('<', i);
      if (lt < 0) lt = s.length;
      // A NUL in text is dropped, as HTML drops it.
      if (lt > i) { text(decode(s.slice(i, lt), false).replace(/\x00/g, '')); i = lt; continue; }
      var next = s.charAt(i + 1);
      if (s.slice(i, i + 4) === '<!--') {
        var from = i + 4;
        if (s.charAt(from) === '>' || s.slice(from, from + 2) === '->') {
          append(makeComment(''));
          i = s.indexOf('>', from) + 1;
          continue;
        }
        // Ended by --> or --!>.
        var close = s.indexOf('--', from);
        while (close >= 0 && s.charAt(close + 2) !== '>' && s.slice(close + 2, close + 4) !== '!>') close = s.indexOf('--', close + 1);
        append(makeComment(s.slice(from, close < 0 ? s.length : close)));
        i = close < 0 ? s.length : s.indexOf('>', close) + 1;
        continue;
      }
      // In a drawing, <![CDATA[…]]> is text.
      if (s.slice(i, i + 9) === '<![CDATA[' && entryNs(top())) {
        var cdataEnd = s.indexOf(']]>', i + 9);
        text(s.slice(i + 9, cdataEnd < 0 ? s.length : cdataEnd));
        i = cdataEnd < 0 ? s.length : cdataEnd + 3;
        continue;
      }
      if (next === '/' && i + 2 >= s.length) { text('</'); i = s.length; continue; }
      if (next === '!' || next === '?' || (next === '/' && !/[A-Za-z>]/.test(s.charAt(i + 2)))) {
        // <!DOCTYPE …> is left out of a fragment; <!…>, <?…> and </…> that
        // is not a tag are comments, as a browser reads them.
        var bogus = s.indexOf('>', i);
        var inner = s.slice(i + (next === '?' ? 1 : 2), bogus < 0 ? s.length : bogus);
        if (next !== '!' || !/^doctype/i.test(inner)) append(makeComment(inner));
        i = bogus < 0 ? s.length : bogus + 1;
        continue;
      }
      if (next === '/') {
        if (s.charAt(i + 2) === '>') { i += 3; continue; }
        var endAt = nameEnd(i + 2);
        var endName = s.slice(i + 2, endAt).toLowerCase();
        var gtAt = s.indexOf('>', endAt);
        i = gtAt < 0 ? s.length : gtAt + 1;
        if (gtAt >= 0) endTag(endName);
        continue;
      }
      if (!/[A-Za-z]/.test(next)) { text('<'); i++; continue; }
      var j = nameEnd(i + 1);
      var tagName = s.slice(i + 1, j).toLowerCase();
      var attrs = [];
      var seen = Object.create(null);
      var selfClosing = false;
      var ended = false;
      while (j < s.length) {
        while (j < s.length && SPACE_CHARS.indexOf(s.charAt(j)) >= 0) j++;
        var ch = s.charAt(j);
        if (ch === '>') { j++; ended = true; break; }
        if (ch === '/') {
          j++;
          if (s.charAt(j) === '>') { j++; selfClosing = true; ended = true; break; }
          continue;
        }
        if (ch === '') break;
        var nameAt = j++;
        while (j < s.length && '\t\n\f\r />='.indexOf(s.charAt(j)) < 0) j++;
        var attrName = s.slice(nameAt, j).toLowerCase();
        while (j < s.length && SPACE_CHARS.indexOf(s.charAt(j)) >= 0) j++;
        var value = '';
        if (s.charAt(j) === '=') {
          j++;
          while (j < s.length && SPACE_CHARS.indexOf(s.charAt(j)) >= 0) j++;
          var quote = s.charAt(j);
          if (quote === '"' || quote === "'") {
            var quoteEnd = s.indexOf(quote, j + 1);
            if (quoteEnd < 0) quoteEnd = s.length;
            value = decode(s.slice(j + 1, quoteEnd), true);
            j = quoteEnd + 1;
          } else {
            var valueEnd = j;
            while (valueEnd < s.length && '\t\n\f\r >'.indexOf(s.charAt(valueEnd)) < 0) valueEnd++;
            value = decode(s.slice(j, valueEnd), true);
            j = valueEnd;
          }
        }
        if (!seen[attrName]) {
          seen[attrName] = 1;
          attrs.push([attrName, value.replace(/\x00/g, '\ufffd')]);
        }
      }
      // A tag the input ends inside is dropped, as a browser drops it.
      i = ended ? j : s.length;
      if (ended) startTag(tagName, attrs, selfClosing);
    }
    var nodes = rec(root).kids.slice();
    for (var n = 0; n < nodes.length; n++) rec(nodes[n]).parent = null;
    rec(root).kids = [];
    return nodes;
  }

  function setInnerHTML(node, html) {
    var r = rec(node);
    replaceAllChildren(r.tag === 'template' && !r.ns ? node.content : node, parseHTML(html, node));
  }

  // ---------------------------------------------------------------- events

  function Event(type, init) {
    if (arguments.length === 0) throw new TypeError('Failed to construct \'Event\': 1 argument required, but only 0 present.');
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
    Object.defineProperty(this, '_passive', { value: false, writable: true, enumerable: false });
  }
  // A passive listener's preventDefault() does nothing, as a browser has it.
  Event.prototype.preventDefault = function () { if (this.cancelable && !this._passive) this.defaultPrevented = true; };
  Event.prototype.stopPropagation = function () { if (this._stop < 1) this._stop = 1; };
  Event.prototype.stopImmediatePropagation = function () { this._stop = 2; };
  Event.prototype.composedPath = function () {
    var path = [];
    for (var n = this.target; n; n = rec(n).parent) path.push(n);
    return path;
  };
  // The older names for the same things, which pages still use.
  Object.defineProperty(Event.prototype, 'cancelBubble', {
    configurable: true,
    get: function () { return this._stop !== 0; },
    set: function (value) { if (value) this.stopPropagation(); },
  });
  Object.defineProperty(Event.prototype, 'returnValue', {
    configurable: true,
    get: function () { return !this.defaultPrevented; },
    set: function (value) { if (!value) this.preventDefault(); },
  });
  Object.defineProperty(Event.prototype, 'srcElement', { configurable: true, get: function () { return this.target; } });
  Event.NONE = 0;
  Event.CAPTURING_PHASE = 1;
  Event.AT_TARGET = 2;
  Event.BUBBLING_PHASE = 3;
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

  function captureOf(options) { return options === true || !!(options && typeof options === 'object' && options.capture); }

  function addListener(node, type, fn, options) {
    if (fn === null || fn === undefined) return;
    var r = rec(node);
    var capture = captureOf(options);
    var signal = options && typeof options === 'object' ? options.signal : undefined;
    if (signal && signal.aborted) return;
    var list = r.listeners[type] || (r.listeners[type] = []);
    for (var i = 0; i < list.length; i++) if (!list[i].inline && list[i].fn === fn && list[i].capture === capture) return;
    var entry = { fn: fn, capture: capture, once: !!(options && options.once), passive: !!(options && options.passive) };
    list.push(entry);
    // Taken off when the signal it was given is aborted.
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', function () { drop(r, type, entry); });
    if (r.type !== 0) listen(type);
  }

  function drop(r, type, entry) {
    var list = r.listeners[type];
    var at = list ? list.indexOf(entry) : -1;
    if (at >= 0) list.splice(at, 1);
  }

  function removeListener(node, type, fn, options) {
    if (fn === null || fn === undefined) return;
    var r = rec(node);
    var capture = captureOf(options);
    var list = r.listeners[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].inline && list[i].fn === fn && list[i].capture === capture) { list.splice(i, 1); return; }
    }
  }

  // on<type>, set as a property or written as an attribute: one handler of
  // each kind, run in the place among the element's listeners where it was
  // first set, as a browser runs it; set to null, it gives up its place.
  function setInline(r, type, fn) {
    var list = r.listeners[type] || (r.listeners[type] = []);
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].inline) { at = i; break; }
    if (typeof fn === 'function') {
      r.inline[type] = fn;
      if (at < 0) list.push({ inline: true, capture: false });
      if (r.type !== 0) listen(type);
    } else {
      delete r.inline[type];
      if (at >= 0) list.splice(at, 1);
    }
  }

  function invoke(node, event, capture) {
    var r = rec(node);
    event.currentTarget = node;
    var all = r.listeners[event.type];
    if (!all || all.length === 0) return;
    var list = all.slice();
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (l.capture !== capture) continue;
      // Taken off by a listener before it, during this event: not run.
      if (all.indexOf(l) < 0) continue;
      if (l.once) drop(r, event.type, l);
      event._passive = !!l.passive;
      try {
        if (l.inline) {
          var handler = r.inline[event.type];
          // A handler that answers false cancels the event.
          if (typeof handler === 'function' && handler.call(node, event) === false) {
            event._passive = false;
            event.preventDefault();
          }
        } else if (typeof l.fn === 'function') l.fn.call(node, event);
        else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(event);
      } catch (error) {
        console.error('[SoftN] A ' + event.type + ' listener failed: ' + (error && error.message ? error.message : error));
      }
      event._passive = false;
      if (event._stop === 2) return;
    }
  }

  function dispatch(target, event) {
    if (!(event instanceof Event)) throw new TypeError('Failed to execute \'dispatchEvent\': parameter 1 is not of type \'Event\'.');
    var path = [];
    for (var n = target; n; n = rec(n).parent) path.push(n);
    event.target = target;
    event._stop = 0;
    for (var i = path.length - 1; i > 0 && event._stop === 0; i--) { event.eventPhase = 1; invoke(path[i], event, true); }
    // At the target, its capture listeners run first, then the rest, as
    // browsers run them now; a stop in the first keeps the rest from running.
    if (event._stop === 0) { event.eventPhase = 2; invoke(target, event, true); }
    event._captureStop = event._stop !== 0;
    if (event._stop === 0) { event.eventPhase = 2; invoke(target, event, false); }
    if (event.bubbles) for (var j = 1; j < path.length && event._stop === 0; j++) { event.eventPhase = 3; invoke(path[j], event, false); }
    event.eventPhase = 0;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }

  // What a click does, as HTML's activation behaviour has it. A box changes
  // before the click is heard, so a click listener reads the state the click
  // gives, and changes back when the click is cancelled. A form's button
  // sends or resets its form, a label clicks its field, and a <summary> opens
  // or closes its <details>.
  function activationTarget(node) {
    for (var n = node; n; n = rec(n).parent) {
      var r = rec(n);
      if (r.type !== 1) return null;
      if (r.ns) continue;
      if (r.tag === 'input' || r.tag === 'button' || r.tag === 'label') return n;
      if (r.tag === 'summary' && r.parent && rec(r.parent).tag === 'details' && firstChildOf(rec(r.parent), 'summary') === n) return n;
    }
    return null;
  }

  function firstChildOf(r, tag) {
    for (var i = 0; i < r.kids.length; i++) {
      var k = rec(r.kids[i]);
      if (k.type === 1 && !k.ns && k.tag === tag) return r.kids[i];
    }
    return null;
  }

  // A box ticked or a radio chosen before the click is dispatched; quiet
  // when the page already shows it (the person clicked it there).
  function preActivate(node, quiet) {
    var r = rec(node);
    if (r.tag !== 'input' || r.ns || r.seen || r.island) return null;
    var type = inputType(r);
    if (type === 'checkbox') {
      var was = checkedOf(r);
      setChecked(node, !was, quiet);
      return { node: node, was: was, other: null, changed: true };
    }
    if (type !== 'radio') return null;
    var before = checkedOf(r);
    var other = null;
    if (!before) {
      var group = radioGroup(node);
      for (var i = 0; i < group.length; i++) if (group[i] !== node && checkedOf(rec(group[i]))) other = group[i];
    }
    setChecked(node, true, quiet);
    return { node: node, was: before, other: other, changed: !before };
  }

  function undoActivation(undo, quiet) {
    setChecked(undo.node, undo.was, quiet);
    if (undo.other) setChecked(undo.other, true, quiet);
  }

  function activate(node, clicked) {
    var r = rec(node);
    var type = r.tag === 'input' ? inputType(r) : buttonType(r);
    if ((r.tag === 'button' || r.tag === 'input') && (type === 'submit' || type === 'image')) {
      var form = formOf(node);
      if (form) form.requestSubmit(node);
    } else if ((r.tag === 'button' || r.tag === 'input') && type === 'reset') {
      var owner = formOf(node);
      if (owner) owner.reset();
    } else if (r.tag === 'label') {
      var control = labelControl(node);
      if (control && !contains(control, clicked)) control.click();
    } else if (r.tag === 'summary') {
      var details = r.parent;
      if (getAttr(rec(details), 'open') !== null) removeAttr(details, 'open');
      else setAttr(details, 'open', '');
    }
  }

  // The field a label is for: by its for, or the first it holds.
  var LABELABLE = set('button input meter output progress select textarea');
  function labelable(r) { return !r.ns && !!LABELABLE[r.tag] && !(r.tag === 'input' && inputType(r) === 'hidden'); }
  function labelControl(label) {
    var r = rec(label);
    var id = getAttr(r, 'for');
    if (id !== null) {
      var found = findById(label, id);
      return found && labelable(rec(found)) ? found : null;
    }
    var inside = null;
    walk(r, function (node, k) { if (labelable(k)) { inside = node; return false; } return true; });
    return inside;
  }

  // An element by id in the tree node is in: the page, or a part of it the
  // code holds apart.
  function findById(node, id) {
    var r = rec(node);
    if (isConnected(r)) return doc.getElementById(id);
    var root = node;
    while (rec(root).parent) root = rec(root).parent;
    var found = null;
    if (rec(root).type === 1 && getAttr(rec(root), 'id') === id) return root;
    walk(rec(root), function (n, k) { if (getAttr(k, 'id') === id) { found = n; return false; } return true; });
    return found;
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
    get childNodes() {
      return cachedList(this, 'childNodes', function (r) {
        return liveList(function () { return r.kids; }, function () { return r.kidsVersion || 0; });
      });
    }
    get firstChild() { var k = rec(this).kids; return k.length ? k[0] : null; }
    get lastChild() { var k = rec(this).kids; return k.length ? k[k.length - 1] : null; }
    get nextSibling() { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; return k[k.indexOf(this) + 1] || null; }
    get previousSibling() { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; var at = k.indexOf(this); return at > 0 ? k[at - 1] : null; }
    get ownerDocument() { return rec(this).type === 9 ? null : doc; }
    get isConnected() { return isConnected(rec(this)); }
    get textContent() { var r = rec(this); return r.type === 9 ? null : textOf(r); }
    set textContent(value) {
      var r = rec(this);
      if (r.type === 9) return;
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
      if (r.type === 3 && was !== r.text && isConnected(r)) ops.push(['x', r.id, r.text]);
      // Told to an observer even when it is the text it was, as a browser tells it.
      mutated({ type: 'characterData', target: this, oldValue: was });
    }
    appendChild(child) { insert(this, [child], null); return child; }
    insertBefore(child, ref) {
      if (arguments.length < 2) throw new TypeError('Failed to execute \'insertBefore\' on \'Node\': 2 arguments required, but only ' + arguments.length + ' present.');
      insert(this, [child], ref || null);
      return child;
    }
    removeChild(child) {
      if (!child || !rec(child)) throw new TypeError('Failed to execute \'removeChild\' on \'Node\': parameter 1 is not of type \'Node\'.');
      if (rec(child).parent !== this) throw domError('NotFoundError', 'The node to be removed is not a child of this node.');
      detach(child);
      return child;
    }
    // A node put in another's place: the old one out, the new one where it was.
    replaceChild(child, old) {
      if (!old || !rec(old) || rec(old).parent !== this) throw domError('NotFoundError', 'The node to be replaced is not a child of this node.');
      checkInsert(this, [child]);
      if (child === old) return old;
      var ref = nextSiblingOf(old, []);
      if (ref === child) ref = nextSiblingOf(child, []);
      detach(old);
      insert(this, [child], ref);
      return old;
    }
    hasChildNodes() { return rec(this).kids.length > 0; }
    contains(other) { return !!other && !!rec(other) && contains(this, other); }
    getRootNode() { var n = this; while (rec(n).parent) n = rec(n).parent; return n; }
    cloneNode(deep) { return clone(this, !!deep); }
    isSameNode(other) { return other === this; }
    // Adjacent texts made one, and empty ones taken out.
    normalize() {
      var r = rec(this);
      for (var i = 0; i < r.kids.length; i++) {
        var kid = r.kids[i];
        var k = rec(kid);
        if (k.type === 1 || k.type === 11) { kid.normalize(); continue; }
        if (k.type !== 3) continue;
        var text = k.text;
        while (i + 1 < r.kids.length && rec(r.kids[i + 1]).type === 3) {
          text += rec(r.kids[i + 1]).text;
          detach(r.kids[i + 1]);
        }
        if (text === '') { detach(kid); i--; }
        else if (text !== k.text) kid.nodeValue = text;
      }
    }
  }
  Node.ELEMENT_NODE = 1;
  Node.TEXT_NODE = 3;
  Node.COMMENT_NODE = 8;
  Node.DOCUMENT_NODE = 9;
  Node.DOCUMENT_FRAGMENT_NODE = 11;

  // A copy has the attributes, and so the handlers written as attributes;
  // not the handlers set as properties or added as listeners.
  function clone(node, deep) {
    var r = rec(node);
    var copy;
    if (r.type === 3) return makeText(r.text);
    if (r.type === 8) return makeComment(r.text);
    if (r.type === 11) copy = makeFragment();
    else {
      if (r.island) warnOnce('island-clone', 'A part of the page SoftN draws is copied as an empty element of its kind.');
      copy = makeElement(r.tag, undefined, false, r.ns);
      for (var i = 0; i < r.attrs.length; i++) initAttr(copy, r.attrs[i][0], r.attrs[i][1]);
      var cr = rec(copy);
      if (r.value !== undefined) cr.value = r.value;
      if (r.checked !== undefined) cr.checked = r.checked;
      if (deep && r.content) {
        var content = clone(r.content, true);
        cr.content = content;
        rec(content).templateOf = copy;
      }
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

  // Several nodes as one to insert: a fragment holding them, as a browser makes it.
  function intoNode(nodes) {
    if (nodes.length === 1) return nodes[0];
    var fragment = makeFragment();
    if (nodes.length > 0) insert(fragment, nodes, null);
    return fragment;
  }

  function elementTagMatcher(name) {
    name = String(name);
    var lower = name.toLowerCase();
    return function (r) { return name === '*' || (r.ns ? r.tag === name : r.tag === lower); };
  }

  // The methods an element, a fragment and the document share for finding
  // what is in them and putting things in them.
  var PARENT_METHODS = {
    querySelector: function (selector) { return query(this, selector, false); },
    querySelectorAll: function (selector) { return query(this, selector, true); },
    getElementsByTagName: function (tag) {
      var root = this;
      return cachedList(this, 'tag:' + tag, function () {
        var keep = elementTagMatcher(tag);
        return liveList(function () { return elementsIn(root, keep); }, structureStamp, true);
      });
    },
    getElementsByClassName: function (names) {
      var root = this;
      var want = String(names).split(/[\t\n\f\r ]+/).filter(function (c) { return c !== ''; });
      return cachedList(this, 'class:' + want.join(' '), function () {
        return liveList(function () {
          if (want.length === 0) return [];
          return elementsIn(root, function (r) {
            var list = classesOf(r);
            for (var i = 0; i < want.length; i++) if (list.indexOf(want[i]) < 0) return false;
            return true;
          });
        }, structureAndAttrStamp, true);
      });
    },
    append: function () { insert(this, [intoNode(nodesFrom(arguments))], null); },
    prepend: function () { insert(this, [intoNode(nodesFrom(arguments))], rec(this).kids[0] || null); },
    replaceChildren: function () {
      var nodes = nodesFrom(arguments);
      checkInsert(this, nodes);
      replaceAllChildren(this, nodes);
    },
  };
  function mix(proto, methods) { for (var key in methods) proto[key] = methods[key]; }
  function defineGetters(proto, getters) {
    for (var key in getters) Object.defineProperty(proto, key, { get: getters[key], configurable: true });
  }
  function firstElement(kids, from, step) {
    for (var i = from; i >= 0 && i < kids.length; i += step) if (rec(kids[i]).type === 1) return kids[i];
    return null;
  }
  var PARENT_GETTERS = {
    children: function () {
      return cachedList(this, 'children', function (r) {
        return liveList(function () { return r.kids.filter(function (n) { return rec(n).type === 1; }); }, function () { return r.kidsVersion || 0; }, true);
      });
    },
    childElementCount: function () { return rec(this).kids.filter(function (n) { return rec(n).type === 1; }).length; },
    firstElementChild: function () { return firstElement(rec(this).kids, 0, 1); },
    lastElementChild: function () { var k = rec(this).kids; return firstElement(k, k.length - 1, -1); },
  };

  // What an element, a text and a comment share for moving themselves among
  // their siblings, as a browser does it: before(), after(), replaceWith()
  // and remove(), given nodes or text, even nodes already beside them.
  var CHILD_METHODS = {
    remove: function () { if (rec(this).parent) detach(this); },
    before: function () {
      var parent = rec(this).parent;
      if (!parent) return;
      var nodes = nodesFrom(arguments);
      var prev = this.previousSibling;
      while (prev && nodes.indexOf(prev) >= 0) prev = prev.previousSibling;
      var node = intoNode(nodes);
      insert(parent, [node], prev ? prev.nextSibling : rec(parent).kids[0] || null);
    },
    after: function () {
      var parent = rec(this).parent;
      if (!parent) return;
      var nodes = nodesFrom(arguments);
      var next = this.nextSibling;
      while (next && nodes.indexOf(next) >= 0) next = next.nextSibling;
      insert(parent, [intoNode(nodes)], next);
    },
    replaceWith: function () {
      var parent = rec(this).parent;
      if (!parent) return;
      var nodes = nodesFrom(arguments);
      var next = this.nextSibling;
      while (next && nodes.indexOf(next) >= 0) next = next.nextSibling;
      var node = intoNode(nodes);
      if (rec(this).parent === parent) Node.prototype.replaceChild.call(parent, node, this);
      else insert(parent, [node], next);
    },
  };

  function attrNode(node, name, value) {
    return { name: name, localName: name, nodeName: name, value: value, nodeValue: value, specified: true, namespaceURI: null, prefix: null, ownerElement: node };
  }

  class Element extends Node {
    get tagName() { var r = rec(this); return r.ns ? r.tag : r.tag.toUpperCase(); }
    get nodeName() { return this.tagName; }
    get localName() { return rec(this).tag; }
    get namespaceURI() { var ns = rec(this).ns; return ns === 'svg' ? SVG_NS : ns === 'math' ? MATH_NS : HTML_NS; }
    get prefix() { return null; }
    get id() { return getAttr(rec(this), 'id') || ''; }
    set id(value) { setAttr(this, 'id', value); }
    get className() { return getAttr(rec(this), 'class') || ''; }
    set className(value) { setAttr(this, 'class', value); }
    get classList() { return classListOf(this); }
    set classList(value) { setAttr(this, 'class', value); }
    get dataset() { return datasetOf(this); }
    get style() { return styleOf(this); }
    set style(value) { styleOf(this).cssText = value; }
    // The attributes, live, by index and by name.
    get attributes() {
      var node = this;
      return cachedList(this, 'attributes', function (r) {
        var map = liveList(function () {
          return r.attrs.map(function (a) { return attrNode(node, a[0], a[1]); });
        }, function () { return attrVersion; }, false, function (name) {
          var value = getAttr(r, name);
          return value === null ? undefined : attrNode(node, attrName(r, name), value);
        });
        return map;
      });
    }
    getAttributeNode(name) { var value = getAttr(rec(this), name); return value === null ? null : attrNode(this, attrName(rec(this), name), value); }
    get innerHTML() {
      var r = rec(this);
      var template = r.tag === 'template' && !r.ns;
      var from = template ? rec(this.content) : r;
      var out = '';
      if (!r.island || template) for (var i = 0; i < from.kids.length; i++) out += serialize(rec(from.kids[i]));
      return out;
    }
    set innerHTML(html) {
      if (rec(this).island) { warnOnce('island-children', 'A part of the page SoftN draws cannot be given children by the page\u2019s code.'); return; }
      setInnerHTML(this, html === null || html === undefined ? '' : html);
    }
    get outerHTML() { return serialize(rec(this)); }
    // The element replaced by what the HTML makes, read where it was.
    set outerHTML(html) {
      var parent = rec(this).parent;
      if (!parent) return;
      if (rec(parent).type === 9) throw domError('NoModificationAllowedError', 'This element\u2019s parent is the document.');
      var nodes = parseHTML(html === null || html === undefined ? '' : html, rec(parent).type === 1 ? parent : null);
      Node.prototype.replaceChild.call(parent, intoNode(nodes), this);
    }
    get innerText() { return innerTextOf(rec(this)); }
    // A line break given is a <br>, as a browser writes it.
    set innerText(value) {
      var text = value === null || value === undefined ? '' : String(value);
      var lines = text.split(/\r\n|\r|\n/);
      var nodes = [];
      for (var i = 0; i < lines.length; i++) {
        if (i > 0) nodes.push(makeElement('br'));
        if (lines[i] !== '') nodes.push(makeText(lines[i]));
      }
      replaceAllChildren(this, nodes);
    }
    get outerText() { return this.innerText; }
    get nextElementSibling() { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; return firstElement(k, k.indexOf(this) + 1, 1); }
    get previousElementSibling() { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; return firstElement(k, k.indexOf(this) - 1, -1); }
    getAttribute(name) { return getAttr(rec(this), name); }
    setAttribute(name, value) { name = String(name); checkAttrName(name); setAttr(this, name, value); }
    removeAttribute(name) { removeAttr(this, name); }
    hasAttribute(name) { return getAttr(rec(this), name) !== null; }
    hasAttributes() { return rec(this).attrs.length > 0; }
    // An attribute in a namespace (xlink:href) is kept by its written name.
    getAttributeNS(ns, name) { return getAttr(rec(this), nsName(rec(this), ns, name)); }
    setAttributeNS(ns, name, value) { name = String(name); checkAttrName(name); setAttr(this, name, value); }
    removeAttributeNS(ns, name) { removeAttr(this, nsName(rec(this), ns, name)); }
    hasAttributeNS(ns, name) { return getAttr(rec(this), nsName(rec(this), ns, name)) !== null; }
    toggleAttribute(name, force) {
      name = String(name);
      checkAttrName(name);
      var has = this.hasAttribute(name);
      var on = force === undefined ? !has : !!force;
      if (on && !has) setAttr(this, name, '');
      if (!on && has) removeAttr(this, name);
      return on;
    }
    getAttributeNames() { return rec(this).attrs.map(function (a) { return a[0]; }); }
    matches(selector) {
      var node = this;
      var groups = parseSelectors(selector);
      return withScope(this, function () { return matchesAny(node, groups); });
    }
    closest(selector) {
      var node = this;
      var groups = parseSelectors(selector);
      return withScope(this, function () {
        for (var n = node; n && rec(n).type === 1; n = rec(n).parent) if (matchesAny(n, groups)) return n;
        return null;
      });
    }
    insertAdjacentElement(position, node) { return adjacent(this, position, [node]) ? node : null; }
    insertAdjacentText(position, text) { adjacent(this, position, [makeText(text)]); }
    insertAdjacentHTML(position, html) {
      adjacent(this, position, function (context) { return parseHTML(html, rec(context).type === 1 ? context : null); }, true);
    }
    focus() { var r = rec(this); activeId = r.id; propChanged(r, 'focus', true); }
    blur() { var r = rec(this); if (activeId === r.id) activeId = 0; propChanged(r, 'blur', true); }
    click() {
      var r = rec(this);
      // A disabled field is not clicked; nor is one already being clicked
      // (a label's click that comes back to it).
      if ((!r.ns && CAN_DISABLE[r.tag] && isDisabled(r)) || r.clicking) return;
      r.clicking = true;
      try {
        var actor = activationTarget(this);
        var undo = actor ? preActivate(actor, false) : null;
        var go = dispatch(this, new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        if (undo) {
          if (!go) undoActivation(undo, false);
          else if (undo.changed) {
            dispatch(actor, new InputEvent('input', { bubbles: true, composed: true }));
            dispatch(actor, new Event('change', { bubbles: true }));
          }
        } else if (go && actor) activate(actor, this);
      } finally {
        r.clicking = false;
      }
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
  mix(Element.prototype, CHILD_METHODS);
  defineGetters(Element.prototype, PARENT_GETTERS);

  function nsName(r, ns, name) {
    name = String(name);
    if (ns === null || ns === undefined || ns === '') return name;
    for (var i = 0; i < r.attrs.length; i++) {
      var n = r.attrs[i][0];
      if (n.slice(n.indexOf(':') + 1) === name) return n;
    }
    return name;
  }

  // Where insertAdjacent… puts what it is given; nodes may be a function
  // that makes them, given the element they will be read in.
  function adjacent(node, position, nodes, html) {
    var r = rec(node);
    var where = String(position).toLowerCase();
    var outside = where === 'beforebegin' || where === 'afterend';
    if (!outside && where !== 'afterbegin' && where !== 'beforeend') {
      throw domError('SyntaxError', 'The value provided (\'' + position + '\') is not one of \'beforeBegin\', \'afterBegin\', \'beforeEnd\', or \'afterEnd\'.');
    }
    if (outside && (!r.parent || rec(r.parent).type === 9)) {
      if (html) throw domError('NoModificationAllowedError', 'The element has no parent.');
      return false;
    }
    if (typeof nodes === 'function') nodes = nodes(outside ? r.parent : node);
    if (where === 'beforebegin') insert(r.parent, nodes, node);
    else if (where === 'afterbegin') insert(node, nodes, r.kids[0] || null);
    else if (where === 'beforeend') insert(node, nodes, null);
    else insert(r.parent, nodes, nextSiblingOf(node, []));
    return true;
  }

  class HTMLElement extends Element {}
  // An element of a drawing (<svg>, made in it or with createElementNS):
  // its names keep their case, and it has an HTML element's handlers.
  class SVGElement extends Element {}

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
    ['title', 'title'], ['lang', 'lang'], ['name', 'name'], ['placeholder', 'placeholder'],
    ['href', 'href'], ['src', 'src'], ['alt', 'alt'], ['rel', 'rel'], ['target', 'target'], ['action', 'action'],
    ['method', 'method'], ['min', 'min'], ['max', 'max'], ['step', 'step'], ['pattern', 'pattern'], ['role', 'role'],
    ['htmlFor', 'for'], ['accept', 'accept'], ['autocomplete', 'autocomplete'], ['download', 'download'], ['label', 'label'],
  ]);
  reflectBoolean(HTMLElement.prototype, [
    ['disabled', 'disabled'], ['required', 'required'], ['readOnly', 'readonly'],
    ['multiple', 'multiple'], ['autofocus', 'autofocus'], ['open', 'open'], ['defaultChecked', 'checked'],
  ]);
  Object.defineProperty(HTMLElement.prototype, 'hidden', {
    configurable: true,
    get: function () { var v = getAttr(rec(this), 'hidden'); return v === null ? false : v.toLowerCase() === 'until-found' ? 'until-found' : true; },
    set: function (value) {
      if (value === 'until-found') setAttr(this, 'hidden', 'until-found');
      else if (value) setAttr(this, 'hidden', '');
      else removeAttr(this, 'hidden');
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'dir', {
    configurable: true,
    get: function () { var v = (getAttr(rec(this), 'dir') || '').toLowerCase(); return v === 'ltr' || v === 'rtl' || v === 'auto' ? v : ''; },
    set: function (value) { setAttr(this, 'dir', value); },
  });
  // What the person can reach with Tab without a tabindex: a link, a button, a field.
  function focusableByDefault(r) {
    if (r.tag === 'a' || r.tag === 'area') return getAttr(r, 'href') !== null;
    return r.tag === 'button' || r.tag === 'input' || r.tag === 'select' || r.tag === 'textarea' || r.tag === 'iframe' ||
      (r.tag === 'summary' && !!r.parent && rec(r.parent).tag === 'details');
  }
  Object.defineProperty(HTMLElement.prototype, 'tabIndex', {
    configurable: true,
    get: function () {
      var r = rec(this);
      var v = /^[\t\n\f\r ]*([+-]?\d+)/.exec(getAttr(r, 'tabindex') || '');
      return v ? parseInt(v[1], 10) : focusableByDefault(r) ? 0 : -1;
    },
    set: function (value) { setAttr(this, 'tabindex', String(value)); },
  });
  // An input's type is one HTML has (anything else is text); a button's is
  // submit unless it says reset or button.
  var INPUT_TYPES = set('hidden text search tel url email password date month week time datetime-local number range color checkbox radio file submit image reset button');
  function inputType(r) {
    var t = (getAttr(r, 'type') || '').toLowerCase();
    return INPUT_TYPES[t] ? t : 'text';
  }
  function buttonType(r) {
    var t = (getAttr(r, 'type') || '').toLowerCase();
    return t === 'reset' || t === 'button' ? t : 'submit';
  }
  Object.defineProperty(HTMLElement.prototype, 'type', {
    configurable: true,
    get: function () {
      var r = rec(this);
      if (r.tag === 'input') return inputType(r);
      if (r.tag === 'button') return buttonType(r);
      if (r.tag === 'select') return getAttr(r, 'multiple') !== null ? 'select-multiple' : 'select-one';
      var v = getAttr(r, 'type');
      return v === null ? '' : v;
    },
    set: function (value) { setAttr(this, 'type', value); },
  });

  // on<type> = fn: one handler of each kind, as a browser keeps it.
  var HANDLER_TYPES = (
    'click dblclick input change submit reset keydown keyup keypress focus blur mousedown mouseup mouseover mouseout ' +
    'mouseenter mouseleave mousemove contextmenu pointerdown pointerup pointermove pointerover pointerout pointerenter ' +
    'pointerleave pointercancel wheel scroll toggle load error focusin focusout dragstart drag dragend dragenter ' +
    'dragover dragleave drop touchstart touchmove touchend beforeinput copy cut paste close cancel invalid select ' +
    'animationstart animationend animationiteration transitionstart transitionend transitionrun transitioncancel'
  ).split(' ');
  function handlerProperties(proto) {
    HANDLER_TYPES.forEach(function (type) {
      Object.defineProperty(proto, 'on' + type, {
        configurable: true,
        get: function () { return rec(this).inline[type] || null; },
        set: function (fn) { setInline(rec(this), type, typeof fn === 'function' ? fn : null); },
      });
    });
  }
  handlerProperties(HTMLElement.prototype);
  handlerProperties(SVGElement.prototype);

  // A field's value is the field's, not its attribute's: the attribute is
  // where it starts. What is typed comes in from the host (__softnDocSync).
  // A textarea's lines end in \n however they were given.
  function fieldValue(r) {
    var value = r.value !== undefined ? r.value : r.tag === 'textarea' ? textOf(r) : getAttr(r, 'value');
    if (value === null) return '';
    return r.tag === 'textarea' ? value.replace(/\r\n?/g, '\n') : value;
  }

  // The form a field belongs to: the one its form attribute names, or the one it is in.
  function formOf(node) {
    var r = rec(node);
    var id = getAttr(r, 'form');
    if (id !== null) {
      var named = findById(node, id);
      return named && rec(named).tag === 'form' && !rec(named).ns ? named : null;
    }
    for (var n = r.parent; n; n = rec(n).parent) if (rec(n).tag === 'form' && !rec(n).ns) return n;
    return null;
  }

  // Disabled, as HTML has it: by its own disabled, or a <fieldset disabled>
  // it is in (but not in that fieldset's first <legend>), or, for an
  // option, its <optgroup disabled>.
  var CAN_DISABLE = set('button input select textarea optgroup option fieldset');
  var FIELDS = set('input select textarea');
  function isDisabled(r) {
    if (r.ns || !CAN_DISABLE[r.tag]) return false;
    if (getAttr(r, 'disabled') !== null) return true;
    if (r.tag === 'option') {
      var group = r.parent ? rec(r.parent) : null;
      return !!group && group.tag === 'optgroup' && getAttr(group, 'disabled') !== null;
    }
    if (r.tag === 'optgroup') return false;
    for (var child = r.node, up = r.parent; up; child = up, up = rec(up).parent) {
      var u = rec(up);
      if (u.type !== 1) break;
      if (u.tag === 'fieldset' && !u.ns && getAttr(u, 'disabled') !== null && firstChildOf(u, 'legend') !== child) return true;
    }
    return false;
  }

  // A field the person can type in, or an element they can edit (:read-write).
  var TEXT_TYPES = set('text search url tel email password date month week time datetime-local number');
  function isWritable(r) {
    if (r.ns) return false;
    if (r.tag === 'textarea' || (r.tag === 'input' && TEXT_TYPES[inputType(r)])) return getAttr(r, 'readonly') === null && !isDisabled(r);
    for (var n = r; n && n.type === 1; n = n.parent ? rec(n.parent) : null) {
      var editable = getAttr(n, 'contenteditable');
      if (editable === null) continue;
      editable = editable.toLowerCase();
      return editable === '' || editable === 'true' || editable === 'plaintext-only';
    }
    return false;
  }

  function checkedOf(r) { return r.checked !== undefined ? r.checked : getAttr(r, 'checked') !== null; }
  // A box ticked or a radio chosen by the code (told to the host) or by the
  // person (quiet: the page already shows it); a radio chosen takes its
  // group's other choices with it.
  function setChecked(node, on, quiet) {
    var r = rec(node);
    r.checked = !!on;
    if (!quiet) propChanged(r, 'checked', r.checked);
    if (r.checked && inputType(r) === 'radio') uncheckGroup(node, quiet);
  }

  // :default: a box or option checked by its markup, and a form's first submit button.
  function isDefault(node, r) {
    if (r.tag === 'option') return getAttr(r, 'selected') !== null;
    if (r.tag === 'input' && (inputType(r) === 'checkbox' || inputType(r) === 'radio')) return getAttr(r, 'checked') !== null;
    var submits = (r.tag === 'button' && buttonType(r) === 'submit') || (r.tag === 'input' && (inputType(r) === 'submit' || inputType(r) === 'image'));
    if (!submits) return false;
    var form = formOf(node);
    if (!form) return false;
    var first = query(form, 'button, input[type=submit], input[type=image]', true).filter(function (b) {
      var br = rec(b);
      return br.tag === 'input' || buttonType(br) === 'submit';
    })[0];
    return first === node;
  }

  // :indeterminate: a box set so, a radio group with nothing chosen, a <progress> with no value.
  function isIndeterminate(node, r) {
    if (r.tag === 'progress') return getAttr(r, 'value') === null;
    if (r.tag !== 'input') return false;
    var type = inputType(r);
    if (type === 'checkbox') return !!r.indeterminate;
    return type === 'radio' && !radioGroup(node).some(function (o) { return checkedOf(rec(o)); });
  }

  // :valid and :invalid: a field's validity, or a form's or fieldset's from
  // the fields in it; null where neither applies.
  function validState(node, r) {
    if (r.ns) return null;
    if (FIELDS[r.tag] || r.tag === 'button') return willValidate(r) ? validityOf(node).valid : null;
    if (r.tag !== 'form' && r.tag !== 'fieldset') return null;
    var fields = elementsIn(node, function (k) { return !k.ns && FIELDS[k.tag]; });
    for (var i = 0; i < fields.length; i++) if (willValidate(rec(fields[i])) && !validityOf(fields[i]).valid) return false;
    return true;
  }

  // :in-range and :out-of-range, for a field with a min or a max.
  function rangeState(node, r) {
    if (r.tag !== 'input' || r.ns || !willValidate(r)) return null;
    var type = inputType(r);
    if (!/^(?:number|range|date|month|week|time|datetime-local)$/.test(type)) return null;
    if (type !== 'range' && getAttr(r, 'min') === null && getAttr(r, 'max') === null) return null;
    var v = validityOf(node);
    return !v.rangeUnderflow && !v.rangeOverflow;
  }

  // What a form's checks say of a field: its validity, as a browser works it
  // out from required, type, pattern, minlength, maxlength, min, max and
  // step, and what setCustomValidity() said.
  var EMAIL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_\x60{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  var NOT_CHECKED = set('hidden button submit reset image');
  var VALIDITY_MESSAGES = [
    ['valueMissing', 'Please fill in this field.'], ['typeMismatch', 'Please enter a valid value.'],
    ['patternMismatch', 'Please match the requested format.'], ['tooLong', 'Please shorten this text.'],
    ['tooShort', 'Please lengthen this text.'], ['rangeUnderflow', 'The value is too low.'],
    ['rangeOverflow', 'The value is too high.'], ['stepMismatch', 'Please enter a valid value.'],
    ['badInput', 'Please enter a number.'],
  ];
  // Whether a field's validity is checked: not when it is disabled (itself
  // or by its fieldset), read-only, in a <datalist>, or a kind of input that
  // holds no value of the person's.
  function willValidate(r) {
    if (r.ns || !FIELDS[r.tag]) return false;
    if (isDisabled(r)) return false;
    if (r.tag !== 'select' && getAttr(r, 'readonly') !== null) return false;
    for (var up = r.parent; up; up = rec(up).parent) if (rec(up).tag === 'datalist') return false;
    return r.tag !== 'input' || !NOT_CHECKED[inputType(r)];
  }
  function inputNumber(type, text) {
    if (text === '' || text === null) return NaN;
    if (type === 'number' || type === 'range') return Number(text);
    return Date.parse(type === 'time' ? '1970-01-01T' + text + 'Z' : text);
  }
  // A radio's group: the radios of its name in its form (or, with none, in
  // the same tree and no form).
  function radioGroup(radio) {
    var name = getAttr(rec(radio), 'name');
    if (!name) return [radio];
    var form = formOf(radio);
    var scope = form || radio.getRootNode();
    var group = elementsIn(scope, function (k) {
      return k.tag === 'input' && !k.ns && inputType(k) === 'radio' && getAttr(k, 'name') === name;
    }).filter(function (o) { return formOf(o) === form; });
    if (group.indexOf(radio) < 0) group.push(radio);
    return group;
  }
  function validityOf(node) {
    var r = rec(node);
    var v = {
      valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false,
      rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: !!r.customValidity, valid: true,
    };
    if (willValidate(r)) {
      var type = r.tag === 'input' ? inputType(r) : '';
      var required = getAttr(r, 'required') !== null;
      if (r.tag === 'input' && type === 'checkbox') v.valueMissing = required && !checkedOf(r);
      else if (r.tag === 'input' && type === 'radio') {
        var group = radioGroup(node);
        if (group.some(function (o) { return getAttr(rec(o), 'required') !== null; })) v.valueMissing = !group.some(function (o) { return checkedOf(rec(o)); });
      } else {
        var value = node.value;
        if (required && value === '') v.valueMissing = true;
        if (value !== '' && r.tag === 'input') {
          if (type === 'email') {
            var addresses = getAttr(r, 'multiple') !== null ? value.split(',') : [value];
            v.typeMismatch = addresses.some(function (a) { return !EMAIL.test(a.trim()); });
          }
          if (type === 'url') v.typeMismatch = !URL.canParse(value);
          var pattern = getAttr(r, 'pattern');
          if (pattern !== null && /^(?:text|search|url|tel|email|password)$/.test(type)) {
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
        // Too long or too short only once the person has typed in it, as a
        // browser has it: a value the page set is not held against it.
        if (value !== '' && r.typed && (r.tag === 'input' || r.tag === 'textarea')) {
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
      if (!willValidate(rec(this)) || validityOf(this).valid) return true;
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
      var node = this;
      var found = elementsIn(this.getRootNode(), function (k) { return k.tag === 'label' && !k.ns && labelControl(k.node) === node; });
      return nodeList(found);
    },
    form: function () { return formOf(this); },
  };

  // A box's value is its attribute (or 'on'), and so is a button's; the
  // rest have a value of their own, which starts as the attribute. A number
  // field's value is a number or nothing.
  var VALUE_IS_ATTRIBUTE = set('hidden submit image reset button');
  var FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  class HTMLInputElement extends HTMLElement {
    get value() {
      var r = rec(this);
      var type = inputType(r);
      if (type === 'checkbox' || type === 'radio') { var on = getAttr(r, 'value'); return on === null ? 'on' : on; }
      if (VALUE_IS_ATTRIBUTE[type]) return getAttr(r, 'value') || '';
      var value = fieldValue(r);
      return type === 'number' && value !== '' && !FLOAT.test(value) ? '' : value;
    }
    set value(v) {
      var r = rec(this);
      var type = inputType(r);
      if (type === 'checkbox' || type === 'radio' || VALUE_IS_ATTRIBUTE[type]) { setAttr(this, 'value', v === null || v === undefined ? '' : v); return; }
      r.value = v === null || v === undefined ? '' : String(v);
      propChanged(r, 'value', r.value);
    }
    get defaultValue() { return getAttr(rec(this), 'value') || ''; }
    set defaultValue(v) { setAttr(this, 'value', v); }
    get checked() { return checkedOf(rec(this)); }
    set checked(v) { setChecked(this, v, false); }
    get indeterminate() { return !!rec(this).indeterminate; }
    set indeterminate(v) { rec(this).indeterminate = !!v; }
    get valueAsNumber() {
      var type = inputType(rec(this));
      if (/^(?:date|month|week|time|datetime-local)$/.test(type)) return inputNumber(type, this.value);
      var n = parseFloat(this.value);
      return isNaN(n) ? NaN : n;
    }
    set valueAsNumber(n) { this.value = String(n); }
    get valueAsDate() {
      var type = inputType(rec(this));
      var t = /^(?:date|month|week|time)$/.test(type) ? inputNumber(type, this.value) : NaN;
      return isNaN(t) ? null : new Date(t);
    }
    set valueAsDate(date) {
      var type = inputType(rec(this));
      if (date === null) { this.value = ''; return; }
      var iso = new Date(date.getTime()).toISOString();
      this.value = type === 'time' ? iso.slice(11, 16) : type === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
    }
    select() {}
    setSelectionRange() {}
  }

  function uncheckGroup(radio, quiet) {
    var group = radioGroup(radio);
    for (var i = 0; i < group.length; i++) {
      var o = rec(group[i]);
      if (group[i] !== radio && checkedOf(o)) {
        o.checked = false;
        if (!quiet) propChanged(o, 'checked', false);
      }
    }
  }

  class HTMLTextAreaElement extends HTMLElement {
    get value() { return fieldValue(rec(this)); }
    set value(v) { var r = rec(this); r.value = v === null || v === undefined ? '' : String(v).replace(/\r\n?/g, '\n'); propChanged(r, 'value', r.value); }
    get defaultValue() { return textOf(rec(this)); }
    set defaultValue(v) { this.textContent = v; }
    select() {}
    setSelectionRange() {}
  }

  // An option's text, its spaces run together, as a browser gives it.
  class HTMLOptionElement extends HTMLElement {
    get value() { var v = getAttr(rec(this), 'value'); return v === null ? this.text : v; }
    set value(v) { setAttr(this, 'value', v); }
    get text() { return textOf(rec(this)).replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, ''); }
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
    add(option) { this.appendChild(option); }
  }

  // A form's fields, each also under its name and its id (a list of them
  // where several share one, as radio buttons do), as form.elements has them.
  function formFields(form) {
    var list = nodeList(query(form, 'input, select, textarea, button, fieldset, output', true));
    var named = Object.create(null);
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
    // Told first, and done unless a listener cancels it, as a browser does.
    reset() {
      if (!dispatch(this, new Event('reset', { bubbles: true, cancelable: true }))) return;
      var fields = this.elements;
      for (var i = 0; i < fields.length; i++) {
        var r = rec(fields[i]);
        r.typed = false;
        if (r.value !== undefined) { delete r.value; propChanged(r, 'value', fieldValue(r)); }
        if (r.checked !== undefined) { delete r.checked; propChanged(r, 'checked', getAttr(r, 'checked') !== null); }
        if (r.chosen !== undefined) { delete r.chosen; delete r.selectedIndex; propChanged(r, 'chosen', chosenIndexes(fields[i])); }
        else if (r.selectedIndex !== undefined) { delete r.selectedIndex; propChanged(r, 'selectedIndex', fields[i].selectedIndex); }
      }
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
    get form() { return formOf(this); }
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
    get form() { return formOf(this); }
  }
  class HTMLImageElement extends HTMLElement {
    get src() { return addressOf(this, 'src'); }
    set src(v) { setAttr(this, 'src', v); }
    get width() { return Number(getAttr(rec(this), 'width')) || 0; }
    get height() { return Number(getAttr(rec(this), 'height')) || 0; }
    get complete() { return true; }
  }

  var ELEMENT_CLASSES = dict({
    input: HTMLInputElement, textarea: HTMLTextAreaElement, select: HTMLSelectElement, option: HTMLOptionElement,
    form: HTMLFormElement, button: HTMLButtonElement, a: HTMLAnchorElement, img: HTMLImageElement, output: HTMLOutputElement,
    template: HTMLTemplateElement, dialog: HTMLDialogElement,
  });
  [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement].forEach(function (Field) {
    mix(Field.prototype, FIELD_CHECKS);
    defineGetters(Field.prototype, FIELD_CHECK_GETTERS);
  });

  // The text of a Text or a Comment, read and changed in parts.
  function checkOffset(r, offset) {
    offset = Number(offset) >>> 0;
    if (offset > r.text.length) throw domError('IndexSizeError', 'The offset ' + offset + ' is larger than the data\u2019s length.');
    return offset;
  }
  var CHARACTER_DATA = {
    substringData: function (offset, count) { var r = rec(this); offset = checkOffset(r, offset); return r.text.substr(offset, Number(count) >>> 0); },
    appendData: function (text) { this.nodeValue = rec(this).text + String(text); },
    insertData: function (offset, text) { var r = rec(this); offset = checkOffset(r, offset); this.nodeValue = r.text.slice(0, offset) + String(text) + r.text.slice(offset); },
    deleteData: function (offset, count) { this.replaceData(offset, count, ''); },
    replaceData: function (offset, count, text) {
      var r = rec(this);
      offset = checkOffset(r, offset);
      this.nodeValue = r.text.slice(0, offset) + String(text) + r.text.slice(offset + (Number(count) >>> 0));
    },
  };
  var CHARACTER_DATA_GETTERS = {
    length: function () { return rec(this).text.length; },
    nextElementSibling: function () { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; return firstElement(k, k.indexOf(this) + 1, 1); },
    previousElementSibling: function () { var r = rec(this); if (!r.parent) return null; var k = rec(r.parent).kids; return firstElement(k, k.indexOf(this) - 1, -1); },
  };

  class Text extends Node {
    get nodeName() { return '#text'; }
    get data() { return rec(this).text; }
    set data(value) { this.nodeValue = value; }
    get wholeText() { return rec(this).text; }
    // The text from offset on, as a text of its own after this one.
    splitText(offset) {
      var r = rec(this);
      offset = checkOffset(r, offset);
      var rest = makeText(r.text.slice(offset));
      if (r.parent) insert(r.parent, [rest], this.nextSibling);
      this.nodeValue = r.text.slice(0, offset);
      return rest;
    }
  }

  class Comment extends Node {
    get nodeName() { return '#comment'; }
    get data() { return rec(this).text; }
    set data(value) { this.nodeValue = value; }
  }
  [Text, Comment].forEach(function (Kind) {
    mix(Kind.prototype, CHILD_METHODS);
    mix(Kind.prototype, CHARACTER_DATA);
    defineGetters(Kind.prototype, CHARACTER_DATA_GETTERS);
  });

  class DocumentFragment extends Node {
    get nodeName() { return '#document-fragment'; }
    getElementById(id) { return findById(this, String(id)); }
  }
  mix(DocumentFragment.prototype, PARENT_METHODS);
  defineGetters(DocumentFragment.prototype, PARENT_GETTERS);

  // A name createElement() refuses, as a browser does.
  function checkTagName(name) {
    if (!/^[A-Za-z][^\t\n\f\r \x00\/>]*$/.test(name) && !/^[:_\u0080-\uffff][\-.0-9:A-Z_a-z\u00b7-\uffff]*$/.test(name)) {
      throw domError('InvalidCharacterError', 'The tag name provided (\'' + name + '\') is not a valid name.');
    }
  }

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
    // From the index of ids on the page; of several with one id, the first.
    getElementById(id) {
      var list = IDS.get(String(id));
      if (!list) return null;
      if (list.length === 1) return list[0];
      var found = null;
      walk(rec(this), function (node) {
        if (list.indexOf(node) >= 0) { found = node; return false; }
        return true;
      });
      return found;
    }
    getElementsByName(name) {
      var root = this;
      var want = String(name);
      return cachedList(this, 'name:' + want, function () {
        return liveList(function () { return elementsIn(root, function (r) { return !r.ns && getAttr(r, 'name') === want; }); }, structureAndAttrStamp);
      });
    }
    createElement(tag) { tag = String(tag); checkTagName(tag); return makeElement(tag); }
    // In SVG's or MathML's namespace, an element of a drawing or a formula,
    // its name in its case.
    createElementNS(ns, tag) {
      tag = String(tag);
      checkTagName(tag);
      var local = tag.slice(tag.indexOf(':') + 1);
      if (ns === SVG_NS) return makeElement(local, undefined, false, 'svg');
      if (ns === MATH_NS) return makeElement(local, undefined, false, 'math');
      return makeElement(local);
    }
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
  handlerProperties(Document.prototype);

  // A form's fields by name, as sending it would give them: not a disabled
  // one (by itself or its fieldset), a box not ticked, a button other than
  // the one it is sent with, a file or image input, or a select with nothing
  // chosen.
  function FormData(form, submitter) {
    Object.defineProperty(this, '_entries', { value: [], writable: true, enumerable: false });
    if (form === undefined || form === null) return;
    if (!rec(form) || rec(form).tag !== 'form') throw new TypeError('Failed to construct \'FormData\': parameter 1 is not of type \'HTMLFormElement\'.');
    var fields = elementsIn(form, function (k) { return !k.ns && (!!FIELDS[k.tag] || k.tag === 'button'); });
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var r = rec(f);
      var name = getAttr(r, 'name');
      if (!name || isDisabled(r)) continue;
      var type = r.tag === 'input' ? inputType(r) : r.tag === 'button' ? buttonType(r) : '';
      if (r.tag === 'button' || (r.tag === 'input' && (VALUE_IS_ATTRIBUTE[type] && type !== 'hidden'))) {
        if (f === submitter && type === 'submit') this._entries.push([name, f.value]);
        continue;
      }
      if (type === 'file') continue;
      if ((type === 'checkbox' || type === 'radio') && !checkedOf(r)) continue;
      if (r.tag === 'select') {
        var chosen = f.selectedOptions;
        for (var c = 0; c < chosen.length; c++) this._entries.push([name, chosen[c].value]);
        continue;
      }
      this._entries.push([name, f.value]);
    }
  }
  // set(): the first entry of the name takes the value, where it is, and
  // the rest of that name go, as a browser has it.
  function setEntry(list, name, value) {
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i][0] !== name) continue;
      if (at < 0) { at = i; list[i][1] = value; }
      else { list.splice(i, 1); i--; }
    }
    if (at < 0) list.push([name, value]);
  }
  FormData.prototype.get = function (name) { name = String(name); for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] === name) return this._entries[i][1]; return null; };
  FormData.prototype.getAll = function (name) { name = String(name); return this._entries.filter(function (e) { return e[0] === name; }).map(function (e) { return e[1]; }); };
  FormData.prototype.has = function (name) { return this.get(name) !== null; };
  FormData.prototype.set = function (name, value) { setEntry(this._entries, String(name), String(value)); };
  FormData.prototype.append = function (name, value) { this._entries.push([String(name), String(value)]); };
  FormData.prototype.delete = function (name) { name = String(name); this._entries = this._entries.filter(function (e) { return e[0] !== name; }); };
  FormData.prototype.entries = function () { return this._entries.map(function (e) { return [e[0], e[1]]; })[Symbol.iterator](); };
  FormData.prototype.keys = function () { return this._entries.map(function (e) { return e[0]; })[Symbol.iterator](); };
  FormData.prototype.values = function () { return this._entries.map(function (e) { return e[1]; })[Symbol.iterator](); };
  FormData.prototype.forEach = function (fn, self) { var list = this._entries.slice(); for (var i = 0; i < list.length; i++) fn.call(self, list[i][1], list[i][0], this); };
  FormData.prototype[Symbol.iterator] = function () { return this.entries(); };

  function getComputedStyle(node) { return node && rec(node) && rec(node).type === 1 ? styleOf(node) : {}; }

  // ---------------------------------------------------------------- the rest of the window

  // fetch, through softn.net.fetch: the app's permission.json says which
  // hosts it may reach, as it does for every request the app makes.
  function Headers(init) {
    Object.defineProperty(this, '_map', { value: Object.create(null), writable: true, enumerable: false });
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
  // Read in the order of their names, as a browser gives them.
  function headerNames(headers) { return Object.keys(headers._map).sort(); }
  Headers.prototype.forEach = function (fn, self) { var names = headerNames(this); for (var i = 0; i < names.length; i++) fn.call(self, this._map[names[i]], names[i], this); };
  Headers.prototype.entries = function () { var m = this._map; return headerNames(this).map(function (k) { return [k, m[k]]; })[Symbol.iterator](); };
  Headers.prototype.keys = function () { return headerNames(this)[Symbol.iterator](); };
  Headers.prototype.values = function () { var m = this._map; return headerNames(this).map(function (k) { return m[k]; })[Symbol.iterator](); };
  Headers.prototype[Symbol.iterator] = function () { return this.entries(); };

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

  // URLSearchParams: a list of names and values, read and written as a
  // form sends them (a space as +, any byte but a letter, digit or *-._ as
  // %XX), made from a string, a list of pairs, a record or another, and kept
  // in step with the URL it is the searchParams of.
  function URLSearchParams(init) {
    Object.defineProperty(this, '_list', { value: [], writable: true, enumerable: false });
    Object.defineProperty(this, '_url', { value: null, writable: true, enumerable: false });
    if (init === undefined || init === null) return;
    if (typeof init === 'object' || typeof init === 'function') {
      if (typeof init[Symbol.iterator] === 'function') {
        var pairs = Array.from(init);
        for (var i = 0; i < pairs.length; i++) {
          var pair = pairs[i] !== null && typeof pairs[i] === 'object' && typeof pairs[i][Symbol.iterator] === 'function' ? Array.from(pairs[i]) : null;
          if (!pair || pair.length !== 2) throw new TypeError('Failed to construct \'URLSearchParams\': Each query pair must be an iterable [name, value] tuple');
          this._list.push([String(pair[0]), String(pair[1])]);
        }
      } else {
        var keys = Object.keys(init);
        for (var k = 0; k < keys.length; k++) this._list.push([keys[k], String(init[keys[k]])]);
      }
    } else this._list = parseQuery(String(init));
  }
  function parseQuery(text) {
    if (text.charAt(0) === '?') text = text.slice(1);
    var list = [];
    var pairs = text.split('&');
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i] === '') continue;
      var at = pairs[i].indexOf('=');
      list.push([unquery(at < 0 ? pairs[i] : pairs[i].slice(0, at)), unquery(at < 0 ? '' : pairs[i].slice(at + 1))]);
    }
    return list;
  }
  function unquery(text) { return percentDecode(text.replace(/\+/g, ' ')); }
  // %XX as a byte, the bytes read as UTF-8 (a byte that is not is U+FFFD); a
  // % without two hex digits after it is itself.
  function percentDecode(text) {
    if (text.indexOf('%') < 0) return text;
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
        continue;
      }
      var cp = text.codePointAt(i);
      if (cp > 0xffff) i++;
      bytes.push.apply(bytes, utf8(cp));
    }
    return utf8Decode(bytes, false, false).text;
  }
  function formEncode(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (/[A-Za-z0-9*\-._]/.test(ch)) { out += ch; continue; }
      if (ch === ' ') { out += '+'; continue; }
      var cp = text.codePointAt(i);
      if (cp > 0xffff) i++;
      var bytes = utf8(cp);
      for (var b = 0; b < bytes.length; b++) out += percent(bytes[b]);
    }
    return out;
  }
  // Changed, the list is the URL's query from then on (none, when empty).
  function paramsChanged(params) {
    if (!params._url) return;
    var text = params.toString();
    params._url._p.search = text === '' ? null : text;
  }
  URLSearchParams.prototype.get = function (name) { name = String(name); for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === name) return this._list[i][1]; return null; };
  URLSearchParams.prototype.getAll = function (name) { name = String(name); return this._list.filter(function (e) { return e[0] === name; }).map(function (e) { return e[1]; }); };
  URLSearchParams.prototype.has = function (name, value) {
    name = String(name);
    var any = value === undefined;
    return this._list.some(function (e) { return e[0] === name && (any || e[1] === String(value)); });
  };
  URLSearchParams.prototype.append = function (name, value) { this._list.push([String(name), String(value)]); paramsChanged(this); };
  URLSearchParams.prototype.set = function (name, value) { setEntry(this._list, String(name), String(value)); paramsChanged(this); };
  URLSearchParams.prototype.delete = function (name, value) {
    name = String(name);
    var any = value === undefined;
    this._list = this._list.filter(function (e) { return !(e[0] === name && (any || e[1] === String(value))); });
    paramsChanged(this);
  };
  URLSearchParams.prototype.forEach = function (fn, self) { var list = this._list.slice(); for (var i = 0; i < list.length; i++) fn.call(self, list[i][1], list[i][0], this); };
  URLSearchParams.prototype.keys = function () { return this._list.map(function (e) { return e[0]; })[Symbol.iterator](); };
  URLSearchParams.prototype.values = function () { return this._list.map(function (e) { return e[1]; })[Symbol.iterator](); };
  URLSearchParams.prototype.entries = function () { return this._list.map(function (e) { return [e[0], e[1]]; })[Symbol.iterator](); };
  URLSearchParams.prototype.toString = function () { return this._list.map(function (e) { return formEncode(e[0]) + '=' + formEncode(e[1]); }).join('&'); };
  // By name, keeping the order of those with one name.
  URLSearchParams.prototype.sort = function () {
    var indexed = this._list.map(function (e, i) { return [e, i]; });
    indexed.sort(function (a, b) { return a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]; });
    this._list = indexed.map(function (x) { return x[0]; });
    paramsChanged(this);
  };
  URLSearchParams.prototype[Symbol.iterator] = function () { return this.entries(); };
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
  // A copy as a browser makes one: dates, maps, sets, errors of their kind,
  // boxed values, an array with its length and its holes, typed arrays and
  // views that share a buffer still sharing their copy of it, and a value
  // that holds itself, which a round trip through JSON loses. A function, a
  // symbol, a weak map, a promise or a node of the document is not copied:
  // a DataCloneError says so.
  var ERROR_KINDS = dict({ Error: Error, EvalError: EvalError, RangeError: RangeError, ReferenceError: ReferenceError, SyntaxError: SyntaxError, TypeError: TypeError, URIError: URIError });
  var NOT_CLONED = set('WeakMap WeakSet WeakRef Promise Generator AsyncGenerator FinalizationRegistry');
  function structuredClone(value, seen) {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') throw new DOMException(String(value) + ' could not be cloned.', 'DataCloneError');
      return value;
    }
    seen = seen || new Map();
    if (seen.has(value)) return seen.get(value);
    if (rec(value)) throw new DOMException('A node of the document could not be cloned.', 'DataCloneError');
    var kind = Object.prototype.toString.call(value).slice(8, -1);
    if (NOT_CLONED[kind]) throw new DOMException(kind + ' object could not be cloned.', 'DataCloneError');
    var out;
    if (value instanceof Date) out = new Date(value.getTime());
    else if (value instanceof RegExp) out = new RegExp(value.source, value.flags);
    else if (value instanceof ArrayBuffer) out = value.slice(0);
    else if (value instanceof DataView) out = new DataView(structuredClone(value.buffer, seen), value.byteOffset, value.byteLength);
    else if (ArrayBuffer.isView(value)) out = new value.constructor(structuredClone(value.buffer, seen), value.byteOffset, value.length);
    else if (kind === 'Boolean' || kind === 'Number' || kind === 'String' || kind === 'BigInt') out = Object(value.valueOf());
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
      var Kind = ERROR_KINDS[value.name] || Error;
      out = new Kind(value.message === undefined ? '' : String(value.message));
      seen.set(value, out);
      if (Object.prototype.hasOwnProperty.call(value, 'cause')) out.cause = structuredClone(value.cause, seen);
      return out;
    } else {
      out = Array.isArray(value) ? new Array(value.length) : {};
      seen.set(value, out);
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) out[keys[i]] = structuredClone(value[keys[i]], seen);
      return out;
    }
    seen.set(value, out);
    return out;
  }

  // sessionStorage: for as long as the page is open.
  function Storage() { Object.defineProperty(this, '_items', { value: Object.create(null), writable: true, enumerable: false }); }
  Storage.prototype.getItem = function (key) { var v = this._items[String(key)]; return v === undefined ? null : v; };
  Storage.prototype.setItem = function (key, value) { this._items[String(key)] = String(value); };
  Storage.prototype.removeItem = function (key) { delete this._items[String(key)]; };
  Storage.prototype.clear = function () { this._items = Object.create(null); };
  Storage.prototype.key = function (i) { var keys = Object.keys(this._items); return i < keys.length ? keys[i] : null; };
  Object.defineProperty(Storage.prototype, 'length', { get: function () { return Object.keys(this._items).length; } });
  var sessionStorage = new Storage();


  // ---------------------------------------------------------------- more of the window

  // DOMException, as a browser's errors are made, with the old number of each name.
  var EXCEPTION_CODES = dict({
    IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NoModificationAllowedError: 7,
    NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14,
    InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21,
    QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
  });
  class DOMException extends Error {
    constructor(message, name) {
      super(message === undefined ? '' : String(message));
      this.name = name === undefined ? 'Error' : String(name);
    }
    get code() { return EXCEPTION_CODES[this.name] || 0; }
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

  // URL: an address, taken apart and put together as the URL Standard has
  // it: each part percent-encoded as a browser encodes it (a space, a quote,
  // an é), %2e%2e read as .., any number of slashes after a special scheme
  // (http:, https:, file:…), an empty ? or # kept, and a port that cannot be
  // one refused. A host is taken as it is written (in lower case, for a
  // special scheme): not turned into punycode, and an IPv4 address not
  // read in its short forms.
  var DEFAULT_PORTS = dict({ 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' });
  function isSpecial(protocol) { return DEFAULT_PORTS[protocol] !== undefined || protocol === 'file:'; }
  var C0_SET = /[\x00-\x1f\x7f]/;
  var FRAGMENT_SET = /[\x00-\x20\x7f"<>\x60]/;
  var QUERY_SET = /[\x00-\x20\x7f"#<>]/;
  var SPECIAL_QUERY_SET = /[\x00-\x20\x7f"#<>']/;
  var PATH_SET = /[\x00-\x20\x7f"#<>?\x60{}^|]/;
  var USERINFO_SET = /[\x00-\x20\x7f"#<>?\x60{}^|\/:;=@\[\\\]]/;

  function percent(byte) { return '%' + (byte < 16 ? '0' : '') + byte.toString(16).toUpperCase(); }
  // What the set matches, and every character past ASCII (as UTF-8), as %XX.
  function encodeSet(text, set) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) { out += set.test(text.charAt(i)) ? percent(code) : text.charAt(i); continue; }
      var cp = text.codePointAt(i);
      if (cp > 0xffff) i++;
      var bytes = utf8(cp);
      for (var b = 0; b < bytes.length; b++) out += percent(bytes[b]);
    }
    return out;
  }

  // A special scheme's host: %XX read, in lower case, a space or a control
  // character written as %XX, as Chrome writes it.
  function specialHost(host) {
    return percentDecode(host).toLowerCase().replace(/[\x00-\x20\x7f]/g, function (c) { return percent(c.charCodeAt(0)); });
  }

  function isDot(part) { return part === '.' || part.toLowerCase() === '%2e'; }
  function isDots(part) { var p = part.toLowerCase(); return p === '..' || p === '.%2e' || p === '%2e.' || p === '%2e%2e'; }
  // A path with its . and .. taken out, each segment encoded.
  function cleanPath(path) {
    var parts = path.split('/');
    var out = [];
    for (var i = 1; i < parts.length; i++) {
      var last = i === parts.length - 1;
      if (isDots(parts[i])) { if (out.length) out.pop(); if (last) out.push(''); }
      else if (isDot(parts[i])) { if (last) out.push(''); }
      else out.push(encodeSet(parts[i], PATH_SET));
    }
    return '/' + out.join('/');
  }

  // A URL's parts: hostname null when it has no host part (mailto:, foo:/a);
  // search and hash null when absent, '' when written empty.
  function urlParts(protocol) {
    return { protocol: protocol, username: '', password: '', hostname: null, port: '', pathname: '', search: null, hash: null, opaque: false };
  }

  // The path, the query and the fragment of text (what follows the host),
  // or, for keepPath, the query and fragment over the path parts has.
  function pathQueryHash(parts, text, keepPath) {
    var special = isSpecial(parts.protocol);
    var hashAt = text.indexOf('#');
    if (hashAt >= 0) { parts.hash = encodeSet(text.slice(hashAt + 1), FRAGMENT_SET); text = text.slice(0, hashAt); }
    var queryAt = text.indexOf('?');
    if (queryAt >= 0) { parts.search = encodeSet(text.slice(queryAt + 1), special ? SPECIAL_QUERY_SET : QUERY_SET); text = text.slice(0, queryAt); }
    if (keepPath) return parts;
    if (special) text = text.replace(/\\/g, '/');
    if (parts.opaque) parts.pathname = encodeSet(text, C0_SET);
    else if (text === '' && !special) parts.pathname = '';
    else parts.pathname = cleanPath(text.charAt(0) === '/' ? text : '/' + text);
    return parts;
  }

  function authorityParts(protocol, rest) {
    var end = rest.search(isSpecial(protocol) ? /[\/\\?#]/ : /[\/?#]/);
    var authority = end < 0 ? rest : rest.slice(0, end);
    var at = authority.lastIndexOf('@');
    var parts = urlParts(protocol);
    if (at >= 0) {
      var userinfo = authority.slice(0, at);
      var colon = userinfo.indexOf(':');
      parts.username = encodeSet(colon < 0 ? userinfo : userinfo.slice(0, colon), USERINFO_SET);
      parts.password = colon < 0 ? '' : encodeSet(userinfo.slice(colon + 1), USERINFO_SET);
    }
    var hp = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(authority.slice(at + 1));
    if (!hp) return null;
    var port = hp[2] === undefined ? '' : hp[2];
    if (port !== '') {
      if (!/^\d+$/.test(port) || Number(port) > 65535) return null;
      port = String(Number(port));
      if (DEFAULT_PORTS[protocol] === port) port = '';
    }
    var host = hp[1];
    if (isSpecial(protocol)) {
      host = specialHost(host);
      if (host === '' && protocol !== 'file:') return null;
    } else host = encodeSet(host, C0_SET);
    parts.hostname = host;
    parts.port = port;
    return pathQueryHash(parts, end < 0 ? '' : rest.slice(end));
  }

  function resolveParts(input, base) {
    var text = String(input).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
    var scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text);
    if (scheme) {
      var protocol = scheme[1].toLowerCase() + ':';
      var rest = text.slice(scheme[0].length);
      if (protocol === 'file:') {
        var file = /^[\/\\]{2}([^\/\\?#]*)/.exec(rest);
        if (file) return authorityParts(protocol, rest.slice(2));
        var local = urlParts(protocol);
        local.hostname = '';
        return pathQueryHash(local, rest);
      }
      if (isSpecial(protocol)) {
        // https:b, against a base of the same scheme, is relative to it.
        if (base && base.protocol === protocol && !/^[\/\\]/.test(rest)) return relativeParts(rest, base);
        return authorityParts(protocol, rest.replace(/^[\/\\]*/, ''));
      }
      if (rest.slice(0, 2) === '//') return authorityParts(protocol, rest.slice(2));
      var parts = urlParts(protocol);
      parts.opaque = rest.charAt(0) !== '/';
      return pathQueryHash(parts, rest);
    }
    if (!base) return null;
    if (base.opaque) {
      if (text.charAt(0) !== '#') return null;
      var same = copyParts(base);
      same.hash = encodeSet(text.slice(1), FRAGMENT_SET);
      return same;
    }
    return relativeParts(text, base);
  }

  function copyParts(p) {
    return { protocol: p.protocol, username: p.username, password: p.password, hostname: p.hostname, port: p.port, pathname: p.pathname, search: p.search, hash: p.hash, opaque: p.opaque };
  }

  function relativeParts(text, base) {
    var special = isSpecial(base.protocol);
    var head = text.search(/[?#]/);
    if (special) text = (head < 0 ? text : text.slice(0, head)).replace(/\\/g, '/') + (head < 0 ? '' : text.slice(head));
    if (text.slice(0, 2) === '//') return resolveParts(base.protocol + text, null);
    var parts = copyParts(base);
    parts.hash = null;
    if (text === '') return parts;
    if (text.charAt(0) === '#') { parts.hash = encodeSet(text.slice(1), FRAGMENT_SET); return parts; }
    parts.search = null;
    if (text.charAt(0) === '?') return pathQueryHash(parts, text, true);
    if (text.charAt(0) !== '/') {
      var path = /^[^?#]*/.exec(text)[0];
      text = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1) + path + text.slice(path.length);
    }
    return pathQueryHash(parts, text);
  }

  function urlHref(p, noHash) {
    var out = p.protocol;
    if (p.hostname !== null) {
      out += '//';
      if (p.username || p.password) out += p.username + (p.password ? ':' + p.password : '') + '@';
      out += p.hostname + (p.port ? ':' + p.port : '');
    } else if (!p.opaque && p.pathname.slice(0, 2) === '//') out += '/.';
    out += p.pathname;
    if (p.search !== null) out += '?' + p.search;
    if (!noHash && p.hash !== null) out += '#' + p.hash;
    return out;
  }

  class URL {
    constructor(url, base) {
      var baseParts = null;
      if (base !== undefined) {
        baseParts = resolveParts(base instanceof URL ? base.href : String(base), null);
        if (!baseParts) throw new TypeError('Failed to construct \'URL\': Invalid base URL');
      }
      var parts = resolveParts(url instanceof URL ? url.href : String(url), baseParts);
      if (!parts) throw new TypeError('Failed to construct \'URL\': Invalid URL');
      Object.defineProperty(this, '_p', { value: parts, writable: true, enumerable: false });
      Object.defineProperty(this, '_q', { value: null, writable: true, enumerable: false });
    }
    static canParse(url, base) { try { new URL(url, base); return true; } catch (e) { return false; } }
    static parse(url, base) { try { return new URL(url, base); } catch (e) { return null; } }
    get protocol() { return this._p.protocol; }
    set protocol(v) {
      var p = String(v).replace(/:.*$/, '').toLowerCase() + ':';
      if (!/^[a-z][a-z0-9+.-]*:$/.test(p) || isSpecial(p) !== isSpecial(this._p.protocol)) return;
      this._p.protocol = p;
      if (DEFAULT_PORTS[p] === this._p.port) this._p.port = '';
    }
    get username() { return this._p.username; }
    set username(v) { if (this._p.hostname) this._p.username = encodeSet(String(v), USERINFO_SET); }
    get password() { return this._p.password; }
    set password(v) { if (this._p.hostname) this._p.password = encodeSet(String(v), USERINFO_SET); }
    get hostname() { return this._p.hostname || ''; }
    set hostname(v) {
      if (this._p.opaque) return;
      var host = String(v).replace(/[:\/\\?#].*$/, '');
      if (isSpecial(this._p.protocol)) { host = specialHost(host); if (host === '' && this._p.protocol !== 'file:') return; }
      this._p.hostname = host;
    }
    get port() { return this._p.port; }
    set port(v) {
      var digits = /^\d*/.exec(String(v))[0];
      if (String(v) === '') { this._p.port = ''; return; }
      if (digits === '' || Number(digits) > 65535 || !this._p.hostname) return;
      var n = String(Number(digits));
      this._p.port = DEFAULT_PORTS[this._p.protocol] === n ? '' : n;
    }
    get host() { return this.hostname + (this._p.port ? ':' + this._p.port : ''); }
    set host(v) {
      var m = /^(\[[^\]]*\]|[^:\/\\?#]*)(?::(\d*))?/.exec(String(v));
      if (!m) return;
      this.hostname = m[1];
      if (m[2] !== undefined && m[2] !== '') this.port = m[2];
    }
    get origin() {
      var p = this._p;
      if (p.protocol === 'blob:') { var inner = URL.parse(p.pathname); return inner && /^https?:$/.test(inner.protocol) ? inner.origin : 'null'; }
      if (p.protocol === 'file:') return 'file://';
      return DEFAULT_PORTS[p.protocol] !== undefined ? p.protocol + '//' + this.host : 'null';
    }
    get pathname() { return this._p.pathname; }
    set pathname(v) {
      if (this._p.opaque) return;
      var path = String(v);
      if (isSpecial(this._p.protocol)) path = path.replace(/\\/g, '/');
      this._p.pathname = path === '' && !isSpecial(this._p.protocol) ? '' : cleanPath(path.charAt(0) === '/' ? path : '/' + path);
    }
    get search() { return this._p.search ? '?' + this._p.search : ''; }
    set search(v) {
      var t = String(v);
      if (t.charAt(0) === '?') t = t.slice(1);
      this._p.search = t === '' ? null : encodeSet(t, isSpecial(this._p.protocol) ? SPECIAL_QUERY_SET : QUERY_SET);
      if (this._q) this._q._list = parseQuery(t);
    }
    // The URL's query, as a list kept in step with it both ways.
    get searchParams() {
      if (!this._q) {
        this._q = new URLSearchParams(this._p.search || '');
        this._q._url = this;
      }
      return this._q;
    }
    get hash() { return this._p.hash ? '#' + this._p.hash : ''; }
    set hash(v) {
      var t = String(v);
      if (t.charAt(0) === '#') t = t.slice(1);
      this._p.hash = t === '' ? null : encodeSet(t, FRAGMENT_SET);
    }
    get href() { return urlHref(this._p, false); }
    set href(v) {
      var parts = resolveParts(String(v), null);
      if (!parts) throw new TypeError('Failed to set the \'href\' property on \'URL\': Invalid URL');
      this._p = parts;
      if (this._q) this._q._list = parseQuery(parts.search || '');
    }
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
  function utf8(code) {
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) return [code];
    if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 63)];
    if (code < 0x10000) return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
    return [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
  }
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(text) {
      var input = text === undefined ? '' : String(text);
      var bytes = [];
      for (var i = 0; i < input.length; i++) {
        var code = input.codePointAt(i);
        if (code > 0xffff) i++;
        if (code < 0x80) bytes.push(code);
        else bytes.push.apply(bytes, utf8(code));
      }
      return new Uint8Array(bytes);
    }
    // As much of text as fits in dest, whole characters only.
    encodeInto(text, dest) {
      var input = String(text);
      var read = 0;
      var written = 0;
      for (var i = 0; i < input.length; i++) {
        var code = input.codePointAt(i);
        var bytes = utf8(code);
        if (written + bytes.length > dest.length) break;
        for (var b = 0; b < bytes.length; b++) dest[written++] = bytes[b];
        var units = code > 0xffff ? 2 : 1;
        read += units;
        i += units - 1;
      }
      return { read: read, written: written };
    }
  }

  // Bytes read as UTF-8, as the Encoding Standard reads them: each part
  // that is not UTF-8 (a stray byte, a sequence cut short, too long, a
  // surrogate's, past U+10FFFF) is one U+FFFD, or, fatal, a TypeError. With
  // stream, a sequence the bytes end inside is left (rest) for the next.
  function utf8Decode(bytes, fatal, stream) {
    var out = '';
    var units = [];
    var code = 0;
    var needed = 0;
    var seen = 0;
    var lower = 0x80;
    var upper = 0xbf;
    var start = 0;
    function put(u) {
      units.push(u);
      if (units.length >= 8192) { out += String.fromCharCode.apply(null, units); units = []; }
    }
    function bad() {
      if (fatal) throw new TypeError('The encoded data was not valid.');
      put(0xfffd);
    }
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (needed === 0) {
        start = i;
        if (b < 0x80) put(b);
        else if (b >= 0xc2 && b <= 0xdf) { needed = 1; code = b & 0x1f; }
        else if (b >= 0xe0 && b <= 0xef) { if (b === 0xe0) lower = 0xa0; if (b === 0xed) upper = 0x9f; needed = 2; code = b & 0xf; }
        else if (b >= 0xf0 && b <= 0xf4) { if (b === 0xf0) lower = 0x90; if (b === 0xf4) upper = 0x8f; needed = 3; code = b & 7; }
        else bad();
        continue;
      }
      if (b < lower || b > upper) {
        code = needed = seen = 0;
        lower = 0x80;
        upper = 0xbf;
        bad();
        // Read again, as the start of what follows.
        i--;
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      code = (code << 6) | (b & 0x3f);
      if (++seen === needed) {
        if (code > 0xffff) { code -= 0x10000; put(0xd800 + (code >> 10)); put(0xdc00 + (code & 0x3ff)); }
        else put(code);
        code = needed = seen = 0;
      }
    }
    var rest = 0;
    if (needed !== 0) {
      if (stream) rest = bytes.length - start;
      else bad();
    }
    if (units.length) out += String.fromCharCode.apply(null, units);
    return { text: out, rest: rest };
  }

  var UTF8_LABELS = set('unicode-1-1-utf-8 unicode11utf8 unicode20utf8 utf-8 utf8 x-unicode20utf8');
  class TextDecoder {
    constructor(label, options) {
      var name = label === undefined ? 'utf-8' : String(label).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
      if (!UTF8_LABELS[name]) throw new RangeError('Only UTF-8 is read here, not ' + label);
      Object.defineProperty(this, '_fatal', { value: !!(options && options.fatal), enumerable: false });
      Object.defineProperty(this, '_ignoreBOM', { value: !!(options && options.ignoreBOM), enumerable: false });
      Object.defineProperty(this, '_pending', { value: [], writable: true, enumerable: false });
      Object.defineProperty(this, '_started', { value: false, writable: true, enumerable: false });
    }
    get encoding() { return 'utf-8'; }
    get fatal() { return this._fatal; }
    get ignoreBOM() { return this._ignoreBOM; }
    // A byte order mark at the start is taken off, unless ignoreBOM.
    decode(input, options) {
      var stream = !!(options && options.stream);
      var bytes;
      if (input === undefined) bytes = [];
      else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else throw new TypeError('Failed to execute \'decode\' on \'TextDecoder\': The provided value is not of type \'(ArrayBuffer or ArrayBufferView)\'.');
      if (this._pending.length) bytes = this._pending.concat(Array.prototype.slice.call(bytes));
      var result;
      try {
        result = utf8Decode(bytes, this._fatal, stream);
      } catch (error) {
        this._pending = [];
        this._started = false;
        throw error;
      }
      this._pending = result.rest ? Array.prototype.slice.call(bytes, bytes.length - result.rest) : [];
      var text = result.text;
      if (!this._started && text.length > 0) {
        if (!this._ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        this._started = true;
      }
      if (!stream) {
        this._started = false;
        this._pending = [];
      }
      return text;
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
      if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) {
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
      if (!node || typeof node !== 'object' || !rec(node) || rec(node).type === 0) throw new TypeError('Failed to execute \'observe\' on \'MutationObserver\': parameter 1 is not of type \'Node\'.');
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
      // A handler written in the markup as code is the page's to run, with
      // the element as this and the event as event, as a browser runs it.
      // One SoftN reads (onclick="save()") is SoftN's, and is not here.
      for (var key in seed.a || {}) initAttr(node, key, String(seed.a[key]));
      var id = getAttr(r, 'id');
      if (id && !inert) idIndex(id, node, true);
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

  // What the code changed, for the host, a page at a time: the engine hands
  // a value of up to two million parts across, and a turn that built a long
  // list can come to more. A page is kept until the host asks for the next;
  // one it could not read (failed) is sent again, in halves.
  var PAGE = 100000;
  var pageSize = PAGE;
  var sent = null;
  function opSize(op) {
    var last = op[op.length - 1];
    var n = op.length + 1;
    if (last !== null && typeof last === 'object') n += Array.isArray(last) ? last.length : 2 * Object.keys(last).length;
    return n;
  }
  function take(failed) {
    if (sent) {
      if (!failed) pageSize = PAGE;
      else if (sent.length > 1) { ops = sent.concat(ops); pageSize = Math.max(1, Math.floor(pageSize / 2)); }
      else warnOnce('unreadable-op', 'A change the page\u2019s code made could not be handed to the page, and is left out.');
      sent = null;
    }
    tellChildren();
    if (ops.length === 0) return null;
    var size = 0;
    var n = 0;
    while (n < ops.length) {
      var s = opSize(ops[n]);
      if (n > 0 && size + s > pageSize) break;
      size += s;
      n++;
    }
    sent = ops.slice(0, n);
    ops = ops.slice(n);
    return sent;
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
      if (c[0] === 'v') { r.value = String(c[2]); r.typed = true; }
      else if (c[0] === 'k') r.checked = !!c[2];
      else if (c[0] === 's') r.selectedIndex = Number(c[2]);
      else if (c[0] === 'S') { r.chosen = c[2].slice(); r.selectedIndex = r.chosen.length ? r.chosen[0] : -1; }
      else if (c[0] === 'A') {
        // An attribute SoftN draws from a {value}: told as the page shows it,
        // so classList.add on class={cls} adds to what is there.
        var at = -1;
        for (var a = 0; a < r.attrs.length; a++) if (r.attrs[a][0] === c[2]) at = a;
        if (c[2] === 'id' && at >= 0) idIndex(r.attrs[at][1], node, false);
        if (c[3] === null) { if (at >= 0) r.attrs.splice(at, 1); }
        else if (at >= 0) r.attrs[at][1] = String(c[3]);
        else r.attrs.push([c[2], String(c[3])]);
        if (c[2] === 'id' && c[3] !== null) idIndex(String(c[3]), node, true);
        attrVersion++;
      }
    }
  }

  var EVENT_KINDS = dict({
    keydown: KeyboardEvent, keyup: KeyboardEvent, keypress: KeyboardEvent,
    click: MouseEvent, dblclick: MouseEvent, mousedown: MouseEvent, mouseup: MouseEvent, mousemove: MouseEvent,
    mouseover: MouseEvent, mouseout: MouseEvent, mouseenter: MouseEvent, mouseleave: MouseEvent, contextmenu: MouseEvent,
    input: InputEvent, focus: FocusEvent, blur: FocusEvent, focusin: FocusEvent, focusout: FocusEvent, submit: SubmitEvent,
    pointerdown: PointerEvent, pointerup: PointerEvent, pointermove: PointerEvent, pointerover: PointerEvent, pointerout: PointerEvent,
    pointerenter: PointerEvent, pointerleave: PointerEvent, pointercancel: PointerEvent,
    dragstart: DragEvent, drag: DragEvent, dragend: DragEvent, dragenter: DragEvent, dragover: DragEvent, dragleave: DragEvent, drop: DragEvent,
  });
  var OWN_EVENT_FIELDS = set('type target currentTarget bubbles cancelable defaultPrevented eventPhase isTrusted timeStamp srcElement cancelBubble returnValue');
  var NOT_BUBBLING = set('focus blur mouseenter mouseleave load error scroll toggle invalid');

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
    // The person's click on a box: the page ticked it before the click was
    // heard, so the box is ticked here too, and unticked if the code cancels it.
    var undo = type === 'click' && !(path && path.length) ? preActivate(target, true) : null;
    dispatch(target, e);
    if (undo && e.defaultPrevented) undoActivation(undo, true);
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
    SVGElement: SVGElement,
    viewport: function () { return viewport; },
  };
  return api;
})(typeof window !== 'undefined' ? window : null);

function __softnDocInit(seed) { __softnShell.init(seed); }
function __softnDocTake(failed) { return __softnShell.take(failed); }
function __softnDocSync(changes) { __softnShell.sync(changes); }
function __softnDocEvent(id, type, props, path) { return __softnShell.event(id, type, props, path); }
function __softnDocReady() { __softnShell.ready(); }
`.replace('@ENTITIES@', entityTable());

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
