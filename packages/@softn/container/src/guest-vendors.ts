/**
 * On-Demand Hosted Vendor Modules for SoftN Web App Containers.
 *
 * Unlike core Web APIs, none of these vendor libraries are evaluated inside the
 * ZIPP VM unless a container's module graph actually imports them (`import ... from 'preact'`,
 * `'preact/hooks'`, `'preact/jsx-runtime'`, `'htm'`, `'marked'`, or `'three'`).
 * Plain JavaScript, TypeScript, and bundled Vite apps (React, Vue, Svelte, Solid, Lit)
 * pay 0 bytes of VM parse/evaluation overhead for unused vendor shims.
 */

const VENDOR_MARKED = String.raw`
var inlineCodeRe = new RegExp('\\x60([^\\x60]+)\\x60', 'g');
// Quotes too, as marked escapes them: a link's address is written into an attribute, and a
// quote in it ended the attribute ([x](https://site/"onclick="...) wrote a handler of its own).
function escapeMd(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function inlineMd(s) {
  return escapeMd(s)
    .replace(inlineCodeRe, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
}
export function parse(md) {
  var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  var out = [];
  var inList = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inlineMd(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    var hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      var lvl = hm[1].length;
      out.push('<h' + lvl + '>' + inlineMd(hm[2]) + '</h' + lvl + '>');
    } else if (line.trim() !== '') {
      out.push('<p>' + inlineMd(line) + '</p>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}
export const marked = { parse };
export default marked;
`;

const VENDOR_PREACT = String.raw`
var g = globalThis;
var doc = g.document;
var currentComponent = null;

export function h(type, props) {
  var children = [];
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (Array.isArray(c)) {
      for (var j = 0; j < c.length; j++) children.push(c[j]);
    } else {
      children.push(c);
    }
  }
  return { type: type, props: Object.assign({}, props || {}, { children: children }) };
}

export const createElement = h;

export function Fragment(props) {
  return props && props.children !== undefined ? props.children : null;
}

function mountVNode(vnode) {
  if (vnode === null || vnode === undefined || typeof vnode === 'boolean') {
    return doc.createComment('');
  }
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    return doc.createTextNode(String(vnode));
  }
  if (Array.isArray(vnode)) {
    var frag = doc.createDocumentFragment();
    for (var i = 0; i < vnode.length; i++) frag.appendChild(mountVNode(vnode[i]));
    return frag;
  }
  if (typeof vnode.type === 'function') {
    var inst = { hooks: [], hookIdx: 0, vnode: vnode, container: null, dom: null, rerender: null };
    var wrapper = doc.createElement('div');
    wrapper.style.display = 'contents';
    inst.rerender = function () {
      inst.hookIdx = 0;
      var prev = currentComponent;
      currentComponent = inst;
      var rendered;
      try { rendered = vnode.type(vnode.props); } finally { currentComponent = prev; }
      while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
      wrapper.appendChild(mountVNode(rendered));
    };
    inst.rerender();
    return wrapper;
  }
  var el = doc.createElement(String(vnode.type));
  var p = vnode.props || {};
  for (var k in p) {
    if (k === 'children' || k === 'key') continue;
    var val = p[k];
    if (k === 'className' || k === 'class') {
      if (val) el.setAttribute('class', String(val));
    } else if (k === 'style' && val && typeof val === 'object') {
      for (var sk in val) el.style[sk] = val[sk];
    } else if (k.toLowerCase().indexOf('on') === 0 && typeof val === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), val);
    } else if (k === 'value') {
      el.value = val == null ? '' : String(val);
    } else if (k === 'checked') {
      el.checked = !!val;
    } else if (val !== false && val != null) {
      el.setAttribute(k, val === true ? '' : String(val));
    }
  }
  var kids = Array.isArray(p.children) ? p.children : p.children !== undefined ? [p.children] : [];
  for (var ci = 0; ci < kids.length; ci++) el.appendChild(mountVNode(kids[ci]));
  return el;
}

export function render(vnode, container) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(mountVNode(vnode));
}

g.__softnPreactCurrent = function () { return currentComponent; };
export default { h, createElement: h, Fragment, render };
`;

const VENDOR_PREACT_HOOKS = String.raw`
import 'preact';
var g = globalThis;

function getInst() {
  var inst = g.__softnPreactCurrent && g.__softnPreactCurrent();
  if (!inst) throw new Error('Hooks can only be called inside a component');
  return inst;
}

export function useState(initial) {
  var inst = getInst();
  var idx = inst.hookIdx++;
  if (inst.hooks.length <= idx) {
    inst.hooks.push(typeof initial === 'function' ? initial() : initial);
  }
  var setState = function (next) {
    var cur = inst.hooks[idx];
    var resolved = typeof next === 'function' ? next(cur) : next;
    if (!Object.is(cur, resolved)) {
      inst.hooks[idx] = resolved;
      inst.rerender();
    }
  };
  return [inst.hooks[idx], setState];
}

export function useRef(initial) {
  var inst = getInst();
  var idx = inst.hookIdx++;
  if (inst.hooks.length <= idx) inst.hooks.push({ current: initial });
  return inst.hooks[idx];
}

export function useEffect(fn, deps) {
  var inst = getInst();
  var idx = inst.hookIdx++;
  var prev = inst.hooks[idx];
  var changed = !prev || !deps || deps.some(function (d, i) { return !Object.is(d, prev.deps[i]); });
  if (changed) {
    inst.hooks[idx] = { deps: deps, cleanup: null };
    Promise.resolve().then(function () {
      if (prev && typeof prev.cleanup === 'function') prev.cleanup();
      var c = fn();
      if (typeof c === 'function') inst.hooks[idx].cleanup = c;
    });
  }
}

export function useMemo(fn, deps) {
  var inst = getInst();
  var idx = inst.hookIdx++;
  var prev = inst.hooks[idx];
  if (!prev || !deps || deps.some(function (d, i) { return !Object.is(d, prev.deps[i]); })) {
    var val = fn();
    inst.hooks[idx] = { deps: deps, val: val };
    return val;
  }
  return prev.val;
}

export function useCallback(fn, deps) {
  return useMemo(function () { return fn; }, deps);
}
`;

const VENDOR_PREACT_JSX_RUNTIME = String.raw`
import { h, Fragment } from 'preact';
export function jsx(type, props, key) {
  var p = Object.assign({}, props || {});
  if (key !== undefined) p.key = key;
  var children = p.children;
  delete p.children;
  if (children === undefined) return h(type, p);
  return Array.isArray(children) ? h.apply(null, [type, p].concat(children)) : h(type, p, children);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export { Fragment };
`;

const VENDOR_HTM = String.raw`
var doc = globalThis.document;

function buildHtm(h, strings, values) {
  var marker = 'htm-slot-';
  var raw = '';
  var map = Object.create(null);
  for (var i = 0; i < strings.length; i++) {
    raw += strings[i];
    if (i < values.length) {
      var key = marker + i + '-end';
      map[key] = values[i];
      raw += key;
    }
  }
  raw = raw.replace(/<(htm-slot-\d+-end)([^>]*?)\/>/g, '<$1$2></$1>');
  var tpl = doc.createElement('template');
  tpl.innerHTML = raw.trim();
  function toVNode(node) {
    if (node.nodeType === 3) {
      var txt = node.nodeValue || '';
      var parts = txt.split(/(htm-slot-\d+-end)/g);
      var res = [];
      for (var p = 0; p < parts.length; p++) {
        if (!parts[p]) continue;
        if (parts[p] in map) res.push(map[parts[p]]);
        else res.push(parts[p]);
      }
      return res.length === 1 ? res[0] : res;
    }
    if (node.nodeType !== 1) return null;
    var props = {};
    var attrs = node.attributes;
    for (var a = 0; a < attrs.length; a++) {
      var aname = attrs[a].name;
      var aval = attrs[a].value;
      props[aname] = aval in map ? map[aval] : aval;
    }
    var children = [];
    var childNodes = node.childNodes;
    for (var c = 0; c < childNodes.length; c++) {
      var cv = toVNode(childNodes[c]);
      if (Array.isArray(cv)) children.push.apply(children, cv);
      else if (cv !== null) children.push(cv);
    }
    var tag = node.tagName.toLowerCase();
    return h.apply(null, [tag in map ? map[tag] : tag, props].concat(children));
  }
  var top = tpl.content.childNodes;
  if (top.length === 1) return toVNode(top[0]);
  var arr = [];
  for (var t = 0; t < top.length; t++) {
    var v = toVNode(top[t]);
    if (v !== null) arr.push(v);
  }
  return arr;
}

export const htm = {
  bind: function (h) {
    return function (strings) {
      var vals = Array.prototype.slice.call(arguments, 1);
      return buildHtm(h, strings, vals);
    };
  },
};
export default htm;
`;

const VENDOR_THREE = String.raw`
var g = globalThis;
var doc = g.document;
var nextObjId = 2; // 1 reserved for Scene

export function Vector3(x, y, z, onChange) {
  this._x = x || 0; this._y = y || 0; this._z = z || 0; this._cb = onChange;
}
['x', 'y', 'z'].forEach(function (k) {
  var p = '_' + k;
  Object.defineProperty(Vector3.prototype, k, {
    get: function () { return this[p]; },
    set: function (v) { this[p] = Number(v) || 0; if (this._cb) this._cb(); },
  });
});
Vector3.prototype.set = function (x, y, z) {
  this._x = Number(x) || 0; this._y = Number(y) || 0; this._z = Number(z) || 0;
  if (this._cb) this._cb();
  return this;
};
Vector3.prototype.toArray = function () { return [this._x, this._y, this._z]; };

export function Color(c) { this.value = c !== undefined ? c : 0xffffff; }
Color.prototype.set = function (c) { this.value = c; return this; };

export function Object3D(id) {
  var self = this;
  this._id = id || nextObjId++;
  this._dirty = true;
  this.children = [];
  var mark = function () { self._dirty = true; };
  this.position = new Vector3(0, 0, 0, mark);
  this.rotation = new Vector3(0, 0, 0, mark);
  this.scale = new Vector3(1, 1, 1, mark);
}
Object3D.prototype.add = function () {
  for (var i = 0; i < arguments.length; i++) {
    var child = arguments[i];
    if (child && child._id) {
      this.children.push(child);
      this._pendingAdds = this._pendingAdds || [];
      this._pendingAdds.push(['add', this._id, child._id]);
    }
  }
  return this;
};
Object3D.prototype.remove = function (child) {
  if (!child || !child._id) return this;
  this.children = this.children.filter(function (c) { return c !== child; });
  this._pendingAdds = this._pendingAdds || [];
  this._pendingAdds.push(['remove', this._id, child._id]);
  return this;
};
Object3D.prototype.lookAt = function (x, y, z) {
  if (x && typeof x === 'object') {
    this._lookAt = [Number(x.x) || 0, Number(x.y) || 0, Number(x.z) || 0];
  } else {
    this._lookAt = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
  }
  this._dirty = true;
  return this;
};

export function Scene() { Object3D.call(this, 1); this._kind = 'scene'; }
Scene.prototype = Object.create(Object3D.prototype);
export function Group() { Object3D.call(this); this._kind = 'group'; }
Group.prototype = Object.create(Object3D.prototype);

export function PerspectiveCamera(fov, aspect, near, far) {
  Object3D.call(this);
  this._kind = 'camera';
  this._camType = 'perspective';
  this.fov = fov || 60; this.aspect = aspect || 1; this.near = near || 0.1; this.far = far || 1000;
}
PerspectiveCamera.prototype = Object.create(Object3D.prototype);
PerspectiveCamera.prototype.updateProjectionMatrix = function () { this._dirty = true; };

export function BoxGeometry(w, h, d) { this._geo = ['box', w || 1, h || 1, d || 1]; }
export function SphereGeometry(r, ws, hs) { this._geo = ['sphere', r || 1, ws || 24, hs || 16]; }
export function PlaneGeometry(w, h, ws, hs) { this._geo = ['plane', w || 1, h || 1, ws || 1, hs || 1]; }
export function CylinderGeometry(rt, rb, h, rs) { this._geo = ['cylinder', rt || 1, rb || 1, h || 1, rs || 24]; }
export function TorusGeometry(r, t, rs, ts) { this._geo = ['torus', r || 1, t || 0.4, rs || 16, ts || 32]; }

export function MeshStandardMaterial(opts) { this._mat = Object.assign({ kind: 'standard' }, opts || {}); }
export function MeshBasicMaterial(opts) { this._mat = Object.assign({ kind: 'basic' }, opts || {}); }

export function Mesh(geo, mat) {
  Object3D.call(this);
  this._kind = 'mesh';
  this.geometry = geo || new BoxGeometry(1, 1, 1);
  this.material = mat || new MeshStandardMaterial({});
}
Mesh.prototype = Object.create(Object3D.prototype);

export function AmbientLight(color, intensity) {
  Object3D.call(this);
  this._kind = 'light'; this._lightKind = 'ambient'; this.color = color; this.intensity = intensity;
}
AmbientLight.prototype = Object.create(Object3D.prototype);
export function DirectionalLight(color, intensity) {
  Object3D.call(this);
  this._kind = 'light'; this._lightKind = 'directional'; this.color = color; this.intensity = intensity;
}
DirectionalLight.prototype = Object.create(Object3D.prototype);
export function PointLight(color, intensity) {
  Object3D.call(this);
  this._kind = 'light'; this._lightKind = 'point'; this.color = color; this.intensity = intensity;
}
PointLight.prototype = Object.create(Object3D.prototype);

export function WebGLRenderer(opts) {
  opts = opts || {};
  this.domElement = opts.canvas || doc.createElement('canvas');
  this._ops = [['init', { antialias: opts.antialias !== false, alpha: !!opts.alpha }]];
  this._created = Object.create(null);
}
WebGLRenderer.prototype.setSize = function (w, h) {
  this.domElement.width = w;
  this.domElement.height = h;
  this._ops.push(['resize', w, h, 1]);
};
WebGLRenderer.prototype.setPixelRatio = function (dpr) {
  this._dpr = dpr;
};
WebGLRenderer.prototype.setClearColor = function (color, alpha) {
  this._ops.push(['clearColor', color instanceof Color ? color.value : color, alpha !== undefined ? alpha : 1]);
};
WebGLRenderer.prototype._syncTree = function (obj) {
  if (!this._created[obj._id]) {
    this._created[obj._id] = true;
    if (obj._kind === 'scene' || obj._kind === 'group') this._ops.push(['group', obj._id]);
    else if (obj._kind === 'camera') this._ops.push(['camera', obj._id, obj._camType, [obj.fov, obj.aspect, obj.near, obj.far]]);
    else if (obj._kind === 'mesh') this._ops.push(['mesh', obj._id, { geo: obj.geometry._geo, mat: obj.material._mat }]);
    else if (obj._kind === 'light') this._ops.push(['light', obj._id, obj._lightKind, { color: obj.color, intensity: obj.intensity, pos: obj.position.toArray() }]);
    else if (obj._kind === 'gltf') this._ops.push(['gltf', obj._id, obj._src]);
  }
  for (var i = 0; i < obj.children.length; i++) this._syncTree(obj.children[i]);
  if (obj._pendingAdds && obj._pendingAdds.length) {
    for (var a = 0; a < obj._pendingAdds.length; a++) this._ops.push(obj._pendingAdds[a]);
    obj._pendingAdds.length = 0;
  }
  if (obj._dirty) {
    obj._dirty = false;
    this._ops.push(['xform', obj._id, obj.position.toArray(), obj.rotation.toArray(), obj.scale.toArray()]);
    if (obj._lookAt) {
      this._ops.push(['lookAt', obj._id, obj._lookAt]);
    }
  }
};
WebGLRenderer.prototype.render = function (scene, camera) {
  this._syncTree(scene);
  this._syncTree(camera);
  this._ops.push(['render', scene._id, camera._id]);
  var cid = this.domElement && this.domElement.__softnNode;
  if (cid && typeof g.__softnPushExtraOp === 'function') {
    g.__softnPushExtraOp(['3d', cid, this._ops.splice(0, this._ops.length)]);
  }
};

export function loadGLTF(path) {
  var grp = new Object3D();
  grp._kind = 'gltf';
  grp._src = String(path);
  return grp;
}

const api = {
  Scene, Group, Object3D, PerspectiveCamera,
  BoxGeometry, SphereGeometry, PlaneGeometry, CylinderGeometry, TorusGeometry,
  MeshStandardMaterial, MeshBasicMaterial, Mesh,
  AmbientLight, DirectionalLight, PointLight,
  WebGLRenderer, Vector3, Color, loadGLTF,
};
export default api;
`;

export const BUILTIN_VENDOR_MODULES: Readonly<Record<string, string>> = {
  marked: VENDOR_MARKED,
  preact: VENDOR_PREACT,
  'preact/hooks': VENDOR_PREACT_HOOKS,
  'preact/jsx-runtime': VENDOR_PREACT_JSX_RUNTIME,
  'preact/jsx-dev-runtime': VENDOR_PREACT_JSX_RUNTIME,
  htm: VENDOR_HTM,
  three: VENDOR_THREE,
};
