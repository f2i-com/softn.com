/**
 * The evaluator of template expressions: what `{count + 1}`, `@click={() => save(item)}`
 * and `#if (items.length)` are worth, against the page's state, its functions and
 * the names the template has bound around them.
 *
 * An expression runs in the host page, not in the script VM, so what it can reach
 * is held here: the globals it sees (JS_GLOBALS), what `new` may construct, which
 * keys a member access may read, and when it may write state. render.tsx draws the
 * page with it.
 */

import type { ArrowFunctionExpression, BindingPattern, BindingTarget, Expression } from '../parser/ast';
import { isIdentifierName } from '../parser/ast';
import type { SoftNLocalScope, SoftNRenderContext } from '../types';
import { parseStatePath } from '../runtime/state-path';
import { markupValue } from './host-values';
import { isDevelopment } from './development';

/**
 * Write `value` at `path` in `state`, copying each record and list on the
 * way rather than changing it: what the path passes through may be the
 * page's own state, which only React writes.
 */
function writeStatePath(state: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) return;
  let into: Record<string, unknown> | unknown[] = state;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next: unknown = (into as Record<string, unknown>)[key];
    const copy: Record<string, unknown> | unknown[] = Array.isArray(next)
      ? [...next]
      : next !== null && typeof next === 'object'
        ? { ...(next as Record<string, unknown>) }
        : {};
    (into as Record<string, unknown>)[key] = copy;
    into = copy;
  }
  (into as Record<string, unknown>)[path[path.length - 1]] = value;
}

// Maximum recursion depth for expression evaluation to prevent infinite loops
const MAX_EVAL_DEPTH = 100;

/**
 * What a template sees as `Object`.
 *
 * Not the real one: `Object.defineProperty` and its relatives are how a
 * template would rewrite the page it runs in. These three only read, and
 * `#each (key in Object.keys(totals))` is how a map is listed. `null` and
 * `undefined` answer an empty list, because data that has not loaded yet is
 * the usual reason a template meets them.
 *
 * They list what markup may hold (host-values.ts), going in and coming out:
 * `list.map(Object.entries)` is the browser calling these on whatever the
 * list holds, with no expression in between to check it.
 */
const TEMPLATE_OBJECT = Object.freeze({
  keys: (value: unknown) => Object.keys(Object(markupValue(value) ?? {})),
  values: (value: unknown) => Object.values(Object(markupValue(value) ?? {})).map(markupValue),
  entries: (value: unknown) =>
    Object.entries(Object(markupValue(value) ?? {})).map(([key, held]): [string, unknown] => [key, markupValue(held)]),
});

/**
 * JavaScript globals available in template expressions.
 * These are commonly used in .ui files (e.g., Number(), String(), Math.round()).
 */
const JS_GLOBALS: Record<string, unknown> = {
  Number,
  String,
  Boolean,
  Array,
  Date,
  Map,
  Set,
  Math,
  JSON,
  Object: TEMPLATE_OBJECT,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  NaN,
  Infinity,
  undefined,
  encodeURIComponent,
  decodeURIComponent,
  // `new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`:
  // formatters, which read and write nothing. It was undefined, so such a
  // price showed nothing.
  Intl,
};

/**
 * What `new` may construct in a template.
 *
 * An expression here runs in the host page, not in the script VM, so `new`
 * on whatever a name evaluates to would be a way to run a constructor the
 * author was never handed. These build values and nothing else.
 */
const CONSTRUCTIBLE: ReadonlySet<unknown> = new Set([
  Date,
  Array,
  Map,
  Set,
  ...Object.values(Object.getOwnPropertyDescriptors(Intl))
    .map((descriptor) => descriptor.value as unknown)
    .filter((value) => typeof value === 'function' && /^[A-Z]/.test((value as { name: string }).name)),
]);

/** The keys no template may read or write: the way from a value to its constructor and prototype. */
export const BLOCKED_MEMBER_KEYS = new Set(['constructor', '__proto__', 'prototype']);

/**
 * How many `renderNode` calls are on the stack. Above zero the page is being
 * drawn, and an expression evaluated now is one the page shows, not one a
 * person triggered: see `stateWriteAllowed`.
 */
let renderDepth = 0;

/** One more level of the page is being drawn: the depth it is drawn at now. */
export function beginDrawing(): number {
  return ++renderDepth;
}

/** The level begun last is drawn. */
export function endDrawing(): void {
  renderDepth--;
}

/** Expressions already reported for writing state while the page was drawn. */
const reportedRenderWrites = new WeakSet<object>();

/**
 * Whether an assignment or `++` may write state right now.
 *
 * A handler runs when something happens; `{count++}` in the body of a page
 * runs every time the page is drawn, and the write it makes causes the next
 * drawing. With `++` readable that is a loop from one keystroke: React stops
 * it by tearing the document down ("Too many re-renders"). So while the page
 * is being drawn the expression is worth what it would be worth and writes
 * nothing, and says so once. An arrow called during the drawing, such as the
 * callback of `items.map(…)`, is the same case; an arrow called by an event
 * is not, because by then nothing is being drawn.
 */
function stateWriteAllowed(expr: Expression, what: string): boolean {
  if (renderDepth === 0) return true;
  if (!reportedRenderWrites.has(expr)) {
    reportedRenderWrites.add(expr);
    console.error(
      `[SoftN] ${what} on line ${expr.loc?.line ?? '?'} changes state while the page is being drawn, ` +
        'which would draw it again without end, so the change was not made. ' +
        'Change state in a handler: @click={() => count++}.'
    );
  }
  return false;
}

/**
 * `left operator right` for an operator on numbers: `-`, `*`, `/`, `%`,
 * `**`, the bitwise ones and the shifts, as in a template and as the
 * compound assignment (`-=`, `|=`) without its `=`.
 */
function arithmetic(operator: string, left: unknown, right: unknown): unknown {
  const a = left as number;
  const b = right as number;
  switch (operator) {
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    case '**':
      return a ** b;
    case '&':
      return a & b;
    case '|':
      return a | b;
    case '^':
      return a ^ b;
    case '<<':
      return a << b;
    case '>>':
      return a >> b;
    case '>>>':
      return a >>> b;
    default:
      return undefined;
  }
}

export function getSafeMemberKey(value: unknown): string | null {
  const key = String(value);
  return BLOCKED_MEMBER_KEYS.has(key) ? null : key;
}

/**
 * The values of an argument list or an array literal, with every `...list`
 * laid out in place.
 *
 * A list spreads its items; so does anything else that iterates (a string's
 * characters, a Set's members). `null` and `undefined` spread to nothing
 * rather than throwing, because the usual reason a template meets one is
 * data that has not arrived yet; anything else that cannot be iterated is
 * dropped the same way.
 */
export function evaluateArguments(
  nodes: Expression[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown[] {
  const values: unknown[] = [];
  for (const node of nodes) {
    if (node.type !== 'SpreadElement') {
      values.push(evaluate(node, context, locals, depth));
      continue;
    }
    const spread = evaluate(node.argument, context, locals, depth);
    if (Array.isArray(spread)) {
      // Not push(...spread): a long list would overflow the call stack.
      for (const item of spread) values.push(item);
    } else if (
      spread !== null &&
      spread !== undefined &&
      typeof (spread as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
    ) {
      for (const item of spread as Iterable<unknown>) values.push(item);
    }
  }
  return values;
}

/** A value as the list a list pattern takes apart: a list is itself, a Set or Map its members. */
function listToTakeApart(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  ) {
    return Array.from(value as Iterable<unknown>);
  }
  return [];
}

/**
 * Take `value` apart by `pattern`, pushing what each name is bound to onto
 * `values` in the order `patternNames` lists the names.
 *
 * Where JavaScript would throw (a list pattern given a number, a record
 * pattern given null) every name is `undefined`: a template meets data that
 * has not arrived far more often than data of the wrong kind. Keys are read
 * under the rule a member access is, so `{ constructor }` binds nothing.
 *
 * `defaults` evaluates a default; it is absent for an `#each`, whose
 * patterns have none.
 */
export function takeApart(
  pattern: BindingPattern,
  value: unknown,
  values: unknown[],
  defaults?: (expr: Expression) => unknown
): void {
  // As markup holds it (host-values.ts), at every depth: `({ view: { eval } })`
  // would otherwise read through an event to the window inside one pattern.
  value = markupValue(value);
  if (pattern.type === 'NamePattern') {
    values.push(value);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    const list = listToTakeApart(value);
    for (let i = 0; i < pattern.elements.length; i++) bindTarget(pattern.elements[i], list[i], values, defaults);
    if (pattern.rest) takeApart(pattern.rest, list.slice(pattern.elements.length), values, defaults);
    return;
  }
  const record = value === null || value === undefined ? undefined : (value as Record<string, unknown>);
  for (const property of pattern.properties) {
    const key = getSafeMemberKey(property.key);
    bindTarget(property.value, record !== undefined && key !== null ? record[key] : undefined, values, defaults);
  }
  if (pattern.rest !== undefined) {
    const rest: Record<string, unknown> = {};
    if (record !== undefined && typeof record === 'object') {
      const taken = new Set(pattern.properties.map((property) => property.key));
      for (const key of Object.keys(record)) {
        if (!taken.has(key) && !BLOCKED_MEMBER_KEYS.has(key)) rest[key] = record[key];
      }
    }
    values.push(rest);
  }
}

function bindTarget(
  target: BindingTarget,
  value: unknown,
  values: unknown[],
  defaults?: (expr: Expression) => unknown
): void {
  takeApart(
    target.pattern,
    value === undefined && target.default && defaults ? defaults(target.default) : value,
    values,
    defaults
  );
}

/**
 * What an arrow's names are bound to for a call, when its parameters are
 * more than names. A default is evaluated with the parameters before it
 * already bound, as in JavaScript (`(a, b = a) => …`).
 */
function boundParams(
  expr: ArrowFunctionExpression,
  args: unknown[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown[] {
  const values: unknown[] = [];
  // The layer the body will see, already in place for the defaults: a name
  // not bound yet is past the end of `values`, and reads as undefined.
  const scope: SoftNLocalScope = { names: expr.params, values, parent: locals };
  const defaults = (expression: Expression) => evaluate(expression, context, scope, depth + 1);
  const patterns = expr.patterns ?? [];
  for (let i = 0; i < patterns.length; i++) {
    const param = patterns[i];
    if (param.rest) takeApart(param.pattern, args.slice(i), values, defaults);
    else bindTarget(param, args[i], values, defaults);
  }
  return values;
}

/**
 * For each name a pattern binds, what follows the item's own place in state:
 * `.title` for `{ title }`, `[0]` for the first of `[a, b]`. A name with no
 * place of its own (a rest, a key a path cannot spell) is `undefined`.
 */
export function patternSuffixes(pattern: BindingPattern, prefix: string | undefined, into: Array<string | undefined>): void {
  if (pattern.type === 'NamePattern') {
    into.push(prefix);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element, i) =>
      patternSuffixes(element.pattern, prefix === undefined ? undefined : `${prefix}[${i}]`, into)
    );
    if (pattern.rest) patternSuffixes(pattern.rest, undefined, into);
    return;
  }
  for (const property of pattern.properties) {
    const step = isIdentifierName(property.key) ? `.${property.key}` : pathStep(property.key);
    patternSuffixes(property.value.pattern, prefix === undefined || step === null ? undefined : prefix + step, into);
  }
  if (pattern.rest !== undefined) into.push(undefined);
}

/**
 * Evaluate an expression in the given context
 * Includes recursion depth tracking to prevent infinite loops
 */
export function evaluateExpression(
  expr: Expression,
  context: SoftNRenderContext,
  depth: number = 0
): unknown {
  return evaluate(expr, context, context.locals, depth);
}

/**
 * The evaluator itself. `locals` is what the template has bound here: it
 * starts as the context's (the loops around the expression) and gains a
 * layer for each arrow called, which is why it is passed beside the context
 * rather than read from it. A call of an arrow then costs one small layer,
 * where it used to copy the context and every state variable in it.
 */
export function evaluate(
  expr: Expression,
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown {
  // Prevent infinite recursion
  if (depth > MAX_EVAL_DEPTH) {
    if (isDevelopment) {
      console.error(
        '[SoftN] Maximum expression evaluation depth exceeded. Possible circular reference.'
      );
    }
    return undefined;
  }

  switch (expr.type) {
    case 'Identifier':
      // What the template bound itself comes first: a loop variable or an
      // arrow's parameter hides a state variable of the same name.
      for (let scope = locals; scope; scope = scope.parent) {
        const at = scope.names.indexOf(expr.name);
        if (at !== -1) return markupValue(scope.values[at]);
      }
      // Then state, data, computed, props, functions, then JS globals.
      //
      // Own keys only: these are plain objects, so `in` also answered yes for
      // everything on Object.prototype, and an identifier named `constructor`
      // resolved to `Object` itself — from which `defineProperty(__proto__, …)`
      // is a short step to running arbitrary code from a template.
      if (Object.hasOwn(context.state, expr.name)) {
        return markupValue(context.state[expr.name]);
      }
      if (Object.hasOwn(context.data, expr.name)) {
        return markupValue(context.data[expr.name]);
      }
      if (Object.hasOwn(context.computed, expr.name)) {
        // A computed is stored as a thunk — `() => callComputed(name)` — because
        // its value has to be re-derived whenever the state it reads moves.
        // Returning the thunk handed the template the function instead of the
        // value, so `#each (todo in filteredTodos)` iterated a function and
        // rendered its source into the page:
        //   (...r)=>{let i={...t,state:{...t.state}};if(e.para
        const value = context.computed[expr.name];
        return markupValue(typeof value === 'function' ? (value as () => unknown)() : value);
      }
      if (Object.hasOwn(context.props, expr.name)) {
        return markupValue(context.props[expr.name]);
      }
      if (Object.hasOwn(context.functions, expr.name)) {
        return context.functions[expr.name];
      }
      if (Object.hasOwn(JS_GLOBALS, expr.name)) {
        return JS_GLOBALS[expr.name];
      }
      // Identifier not found - return undefined (data may not be loaded yet)
      return undefined;

    case 'Literal':
      return expr.value;

    case 'BinaryExpression': {
      // Short-circuit operators must evaluate right side lazily
      if (expr.operator === '&&') {
        const left = evaluate(expr.left, context, locals, depth + 1);
        return left ? evaluate(expr.right, context, locals, depth + 1) : left;
      }
      if (expr.operator === '||') {
        const left = evaluate(expr.left, context, locals, depth + 1);
        return left ? left : evaluate(expr.right, context, locals, depth + 1);
      }
      if (expr.operator === '??') {
        const left = evaluate(expr.left, context, locals, depth + 1);
        return left != null ? left : evaluate(expr.right, context, locals, depth + 1);
      }

      const left = evaluate(expr.left, context, locals, depth + 1);
      const right = evaluate(expr.right, context, locals, depth + 1);

      switch (expr.operator) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') {
            return String(left ?? '') + String(right ?? '');
          }
          return (left as number) + (right as number);
        case '-':
        case '*':
        case '/':
        case '%':
        case '**':
        case '&':
        case '|':
        case '^':
        case '<<':
        case '>>':
        case '>>>':
          return arithmetic(expr.operator, left, right);
        case 'in': {
          // JavaScript throws for a right side that is not an object; a
          // template asks this of data that has not loaded yet.
          if (right === null || (typeof right !== 'object' && typeof right !== 'function')) {
            return false;
          }
          const key = getSafeMemberKey(left);
          return key !== null && key in (right as object);
        }
        case '==':
          return left == right;
        case '!=':
          return left != right;
        case '===':
          return left === right;
        case '!==':
          return left !== right;
        case '<':
          return (left as number) < (right as number);
        case '>':
          return (left as number) > (right as number);
        case '<=':
          return (left as number) <= (right as number);
        case '>=':
          return (left as number) >= (right as number);
        case 'instanceof':
          return typeof right === 'function'
            ? left instanceof (right as new (...args: unknown[]) => unknown)
            : false;
        default:
          return undefined;
      }
    }

    case 'UnaryExpression': {
      const arg = evaluate(expr.argument, context, locals, depth + 1);

      switch (expr.operator) {
        case '!':
          return !arg;
        case '-':
          return -(arg as number);
        case '+':
          return +(arg as number);
        case 'typeof':
          return typeof arg;
        case 'void':
          return void arg;
        case '~':
          return ~(arg as number);
        default:
          return undefined;
      }
    }

    case 'MemberExpression': {
      const obj = evaluate(expr.object, context, locals, depth + 1);

      // Handle optional chaining - return undefined if object is null/undefined
      // This gracefully handles cases like {selectedItem.name} when selectedItem is null
      if (obj == null) {
        return undefined;
      }

      // Handle primitive types that can have methods (string, number)
      const target = obj as Record<string, unknown>;

      if (expr.computed) {
        const prop = evaluate(expr.property, context, locals, depth + 1);
        const safeKey = getSafeMemberKey(prop);
        if (safeKey === null) return undefined;
        return markupValue(target[safeKey]);
      } else if (expr.property.type === 'Identifier') {
        const safeKey = getSafeMemberKey(expr.property.name);
        if (safeKey === null) return undefined;
        return markupValue(target[safeKey]);
      }

      return undefined;
    }

    case 'CallExpression': {
      // For method calls (e.g., arr.filter(...)), preserve `this` binding
      let fn: unknown;
      let thisObj: unknown = undefined;

      if (expr.callee.type === 'MemberExpression') {
        thisObj = evaluate(expr.callee.object, context, locals, depth + 1);
        if (thisObj != null) {
          const target = thisObj as Record<string, unknown>;
          if (expr.callee.computed) {
            const prop = evaluate(expr.callee.property, context, locals, depth + 1);
            const safeKey = getSafeMemberKey(prop);
            if (safeKey === null) {
              fn = undefined;
            } else {
              fn = target[safeKey];
            }
          } else if (expr.callee.property.type === 'Identifier') {
            const safeKey = getSafeMemberKey(expr.callee.property.name);
            if (safeKey === null) {
              fn = undefined;
            } else {
              fn = target[safeKey];
            }
          }
        }
      } else {
        fn = evaluate(expr.callee, context, locals, depth + 1);
      }

      // Handle optional chaining - return undefined if function is null/undefined
      if (fn == null) {
        if (expr.optional) {
          return undefined;
        }
        // Only warn if the script has finished loading. Before loadScript() completes,
        // functions are not yet available — this is normal and not worth warning about.
        if (context.scriptLoaded) {
          const funcName =
            expr.callee.type === 'Identifier'
              ? expr.callee.name
              : expr.callee.type === 'MemberExpression' && expr.callee.property.type === 'Identifier'
                ? expr.callee.property.name
                : 'unknown';
          console.warn(
            `[SoftN] Function "${funcName}" not found. Callee evaluated to ${fn === null ? 'null' : 'undefined'}`
          );
        }
        return undefined;
      }

      const args = evaluateArguments(expr.arguments, context, locals, depth + 1);

      if (typeof fn === 'function') {
        if (fn === Function) {
          return undefined;
        }
        // Bind `this` for method calls (arr.filter, str.toUpperCase, etc.)
        return markupValue(thisObj != null ? fn.apply(thisObj, args) : fn(...args));
      }

      return undefined;
    }

    case 'ConditionalExpression': {
      const test = evaluate(expr.test, context, locals, depth + 1);
      return test ? evaluate(expr.consequent, context, locals, depth + 1) : evaluate(expr.alternate, context, locals, depth + 1);
    }

    case 'UpdateExpression': {
      // `count++` writes through the same path an assignment does, so
      // `rows[i].qty++` inside an #each changes that row.
      const path = getExpressionPath(expr.argument, context, locals);
      if (!path) {
        if (!reportUnplacedWrite(expr.argument, locals) && isDevelopment) {
          console.error(`[SoftN] Cannot apply "${expr.operator}" to this expression; it must be a name or a property path.`);
        }
        return undefined;
      }
      const current = Number(evaluate(expr.argument, context, locals, depth + 1));
      const next = expr.operator === '++' ? current + 1 : current - 1;
      if (stateWriteAllowed(expr, `"${expr.operator}"`)) context.setState(path, next);
      return expr.prefix ? next : current;
    }

    case 'NewExpression': {
      const ctor = evaluate(expr.callee, context, locals, depth + 1);
      if (!CONSTRUCTIBLE.has(ctor)) {
        if (isDevelopment) {
          console.error('[SoftN] "new" in a template constructs Date, Array, Map, Set or an Intl formatter only; build anything else in a logic function.');
        }
        return undefined;
      }
      const args = evaluateArguments(expr.arguments, context, locals, depth + 1);
      return new (ctor as new (...a: unknown[]) => unknown)(...args);
    }

    case 'AssignmentExpression': {
      // `count = count + 1` in a handler: the parser reads it whole now, and
      // the write goes through the same setState a `:value` binding uses, at
      // the same resolved path — so `todos[i].done = true` inside an #each
      // writes the row, not a key called "i". A target that is not a state
      // path (a call, a literal) is a parse-time diagnostic; here it is
      // reported once and the assignment is a no-op rather than a throw that
      // would take the whole handler down.
      const path = getExpressionPath(expr.left, context, locals);
      if (!path) {
        if (!reportUnplacedWrite(expr.left, locals) && isDevelopment) {
          console.error('[SoftN] Cannot assign to this expression; the left side must be a name or a property path.');
        }
        return undefined;
      }
      const right = evaluate(expr.right, context, locals, depth + 1);
      let value: unknown;
      switch (expr.operator) {
        case '=':
          value = right;
          break;
        case '??=': {
          const current = evaluate(expr.left, context, locals, depth + 1);
          if (current !== null && current !== undefined) return current;
          value = right;
          break;
        }
        case '||=': {
          const current = evaluate(expr.left, context, locals, depth + 1);
          if (current) return current;
          value = right;
          break;
        }
        case '&&=': {
          const current = evaluate(expr.left, context, locals, depth + 1);
          if (!current) return current;
          value = right;
          break;
        }
        case '+=': {
          const current = evaluate(expr.left, context, locals, depth + 1);
          value =
            typeof current === 'string' || typeof right === 'string'
              ? String(current) + String(right)
              : (current as number) + (right as number);
          break;
        }
        default:
          value = arithmetic(expr.operator.slice(0, -1), evaluate(expr.left, context, locals, depth + 1), right);
      }
      if (stateWriteAllowed(expr, `The assignment "${expr.operator}"`)) context.setState(path, value);
      return value;
    }

    case 'ArrowFunctionExpression': {
      return (...given: unknown[]) => {
        // Whoever calls this (an event, a component's callback, `list.map`)
        // may hand it a piece of the browser; markup holds none
        // (host-values.ts).
        const args = given.map(markupValue);
        // The parameters are a layer over what was bound where the arrow
        // was written. An argument that was not passed is `undefined`, which
        // is what reading past the end of `args` gives.
        const values = () => (expr.patterns ? boundParams(expr, args, context, locals, depth) : args);

        if (expr.statements) {
          // A block body, `{ count++; save() }`: each statement in turn, as
          // the expressions they are, under the same rules. A write to state
          // is made from a handler and refused while the page is drawn
          // (stateWriteAllowed), as for any expression. The page's state is
          // written when React next draws it, so the block reads its own
          // writes from a copy kept here: `n = n + 1; n++` adds two.
          const state: Record<string, unknown> = { ...context.state };
          const block: SoftNRenderContext = {
            ...context,
            state,
            setState: (path, value) => {
              const parts = parseStatePath(path);
              writeStatePath(state, parts, value);
              context.setState(path, value);
              // And to the logic, for a function a later statement calls.
              if (parts.length > 0) context.shareState?.({ [parts[0]]: state[parts[0]] });
            },
          };
          const scope = { names: expr.params, values: values(), parent: locals };
          for (const statement of expr.statements) evaluate(statement, block, scope, depth + 1);
          return expr.returns ? evaluate(expr.returns, block, scope, depth + 1) : undefined;
        }

        if (typeof expr.body === 'string') {
          // A block body with a statement markup does not read (`if`, `let`,
          // a loop) runs nothing; the parser said which and why. It used to
          // fail in complete silence, so it says so here as well, when it is
          // pressed, where a person is looking.
          console.error(
            `[SoftN] This handler did not run: its { } body has a statement markup does not read ` +
              `(${expr.body.replace(/\s+/g, ' ').slice(0, 80)}). Put it in a <logic> function and call that.`
          );
          return undefined;
        }

        return evaluate(expr.body, context, { names: expr.params, values: values(), parent: locals }, depth + 1);
      };
    }

    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (prop.type === 'SpreadElement') {
          // `{ ...base, color: "red" }`: own enumerable keys, in order, under
          // the same key rule as a written property. Nothing to spread (data
          // not loaded yet, a number) contributes nothing.
          const source = evaluate(prop.argument, context, locals, depth + 1);
          if (source !== null && typeof source === 'object') {
            for (const key of Object.keys(source)) {
              if (BLOCKED_MEMBER_KEYS.has(key)) continue;
              obj[key] = (source as Record<string, unknown>)[key];
            }
          }
          continue;
        }
        if (prop.computedKey) {
          // `{ [field]: value }`. The key goes through the rule every key
          // read from a template goes through, so one that works out to
          // `__proto__` sets nothing rather than the object's prototype.
          const key = getSafeMemberKey(evaluate(prop.computedKey, context, locals, depth + 1));
          const value = evaluate(prop.value, context, locals, depth + 1);
          if (key !== null) obj[key] = value;
          continue;
        }
        // Prevent prototype pollution from user expressions
        if (prop.key === '__proto__' || prop.key === 'constructor' || prop.key === 'prototype') continue;
        obj[prop.key] = evaluate(prop.value, context, locals, depth + 1);
      }
      return obj;
    }

    case 'ArrayExpression': {
      return evaluateArguments(expr.elements, context, locals, depth + 1);
    }

    case 'SpreadElement': {
      // Spread elements should be handled in their parent context (object/array)
      const value = evaluate(expr.argument, context, locals, depth + 1);
      return value;
    }

    case 'TemplateLiteral': {
      // Template literal: combine quasis and expressions
      let result = '';
      const quasis = expr.quasis || [];
      const expressions = expr.expressions || [];

      for (let i = 0; i < quasis.length; i++) {
        const q = quasis[i];
        // quasis[i] may be a TemplateElement object or a plain string
        result += typeof q === 'string' ? q : (q?.value?.cooked ?? q?.value?.raw ?? String(q ?? ''));
        if (i < expressions.length) {
          result += String(evaluate(expressions[i], context, locals, depth + 1) ?? '');
        }
      }
      return result;
    }

    default:
      return undefined;
  }
}

/** `[3]` or `["theme"]`: one step of a state path, or null for a key a path cannot spell. */
export function pathStep(position: number | string): string | null {
  if (typeof position === 'number') return `[${position}]`;
  // The path is split on `]` and has its quotes taken off, so a key holding
  // either cannot be written back whole, and an empty one is dropped.
  return position === '' || /["'\]]/.test(position) ? null : `["${position}"]`;
}

/** Where in the app's state the value of `scope.names[at]` lives, or null when it has no place there. */
function placeInState(scope: SoftNLocalScope, at: number): string | null {
  const suffix = scope.suffixes?.[at];
  if (scope.list === undefined || scope.position === undefined || suffix === undefined) return null;
  const step = pathStep(scope.position);
  return step === null ? null : scope.list + step + suffix;
}

/**
 * The path of a list an `#each` goes through, when it is one a row can be
 * written back to: a path whose first name is a state variable, or a prop
 * (which the binding hands to the parent's handler). A collection's records
 * and a computed value read the same way and are not state: writing at
 * `notes[0].title` would make a state variable called `notes` that hides the
 * collection. The order is the one a name is looked up in.
 */
export function writableListPath(expr: Expression, context: SoftNRenderContext): string | null {
  const path = getExpressionPath(expr, context);
  if (!path) return null;
  const end = path.search(/[.[]/);
  const root = end === -1 ? path : path.slice(0, end);
  if (Object.hasOwn(context.state, root)) return path;
  if (Object.hasOwn(context.data, root) || Object.hasOwn(context.computed, root)) return null;
  return Object.hasOwn(context.props, root) ? path : null;
}

/** An assignment target as it was written, for a message: `todo.done`, `rows[i].qty`. */
function spelledTarget(expr: Expression): string {
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'MemberExpression') {
    const object = spelledTarget(expr.object);
    if (!expr.computed && expr.property.type === 'Identifier') return `${object}.${expr.property.name}`;
    if (expr.property.type === 'Identifier') return `${object}[${expr.property.name}]`;
    if (expr.property.type === 'Literal') return `${object}[${expr.property.raw}]`;
    return `${object}[…]`;
  }
  return '…';
}

/** Targets already reported as having no place in state. */
const reportedUnplacedWrites = new WeakSet<object>();

/**
 * Report, once, a write whose target starts from a name the template bound
 * and that has no place in the app's state. True when that is what `target`
 * is (reported now or before); false when it is something else, which the
 * caller has its own words for.
 *
 * Not kept to development: the control or button this is behind looks
 * ordinary and does nothing, and this line is the only thing that says why.
 */
export function reportUnplacedWrite(target: Expression, locals: SoftNLocalScope | undefined): boolean {
  let root = target;
  while (root.type === 'MemberExpression') root = root.object;
  if (root.type !== 'Identifier') return false;
  const name = root.name;
  let bound = false;
  for (let scope = locals; scope && !bound; scope = scope.parent) bound = scope.names.includes(name);
  if (!bound) return false;
  if (!reportedUnplacedWrites.has(target)) {
    reportedUnplacedWrites.add(target);
    console.error(
      `[SoftN] "${spelledTarget(target)}" on line ${target.loc?.line ?? '?'} was not written: "${name}" is a name ` +
        'the page itself bound (an item of a list that is worked out in the page or is not the app’s state, ' +
        'a loop’s index, or an arrow’s parameter), so there is nowhere in state to write it. ' +
        'Loop over the state list itself, or make the change in a logic function.'
    );
  }
  return true;
}

/**
 * Get the path string from an expression (for state updates)
 * Supports complex paths including computed properties and optional chaining
 */
export function getExpressionPath(
  expr: Expression,
  context?: SoftNRenderContext,
  locals: SoftNLocalScope | undefined = context?.locals
): string | null {
  if (expr.type === 'Identifier') {
    // A name the template bound is not a state variable. An `#each` variable
    // over a list in state stands for a place in that list, and the path is
    // that place; anything else bound here (an index, an arrow's parameter,
    // an item of a list that was worked out) has no place to write to.
    // Answering with the name, as this did, wrote a state variable called
    // after the loop variable.
    for (let scope = locals; scope; scope = scope.parent) {
      const at = scope.names.indexOf(expr.name);
      if (at !== -1) return placeInState(scope, at);
    }
    return expr.name;
  }

  if (expr.type === 'MemberExpression') {
    const objectPath = getExpressionPath(expr.object, context, locals);
    if (!objectPath) return null;

    if (!expr.computed && expr.property.type === 'Identifier') {
      return `${objectPath}.${expr.property.name}`;
    }

    // Handle computed properties like items[0] or items[index]
    if (expr.computed) {
      if (expr.property.type === 'Literal') {
        const key = expr.property.value;
        if (typeof key === 'number') {
          return `${objectPath}[${key}]`;
        }
        if (typeof key === 'string') {
          return `${objectPath}["${key}"]`;
        }
      }
      if (expr.property.type === 'Identifier') {
        // Resolve the index, do not name it.
        //
        // This returned `todos[i]` — the identifier's spelling — so a :bind
        // inside `#each (todo, i in todos)` wrote every row's edit to a literal
        // key called "i". The real row was never touched and a junk entry
        // appeared beside the list, so typing in the second row changed nothing
        // visible and quietly corrupted the data behind it.
        if (context) {
          const index = evaluate(expr.property, context, locals, 0);
          if (typeof index === 'number' || typeof index === 'string') {
            return typeof index === 'number'
              ? `${objectPath}[${index}]`
              : `${objectPath}["${index}"]`;
          }
        }
        // Without a context there is nothing to resolve against; the caller
        // gets the old placeholder rather than a silently wrong path.
        return `${objectPath}[${expr.property.name}]`;
      }
    }
  }

  return null;
}
