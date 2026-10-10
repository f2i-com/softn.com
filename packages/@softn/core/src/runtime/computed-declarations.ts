/**
 * `$:` declarations: finding them in a script, and the code generated so that
 * each is the value of its expression wherever it is read.
 *
 * `$: double = n * 2` is, to the engine, a labelled assignment: it runs once,
 * as the script loads, and leaves a global behind. A page never read that
 * global — the renderer re-evaluated the expression at every draw — but logic
 * did. Another `$:` built on `double`, or a function that returned it, read
 * what `n * 2` was when the script loaded, for as long as the app ran; and a
 * `$:` written above one it read stopped the script loading at all, on a
 * ReferenceError.
 *
 * So the globals are kept true instead. One generated function works every
 * top-level declaration out again and assigns it, each after the ones its
 * expression names, and the runtime calls it before guest code runs and
 * before a page is drawn (see `settleComputed` in script-runtime.ts). This
 * module is the part of that with no engine in it: reading the declarations,
 * ordering them, and writing the generated source.
 */

/** Prefix for everything generated from `$:` declarations. */
export const COMPUTED_PREFIX = '__softnComputed_';

// A declaration's name is an identifier, so one that begins with a digit is
// a name no declaration's own function can have.
/** Works every top-level `$:` out again and assigns it. */
export const COMPUTED_SETTLE_FUNCTION = `${COMPUTED_PREFIX}0settle`;
/** Works one `$:` out as the script loads, where a failure must not stop the load. */
export const COMPUTED_FIRST_FUNCTION = `${COMPUTED_PREFIX}0first`;

export interface ComputedDeclaration {
  name: string;
  /** The expression as written, trimmed. A trailing `// comment` is part of it. */
  expression: string;
  /** Where the expression stands in the code it was read from, untrimmed. */
  start: number;
  end: number;
  /**
   * Whether it is written at the top of the script. One inside a function or
   * a block is an assignment in that scope and is left as the author wrote it.
   */
  topLevel: boolean;
}

/**
 * Extract `$: name = expression;` reactive declarations from source code.
 * Uses a comment/string-aware scanner to avoid matching inside comments or strings,
 * and supports multi-line expressions by balancing brackets.
 */
export function extractComputedDeclarations(code: string): ComputedDeclaration[] {
  const results: ComputedDeclaration[] = [];
  const len = code.length;
  let i = 0;
  // How many `{` are open: zero at the top of the script.
  let blockDepth = 0;

  while (i < len) {
    const ch = code[i];

    // Skip single-line comments
    if (ch === '/' && i + 1 < len && code[i + 1] === '/') {
      i += 2;
      while (i < len && code[i] !== '\n') i++;
      continue;
    }

    // Skip multi-line comments
    if (ch === '/' && i + 1 < len && code[i + 1] === '*') {
      i += 2;
      while (i < len && !(code[i] === '*' && i + 1 < len && code[i + 1] === '/')) i++;
      if (i + 1 < len) i += 2; // skip */ (with bounds check)
      continue;
    }

    // Skip string literals
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < len && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < len) i++; // skip escaped char (with bounds check)
        i++;
      }
      if (i < len) i++; // skip closing quote (with bounds check)
      continue;
    }

    if (ch === '{') blockDepth++;
    else if (ch === '}') blockDepth = Math.max(0, blockDepth - 1);

    // Look for `$:` at a statement boundary (start of line or after whitespace/semicolon)
    if (ch === '$' && i + 1 < len && code[i + 1] === ':') {
      // Verify it's at a statement boundary (not part of an identifier like `a$:`)
      const prev = i > 0 ? code[i - 1] : '\n';
      if (prev === '\n' || prev === ';' || prev === '{' || prev === '}' || /\s/.test(prev)) {
        let j = i + 2; // skip "$:"
        // Skip whitespace
        while (j < len && (code[j] === ' ' || code[j] === '\t')) j++;

        // Extract variable name
        const nameStart = j;
        while (j < len && /\w/.test(code[j])) j++;
        const name = code.substring(nameStart, j);

        if (name) {
          // Skip whitespace and '='
          while (j < len && (code[j] === ' ' || code[j] === '\t')) j++;
          if (j < len && code[j] === '=') {
            j++; // skip '='
            while (j < len && (code[j] === ' ' || code[j] === '\t')) j++;

            // Extract expression — balance brackets until ';' at depth 0
            // Skips strings AND comments to avoid false termination
            const exprStart = j;
            let depth = 0;
            while (j < len) {
              const ec = code[j];
              // Skip single-line comments inside expression
              if (ec === '/' && j + 1 < len && code[j + 1] === '/') {
                j += 2;
                while (j < len && code[j] !== '\n') j++;
                continue;
              }
              // Skip multi-line comments inside expression
              if (ec === '/' && j + 1 < len && code[j + 1] === '*') {
                j += 2;
                while (j < len && !(code[j] === '*' && j + 1 < len && code[j + 1] === '/')) j++;
                if (j + 1 < len) j += 2;
                continue;
              }
              if (ec === '(' || ec === '[' || ec === '{') {
                depth++;
              } else if (ec === ')' || ec === ']' || ec === '}') {
                // A bracket the expression did not open closes the block the
                // declaration is written in: `if (x) { $: y = 1 }`. Read on
                // past it and the expression took the rest of the script.
                if (depth === 0) break;
                depth--;
              } else if (ec === '"' || ec === "'" || ec === '`') {
                // Skip string inside expression
                const q = ec;
                j++;
                while (j < len && code[j] !== q) {
                  if (code[j] === '\\' && j + 1 < len) j++;
                  j++;
                }
              } else if (ec === ';' && depth === 0) {
                break;
              } else if (ec === '\n' && depth === 0) {
                // Newline at depth 0 also ends the expression (ASI)
                break;
              }
              j++;
            }
            const end = Math.min(j, len);
            const expression = code.substring(exprStart, end).trim();
            if (expression) {
              results.push({ name, expression, start: exprStart, end, topLevel: blockDepth === 0 });
            }
          }
        }
        // Past the `;` or the line end that closed it; a closing bracket is
        // left for the count of open blocks above.
        i = code[j] === ')' || code[j] === ']' || code[j] === '}' ? j : j + 1;
        continue;
      }
    }

    i++;
  }

  return results;
}

/** An expression with its comments and quoted strings blanked, so a word in either is not taken for a name. */
function withoutCommentsAndStrings(expression: string): string {
  let out = '';
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (ch === '/' && expression[i + 1] === '/') {
      while (i < expression.length && expression[i] !== '\n') i++;
    } else if (ch === '/' && expression[i + 1] === '*') {
      const end = expression.indexOf('*/', i + 2);
      i = end === -1 ? expression.length : end + 2;
      out += ' ';
    } else if (ch === '"' || ch === "'") {
      i++;
      while (i < expression.length && expression[i] !== ch) i += expression[i] === '\\' ? 2 : 1;
      i++;
      out += '""';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * The names an expression reads that are not somebody's property: `double`
 * and `todos` in `double + todos.length`, not `length`. Deliberately generous
 * — a parameter of an arrow function or an object's key is counted too —
 * because it is only used to order work, where a name too many costs nothing.
 */
export function namesReadBy(expression: string): Set<string> {
  const text = withoutCommentsAndStrings(expression);
  const names = new Set<string>();
  const word = /[A-Za-z_$][\w$]*/g;
  let match: RegExpExecArray | null;
  while ((match = word.exec(text)) !== null) {
    const before = text[match.index - 1];
    // `a.b` reads `a`; `...b` reads `b`.
    if (before === '.' && text.slice(match.index - 3, match.index) !== '...') continue;
    names.add(match[0]);
  }
  return names;
}

export interface ComputedPlan {
  /** The top-level declarations, each after the ones its expression names. */
  order: ComputedDeclaration[];
  /** Declarations that name each other in a circle, as the path of each circle found. */
  circles: string[][];
}

/**
 * Order the top-level declarations so that each is worked out after the ones
 * it reads, whatever order they are written in.
 *
 * Declarations that read each other in a circle have no such order. They
 * keep the order they are written in, after everything that could be placed,
 * and each circle is returned so the runtime can say which they are.
 */
export function planComputed(declarations: readonly ComputedDeclaration[]): ComputedPlan {
  const topLevel = declarations.filter((declaration) => declaration.topLevel);
  // A name declared twice is one name: the last declaration is the one the
  // engine keeps.
  const byName = new Map<string, ComputedDeclaration>();
  for (const declaration of topLevel) byName.set(declaration.name, declaration);
  const nodes = [...byName.values()];

  const reads = new Map<string, string[]>();
  for (const node of nodes) {
    const named = namesReadBy(node.expression);
    // A value that names itself reads what it was, which orders nothing.
    reads.set(node.name, nodes.filter((other) => other !== node && named.has(other.name)).map((other) => other.name));
  }

  const order: ComputedDeclaration[] = [];
  const placed = new Set<string>();
  let moved = true;
  while (moved) {
    moved = false;
    for (const node of nodes) {
      if (placed.has(node.name)) continue;
      if (reads.get(node.name)!.every((name) => placed.has(name))) {
        placed.add(node.name);
        order.push(node);
        moved = true;
      }
    }
  }

  // What is left reads something that is itself left: a circle, or a value
  // downstream of one.
  const left = nodes.filter((node) => !placed.has(node.name));
  const circles: string[][] = [];
  const inACircle = new Set<string>();
  for (const start of left) {
    if (inACircle.has(start.name)) continue;
    const path: string[] = [];
    let at = start.name;
    while (!path.includes(at)) {
      path.push(at);
      at = reads.get(at)!.find((name) => !placed.has(name))!;
    }
    const circle = path.slice(path.indexOf(at));
    if (circle.some((name) => inACircle.has(name))) continue;
    for (const name of circle) inACircle.add(name);
    circles.push([...circle, at]);
  }
  return { order: [...order, ...left], circles };
}

/**
 * The source of the functions generated for the declarations: one for each,
 * returning its expression, and the two that keep the globals true.
 *
 * The expression is raw source and keeps whatever trailed it, including a
 * `// comment`. Each piece therefore gets its own line: on one line a
 * trailing comment would swallow the closing `);` and take the whole
 * script's compilation down with it, not just this one value.
 */
export function computedSource(declarations: readonly ComputedDeclaration[], plan: ComputedPlan): string {
  const functions = declarations.map(
    (declaration) => `function ${COMPUTED_PREFIX}${declaration.name}() {\nreturn (\n${declaration.expression}\n);\n}`
  );
  if (plan.order.length === 0) return functions.join('\n');

  // A value that cannot be worked out is `undefined`, and the reason is
  // handed back with its place in the order rather than thrown: one bad
  // expression must not leave the values after it as they were.
  const settle = plan.order.map(
    ({ name }, index) =>
      `try { ${name} = ${COMPUTED_PREFIX}${name}(); } catch (__softnError) { ${name} = undefined; __softnErrors.push([${index}, String(__softnError)]); }`
  );
  const values = plan.order.map(({ name }) => name).join(', ');
  return [
    ...functions,
    `function ${COMPUTED_FIRST_FUNCTION}(__softnCompute) {`,
    'try { return __softnCompute(); } catch (__softnError) { return undefined; }',
    '}',
    `function ${COMPUTED_SETTLE_FUNCTION}(__softnWanted) {`,
    'let __softnErrors = [];',
    ...settle,
    `return __softnWanted ? [[${values}], __softnErrors] : [null, __softnErrors];`,
    '}',
  ].join('\n');
}

/**
 * The script with each top-level `$:` expression worked out, as it loads,
 * through the function generated for it.
 *
 * As written, `$: quad = double * 2` above `$: double = n * 2` stopped the
 * script loading: `double` had not been assigned when the line ran. And any
 * `$:` whose expression threw on the state the script starts with — a
 * property of something still `null` — took the whole script with it. Through
 * the guard a first value that cannot be had yet is `undefined`, and the
 * runtime works every value out properly once the script has loaded. A value
 * that can be had is what it always was, for the top-level code after it.
 *
 * The replacement keeps the lines the expression took, so the engine's line
 * numbers still point into the author's source.
 */
export function guardFirstValues(code: string, plan: ComputedPlan): string {
  const spans = [...plan.order].sort((a, b) => b.start - a.start);
  let out = code;
  for (const { name, start, end } of spans) {
    const lines = out.slice(start, end).split('\n').length - 1;
    out = `${out.slice(0, start)}${COMPUTED_FIRST_FUNCTION}(${COMPUTED_PREFIX}${name})${'\n'.repeat(lines)}${out.slice(end)}`;
  }
  return out;
}
