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
 * Each rule is now made to style only what is inside this app. The renderer
 * draws the app in an element of its own, marked with an attribute naming it
 * (`data-softn-app`), and what every selector here styles — its subject, the
 * last part — must be inside that element: `.card` becomes
 * `.card:where([data-softn-app="a1"] *)`, which no element outside the app
 * matches, however the rest of the selector is written. What is around the
 * subject may still be anything, so `.softn-theme-dark .fn` answers to a
 * theme the host sets around the app. `html`, `body` and `:root`, which in a
 * page of its own are the page, are the app's own root element as well, so a
 * page's `body { margin: 0 }` and `:root { --brand: … }` still mean what their
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
 * any rule that would still reach outside the app is removed: a selector
 * whose subject is outside it, a face or animation that kept a name of its
 * own, and an `appearance` that opens the top layer. That is the test that
 * counts: this file reads CSS the way the CSS Syntax spec says a browser
 * does, and the browser has the last word on what it read.
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

/** Where the subject — the last compound, what the selector styles — starts. */
function subjectStart(selector: string): number {
  let start = 0;
  for (let i = 0; i < selector.length; ) {
    const next = pastValue(selector, i);
    if (/[\s>+~]/.test(selector[i])) start = next;
    i = next;
  }
  return start;
}

/**
 * `selector` with its subject held inside the app: `restriction` added to
 * the subject's compound, before any pseudo-element (`.x::before` styles a
 * part of `.x`, and is held by holding `.x`).
 */
function restrictSubject(selector: string, restriction: string): string {
  let at = selector.length;
  for (let i = subjectStart(selector); i < selector.length; i = pastValue(selector, i)) {
    if (selector[i] === ':' && /^(?:::|:(?:before|after|first-line|first-letter)(?![\w-]))/i.test(selector.slice(i))) {
      at = i;
      break;
    }
  }
  return selector.slice(0, at) + restriction + selector.slice(at);
}

/**
 * One selector of a top-level rule, as the selectors that style the same
 * things inside the app: none, one, or two.
 *
 * The subject — what is styled — is held inside the app; what is around it
 * may be anything, as it is for any stylesheet: `.softn-theme-dark .fn` and
 * `[data-theme="dark"] .card` still answer to a theme the host sets on an
 * element around the app. `html`, `body` and `:root` at its start are the
 * app's own root as well, so `body { margin: 0 }` and `body.dark .x`, where
 * the page's code put `dark` on its body, mean what they meant.
 */
function scopeSelector(selector: string, restriction: string, root: string): string[] {
  const written = selector.trim();
  // `> a`, `+ a`, `~ a` are not selectors at the top of a stylesheet.
  if (!written || /^[>+~|]/.test(written)) return [];
  if (!ROOT_COMPOUND.test(written)) return [restrictSubject(written, restriction)];
  let rest = written;
  let suffix = '';
  let child = false;
  let beside = false;
  for (let m = ROOT_COMPOUND.exec(rest); m; m = ROOT_COMPOUND.exec(rest)) {
    rest = rest.slice(m[0].length);
    const end = compoundEnd(rest);
    suffix += rest.slice(0, end);
    rest = rest.slice(end).trimStart();
    child = rest.startsWith('>');
    if (child) rest = rest.slice(1).trimStart();
    // `body + a` is beside the page, which in an app is nothing.
    beside = /^[+~|]/.test(rest);
    if (beside) break;
  }
  const out: string[] = [];
  if (!beside) out.push(root + suffix + (rest ? (child ? ' > ' : ' ') + rest : ''));
  // As written too, when something below the root is styled: the root's
  // class may be the host's, on its own `html` or `body`.
  if (rest) out.push(restrictSubject(written, restriction));
  return out;
}

function unquote(text: string): string {
  const t = text.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t.replace(/\s+/g, ' ');
}

class Scoper {
  /** The app's font families, by `familyKey`, and the names they were given. */
  readonly fonts: Map<string, string>;
  readonly animations: Map<string, string>;
  /** The longest key in `fonts`: no longer run of a value can be one of them. */
  readonly longest: { family: number };
  readonly restriction: string;
  readonly root: string;

  /** `outer`: the stylesheet a group rule's block is in, whose names it shares. */
  constructor(readonly css: string, readonly app: string, outer?: Scoper) {
    this.restriction = insideTheApp(app);
    this.root = rootOfTheApp(app);
    this.fonts = outer?.fonts ?? new Map();
    this.animations = outer?.animations ?? new Map();
    this.longest = outer?.longest ?? { family: 0 };
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
        // Every `font-family` of the face, not only the first: in a block of
        // descriptors the last one names the face, and
        // `font-family: a; font-family: "IBM Plex Sans"` kept the second as
        // written, a face the permission bar's text was then drawn in.
        let family = '';
        const declarations = body.replace(/(^|[;{\s])font-family\s*:([^;]*)/gi, (_m, before: string, value: string) => {
          family = unquote(value);
          return `${before}font-family:"${family.replace(/["\\]/g, '')} ${this.app}"`;
        });
        if (!family) return '';
        const key = familyKey(family);
        this.fonts.set(key, `${family.replace(/["\\]/g, '')} ${this.app}`);
        this.longest.family = Math.max(this.longest.family, key.length);
        return `@font-face {${declarations}}\n`;
      }
      return '';
    }
    const selectors: string[] = [];
    for (const selector of splitList(prelude)) selectors.push(...scopeSelector(selector, this.restriction, this.root));
    return selectors.length > 0 ? `${selectors.join(', ')} {${body}}\n` : '';
  }

  /**
   * `value` of a font or animation declaration, with the app's names put to
   * the ones given here. Each name in the value is looked up: each name given
   * was a pattern of its own, compiled and tried on every value, and 4,000
   * faces each used once held the page's thread for most of a minute.
   */
  rename(property: string, value: string): string {
    if (/^font/i.test(property)) return this.fonts.size === 0 ? value : renameFamilies(value, this.fonts, this.longest.family);
    if (this.animations.size === 0) return value;
    return value.replace(/(^|[\s,])([^\s,!]+)/g, (match, before: string, name: string) => {
      const renamed = this.animations.get(name);
      return renamed === undefined ? match : before + renamed;
    });
  }
}

/** How a family is looked up: case and runs of white space set aside, as the browser matches it. */
function familyKey(family: string): string {
  return family.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * `value` with each family the app named, wherever a family may stand (at
 * the start or after white space, `,` or `/`, and running to a `,`, a `!`
 * or the end), put to its new name, quoted.
 */
function renameFamilies(value: string, fonts: Map<string, string>, longest: number): string {
  let out = '';
  let boundary = true;
  for (let i = 0; i < value.length; ) {
    if (boundary && !/\s/.test(value[i])) {
      const found = familyAt(value, i, longest);
      const renamed = found && fonts.get(found.key);
      if (found && renamed !== undefined) {
        out += `"${renamed}"`;
        i = found.end;
        boundary = false;
        continue;
      }
    }
    out += value[i];
    boundary = /[\s,/]/.test(value[i]);
    i++;
  }
  return out;
}

/**
 * The family that starts at `from` and runs to the next `,`, `!` or the
 * end, as `familyKey` has it, and where it ends; null where none could be
 * one the app named (none is longer than `longest`), so a long value costs
 * at most that much at each place a family may start.
 */
function familyAt(value: string, from: number, longest: number): { key: string; end: number } | null {
  let key = '';
  let end: number;
  const quote = value[from];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, from + 1);
    if (close < 0 || close - from - 1 > longest * 4) return null;
    key = familyKey(value.slice(from + 1, close));
    end = close + 1;
  } else {
    let space = false;
    end = from;
    for (let k = from; k < value.length && value[k] !== ',' && value[k] !== '!'; k++) {
      if (/\s/.test(value[k])) {
        space = true;
        continue;
      }
      if (space) key += ' ';
      space = false;
      key += value[k].toLowerCase();
      end = k + 1;
      if (key.length > longest) return null;
    }
  }
  // Nothing but white space between it and its `,`, `!` or the end.
  let next = end;
  while (next < value.length && /\s/.test(value[next])) next++;
  if (next < value.length && value[next] !== ',' && value[next] !== '!') return null;
  return key.length > 0 && key.length <= longest ? { key, end } : null;
}

const NAMED = /([{;]\s*)(font-family|font|animation-name|animation)(\s*:)([^;{}]*)/gi;

/**
 * An `appearance` that opens a select's picker in the top layer, which no
 * containment clips (`base-select`, and the `base` it was drafted as): with
 * the picker sized to the viewport, an app covered the host's controls and
 * the permission bar from one click, with CSS alone. Inline styles are held
 * to the same (prop-safety.ts `dropTopLayerStyle`).
 */
const TOP_LAYER_APPEARANCE = /^\s*base\b/i;
const TOP_LAYER_APPEARANCE_DECLARATION = /([{;]\s*)(?:-(?:webkit|moz)-)?appearance\s*:\s*base\b[^;{}]*/gi;

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

/** The pseudo-class that holds a subject inside the app named `app`. */
function insideTheApp(app: string): string {
  return `:where([data-softn-app="${app}"] *)`;
}

/** The app's root element: what `html`, `body` and `:root` are in its stylesheet. */
function rootOfTheApp(app: string): string {
  return `:where([data-softn-app="${app}"] > *)`;
}

/** Whether `token` is in `compound` itself, and not inside one of its `:not()` or `:is()`. */
function atTopOf(compound: string, token: string): boolean {
  for (let i = 0; i < compound.length; i = pastValue(compound, i)) if (compound.startsWith(token, i)) return true;
  return false;
}

function insideApp(selectorText: string, app: string, nested: boolean): boolean {
  const restriction = insideTheApp(app);
  const root = new RegExp(`^:where\\(\\[data-softn-app="${app}"\\]\\s*>\\s*\\*\\)`);
  for (const part of splitList(selectorText)) {
    const selector = part.trim();
    // What it styles is inside the app: its subject is held there, or it
    // starts from the app's root, and nothing an app's root leads to is
    // outside the element around it.
    if (root.test(selector) || atTopOf(selector.slice(subjectStart(selector)), restriction)) continue;
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
      // A face or an animation is the app's by the name it was given here,
      // whatever the text above managed to read: one that kept a name of
      // its own would stand in for the host's.
      if (keep && kind === 'CSSFontFaceRule') {
        keep = unquote((rule as CSSFontFaceRule).style.getPropertyValue('font-family')).endsWith(` ${app}`);
      }
      if (keep && kind === 'CSSKeyframesRule') keep = (rule as CSSKeyframesRule).name.endsWith(`-${app}`);
      const style = (rule as Partial<CSSStyleRule>).style;
      if (keep && style && TOP_LAYER_APPEARANCE.test(style.getPropertyValue('appearance'))) {
        style.removeProperty('appearance');
        removed = true;
      }
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
  let scoped = scoper.rules(0, css.length).replace(TOP_LAYER_APPEARANCE_DECLARATION, '$1');
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
