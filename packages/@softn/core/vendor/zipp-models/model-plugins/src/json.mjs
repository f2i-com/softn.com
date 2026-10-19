import {check} from './common.mjs';
const decoder = new TextDecoder('utf-8', {fatal: true});
export function decodeUTF8(bytes) {
  try { return decoder.decode(bytes); } catch { throw new Error('Invalid UTF-8'); }
}
/** Bounded JSON parser with duplicate-key detection, including escaped duplicates. */
export function parseJSON(text, {maxChars = 4 * 1024 * 1024, maxDepth = 32, maxItems = 100000} = {}) {
  check(typeof text === 'string' && text.length <= maxChars, 'LIMIT', 'JSON exceeds text budget');
  let at = 0, items = 0;
  const ws = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  function string() {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const c = text[at++];
      if (!escaped && c === '"') {
        try { return JSON.parse(text.slice(start, at)); } catch { break; }
      }
      if (c.charCodeAt(0) < 32) break;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
    }
    check(false, 'JSON', 'Invalid JSON string');
  }
  function value(depth) {
    check(depth <= maxDepth && ++items <= maxItems, 'LIMIT', 'JSON nesting/item limit exceeded');
    ws(); const c = text[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; ws(); const out = Object.create(null), seen = new Set();
      if (text[at] === '}') { at++; return out; }
      while (true) {
        ws(); check(text[at] === '"', 'JSON', 'Object key must be a string');
        const key = string();
        check(!seen.has(key), 'JSON', `Duplicate JSON key: ${key}`); seen.add(key);
        ws(); check(text[at++] === ':', 'JSON', 'Expected colon');
        out[key] = value(depth + 1); ws(); const end = text[at++];
        if (end === '}') return out;
        check(end === ',', 'JSON', 'Expected comma or closing brace');
      }
    }
    if (c === '[') {
      at++; ws(); const out = [];
      if (text[at] === ']') { at++; return out; }
      while (true) {
        out.push(value(depth + 1)); ws(); const end = text[at++];
        if (end === ']') return out;
        check(end === ',', 'JSON', 'Expected comma or closing bracket');
      }
    }
    for (const [token, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, at)) { at += token.length; return v; }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    check(m, 'JSON', 'Invalid JSON value'); at += m[0].length;
    const number = Number(m[0]); check(Number.isFinite(number), 'JSON', 'Non-finite JSON number'); return number;
  }
  const out = value(0); ws(); check(at === text.length, 'JSON', 'Trailing JSON data'); return out;
}
