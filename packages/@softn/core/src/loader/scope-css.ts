/**
 * An app's own stylesheet, kept to the app.
 *
 * A `<style>` element applies to the whole document it is in, wherever in
 * the document it is. An app's style block was put in the host's document
 * as written, so a bundle could style what the host draws around it:
 * `.softn-consent-bar { display: none !important }` hid the permission bar
 * while the app ran with everything withheld, `::after { content: … }`
 * rewrote what it says while the real Allow button kept working, and
 * `.softn-runner-app { contain: none }` undid the box the host keeps the
 * app's paint in. Nothing about the app's CSS was wrong as CSS; it simply
 * reached past the app.
 *
 * Each rule is now made to say "inside this app". The renderer draws the
 * app in an element of its own, marked with an attribute naming it
 * (`data-softn-app`), and every selector here is put under that element:
 * `.card` becomes `:where([data-softn-app="a1"]) .card`, which no element
 * outside the app matches. `html`, `body` and `:root`, which in a page of
 * its own are the page, become the app's own root element, so a page's
 * `body { margin: 0 }` and `:root { --brand: … }` still mean what their
 * author meant. `:where()` adds nothing to a selector's specificity, so the
 * app's rules weigh against each other, and against the components' own,
 * exactly as they did.
 *
 * Names the CSS gives things are document-wide too. A `@font-face` named
 * like the font the permission bar is set in replaces that font for the
 * bar, glyph by glyph; a `@keyframes` named like one of the host's runs in
 * its place. The app's fonts and animations are given names of their own
 * here, and the app's CSS — and its inline styles, through `names` — uses
 * those. At-rules that change the whole document (`@property`, `@page`,
 * `@view-transition`), that choose their own scope (`@scope`) or that load
 * something (`@import`) are dropped, and so is any at-rule this file does not
 * know: a new one is let in when someone has read what it does.
 *
 * Where the browser can read CSS without applying it (a constructed
 * `CSSStyleSheet`), the result is read back by the browser's own parser and
 * any rule that would still reach outside the app is removed. That is the
 * test that counts: this file reads CSS the way the CSS Syntax spec says a
 * browser does, and the browser has the last word on what it read.
 *
 * Loaded only for an app that has a style block (see SoftNRenderer).
 */

/** The renamed fonts and animations, for an inline style that uses one. */
export type StyleNames = (style: Record<string, unknown>) => Record<string, unknown>;

export interface ScopedCss {
  css: string;
  /** Present when the stylesheet renamed something an inline style may refer to. */
  names?: StyleNames;
}

/** At-rules whose contents are rules, and are scoped as the stylesheet is. */
const GROUP_RULES = new Set(['media', 'supports', 'container', 'layer', 'starting-style']);

const KEYFRAMES = /^(?:-webkit-)?keyframes$/;

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && (/[\w-]/.test(c) || c.charCodeAt(0) >= 0x80);
}

function pastComment(css: string, i: number): number {
  const end = css.indexOf('*/', i + 2);
  return end < 0 ? css.length : end + 2;
}

/** A newline ends a string without being part of it, as the browser's bad string does. */
function pastString(css: string, i: number): number {
  const quote = css[i];
  for (let j = i + 1; j < css.length; j++) {
    const c = css[j];
    if (c === quote) return j + 1;
    if (c === '\\') j++;
    else if (c === '\n' || c === '\r' || c === '\f') return j;
  }
  return css.length;
}

/**
 * Past one unquoted `url(…)`: a single token to the browser, ended by the
 * first `)` whatever comes before it, so a `{` inside opens nothing.
 */
function pastUrl(css: string, open: number): number {
  let j = open + 1;
  while (j < css.length && /\s/.test(css[j])) j++;
  if (css[j] === '"' || css[j] === "'") return pastBlock(css, open);
  const close = css.indexOf(')', j);
  return close < 0 ? css.length : close + 1;
}

function pastBlock(css: string, i: number): number {
  const close = css[i] === '{' ? '}' : css[i] === '[' ? ']' : ')';
  let j = i + 1;
  while (j < css.length) {
    if (css[j] === close) return j + 1;
    j = pastValue(css, j);
  }
  return css.length;
}

/**
 * Past one component value starting at `i`: a comment, a string, a url, a
 * block with everything in it, a hash or at-keyword, or one character. A
 * closer of the wrong kind is one character, as it is to the browser.
 */
function pastValue(css: string, i: number): number {
  const c = css[i];
  if (c === '/' && css[i + 1] === '*') return pastComment(css, i);
  if (c === '"' || c === "'") return pastString(css, i);
  if (c === '{' || c === '(' || c === '[') return pastBlock(css, i);
  if (c === '#' || c === '@') {
    let j = i + 1;
    while (isIdentChar(css[j])) j++;
    return j;
  }
  if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !isIdentChar(css[i - 1])) {
    return pastUrl(css, i + 3);
  }
  return i + 1;
}

/** `text` cut at its top-level commas, comments taken out. */
function splitList(text: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (let i = 0; i < text.length; ) {
    const next = pastValue(text, i);
    if (text[i] === ',') {
      parts.push(part);
      part = '';
    } else if (text[i] === '/' && text[i + 1] === '*') part += ' ';
    else part += text.slice(i, next);
    i = next;
  }
  parts.push(part);
  return parts;
}

/** Where the compound selector at the start of `text` ends. */
function compoundEnd(text: string): number {
  let i = 0;
  while (i < text.length && !/[\s>+~]/.test(text[i])) i = pastValue(text, i);
  return i;
}

const ROOT_COMPOUND = /^(?:html|body|:root|&)(?![\w-])/i;

/** One selector of a top-level rule, put inside the app; null to drop it. */
function scopeSelector(selector: string, prefix: string, root: string): string | null {
  let rest = selector.trim();
  // `> a`, `+ a`, `~ a` are not selectors at the top of a stylesheet, but
  // with the app's element written in front they would be its siblings.
  if (!rest || /^[>+~|]/.test(rest)) return null;
  let atRoot = false;
  let suffix = '';
  let child = false;
  for (let m = ROOT_COMPOUND.exec(rest); m; m = ROOT_COMPOUND.exec(rest)) {
    atRoot = true;
    rest = rest.slice(m[0].length);
    const end = compoundEnd(rest);
    suffix += rest.slice(0, end);
    rest = rest.slice(end).trimStart();
    child = rest.startsWith('>');
    if (child) rest = rest.slice(1).trimStart();
    // `body + a` is beside the page, which is beside the app.
    if (/^[+~|]/.test(rest)) return null;
  }
  if (!atRoot) return prefix + ' ' + rest;
  return root + suffix + (rest ? (child ? ' > ' : ' ') + rest : '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquote(text: string): string {
  const t = text.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t.replace(/\s+/g, ' ');
}

class Scoper {
  readonly fonts: Map<string, string>;
  readonly animations: Map<string, string>;
  readonly prefix: string;
  readonly root: string;

  /** `outer`: the stylesheet a group rule's block is in, whose names it shares. */
  constructor(readonly css: string, readonly app: string, outer?: Scoper) {
    this.prefix = `:where([data-softn-app="${app}"])`;
    this.root = `:where([data-softn-app="${app}"] > *)`;
    this.fonts = outer?.fonts ?? new Map();
    this.animations = outer?.animations ?? new Map();
  }

  /** The rules between `start` and `end`, scoped. */
  rules(start: number, end: number): string {
    const css = this.css;
    let out = '';
    let i = start;
    while (i < end) {
      const c = css[i];
      if (/\s/.test(c) || c === ';' || c === '}') {
        i++;
        continue;
      }
      if (c === '/' && css[i + 1] === '*') {
        i = pastComment(css, i);
        continue;
      }
      if (css.startsWith('<!--', i) || css.startsWith('-->', i)) {
        i += css[i] === '<' ? 4 : 3;
        continue;
      }
      // A rule's prelude runs to its block; a `;` or `}` first ends it as
      // nothing. The browser does not always stop at those, but where it
      // does not, what it reads is one rule this file would have dropped
      // whole: stopping there only ever keeps less.
      let j = i;
      while (j < end && css[j] !== '{' && css[j] !== ';' && css[j] !== '}') j = Math.min(pastValue(css, j), end);
      const prelude = css.slice(i, j).trim();
      if (j >= end || css[j] !== '{') {
        // A statement: `@layer a, b;` orders layers and says nothing else.
        if (/^@layer\s[^{}]*$/i.test(prelude)) out += prelude + ';\n';
        i = j + 1;
        continue;
      }
      const close = Math.min(pastBlock(css, j), end);
      const body = css.slice(j + 1, css[close - 1] === '}' ? close - 1 : close);
      out += this.rule(prelude, body);
      i = close;
    }
    return out;
  }

  private rule(prelude: string, body: string): string {
    if (prelude.startsWith('@')) {
      const name = (/^@([\w-]+)/.exec(prelude)?.[1] ?? '').toLowerCase();
      if (GROUP_RULES.has(name)) {
        // One stylesheet: a name given inside `@media` is the stylesheet's.
        return `${prelude} {\n${new Scoper(body, this.app, this).rules(0, body.length)}}\n`;
      }
      if (KEYFRAMES.test(name)) {
        const own = prelude.slice(name.length + 1).trim();
        const keyframes = unquote(own);
        if (!keyframes) return '';
        const renamed = `${keyframes.replace(/[^\w-]/g, '_')}-${this.app}`;
        this.animations.set(keyframes, renamed);
        return `@${name} ${renamed} {${body}}\n`;
      }
      if (name === 'font-face') {
        let family = '';
        const declarations = body.replace(/(^|[;{\s])font-family\s*:([^;]*)/i, (_m, before: string, value: string) => {
          family = unquote(value);
          return `${before}font-family:"${family.replace(/["\\]/g, '')} ${this.app}"`;
        });
        if (!family) return '';
        this.fonts.set(family.toLowerCase(), `${family.replace(/["\\]/g, '')} ${this.app}`);
        return `@font-face {${declarations}}\n`;
      }
      return '';
    }
    const selectors: string[] = [];
    for (const selector of splitList(prelude)) {
      const scoped = scopeSelector(selector, this.prefix, this.root);
      if (scoped) selectors.push(scoped);
    }
    return selectors.length > 0 ? `${selectors.join(', ')} {${body}}\n` : '';
  }

  /** `value` of a font or animation declaration, with the app's names put to the ones given here. */
  rename(property: string, value: string): string {
    if (/^font/i.test(property)) {
      for (const [family, renamed] of this.fonts) {
        value = value.replace(
          new RegExp(`(^|[\\s,/])(?:"${escapeRegExp(family)}"|'${escapeRegExp(family)}'|${escapeRegExp(family).replace(/ /g, '\\s+')})(?=\\s*(?:,|!|$))`, 'gi'),
          `$1"${renamed}"`
        );
      }
    } else {
      for (const [keyframes, renamed] of this.animations) {
        value = value.replace(new RegExp(`(^|[\\s,])${escapeRegExp(keyframes)}(?=[\\s,!]|$)`, 'g'), `$1${renamed}`);
      }
    }
    return value;
  }
}

const NAMED = /([{;]\s*)(font-family|font|animation-name|animation)(\s*:)([^;{}]*)/gi;

const STYLE_KEYS: Record<string, string> = {
  fontFamily: 'font-family',
  font: 'font',
  animation: 'animation',
  animationName: 'animation-name',
};

/** Kinds of rule that may stay; anything else the browser read is removed. */
const KEPT_RULES = new Set([
  'CSSStyleRule',
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSContainerRule',
  'CSSLayerBlockRule',
  'CSSLayerStatementRule',
  'CSSStartingStyleRule',
  'CSSKeyframesRule',
  'CSSFontFaceRule',
  'CSSNestedDeclarations',
]);

/** The subject of a selector — what it styles — is the parent rule's element, or one of its. */
function subjectIsParent(selector: string): boolean {
  let subject = 0;
  for (let i = 0; i < selector.length; ) {
    const next = pastValue(selector, i);
    if (/[\s>+~]/.test(selector[i])) subject = next;
    i = next;
  }
  for (let i = subject; i < selector.length; ) {
    if (selector[i] === '&') return true;
    i = pastValue(selector, i);
  }
  return false;
}

function insideApp(selectorText: string, app: string, nested: boolean): boolean {
  const below = new RegExp(`^:where\\(\\[data-softn-app="${app}"\\]\\)\\s+[^\\s+~]`);
  const root = new RegExp(`^:where\\(\\[data-softn-app="${app}"\\]\\s*>\\s*\\*\\)`);
  for (const part of splitList(selectorText)) {
    const selector = part.trim();
    if (below.test(selector) || root.test(selector)) continue;
    // A nested rule without `&` is under its parent's element, and so is
    // one that starts from it (`& .b`, as a browser writes `.b` back out);
    // with `&` written in anywhere else, it is only if what it styles is
    // `&` itself.
    if (nested && (!selector.includes('&') || selector.startsWith('&') || subjectIsParent(selector))) continue;
    return false;
  }
  return true;
}

/**
 * The stylesheet as the browser reads it, without the rules that would
 * reach outside the app; null where no browser parser is at hand.
 */
function asTheBrowserReadsIt(css: string, app: string): string | null {
  if (typeof CSSStyleSheet !== 'function') return null;
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    if (typeof sheet.replaceSync !== 'function') return null;
    sheet.replaceSync(css);
  } catch {
    return null;
  }
  let removed = false;
  const walk = (owner: { cssRules: CSSRuleList; deleteRule(index: number): void }, nested: boolean): void => {
    for (let i = owner.cssRules.length - 1; i >= 0; i--) {
      const rule = owner.cssRules[i];
      const kind = Object.prototype.toString.call(rule).slice(8, -1);
      let keep = KEPT_RULES.has(kind);
      if (keep && kind === 'CSSStyleRule') keep = insideApp((rule as CSSStyleRule).selectorText, app, nested);
      if (keep && 'cssRules' in rule && kind !== 'CSSKeyframesRule') {
        walk(rule as unknown as { cssRules: CSSRuleList; deleteRule(index: number): void }, nested || kind === 'CSSStyleRule');
      }
      if (!keep) {
        owner.deleteRule(i);
        removed = true;
      }
    }
  };
  walk(sheet, false);
  if (!removed) return css;
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
}

/**
 * `css` — a bundle's style block, already through `sanitizeBundleCSS`, which
 * has undone its escapes — put inside the app whose element carries
 * `data-softn-app="<app>"`. `app` is a short name of letters and digits.
 */
export function scopeAppCss(css: string, app: string): ScopedCss {
  const scoper = new Scoper(css, app);
  let scoped = scoper.rules(0, css.length);
  if (scoper.fonts.size > 0 || scoper.animations.size > 0) {
    scoped = scoped.replace(NAMED, (_m, before: string, property: string, colon: string, value: string) =>
      // The `font-family` of an `@font-face` is the new name already.
      `${before}${property}${colon}${scoper.rename(property, value)}`
    );
  }
  const read = asTheBrowserReadsIt(scoped, app);
  const result: ScopedCss = { css: read ?? scoped };
  if (scoper.fonts.size > 0 || scoper.animations.size > 0) {
    result.names = (style) => {
      let copy: Record<string, unknown> | null = null;
      for (const key of Object.keys(STYLE_KEYS)) {
        const value = style[key];
        if (typeof value !== 'string') continue;
        const renamed = scoper.rename(STYLE_KEYS[key], value);
        if (renamed === value) continue;
        copy ??= { ...style };
        copy[key] = renamed;
      }
      return copy ?? style;
    };
  }
  return result;
}
