/**
 * A `style="…"` attribute written as CSS text, as a React style object.
 *
 * Markup authors write `style="gap: 8px; color: var(--accent)"` the way HTML
 * spells it, but React takes an object. Given a string, React refuses it on a
 * DOM element, and a component that spreads `style` into its own style object
 * spreads the characters — "Failed to set an indexed property" — so one
 * ordinary attribute took down the whole element. Converting here, once,
 * before the renderer's style checks run, gives the string the same treatment
 * an object gets, including the remote `url()` check.
 *
 * Declarations are split on `;` outside quotes and parentheses, so a data URI
 * or `url("a;b")` stays whole. Property names become camelCase (`background-
 * color` → `backgroundColor`, `-webkit-mask` → `WebkitMask`, `-ms-x` →
 * `msX`); custom properties (`--gap`) keep their name, which React sets with
 * `setProperty`. A declaration without a name or a value is dropped; so is
 * `!important`, which React cannot express.
 */
export function inlineStyleObject(text: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const declaration of splitDeclarations(text)) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    const name = declaration.slice(0, colon).trim();
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim();
    if (!name || !value || !/^-?-?[A-Za-z_][\w-]*$/.test(name)) continue;
    style[propertyName(name)] = value;
  }
  return style;
}

function propertyName(name: string): string {
  if (name.startsWith('--')) return name;
  const lower = name.toLowerCase();
  const camel = lower.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  // A leading dash already capitalised the prefix (`-webkit-x` → `WebkitX`),
  // which is how React spells Webkit, Moz and O; it spells ms in lower case.
  return lower.startsWith('-ms-') ? `ms${camel.slice(2)}` : camel;
}

function splitDeclarations(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
