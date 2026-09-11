/**
 * Expression printer — canonical, precedence-aware text for a SoftN
 * expression AST.
 *
 * The builder keeps every template expression as text in its visual model
 * and writes that text back into the .ui file when it regenerates one. The
 * printer it used to do that walked the tree and joined the pieces with
 * spaces, with no notion of precedence or associativity: `(a + b) * c` came
 * back as `a + b * c` and evaluated to a different number, `a - (b - c)`
 * lost its grouping, a member access on a grouped operand lost its
 * parentheses, an arrow returning an object literal was printed as a block
 * body, object keys that were not identifiers were printed bare, string
 * escapes were dropped (the parser's `raw` for a string is the cooked value
 * in double quotes, so `"say \"hi\""` came back as `"say "hi""`), and any
 * AST kind the printer did not know became an empty string — an empty
 * attribute, binding or handler with nothing to say why.
 *
 * This printer parenthesises exactly where the core parser's grammar needs
 * it (its precedence ladder is nullish < or < and < equality < comparison <
 * additive < multiplicative < unary < call/member, every binary level
 * left-associative, the conditional right-associative, an arrow body
 * swallowing everything after `=>`), prints strings and non-identifier keys
 * with JSON escaping the lexer reads back, keeps template literals as
 * template literals, and refuses anything outside the grammar with a typed
 * error instead of an empty string. Printing the printed text's parse again
 * gives the same text (a fixpoint), and the engine evaluates both to the
 * same value — see expressionPrinter.test.ts.
 */

import type {
  Expression,
  ArrowFunctionExpression,
  ObjectProperty,
} from '@softn/core';

/** Thrown for a node the grammar the builder writes does not have. */
export class ExpressionPrintError extends Error {
  readonly kind: string;

  constructor(kind: string, detail?: string) {
    super(
      detail
        ? `Unsupported expression: ${kind} (${detail})`
        : `Unsupported expression: ${kind}`
    );
    this.name = 'ExpressionPrintError';
    this.kind = kind;
  }
}

/**
 * Binding strength, higher binds tighter. Mirrors the parser's ladder: an
 * operand of lower precedence than its context must be parenthesised.
 */
enum Prec {
  Arrow = 0,
  Conditional = 1,
  Nullish = 2,
  Or = 3,
  And = 4,
  Equality = 5,
  Comparison = 6,
  Additive = 7,
  Multiplicative = 8,
  Unary = 9,
  Postfix = 10,
  Primary = 11,
}

const BINARY_PRECEDENCE: Record<string, Prec> = {
  '??': Prec.Nullish,
  '||': Prec.Or,
  '&&': Prec.And,
  '==': Prec.Equality,
  '!=': Prec.Equality,
  '===': Prec.Equality,
  '!==': Prec.Equality,
  '<': Prec.Comparison,
  '>': Prec.Comparison,
  '<=': Prec.Comparison,
  '>=': Prec.Comparison,
  '+': Prec.Additive,
  '-': Prec.Additive,
  '*': Prec.Multiplicative,
  '/': Prec.Multiplicative,
  '%': Prec.Multiplicative,
};

const UNARY_OPERATORS = new Set(['!', '-', '+', 'typeof', 'void']);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function precedenceOf(expr: Expression): Prec {
  switch (expr.type) {
    case 'ArrowFunctionExpression':
      return Prec.Arrow;
    case 'ConditionalExpression':
      return Prec.Conditional;
    case 'BinaryExpression': {
      const p = BINARY_PRECEDENCE[expr.operator];
      if (p === undefined) {
        throw new ExpressionPrintError('BinaryExpression', `operator ${expr.operator}`);
      }
      return p;
    }
    case 'UnaryExpression':
      return Prec.Unary;
    case 'MemberExpression':
    case 'CallExpression':
      return Prec.Postfix;
    case 'SpreadElement':
      // Only meaningful as an argument or element; never an operand.
      return Prec.Arrow;
    default:
      return Prec.Primary;
  }
}

function parenthesise(text: string): string {
  return `(${text})`;
}

/** Print `expr` as an operand that must bind at least as tightly as `min`. */
function printOperand(expr: Expression, min: Prec): string {
  const text = printExpression(expr);
  return precedenceOf(expr) < min ? parenthesise(text) : text;
}

/**
 * The object of a member access or the callee of a call. Besides anything
 * weaker than a postfix expression, a numeric literal needs parentheses
 * (`5.toFixed` is not a member access) and so does an object literal, which
 * in the leading position of an attribute would otherwise be read as the
 * braces of the attribute itself.
 */
function printCalleeOrObject(expr: Expression): string {
  const text = printExpression(expr);
  if (precedenceOf(expr) < Prec.Postfix) return parenthesise(text);
  if (expr.type === 'Literal' && typeof expr.value === 'number') return parenthesise(text);
  if (expr.type === 'ObjectExpression') return parenthesise(text);
  return text;
}

function printString(value: string): string {
  return JSON.stringify(value);
}

function printNumber(value: number, raw: string): string {
  // The parser keeps the literal's spelling; use it when it still means the
  // same number, so `1.50` and `0x10` come back as written.
  if (typeof raw === 'string' && raw.trim() !== '' && Number(raw) === value) return raw;
  if (!Number.isFinite(value)) throw new ExpressionPrintError('Literal', `number ${String(value)}`);
  return String(value);
}

function printKey(key: string): string {
  return IDENTIFIER.test(key) ? key : printString(key);
}

function printProperty(prop: ObjectProperty): string {
  const key = printKey(prop.key);
  if (
    prop.shorthand &&
    IDENTIFIER.test(prop.key) &&
    prop.value.type === 'Identifier' &&
    prop.value.name === prop.key
  ) {
    return key;
  }
  return `${key}: ${printExpression(prop.value)}`;
}

function printArrow(expr: ArrowFunctionExpression): string {
  const params = `(${expr.params.join(', ')})`;
  let body: string;
  if (typeof expr.body === 'string') {
    // A block body is carried as its source text.
    body = expr.body;
  } else if (expr.body.type === 'ObjectExpression') {
    // `() => { a: 1 }` is a block; the object needs its own parentheses.
    body = parenthesise(printExpression(expr.body));
  } else {
    body = printExpression(expr.body);
  }
  return `${expr.async ? 'async ' : ''}${params} => ${body}`;
}

function printTemplateChunk(raw: string): string {
  // The lexer hands the cooked text back as `raw`, so the characters that
  // end or interrupt a template have to be escaped again.
  return raw.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Print an expression. Throws {@link ExpressionPrintError} for a node or
 * operator outside the grammar; never returns an empty string for one.
 */
export function printExpression(expr: Expression): string {
  if (!expr || typeof expr !== 'object' || typeof (expr as { type?: unknown }).type !== 'string') {
    throw new ExpressionPrintError(String((expr as { type?: unknown } | null)?.type ?? typeof expr));
  }

  switch (expr.type) {
    case 'Identifier':
      return expr.name;

    case 'Literal': {
      const v = expr.value;
      if (v === null) return 'null';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number') return printNumber(v, expr.raw);
      if (typeof v === 'string') return printString(v);
      throw new ExpressionPrintError('Literal', typeof v);
    }

    case 'BinaryExpression': {
      const prec = precedenceOf(expr);
      // Every binary level is left-associative in the parser: the left
      // operand may be the same level, the right one may not.
      const left = printOperand(expr.left, prec);
      const right = printOperand(expr.right, (prec + 1) as Prec);
      return `${left} ${expr.operator} ${right}`;
    }

    case 'UnaryExpression': {
      if (!UNARY_OPERATORS.has(expr.operator)) {
        throw new ExpressionPrintError('UnaryExpression', `operator ${expr.operator}`);
      }
      const argument = expr.argument;
      let inner = printOperand(argument, Prec.Unary);
      const wordOperator = /^[a-z]/.test(expr.operator);
      // `- -x` reads as a decrement to a human and `--` to some lexers;
      // `-(-x)` is unambiguous and parses back to the same tree.
      if (
        !wordOperator &&
        argument.type === 'UnaryExpression' &&
        (argument.operator === '-' || argument.operator === '+')
      ) {
        inner = parenthesise(inner);
      }
      return wordOperator ? `${expr.operator} ${inner}` : `${expr.operator}${inner}`;
    }

    case 'MemberExpression': {
      const object = printCalleeOrObject(expr.object);
      if (expr.computed) {
        return `${object}${expr.optional ? '?.' : ''}[${printExpression(expr.property)}]`;
      }
      if (expr.property.type !== 'Identifier') {
        throw new ExpressionPrintError('MemberExpression', `property ${expr.property.type}`);
      }
      return `${object}${expr.optional ? '?.' : '.'}${expr.property.name}`;
    }

    case 'CallExpression': {
      const callee = printCalleeOrObject(expr.callee);
      const args = expr.arguments.map((a) => printExpression(a)).join(', ');
      return `${callee}${expr.optional ? '?.' : ''}(${args})`;
    }

    case 'ConditionalExpression': {
      // The test must bind tighter than the conditional; the branches are
      // parsed as whole expressions, so only an arrow — whose body would
      // swallow the `:` and everything after it — needs parentheses there.
      const test = printOperand(expr.test, Prec.Nullish);
      const consequent = printOperand(expr.consequent, Prec.Conditional);
      const alternate = printOperand(expr.alternate, Prec.Conditional);
      return `${test} ? ${consequent} : ${alternate}`;
    }

    case 'ArrowFunctionExpression':
      return printArrow(expr);

    case 'ObjectExpression': {
      if (expr.properties.length === 0) return '{}';
      return `{ ${expr.properties.map(printProperty).join(', ')} }`;
    }

    case 'ArrayExpression':
      return `[${expr.elements.map((e) => printExpression(e)).join(', ')}]`;

    case 'SpreadElement':
      return `...${printOperand(expr.argument, Prec.Conditional)}`;

    case 'TemplateLiteral': {
      const parts: string[] = [];
      for (let i = 0; i < expr.quasis.length; i++) {
        parts.push(printTemplateChunk(expr.quasis[i].value.raw));
        if (i < expr.expressions.length) {
          parts.push(`\${${printExpression(expr.expressions[i])}}`);
        }
      }
      return `\`${parts.join('')}\``;
    }

    default:
      throw new ExpressionPrintError((expr as { type: string }).type);
  }
}

export interface PrintedExpression {
  /** The printed text, or the placeholder `undefined` when it could not be printed. */
  text: string;
  /** Empty when the expression printed; otherwise why it could not. */
  diagnostics: string[];
}

/**
 * The placeholder written for an expression that cannot be printed. The
 * core parser itself substitutes this identifier for anything it cannot
 * read, so it is the one value that is never mistaken for an author's own.
 */
export const UNSUPPORTED_EXPRESSION_PLACEHOLDER = 'undefined';

/**
 * Print without throwing. An unsupported node yields the placeholder and a
 * diagnostic naming the node, so a caller can mark the file rather than
 * write an empty attribute.
 */
export function printExpressionSafe(expr: Expression): PrintedExpression {
  try {
    return { text: printExpression(expr), diagnostics: [] };
  } catch (err) {
    if (err instanceof ExpressionPrintError) {
      return { text: UNSUPPORTED_EXPRESSION_PLACEHOLDER, diagnostics: [err.message] };
    }
    throw err;
  }
}
