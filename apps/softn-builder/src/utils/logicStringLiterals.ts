/**
 * Design-time lookup of the string constants a .logic file declares.
 *
 * The canvas resolves an `{expression}` prop — an image `src` bound to a logic
 * variable — against this map so the design surface can show the picture
 * instead of the variable name. A .logic file arrives inside a .softn bundle
 * that anyone can send, so none of it is executed here: the scan reads string
 * literals, `+` chains over them, and the two URI encoders applied to an
 * argument that is itself already a literal. Every other expression is left
 * unresolved rather than run to find out what it produces.
 */

const DECLARATION = /^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s*;?\s*$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The only functions a declaration may call. Both are pure and total over the
 * strings they accept, so applying one to an already-resolved literal reveals
 * nothing and runs nothing the bundle chose.
 */
const CALLABLE: Record<string, (arg: string) => string> = {
  encodeURIComponent,
  decodeURIComponent,
};

interface Scanned {
  value: string;
  end: number;
}

function skipSpace(source: string, from: number): number {
  let i = from;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

/** Reads `n`, `x41`, `u{1f600}` and the "just the next character" cases. */
function readEscape(source: string, start: number): Scanned | null {
  const ch = source[start];
  if (ch === undefined) return null;

  switch (ch) {
    case 'n':
      return { value: '\n', end: start + 1 };
    case 'r':
      return { value: '\r', end: start + 1 };
    case 't':
      return { value: '\t', end: start + 1 };
    case 'b':
      return { value: '\b', end: start + 1 };
    case 'f':
      return { value: '\f', end: start + 1 };
    case 'v':
      return { value: '\v', end: start + 1 };
    case '0':
      return { value: '\0', end: start + 1 };
    case 'x': {
      const hex = source.slice(start + 1, start + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      return { value: String.fromCharCode(parseInt(hex, 16)), end: start + 3 };
    }
    case 'u': {
      if (source[start + 1] === '{') {
        const close = source.indexOf('}', start + 2);
        if (close === -1) return null;
        const hex = source.slice(start + 2, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
        const code = parseInt(hex, 16);
        if (code > 0x10ffff) return null;
        return { value: String.fromCodePoint(code), end: close + 1 };
      }
      const hex = source.slice(start + 1, start + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      return { value: String.fromCharCode(parseInt(hex, 16)), end: start + 5 };
    }
    default:
      // `\\`, `\'`, `\"` and every other escape JavaScript passes through as
      // the character itself.
      return { value: ch, end: start + 1 };
  }
}

function readQuoted(source: string, start: number): Scanned | null {
  const quote = source[start];
  let value = '';

  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];

    if (ch === '\\') {
      const escaped = readEscape(source, i + 1);
      if (!escaped) return null;
      value += escaped.value;
      i = escaped.end - 1;
      continue;
    }
    if (ch === quote) {
      return { value, end: i + 1 };
    }
    value += ch;
  }

  return null;
}

function readTemplate(
  source: string,
  start: number,
  resolved: Record<string, string>
): Scanned | null {
  let value = '';

  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];

    if (ch === '\\') {
      const escaped = readEscape(source, i + 1);
      if (!escaped) return null;
      value += escaped.value;
      i = escaped.end - 1;
      continue;
    }
    if (ch === '$' && source[i + 1] === '{') {
      const close = source.indexOf('}', i + 2);
      if (close === -1) return null;
      // A substitution holding anything but the name of a variable already
      // resolved to a literal — a call, an object, a nested template — fails
      // this test, and the declaration is abandoned.
      const name = source.slice(i + 2, close).trim();
      if (!IDENTIFIER.test(name) || typeof resolved[name] !== 'string') return null;
      value += resolved[name];
      i = close;
      continue;
    }
    if (ch === '`') {
      return { value, end: i + 1 };
    }
    value += ch;
  }

  return null;
}

function readCall(
  source: string,
  start: number,
  apply: (arg: string) => string,
  resolved: Record<string, string>
): Scanned | null {
  const argument = readConcatenation(source, start + 1, resolved);
  if (!argument) return null;

  const close = skipSpace(source, argument.end);
  if (source[close] !== ')') return null;

  try {
    return { value: apply(argument.value), end: close + 1 };
  } catch {
    // decodeURIComponent throws URIError on a malformed sequence, and either
    // encoder throws on a lone surrogate.
    return null;
  }
}

function readOperand(
  source: string,
  start: number,
  resolved: Record<string, string>
): Scanned | null {
  const ch = source[start];
  if (ch === undefined) return null;
  if (ch === '"' || ch === "'") return readQuoted(source, start);
  if (ch === '`') return readTemplate(source, start, resolved);

  const name = source.slice(start).match(/^[A-Za-z_$][\w$]*/)?.[0];
  if (!name) return null;

  const afterName = skipSpace(source, start + name.length);
  if (source[afterName] === '(') {
    const callable = Object.prototype.hasOwnProperty.call(CALLABLE, name)
      ? CALLABLE[name]
      : null;
    return callable ? readCall(source, afterName, callable, resolved) : null;
  }

  if (typeof resolved[name] !== 'string') return null;
  return { value: resolved[name], end: start + name.length };
}

/**
 * `"a" + b + \`c\`` and nothing else, stopping at the first thing that is not
 * a `+` joining two operands. A trailing `.replace(…)`, an index, a ternary or
 * any other operator therefore leaves `end` short of the caller's terminator,
 * and the caller rejects the declaration.
 */
function readConcatenation(
  source: string,
  start: number,
  resolved: Record<string, string>
): Scanned | null {
  let value = '';
  let i = start;

  for (;;) {
    i = skipSpace(source, i);
    const operand = readOperand(source, i, resolved);
    if (!operand) return null;

    value += operand.value;
    i = skipSpace(source, operand.end);
    if (source[i] !== '+') return { value, end: i };
    i++;
  }
}

/**
 * Every `let`/`const`/`var` in `logicSource` whose value is a string literal,
 * or a `+` chain over literals and variables already resolved to one.
 */
export function parseStringLiteralVariables(logicSource: string): Record<string, string> {
  // No prototype: a bundle is free to declare `const constructor = …`, and a
  // lookup for one of those names has to miss rather than find Object's.
  const values: Record<string, string> = Object.create(null);

  for (const line of logicSource.split(/\r?\n/)) {
    const declaration = line.match(DECLARATION);
    if (!declaration) continue;

    const expression = declaration[2].trim();
    const scanned = readConcatenation(expression, 0, values);
    if (scanned && scanned.end === expression.length) {
      values[declaration[1]] = scanned.value;
    }
  }

  return values;
}
