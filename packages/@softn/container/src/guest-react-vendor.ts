/**
 * On-Demand Guest React 18 Compat Runtime injected inside the ZIPP Sandbox.
 *
 * Dynamically loaded and evaluated ONLY when an app uses JSX/TSX or imports
 * `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, or `react/jsx-dev-runtime`.
 * Plain JS, Vue, Svelte, Preact, and pre-bundled Vite apps pay 0 bytes of Worker
 * download and 0 bytes of ZIPP VM startup parsing for this runtime.
 */

export const GUEST_REACT_VENDOR_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var doc = g.document;
  var __softnModules = g.__softnModules;
  if (!__softnModules || typeof __softnModules.define !== 'function') return;
    // 'softn-vendor:react', 'softn-vendor:react-dom', 'softn-vendor:react-dom/client',
    // 'softn-vendor:react/jsx-runtime', 'softn-vendor:react/jsx-dev-runtime'
    // Full-featured hosted React 18 reconciling VDOM runtime on Guest DOM so uncompiled
    // React .tsx / .jsx source apps run directly with zero Vite/Webpack build step!
    (function () {
      var SVG_NS = 'http://www.w3.org/2000/svg';
      var UNITLESS_CSS = {
        animationIterationCount: 1, aspectRatio: 1, borderImageOutset: 1, borderImageSlice: 1,
        borderImageWidth: 1, boxFlex: 1, boxFlexGroup: 1, boxOrdinalGroup: 1, columnCount: 1,
        columns: 1, flex: 1, flexGrow: 1, flexPositive: 1, flexShrink: 1, flexNegative: 1,
        flexOrder: 1, gridArea: 1, gridRow: 1, gridRowEnd: 1, gridRowSpan: 1, gridRowStart: 1,
        gridColumn: 1, gridColumnEnd: 1, gridColumnSpan: 1, gridColumnStart: 1, fontWeight: 1,
        lineClamp: 1, lineHeight: 1, opacity: 1, order: 1, orphans: 1, scale: 1, tabSize: 1,
        widows: 1, zIndex: 1, zoom: 1, fillOpacity: 1, floodOpacity: 1, stopOpacity: 1,
        strokeDasharray: 1, strokeDashoffset: 1, strokeMiterlimit: 1, strokeOpacity: 1, strokeWidth: 1
      };
      var Fragment = function Fragment(props) { return props ? props.children : null; };
      Fragment.$$softnKind = 'fragment';
      var StrictMode = function StrictMode(props) { return props ? props.children : null; };
      StrictMode.$$softnKind = 'fragment';
      var Suspense = function Suspense(props) { return props ? props.children : null; };
      Suspense.$$softnKind = 'fragment';
      var PortalType = { $$softnKind: 'portal' };

      // What a component says a prop is when it is not given (its defaultProps), filled in as
      // React 18 fills it in: a component that relied on one was given undefined.
      function withDefaults(type, props) {
        var defaults = type && (typeof type === 'function' || typeof type === 'object')
          ? type.defaultProps || (type.$$softnKind === 'memo' && type.type ? type.type.defaultProps : null)
          : null;
        if (!defaults || typeof defaults !== 'object') return props;
        for (var name in defaults) if (props[name] === undefined) props[name] = defaults[name];
        return props;
      }

      function createElement(type, rawProps) {
        var props = {};
        var key = null;
        var ref = null;
        if (rawProps && typeof rawProps === 'object') {
          for (var k in rawProps) {
            if (!Object.prototype.hasOwnProperty.call(rawProps, k)) continue;
            if (k === 'key') key = rawProps[k] == null ? null : String(rawProps[k]);
            else if (k === 'ref') ref = rawProps[k];
            else props[k] = rawProps[k];
          }
        }
        var argLen = arguments.length - 2;
        if (argLen === 1) {
          props.children = arguments[2];
        } else if (argLen > 1) {
          var arr = new Array(argLen);
          for (var i = 0; i < argLen; i++) arr[i] = arguments[i + 2];
          props.children = arr;
        }
        return { $$typeof: 'softn.react.element', type: type, key: key, ref: ref, props: withDefaults(type, props) };
      }

      function jsxFactory(type, rawProps, maybeKey) {
        var props = {};
        var key = maybeKey !== undefined && maybeKey !== null ? String(maybeKey) : null;
        var ref = null;
        if (rawProps && typeof rawProps === 'object') {
          for (var k in rawProps) {
            if (!Object.prototype.hasOwnProperty.call(rawProps, k)) continue;
            if (k === 'key' && key === null) key = rawProps[k] == null ? null : String(rawProps[k]);
            else if (k === 'ref') ref = rawProps[k];
            else props[k] = rawProps[k];
          }
        }
        return { $$typeof: 'softn.react.element', type: type, key: key, ref: ref, props: withDefaults(type, props) };
      }

      function isValidElement(obj) {
        return !!(obj && typeof obj === 'object' && obj.$$typeof === 'softn.react.element');
      }

      function cloneElement(el, rawProps) {
        if (!isValidElement(el)) return el;
        var merged = Object.assign({}, el.props, rawProps || {});
        var key = rawProps && rawProps.key !== undefined ? String(rawProps.key) : el.key;
        var ref = rawProps && rawProps.ref !== undefined ? rawProps.ref : el.ref;
        delete merged.key;
        delete merged.ref;
        var argLen = arguments.length - 2;
        if (argLen === 1) merged.children = arguments[2];
        else if (argLen > 1) {
          var arr = new Array(argLen);
          for (var i = 0; i < argLen; i++) arr[i] = arguments[i + 2];
          merged.children = arr;
        }
        return { $$typeof: 'softn.react.element', type: el.type, key: key, ref: ref, props: merged };
      }

      function flattenChildren(input, out) {
        if (!out) out = [];
        if (input === null || input === undefined || typeof input === 'boolean') return out;
        if (Array.isArray(input)) {
          for (var i = 0; i < input.length; i++) flattenChildren(input[i], out);
        } else {
          out.push(input);
        }
        return out;
      }

      function setRef(ref, value) {
        if (!ref) return;
        if (typeof ref === 'function') {
          try { ref(value); } catch (_) {}
        } else if (typeof ref === 'object') {
          ref.current = value;
        }
      }

      function shallowEqual(a, b) {
        if (Object.is(a, b)) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
        var ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !Object.is(a[ka[i]], b[ka[i]])) return false;
        }
        return true;
      }

      var currentComp = null;
      var idSeq = 0;
      var ctxSeq = 0;
      var dirtyQueue = [];
      var flushScheduled = false;
      var pendingEffects = [];
      var effectsScheduled = false;

      function flushEffects() {
        effectsScheduled = false;
        var list = pendingEffects.splice(0);
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          // The cleanup of the effect this one takes the place of, read now: one that ran since
          // this was asked for (rendered twice before effects ran) has one by now. Read when it
          // was asked for, that one was never cleaned up.
          var replaced = item.prev;
          var cleanup = replaced ? replaced.cleanup : null;
          if (replaced) replaced.cleanup = null;
          if (item.inst.unmounted) {
            // Unmounted before it ran: what it replaced is cleaned up all the same (unmounting
            // cleaned up this one, which had nothing to clean up yet).
            if (typeof cleanup === 'function') {
              try { cleanup(); } catch (err) { g.console && g.console.error && g.console.error(err); }
            }
            continue;
          }
          try {
            if (typeof cleanup === 'function') cleanup();
            var c = item.fn();
            if (typeof c === 'function') item.slot.cleanup = c;
          } catch (err) {
            g.console && g.console.error && g.console.error(err);
          }
        }
      }

      function scheduleEffects() {
        if (effectsScheduled) return;
        effectsScheduled = true;
        Promise.resolve().then(flushEffects);
      }

      function flushDirty() {
        flushScheduled = false;
        var guard = 0;
        while (dirtyQueue.length > 0 && guard++ < 64) {
          var batch = dirtyQueue.splice(0);
          for (var i = 0; i < batch.length; i++) {
            var inst = batch[i];
            if (!inst.unmounted && inst.dirty) {
              inst.dirty = false;
              // One that throws is said, and the others go on: it threw out of the whole batch,
              // into a promise nobody heard, and every other update in it was left undone.
              try {
                rerenderInst(inst);
              } catch (err) {
                g.console && g.console.error && g.console.error(err);
              }
            }
          }
        }
        if (pendingEffects.length > 0) scheduleEffects();
      }

      function scheduleInst(inst) {
        if (inst.unmounted) return;
        inst.dirty = true;
        if (dirtyQueue.indexOf(inst) < 0) dirtyQueue.push(inst);
        if (!flushScheduled) {
          flushScheduled = true;
          Promise.resolve().then(flushDirty);
        }
      }

      function getNodes(rec) {
        if (!rec) return [];
        if (rec.dom) return [rec.dom];
        if (rec.kind === 'portal') return [];
        if (rec.childRec) return getNodes(rec.childRec);
        if (rec.children && rec.children.length > 0) {
          var out = [];
          for (var i = 0; i < rec.children.length; i++) {
            var sub = getNodes(rec.children[i]);
            for (var j = 0; j < sub.length; j++) out.push(sub[j]);
          }
          if (out.length > 0) return out;
        }
        return rec.anchor ? [rec.anchor] : [];
      }

      function firstDom(rec) {
        var ns = getNodes(rec);
        return ns.length > 0 ? ns[0] : null;
      }

      function nextSiblingAfter(rec) {
        var ns = getNodes(rec);
        if (ns.length === 0) return null;
        var last = ns[ns.length - 1];
        return last ? last.nextSibling : null;
      }

      // Where what is made in the place of another kind of node goes: after the last of the old
      // one's nodes, which are taken away first. (Put before the first of them, it was put before
      // a node no longer on the page, which threw: {on ? <A /> : 'text'} left the rest of the
      // render undone, and the page as it was.)
      function placeOf(parentDom, prevRec, beforeNode) {
        var after = prevRec ? nextSiblingAfter(prevRec) : null;
        return after && after.parentNode === parentDom ? after : beforeNode;
      }

      function mapEventName(propKey, tagName) {
        var raw = propKey.slice(2).toLowerCase();
        if (raw === 'doubleclick') return ['dblclick'];
        if (raw === 'change') {
          // A field's onChange is React's: called as what it holds changes, which its input event
          // says, for a box or a choice as for text. (Heard on change too, it was called twice for
          // each: a box toggled with setOn(v => !v) was toggled back.)
          var tl = String(tagName || '').toLowerCase();
          if (tl === 'input' || tl === 'textarea') return ['input'];
          return ['change'];
        }
        if (raw === 'focus') return ['focus'];
        if (raw === 'blur') return ['blur'];
        return [raw];
      }

      function applyStyle(el, prevStyle, nextStyle) {
        if (typeof nextStyle === 'string') {
          el.setAttribute('style', nextStyle);
          return;
        }
        if (prevStyle && typeof prevStyle === 'object') {
          for (var pk in prevStyle) {
            if (!nextStyle || !(pk in nextStyle)) {
              if (pk.indexOf('--') === 0 && el.style.removeProperty) el.style.removeProperty(pk);
              else el.style[pk] = '';
            }
          }
        }
        if (nextStyle && typeof nextStyle === 'object') {
          for (var sk in nextStyle) {
            var sv = nextStyle[sk];
            if (sv == null || sv === false) {
              if (sk.indexOf('--') === 0 && el.style.removeProperty) el.style.removeProperty(sk);
              else el.style[sk] = '';
            } else {
              var cssVal = (typeof sv === 'number' && sv !== 0 && !UNITLESS_CSS[sk] && sk.indexOf('--') !== 0)
                ? (sv + 'px')
                : String(sv);
              if (sk.indexOf('--') === 0 && el.style.setProperty) el.style.setProperty(sk, cssVal);
              else el.style[sk] = cssVal;
            }
          }
        }
      }

      function patchProps(el, prevProps, nextProps, listeners, isSvg, tagName) {
        prevProps = prevProps || {};
        nextProps = nextProps || {};
        // Remove old props/listeners
        for (var pk in prevProps) {
          if (pk === 'children' || pk === 'key' || pk === 'ref') continue;
          if (!(pk in nextProps)) {
            if (pk.length > 2 && pk.charCodeAt(0) === 111 && pk.charCodeAt(1) === 110 && pk.charCodeAt(2) >= 65 && pk.charCodeAt(2) <= 90) {
              var oldEvs = listeners[pk];
              if (oldEvs) {
                for (var oi = 0; oi < oldEvs.length; oi++) el.removeEventListener(oldEvs[oi][0], oldEvs[oi][1]);
                delete listeners[pk];
              }
            } else if (pk === 'className' || pk === 'class') {
              el.removeAttribute('class');
            } else if (pk === 'htmlFor') {
              el.removeAttribute('for');
            } else if (pk === 'style') {
              applyStyle(el, prevProps.style, null);
            } else if (pk === 'dangerouslySetInnerHTML') {
              el.innerHTML = '';
            } else if (pk === 'value') {
              el.value = '';
            } else if (pk === 'checked') {
              el.checked = false;
            } else if (pk === 'disabled' || pk === 'readOnly' || pk === 'multiple' || pk === 'selected' || pk === 'hidden') {
              el[pk === 'readOnly' ? 'readOnly' : pk] = false;
              el.removeAttribute(pk.toLowerCase());
            } else {
              el.removeAttribute(pk);
            }
          }
        }
        // Apply new/changed props
        for (var k in nextProps) {
          if (k === 'children' || k === 'key' || k === 'ref') continue;
          var val = nextProps[k];
          var prevVal = prevProps[k];
          if (k === 'style') {
            applyStyle(el, prevVal, val);
            continue;
          }
          if (Object.is(val, prevVal) && k !== 'value' && k !== 'checked') continue;
          if (k.length > 2 && k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110 && k.charCodeAt(2) >= 65 && k.charCodeAt(2) <= 90) {
            var prevEvs = listeners[k];
            if (prevEvs) {
              for (var pi = 0; pi < prevEvs.length; pi++) el.removeEventListener(prevEvs[pi][0], prevEvs[pi][1]);
              delete listeners[k];
            }
            if (typeof val === 'function') {
              var evNames = mapEventName(k, tagName);
              var attached = [];
              for (var ei = 0; ei < evNames.length; ei++) {
                el.addEventListener(evNames[ei], val);
                attached.push([evNames[ei], val]);
              }
              listeners[k] = attached;
            }
          } else if (k === 'className' || k === 'class') {
            if (val == null || val === false || val === '') el.removeAttribute('class');
            else el.setAttribute('class', String(val));
          } else if (k === 'htmlFor') {
            if (val == null || val === false) el.removeAttribute('for');
            else el.setAttribute('for', String(val));
          } else if (k === 'dangerouslySetInnerHTML') {
            el.innerHTML = val && val.__html != null ? String(val.__html) : '';
          } else if (k === 'value') {
            var strVal = val == null ? '' : String(val);
            if (el.value !== strVal) el.value = strVal;
          } else if (k === 'defaultValue') {
            if (prevVal === undefined && el.value === '') el.value = val == null ? '' : String(val);
          } else if (k === 'checked') {
            el.checked = !!val;
          } else if (k === 'defaultChecked') {
            if (prevVal === undefined) el.checked = !!val;
          } else if (k === 'disabled' || k === 'readOnly' || k === 'multiple' || k === 'selected' || k === 'hidden') {
            el[k] = !!val;
            if (val) el.setAttribute(k.toLowerCase(), '');
            else el.removeAttribute(k.toLowerCase());
          } else if (k === 'autoFocus') {
            if (val && typeof el.focus === 'function') el.focus();
          } else if (val === false || val === null || val === undefined) {
            el.removeAttribute(k);
          } else {
            var attrName = isSvg && k === 'viewBox' ? 'viewBox' : k;
            el.setAttribute(attrName, val === true ? '' : String(val));
          }
        }
      }

      function insertNodesBefore(parentDom, nodes, beforeNode) {
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.parentNode !== parentDom || n.nextSibling !== beforeNode) {
            parentDom.insertBefore(n, beforeNode || null);
          }
        }
      }

      function unmountRec(rec) {
        if (!rec) return;
        if (rec.inst) {
          rec.inst.unmounted = true;
          var hooks = rec.inst.hooks;
          for (var hi = 0; hi < hooks.length; hi++) {
            var h = hooks[hi];
            if (h && h.$$effect && typeof h.cleanup === 'function') {
              try { h.cleanup(); } catch (_) {}
            }
          }
          if (rec.inst.classInst && typeof rec.inst.classInst.componentWillUnmount === 'function') {
            try { rec.inst.classInst.componentWillUnmount(); } catch (_) {}
          }
        }
        if (rec.childRec) unmountRec(rec.childRec);
        if (rec.children) {
          for (var ci = 0; ci < rec.children.length; ci++) unmountRec(rec.children[ci]);
        }
        if (rec.ref) setRef(rec.ref, null);
        if (rec.dom && rec.dom.parentNode) rec.dom.parentNode.removeChild(rec.dom);
        if (rec.anchor && rec.anchor.parentNode) rec.anchor.parentNode.removeChild(rec.anchor);
      }

      function renderComponent(inst, ctxMap) {
        inst.hookIdx = 0;
        inst.ctxMap = ctxMap;
        var type = inst.type;
        var props = inst.props;
        if (type && type.$$softnKind === 'memo') type = type.type;
        if (type && type.$$softnKind === 'forwardRef') {
          var prevF = currentComp;
          currentComp = inst;
          try { return type.render(props, inst.ref); } finally { currentComp = prevF; }
        }
        if (type && type.prototype && (type.prototype.isReactComponent || typeof type.prototype.render === 'function')) {
          if (!inst.classInst) {
            inst.classInst = new type(props);
            inst.classInst.props = props;
            inst.classInst.setState = function (partial, cb) {
              var next = typeof partial === 'function' ? partial(inst.classInst.state, inst.classInst.props) : partial;
              inst.classInst.state = Object.assign({}, inst.classInst.state || {}, next || {});
              scheduleInst(inst);
              if (typeof cb === 'function') Promise.resolve().then(cb);
            };
            inst.classInst.forceUpdate = function () { scheduleInst(inst); };
            if (typeof inst.classInst.componentDidMount === 'function') {
              Promise.resolve().then(function () { if (!inst.unmounted) inst.classInst.componentDidMount(); });
            }
          } else {
            inst.classInst.props = props;
          }
          return inst.classInst.render();
        }
        var prev = currentComp;
        currentComp = inst;
        try {
          return type(props);
        } finally {
          currentComp = prev;
        }
      }

      function rerenderInst(inst) {
        var rec = inst.rec;
        if (!rec || inst.unmounted) return;
        var beforeNode = nextSiblingAfter(rec);
        var rendered = renderComponent(inst, inst.ctxMap);
        rec.childRec = reconcile(rec.parentDom, rec.childRec, rendered, beforeNode, rec.isSvg, inst.ctxMap);
        ensureAnchorState(rec, beforeNode);
      }

      function ensureAnchorState(rec, beforeNode) {
        var childNodes = rec.childRec ? getNodes(rec.childRec) : [];
        if (rec.children) {
          childNodes = [];
          for (var i = 0; i < rec.children.length; i++) {
            var sub = getNodes(rec.children[i]);
            for (var j = 0; j < sub.length; j++) childNodes.push(sub[j]);
          }
        }
        if (childNodes.length === 0) {
          if (!rec.anchor) rec.anchor = doc.createComment('');
          if (rec.anchor.parentNode !== rec.parentDom) {
            rec.parentDom.insertBefore(rec.anchor, beforeNode || null);
          }
        } else if (rec.anchor && rec.anchor.parentNode) {
          rec.anchor.parentNode.removeChild(rec.anchor);
        }
      }

      function normalizeVNode(v) {
        if (v === null || v === undefined || typeof v === 'boolean') return { kind: 'empty' };
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return { kind: 'text', text: String(v) };
        if (Array.isArray(v)) return { kind: 'fragment', children: flattenChildren(v), key: null };
        if (isValidElement(v)) {
          if (v.type === PortalType) return { kind: 'portal', container: v.props.container, children: flattenChildren(v.props.children), key: v.key };
          if (v.type && v.type.$$softnKind === 'fragment') return { kind: 'fragment', children: flattenChildren(v.props.children), key: v.key };
          if (v.type && v.type.$$softnKind === 'provider') return { kind: 'provider', ctxId: v.type._ctxId, value: v.props.value, children: flattenChildren(v.props.children), key: v.key };
          if (typeof v.type === 'string') return { kind: 'host', type: v.type, props: v.props, ref: v.ref, key: v.key };
          if (typeof v.type === 'function' || (v.type && (v.type.$$softnKind === 'memo' || v.type.$$softnKind === 'forwardRef'))) {
            return { kind: 'comp', type: v.type, props: v.props, ref: v.ref, key: v.key };
          }
        }
        return { kind: 'text', text: String(v) };
      }

      function reconcileChildren(parentDom, prevList, nextRawChildren, beforeNode, isSvg, ctxMap) {
        var nextVNodes = [];
        for (var i = 0; i < nextRawChildren.length; i++) nextVNodes.push(normalizeVNode(nextRawChildren[i]));
        var oldByKey = Object.create(null);
        var oldUnkeyed = [];
        for (var oi = 0; oi < prevList.length; oi++) {
          var orec = prevList[oi];
          if (orec.key !== null && orec.key !== undefined) oldByKey[orec.key] = orec;
          else oldUnkeyed.push(orec);
        }
        var used = [];
        var nextRecs = new Array(nextVNodes.length);
        var unkeyedIdx = 0;
        // First pick matching previous records
        var matchedPrev = new Array(nextVNodes.length);
        for (var ni = 0; ni < nextVNodes.length; ni++) {
          var nv = nextVNodes[ni];
          var match = null;
          if (nv.key !== null && nv.key !== undefined) {
            if (oldByKey[nv.key]) {
              match = oldByKey[nv.key];
              delete oldByKey[nv.key];
            }
          } else if (unkeyedIdx < oldUnkeyed.length) {
            match = oldUnkeyed[unkeyedIdx++];
          }
          matchedPrev[ni] = match;
          if (match) used.push(match);
        }
        // Unmount unused old records before inserting/moving
        var usedSet = new Set(used);
        for (var ui = 0; ui < prevList.length; ui++) {
          if (!usedSet.has(prevList[ui])) unmountRec(prevList[ui]);
        }
        // Reconcile right-to-left so cursor is always the exact beforeNode!
        var cursor = beforeNode || null;
        for (var ri = nextVNodes.length - 1; ri >= 0; ri--) {
          var rec = reconcileNorm(parentDom, matchedPrev[ri], nextVNodes[ri], cursor, isSvg, ctxMap);
          nextRecs[ri] = rec;
          var nodes = getNodes(rec);
          if (nodes.length > 0) {
            insertNodesBefore(parentDom, nodes, cursor);
            cursor = nodes[0];
          }
        }
        return nextRecs;
      }

      function reconcile(parentDom, prevRec, rawVNode, beforeNode, isSvg, ctxMap) {
        return reconcileNorm(parentDom, prevRec, normalizeVNode(rawVNode), beforeNode, isSvg, ctxMap);
      }

      function reconcileNorm(parentDom, prevRec, nv, beforeNode, isSvg, ctxMap) {
        if (nv.kind === 'empty') {
          if (prevRec && prevRec.kind === 'empty') return prevRec;
          var b = placeOf(parentDom, prevRec, beforeNode);
          if (prevRec) unmountRec(prevRec);
          var c = doc.createComment('');
          parentDom.insertBefore(c, b || null);
          return { kind: 'empty', dom: c, key: null };
        }
        if (nv.kind === 'text') {
          if (prevRec && prevRec.kind === 'text') {
            if (prevRec.text !== nv.text) {
              prevRec.dom.nodeValue = nv.text;
              prevRec.text = nv.text;
            }
            return prevRec;
          }
          var bt = placeOf(parentDom, prevRec, beforeNode);
          if (prevRec) unmountRec(prevRec);
          var tn = doc.createTextNode(nv.text);
          parentDom.insertBefore(tn, bt || null);
          return { kind: 'text', dom: tn, text: nv.text, key: null };
        }
        if (nv.kind === 'portal') {
          if (prevRec && prevRec.kind === 'portal' && prevRec.container === nv.container) {
            prevRec.children = reconcileChildren(nv.container, prevRec.children, nv.children, null, false, ctxMap);
            return prevRec;
          }
          if (prevRec) unmountRec(prevRec);
          var prec = { kind: 'portal', container: nv.container, children: [], key: nv.key };
          if (nv.container) {
            prec.children = reconcileChildren(nv.container, [], nv.children, null, false, ctxMap);
          }
          return prec;
        }
        if (nv.kind === 'fragment') {
          if (prevRec && prevRec.kind === 'fragment') {
            var bf = nextSiblingAfter(prevRec) || beforeNode;
            prevRec.children = reconcileChildren(parentDom, prevRec.children, nv.children, bf, isSvg, ctxMap);
            ensureAnchorState(prevRec, bf);
            return prevRec;
          }
          var bfNew = placeOf(parentDom, prevRec, beforeNode);
          if (prevRec) unmountRec(prevRec);
          var frec = { kind: 'fragment', parentDom: parentDom, children: [], anchor: null, key: nv.key };
          frec.children = reconcileChildren(parentDom, [], nv.children, bfNew, isSvg, ctxMap);
          ensureAnchorState(frec, bfNew);
          return frec;
        }
        if (nv.kind === 'provider') {
          var nextCtx = Object.create(ctxMap || null);
          nextCtx[nv.ctxId] = nv.value;
          if (prevRec && prevRec.kind === 'provider' && prevRec.ctxId === nv.ctxId) {
            var bp = nextSiblingAfter(prevRec) || beforeNode;
            prevRec.children = reconcileChildren(parentDom, prevRec.children, nv.children, bp, isSvg, nextCtx);
            ensureAnchorState(prevRec, bp);
            return prevRec;
          }
          var bpNew = placeOf(parentDom, prevRec, beforeNode);
          if (prevRec) unmountRec(prevRec);
          var pvRec = { kind: 'provider', ctxId: nv.ctxId, parentDom: parentDom, children: [], anchor: null, key: nv.key };
          pvRec.children = reconcileChildren(parentDom, [], nv.children, bpNew, isSvg, nextCtx);
          ensureAnchorState(pvRec, bpNew);
          return pvRec;
        }
        if (nv.kind === 'host') {
          var childSvg = isSvg || nv.type === 'svg';
          if (nv.type === 'foreignObject') childSvg = false;
          if (prevRec && prevRec.kind === 'host' && prevRec.type === nv.type) {
            patchProps(prevRec.dom, prevRec.props, nv.props, prevRec.listeners, isSvg || nv.type === 'svg', nv.type);
            if (prevRec.ref !== nv.ref) {
              setRef(prevRec.ref, null);
              setRef(nv.ref, prevRec.dom);
              prevRec.ref = nv.ref;
            }
            prevRec.props = nv.props;
            if (!nv.props.dangerouslySetInnerHTML) {
              prevRec.children = reconcileChildren(prevRec.dom, prevRec.children, flattenChildren(nv.props.children), null, childSvg, ctxMap);
            } else {
              for (var di = 0; di < prevRec.children.length; di++) unmountRec(prevRec.children[di]);
              prevRec.children = [];
            }
            return prevRec;
          }
          var bh = placeOf(parentDom, prevRec, beforeNode);
          if (prevRec) unmountRec(prevRec);
          var el = (isSvg || nv.type === 'svg') && typeof doc.createElementNS === 'function'
            ? doc.createElementNS(SVG_NS, nv.type)
            : doc.createElement(nv.type);
          var listeners = Object.create(null);
          patchProps(el, null, nv.props, listeners, isSvg || nv.type === 'svg', nv.type);
          parentDom.insertBefore(el, bh || null);
          var hrec = { kind: 'host', type: nv.type, dom: el, props: nv.props, ref: nv.ref, listeners: listeners, children: [], key: nv.key };
          if (!nv.props.dangerouslySetInnerHTML) {
            hrec.children = reconcileChildren(el, [], flattenChildren(nv.props.children), null, childSvg, ctxMap);
          }
          if (nv.ref) setRef(nv.ref, el);
          return hrec;
        }
        // Component
        if (prevRec && prevRec.kind === 'comp' && prevRec.type === nv.type) {
          var inst = prevRec.inst;
          if (nv.type && nv.type.$$softnKind === 'memo') {
            var cmp = nv.type.compare || shallowEqual;
            if (cmp(inst.props, nv.props) && inst.ctxMap === ctxMap) return prevRec;
          }
          inst.props = nv.props;
          inst.ref = nv.ref;
          inst.dirty = false;
          var bc = nextSiblingAfter(prevRec) || beforeNode;
          var rendered = renderComponent(inst, ctxMap);
          prevRec.childRec = reconcile(parentDom, prevRec.childRec, rendered, bc, isSvg, ctxMap);
          ensureAnchorState(prevRec, bc);
          return prevRec;
        }
        var bcNew = placeOf(parentDom, prevRec, beforeNode);
        if (prevRec) unmountRec(prevRec);
        var newInst = { type: nv.type, props: nv.props, ref: nv.ref, hooks: [], hookIdx: 0, ctxMap: ctxMap, dirty: false, unmounted: false, rec: null, classInst: null };
        var crec = { kind: 'comp', type: nv.type, inst: newInst, parentDom: parentDom, isSvg: isSvg, childRec: null, anchor: null, key: nv.key };
        newInst.rec = crec;
        var out = renderComponent(newInst, ctxMap);
        crec.childRec = reconcile(parentDom, null, out, bcNew, isSvg, ctxMap);
        ensureAnchorState(crec, bcNew);
        return crec;
      }

      function reqInst() {
        if (!currentComp) throw new Error('Invalid hook call: hooks can only be called inside a function component');
        return currentComp;
      }
      function useState(initial) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) {
          inst.hooks.push({
            val: typeof initial === 'function' ? initial() : initial,
            setter: null
          });
        }
        var slot = inst.hooks[idx];
        if (!slot.setter) {
          slot.setter = function (next) {
            var resolved = typeof next === 'function' ? next(slot.val) : next;
            if (!Object.is(slot.val, resolved)) {
              slot.val = resolved;
              scheduleInst(inst);
            }
          };
        }
        return [slot.val, slot.setter];
      }
      function useReducer(reducer, initialArg, init) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) {
          inst.hooks.push({
            val: typeof init === 'function' ? init(initialArg) : initialArg,
            reducer: reducer,
            dispatch: null
          });
        }
        var slot = inst.hooks[idx];
        slot.reducer = reducer;
        if (!slot.dispatch) {
          slot.dispatch = function (action) {
            var next = slot.reducer(slot.val, action);
            if (!Object.is(slot.val, next)) {
              slot.val = next;
              scheduleInst(inst);
            }
          };
        }
        return [slot.val, slot.dispatch];
      }
      function useRef(initial) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) inst.hooks.push({ current: initial });
        return inst.hooks[idx];
      }
      function depsChanged(prevDeps, nextDeps) {
        if (!prevDeps || !nextDeps || prevDeps.length !== nextDeps.length) return true;
        for (var i = 0; i < nextDeps.length; i++) {
          if (!Object.is(prevDeps[i], nextDeps[i])) return true;
        }
        return false;
      }
      function useEffect(fn, deps) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        var prev = inst.hooks[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          var slot = { $$effect: true, deps: deps, cleanup: null };
          inst.hooks[idx] = slot;
          pendingEffects.push({ inst: inst, fn: fn, prev: prev || null, slot: slot });
          scheduleEffects();
        }
      }
      function useLayoutEffect(fn, deps) {
        useEffect(fn, deps);
      }
      function useMemo(fn, deps) {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        var prev = inst.hooks[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          var val = fn();
          inst.hooks[idx] = { deps: deps, val: val };
          return val;
        }
        return prev.val;
      }
      function useCallback(fn, deps) {
        return useMemo(function () { return fn; }, deps);
      }
      function useId() {
        var inst = reqInst();
        var idx = inst.hookIdx++;
        if (inst.hooks.length <= idx) inst.hooks.push(':r' + (++idSeq) + ':');
        return inst.hooks[idx];
      }
      function useTransition() {
        return [false, function (fn) { fn(); }];
      }
      function useDeferredValue(v) { return v; }
      function useSyncExternalStore(subscribe, getSnapshot) {
        var pair = useState(getSnapshot);
        useEffect(function () {
          var check = function () { pair[1](getSnapshot()); };
          check();
          return subscribe(check);
        }, [subscribe]);
        return getSnapshot();
      }
      function createContext(defaultValue) {
        var id = 'ctx_' + (++ctxSeq);
        var Provider = function Provider(props) { return props ? props.children : null; };
        Provider.$$softnKind = 'provider';
        Provider._ctxId = id;
        var Consumer = function Consumer(props) {
          var val = useContext(ctx);
          return typeof props.children === 'function' ? props.children(val) : null;
        };
        var ctx = { _ctxId: id, _defaultValue: defaultValue, Provider: Provider, Consumer: Consumer };
        return ctx;
      }
      function useContext(ctx) {
        var inst = reqInst();
        if (inst.ctxMap && ctx._ctxId in inst.ctxMap) return inst.ctxMap[ctx._ctxId];
        return ctx._defaultValue;
      }
      function forwardRef(renderFn) {
        return { $$softnKind: 'forwardRef', render: renderFn };
      }
      function memo(comp, compare) {
        return { $$softnKind: 'memo', type: comp, compare: compare || null };
      }
      function Component(props) { this.props = props; this.state = {}; }
      Component.prototype.isReactComponent = true;
      function PureComponent(props) { this.props = props; this.state = {}; }
      PureComponent.prototype = Object.create(Component.prototype);
      PureComponent.prototype.isPureReactComponent = true;

      var ChildrenApi = {
        toArray: function (c) { return flattenChildren(c); },
        map: function (c, fn, ctx) { return c == null ? c : flattenChildren(c).map(function (x, i) { return fn.call(ctx, x, i); }); },
        forEach: function (c, fn, ctx) { if (c != null) flattenChildren(c).forEach(function (x, i) { fn.call(ctx, x, i); }); },
        count: function (c) { return flattenChildren(c).length; },
        only: function (c) { var a = flattenChildren(c); if (a.length !== 1) throw new Error('React.Children.only expected a single React element child.'); return a[0]; }
      };

      var roots = new WeakMap();
      function createRoot(container) {
        var currentRec = null;
        var root = {
          render: function (vnode) {
            if (!container) return;
            if (!currentRec) {
              while (container.firstChild) container.removeChild(container.firstChild);
            }
            currentRec = reconcile(container, currentRec, vnode, null, false, Object.create(null));
            if (pendingEffects.length > 0) scheduleEffects();
          },
          unmount: function () {
            if (currentRec) {
              unmountRec(currentRec);
              currentRec = null;
            }
          }
        };
        if (container) roots.set(container, root);
        return root;
      }
      function legacyRender(vnode, container, cb) {
        var root = roots.get(container) || createRoot(container);
        root.render(vnode);
        if (typeof cb === 'function') Promise.resolve().then(cb);
      }
      function createPortal(children, container, key) {
        return { $$typeof: 'softn.react.element', type: PortalType, key: key == null ? null : String(key), ref: null, props: { children: children, container: container } };
      }
      function flushSync(fn) {
        var res = typeof fn === 'function' ? fn() : undefined;
        flushDirty();
        flushEffects();
        return res;
      }

      // Expose universal JSX hooks for transpiled .tsx / .jsx files (classic & automatic JSX!)
      g.__softnJsx = createElement;
      g.__softnFragment = Fragment;

      var ReactObj = {
        version: '18.3.1',
        createElement: createElement,
        cloneElement: cloneElement,
        isValidElement: isValidElement,
        Fragment: Fragment,
        StrictMode: StrictMode,
        Suspense: Suspense,
        Children: ChildrenApi,
        Component: Component,
        PureComponent: PureComponent,
        createContext: createContext,
        forwardRef: forwardRef,
        memo: memo,
        useState: useState,
        useReducer: useReducer,
        useEffect: useEffect,
        useLayoutEffect: useLayoutEffect,
        useRef: useRef,
        useMemo: useMemo,
        useCallback: useCallback,
        useContext: useContext,
        useId: useId,
        useTransition: useTransition,
        useDeferredValue: useDeferredValue,
        useSyncExternalStore: useSyncExternalStore
      };

      __softnModules.define('softn-vendor:react', async function (__exports) {
        Object.assign(__exports, ReactObj);
        __exports.default = ReactObj;
      });
      __softnModules.define('softn-vendor:react-dom/client', async function (__exports) {
        __exports.createRoot = createRoot;
        __exports.hydrateRoot = function (container, vnode) { var r = createRoot(container); r.render(vnode); return r; };
        __exports.default = { createRoot: createRoot, hydrateRoot: __exports.hydrateRoot };
      });
      __softnModules.define('softn-vendor:react-dom', async function (__exports) {
        __exports.render = legacyRender;
        __exports.createPortal = createPortal;
        __exports.flushSync = flushSync;
        __exports.createRoot = createRoot;
        __exports.unmountComponentAtNode = function (container) { var r = roots.get(container); if (r) { r.unmount(); return true; } return false; };
        __exports.default = { render: legacyRender, createPortal: createPortal, flushSync: flushSync, createRoot: createRoot, unmountComponentAtNode: __exports.unmountComponentAtNode };
      });
      __softnModules.define('softn-vendor:react/jsx-runtime', async function (__exports) {
        __exports.jsx = jsxFactory;
        __exports.jsxs = jsxFactory;
        __exports.Fragment = Fragment;
        __exports.default = { jsx: jsxFactory, jsxs: jsxFactory, Fragment: Fragment };
      });
      __softnModules.define('softn-vendor:react/jsx-dev-runtime', async function (__exports) {
        __exports.jsxDEV = jsxFactory;
        __exports.jsx = jsxFactory;
        __exports.jsxs = jsxFactory;
        __exports.Fragment = Fragment;
        __exports.default = { jsxDEV: jsxFactory, jsx: jsxFactory, jsxs: jsxFactory, Fragment: Fragment };
      });
    })();
})();
`;
