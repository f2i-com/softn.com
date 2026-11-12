/**
 * The evaluator of template expressions: what `{count + 1}`, `@click={() => save(item)}`
 * and `#if (items.length)` are worth, against the page's state, its functions and
 * the names the template has bound around them.
 *
 * An expression runs in the host page, not in the script VM, so what it can reach
 * is held here: the globals it sees (JS_GLOBALS), what `new` may construct, which
 * keys a member access may read, and when it may write state. render.tsx draws the
 * page with it.
 *
 * There are two ways through an expression. `evaluate` works it out at once,
 * which is how a page is drawn. `waited` is for a handler, where a logic call
 * answers a promise: it works out the same thing by the same rules, and where
 * a value is still on its way it waits for it before going on. Both use the
 * functions between them here for what an operator, a member, a call or an
 * assignment is worth, so a rule about what markup may reach is written once.
 */

import type {
  ArrowFunctionExpression,
  AssignmentExpression,
  BindingPattern,
  BindingTarget,
  CallExpression,
  Expression,
  TemplateLiteral,
} from '../parser/ast';
import { isIdentifierName } from '../parser/ast';
import type { SoftNLocalScope, SoftNRenderContext } from '../types';
import { callFailed } from '../runtime/failed-calls';
import { parseStatePath } from '../runtime/state-path';
import { isArrayMutator, markupValue } from './host-values';
import { isDevelopment } from './development';

/**
 * Write `value` at `path` in `state`, copying each record and list on the
 * way rather than changing it: what the path passes through may be the
 * page's own state, which only React writes.
 */
export function writeStatePath(state: Record<string, unknown>, path: readonly string[], value: unknown): void {
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

/**
 * What `state` holds at `path`, or `undefined` where the path leads nowhere.
 * Own keys only, and none a template may not read: a path is made from what
 * a page wrote, and `todos.constructor` is not a place in anyone's state.
 */
function readStatePath(state: Record<string, unknown>, path: readonly string[]): unknown {
  let at: unknown = state;
  for (const key of path) {
    if (at === null || typeof at !== 'object' || BLOCKED_MEMBER_KEYS.has(key) || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
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
 * A namespace a template may read but not write: a frozen copy of `space`'s
 * own members (the same functions and constants). The page's own `Math`,
 * `JSON` and `Intl` are shared by every app on it and by the host, and a
 * template holding them could write onto them through a generic array
 * method (`[].push.call(Math, 1)`, or `list.forEach([].push, JSON)`).
 */
function readOnlyNamespace(space: object): object {
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.getOwnPropertyNames(space)) copy[key] = (space as Record<string, unknown>)[key];
  return Object.freeze(copy);
}

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
  Math: readOnlyNamespace(Math),
  JSON: readOnlyNamespace(JSON),
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
  // price showed nothing. Its constructors are the real ones (CONSTRUCTIBLE).
  Intl: readOnlyNamespace(Intl),
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

/**
 * The keys no template may read or write: the way from a value to its
 * constructor and prototype, and the four legacy accessor methods every
 * object inherits, through which `Math.__defineGetter__("random", f)` rewrote
 * the page's own `Math` and `__lookupGetter__("__proto__")` handed over
 * `Object.prototype` to define a property every object then had.
 */
export const BLOCKED_MEMBER_KEYS = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/**
 * How many `renderNode` calls are on the stack. Above zero the page is being
 * drawn, and an expression evaluated now is one the page shows, not one a
 * person triggered: see `stateWriteAllowed`.
 */
let renderDepth = 0;

/** One more level of the page is being drawn: the depth it is drawn at now. */
export function beginDrawing(): number {
  // A new drawing: the lists the last one made are no longer markup's own,
  // and the state it reads is the state as it now stands (see `changeList`).
  if (renderDepth === 0) {
    madeByMarkup = null;
    changedLists = null;
  }
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

// ── What each form is worth, once its parts are worked out ──────────────────
//
// `evaluate` and `waited` differ only in how they come by the parts.

/**
 * `left operator right` for an operator that needs both sides: every one but
 * `&&`, `||` and `??`, which may not work the right side out at all.
 */
function binaryValue(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
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
      return arithmetic(operator, left, right);
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

/** `operator arg`: `!ok`, `-n`, `typeof value`. */
function unaryValue(operator: string, arg: unknown): unknown {
  switch (operator) {
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

/**
 * `object.key` or `object[key]`, of an object that is not null: as markup
 * may hold it, and nothing for a key no template may read.
 */
function memberValue(object: unknown, key: unknown): unknown {
  const safeKey = getSafeMemberKey(key);
  if (safeKey === null) return undefined;
  // Handle primitive types that can have methods (string, number)
  return markupValue((object as Record<string, unknown>)[safeKey]);
}

/** The function a call `object.key(…)` makes, read under the same key rule. */
function methodOf(object: unknown, key: unknown): unknown {
  const safeKey = getSafeMemberKey(key);
  return safeKey === null ? undefined : (object as Record<string, unknown>)[safeKey];
}

/** Say that a call found no function to make, unless that is expected. */
function reportMissingFunction(expr: CallExpression, fn: null | undefined, context: SoftNRenderContext): void {
  // Handle optional chaining - return undefined if function is null/undefined
  if (expr.optional) return;
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
}

/**
 * Call `fn`, which is not null, on `thisObj` with `args`: what the call
 * `expr` answers, as markup may hold it.
 */
function callValue(
  expr: CallExpression,
  fn: unknown,
  thisObj: unknown,
  args: unknown[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined
): unknown {
  if (typeof fn === 'function') {
    if (fn === Function) {
      return undefined;
    }
    // `list.push(x)` on a list; on anything else it writes onto a shared object (host-values.ts).
    if (isArrayMutator(fn)) {
      if (!Array.isArray(thisObj)) return undefined;
      return changeList(expr, fn as (...args: unknown[]) => unknown, thisObj, args, context, locals);
    }
    // Bind `this` for method calls (arr.filter, str.toUpperCase, etc.)
    const answer = markupValue(thisObj != null ? fn.apply(thisObj, args) : fn(...args));
    if (Array.isArray(answer) && answer !== thisObj && MAKES_A_LIST.has(fn) && !changesState(context)) madeHere(answer);
    return answer;
  }

  return undefined;
}

// ── `list.push(x)`, `list.sort()`: the methods that change the list itself ──
//
// A list in the app's state is React's, and the logic's copy of it is the
// logic's. Changed where it lies, by `@click={() => items.push(draft)}`,
// neither heard of it: nothing was drawn until something else changed, the
// logic's `items` lacked the entry, and what the logic wrote back next took it
// away again. `#each (x in list.reverse())` turned the stored list round each
// time the page was drawn.
//
// So such a method is made on a copy. In a handler the copy is written to
// state where the list was, as `items = [...items, draft]` would write it:
// the page is drawn again and the logic is told. While the page is drawn the
// copy is all there is: `list.sort()` is the list in order, and state is as
// it was. A list that is nobody's state (one markup made in the same
// expression, or one a handler was handed) is changed as JavaScript changes it.

/**
 * Whether an expression evaluated in `context`, now, is a handler's: it may
 * change state. An arrow written where the page is drawn (`format={(rows) =>
 * rows.sort()}`) is not, whenever a component calls it.
 */
function changesState(context: SoftNRenderContext): boolean {
  return renderDepth === 0 && context.waitsForCalls === true;
}

/**
 * The lists markup itself has made since the page began to be drawn: a list
 * literal, what `slice` or `filter` answered, a copy made below. Such a list
 * is in nobody's state, so it is changed where it lies: `[3, 1, 2].sort()`,
 * and the `acc.push(n)` of a `reduce` that started from `[]`. Forgotten when
 * the next drawing begins, by when a handler may have put one into state.
 */
let madeByMarkup: WeakSet<object> | null = null;

function madeHere(list: object): void {
  (madeByMarkup ??= new WeakSet()).add(list);
}

/**
 * For a list a handler has changed since the page was drawn, the copy that
 * was written to state in its place. A handler reads the state that was
 * drawn, so one called twice before the page is drawn again (a component
 * reporting five files, one after another) would start each time from the
 * same list and keep the last change only. The next change starts from the
 * newest copy instead. Forgotten when the page is drawn again: the state its
 * handlers read is then the state as it stands.
 */
let changedLists: WeakMap<object, unknown[]> | null = null;

/** The methods that answer what they were asked to make, a new list every time. */
const MAKES_A_LIST: ReadonlySet<unknown> = new Set<unknown>([
  Array,
  Array.from,
  Array.of,
  String.prototype.split,
  TEMPLATE_OBJECT.keys,
  TEMPLATE_OBJECT.values,
  TEMPLATE_OBJECT.entries,
  ...['concat', 'filter', 'flat', 'flatMap', 'map', 'slice', 'toReversed', 'toSorted', 'toSpliced', 'with']
    .map((name) => (Array.prototype as unknown as Record<string, unknown>)[name])
    .filter((method) => typeof method === 'function'),
]);

/** The two a page calls to read a list in another order, not to change it. */
const REORDERS: ReadonlySet<unknown> = new Set<unknown>([Array.prototype.sort, Array.prototype.reverse]);

/**
 * Where in the app's state `list` lives, when `expr`, which it was read
 * from, is a path there and state holds this very list at it. A name that
 * reads a collection, a computed value or a prop spells a path too, and
 * state holds nothing there.
 */
function placeOfList(
  expr: Expression,
  list: unknown[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined
): string | null {
  const path = getExpressionPath(expr, context, locals);
  if (!path) return null;
  return readStatePath(context.state, parseStatePath(path)) === list ? path : null;
}

/**
 * Say, once, that a handler changed a list where it lies and state was not
 * told, when the list was reached from a loop's item that has no place in
 * state: `#each (todo in todos.filter(…))` with `@click={todo.tags.push("x")}`.
 * That list is most often the app's state all the same, reached by a way
 * the page cannot write back along, and the change is one nothing is drawn
 * for: an assignment in the same place is refused and says so
 * (`reportUnplacedWrite`). A list an arrow was handed is whoever called the
 * arrow's, and is changed as JavaScript changes it with nothing said.
 */
function reportUnplacedChange(expr: CallExpression, locals: SoftNLocalScope | undefined): void {
  if (expr.callee.type !== 'MemberExpression' || reportedUnplacedWrites.has(expr)) return;
  let root = expr.callee.object;
  while (root.type === 'MemberExpression') root = root.object;
  if (root.type !== 'Identifier') return;
  for (let scope = locals; scope; scope = scope.parent) {
    const at = scope.names.indexOf(root.name);
    if (at === -1) continue;
    // A loop's name (it has a position) with no place; not an arrow's parameter.
    if (scope.position === undefined || placeInState(scope, at) !== null) return;
    reportedUnplacedWrites.add(expr);
    console.error(
      `[SoftN] "${spelledTarget(expr.callee)}()" on line ${expr.loc?.line ?? '?'} changed a list where it lies, and the app’s state was not told: ` +
        `"${root.name}" is an item of a list that is worked out in the page or is not the app’s state, ` +
        'so the page is not drawn again for it and the logic does not have the change. ' +
        'Loop over the state list itself, or make the change in a logic function.'
    );
    return;
  }
}

/** Make the call `expr` of `method`, one that changes the list it is called on, for `list`. */
function changeList(
  expr: CallExpression,
  method: (...args: unknown[]) => unknown,
  list: unknown[],
  args: unknown[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined
): unknown {
  const writes = changesState(context);
  if (!writes && madeByMarkup?.has(list)) return markupValue(method.apply(list, args));
  const path = expr.callee.type === 'MemberExpression' ? placeOfList(expr.callee.object, list, context, locals) : null;
  if (writes && path === null) {
    reportUnplacedChange(expr, locals);
    return markupValue(method.apply(list, args));
  }

  // From the list as the handlers before this one left it.
  let from = list;
  if (writes && changedLists) {
    for (let newer = changedLists.get(from); newer; newer = changedLists.get(from)) from = newer;
  }
  const copy = from.slice();
  const answer = method.apply(copy, args);
  if (writes) {
    (changedLists ??= new WeakMap()).set(from, copy);
    context.setState(path as string, copy);
  } else {
    madeHere(copy);
    if (Array.isArray(answer)) madeHere(answer);
    if (path !== null && !REORDERS.has(method) && renderDepth > 0 && !reportedRenderWrites.has(expr)) {
      reportedRenderWrites.add(expr);
      console.error(
        `[SoftN] "${spelledTarget(expr.callee)}()" on line ${expr.loc?.line ?? '?'} would change state while the page is being drawn, ` +
          'so it was made on a copy and state is as it was. ' +
          `Change state in a handler: @click={() => ${spelledTarget(expr.callee)}(…)}.`
      );
    }
  }
  return answer === copy ? copy : markupValue(answer);
}

/** Whether `new` may construct `ctor` in a template; said when it may not. */
function mayConstruct(ctor: unknown): ctor is new (...args: unknown[]) => unknown {
  if (CONSTRUCTIBLE.has(ctor)) return true;
  if (isDevelopment) {
    console.error('[SoftN] "new" in a template constructs Date, Array, Map, Set or an Intl formatter only; build anything else in a logic function.');
  }
  return false;
}

/**
 * Lay `spread` out at the end of `values`, for `...spread` in an argument
 * list or an array literal.
 *
 * A list spreads its items; so does anything else that iterates (a string's
 * characters, a Set's members). `null` and `undefined` spread to nothing
 * rather than throwing, because the usual reason a template meets one is
 * data that has not arrived yet; anything else that cannot be iterated is
 * dropped the same way.
 */
function spreadInto(values: unknown[], spread: unknown): void {
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

/**
 * `{ ...source }`: the own enumerable keys of `source` onto `obj`, in order,
 * under the same key rule as a written property. Nothing to spread (data
 * not loaded yet, a number) contributes nothing.
 */
function spreadKeys(obj: Record<string, unknown>, source: unknown): void {
  if (source !== null && typeof source === 'object') {
    for (const key of Object.keys(source)) {
      if (BLOCKED_MEMBER_KEYS.has(key)) continue;
      obj[key] = (source as Record<string, unknown>)[key];
    }
  }
}

/** A key written in a record that sets nothing: prototype pollution from user expressions. */
function isBlockedPropertyKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/** The text of a template literal whose `${…}` are worth `values`, in order. */
function templateText(expr: TemplateLiteral, values: readonly unknown[]): string {
  let result = '';
  const quasis = expr.quasis || [];
  for (let i = 0; i < quasis.length; i++) {
    const q = quasis[i] as unknown as string | { value?: { cooked?: string; raw?: string } } | null | undefined;
    // quasis[i] may be a TemplateElement object or a plain string
    result += typeof q === 'string' ? q : (q?.value?.cooked ?? q?.value?.raw ?? String(q ?? ''));
    if (i < values.length) {
      result += String(values[i] ?? '');
    }
  }
  return result;
}

/** How many of a template literal's `${…}` its text has a place for. */
function templateHoles(expr: TemplateLiteral): number {
  return Math.min((expr.expressions || []).length, (expr.quasis || []).length);
}

/**
 * Where an assignment writes, or null when its left side is no place in
 * state, which is said.
 */
function assignmentPath(
  expr: AssignmentExpression,
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined
): string | null {
  const path = getExpressionPath(expr.left, context, locals);
  if (path) return path;
  reportUnwritten(expr.left, context, locals);
  return null;
}

/** Make the assignment `expr` at `path`, its right side being worth `right`: what the assignment is worth. */
function assign(
  expr: AssignmentExpression,
  path: string,
  right: unknown,
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown {
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

/**
 * The values of an argument list or an array literal, with every `...list`
 * laid out in place (see `spreadInto`).
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
    spreadInto(values, evaluate(node.argument, context, locals, depth));
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
    patternSuffixes(property.value.pattern, prefix === undefined ? undefined : prefix + step, into);
  }
  if (pattern.rest !== undefined) into.push(undefined);
}

/**
 * Evaluate an expression in the given context
 * Includes recursion depth tracking to prevent infinite loops
 *
 * In a handler's context (`waitsForCalls`) a value that is still on its way
 * is waited for where it is needed, and the answer is then a promise of the
 * expression's value; with nothing to wait for it is the value, at once, as
 * it is in every other context.
 */
export function evaluateExpression(
  expr: Expression,
  context: SoftNRenderContext,
  depth: number = 0
): unknown {
  if (context.waitsForCalls) return handedBack(waited(expr, context, context.locals, depth));
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
      return binaryValue(expr.operator, left, right);
    }

    case 'UnaryExpression':
      return unaryValue(expr.operator, evaluate(expr.argument, context, locals, depth + 1));

    case 'MemberExpression': {
      const obj = evaluate(expr.object, context, locals, depth + 1);

      // Handle optional chaining - return undefined if object is null/undefined
      // This gracefully handles cases like {selectedItem.name} when selectedItem is null
      if (obj == null) {
        return undefined;
      }

      if (expr.computed) {
        return memberValue(obj, evaluate(expr.property, context, locals, depth + 1));
      } else if (expr.property.type === 'Identifier') {
        return memberValue(obj, expr.property.name);
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
          if (expr.callee.computed) {
            fn = methodOf(thisObj, evaluate(expr.callee.property, context, locals, depth + 1));
          } else if (expr.callee.property.type === 'Identifier') {
            fn = methodOf(thisObj, expr.callee.property.name);
          }
        }
      } else {
        fn = evaluate(expr.callee, context, locals, depth + 1);
      }

      if (fn == null) {
        reportMissingFunction(expr, fn, context);
        return undefined;
      }

      return callValue(expr, fn, thisObj, evaluateArguments(expr.arguments, context, locals, depth + 1), context, locals);
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
        reportUnwritten(expr.argument, context, locals);
        return undefined;
      }
      const current = Number(evaluate(expr.argument, context, locals, depth + 1));
      const next = expr.operator === '++' ? current + 1 : current - 1;
      if (stateWriteAllowed(expr, `"${expr.operator}"`)) context.setState(path, next);
      return expr.prefix ? next : current;
    }

    case 'NewExpression': {
      const ctor = evaluate(expr.callee, context, locals, depth + 1);
      if (!mayConstruct(ctor)) return undefined;
      const args = evaluateArguments(expr.arguments, context, locals, depth + 1);
      const made = new ctor(...args);
      if (Array.isArray(made) && !changesState(context)) madeHere(made);
      return made;
    }

    case 'AssignmentExpression': {
      // `count = count + 1` in a handler: the parser reads it whole now, and
      // the write goes through the same setState a `:value` binding uses, at
      // the same resolved path — so `todos[i].done = true` inside an #each
      // writes the row, not a key called "i". A target that is not a state
      // path (a call, a literal) is a parse-time diagnostic; here it is
      // reported once and the assignment is a no-op rather than a throw that
      // would take the whole handler down.
      const path = assignmentPath(expr, context, locals);
      if (!path) return undefined;
      return assign(expr, path, evaluate(expr.right, context, locals, depth + 1), context, locals, depth);
    }

    case 'ArrowFunctionExpression': {
      // Made in a handler's context, what its body calls may have to be
      // waited for (see `waited`); made while the page is drawn, nothing is.
      const waits = context.waitsForCalls === true;
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
          if (waits) return handedBack(waitedStatements(expr.statements, 0, expr.returns, block, scope, depth));
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

        const scope = { names: expr.params, values: values(), parent: locals };
        return waits
          ? handedBack(waited(expr.body, context, scope, depth + 1))
          : evaluate(expr.body, context, scope, depth + 1);
      };
    }

    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (prop.type === 'SpreadElement') {
          // `{ ...base, color: "red" }`
          spreadKeys(obj, evaluate(prop.argument, context, locals, depth + 1));
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
        if (isBlockedPropertyKey(prop.key)) continue;
        obj[prop.key] = evaluate(prop.value, context, locals, depth + 1);
      }
      return obj;
    }

    case 'ArrayExpression': {
      const list = evaluateArguments(expr.elements, context, locals, depth + 1);
      // Markup's own, for a method that changes it (see `changeList`).
      if (!changesState(context)) madeHere(list);
      return list;
    }

    case 'SpreadElement': {
      // Spread elements should be handled in their parent context (object/array)
      const value = evaluate(expr.argument, context, locals, depth + 1);
      return value;
    }

    case 'TemplateLiteral': {
      // Template literal: combine quasis and expressions
      const values: unknown[] = [];
      for (let i = 0, holes = templateHoles(expr); i < holes; i++) {
        values.push(evaluate(expr.expressions[i], context, locals, depth + 1));
      }
      return templateText(expr, values);
    }

    default:
      return undefined;
  }
}

// ── A handler: a value still on its way is waited for ───────────────────────
//
// In a handler a logic function is the one that tells the page what it
// changed, and that one answers a promise (render.tsx, the callback context).
// Worked out at once, `save(currentDraft())` handed `save` that promise, which
// crosses into the logic as `null` (vm-args.ts): the button did nothing.
// `total() + 1` was the text "[object Promise]1", `ready() ? a() : b()` always
// took the first branch, and `n = total()` wrote the promise into state.
//
// So a handler's expression is worked out by `waited`: the same forms, worth
// the same, in the order written, and wherever a value is used that is still
// on its way (an argument, an operand, a condition, what a member is read
// from, an element of a list or a record, the right side of an assignment) it
// is waited for first. With nothing to wait for it is worked out at once and
// is worth exactly what `evaluate` makes it: `@click={() => count++}` still
// writes before the click returns, and `e.preventDefault()` is still in time.

/**
 * An expression of a handler that has had to wait.
 *
 * `made` resolves once the expression's value has been made, to a record
 * holding it. A record, because the value may itself be a promise, what the
 * outermost call answered, and a promise resolved with a promise waits for
 * that one too. Whoever needs the value waits for it (`onceThere`); a block's
 * next statement does not, and follows the call being made, as it always has
 * (`onceMade`).
 */
class Waiting {
  constructor(readonly made: Promise<{ readonly value: unknown }>) {}
}

/** How the wait for a logic call that failed is ended: see `answerOf`. */
const STOPPED = Symbol('a call this handler waited for failed');

/** The methods asked of a promise itself: `load().then((rows) => show(rows))`. */
const PROMISE_METHODS: ReadonlySet<string> = new Set(['then', 'catch', 'finally']);

/** Whether `value` is still on its way: a promise, or anything else that is waited for as one. */
function isPending(value: unknown): value is PromiseLike<unknown> {
  if (value === null || typeof value !== 'object') return false;
  try {
    return typeof (value as { then?: unknown }).then === 'function';
  } catch {
    return false;
  }
}

/**
 * What a pending value comes to, as markup may hold it.
 *
 * A logic call that failed resolves like any other: the runtime has said
 * what went wrong, naming the function, and the app goes on. A handler that
 * needed the call's value does not go on with nothing in its place, so the
 * wait ends here instead, and `handedBack` lets it end quietly. A promise
 * that rejects (a host's own function) ends the wait with its reason.
 */
function answerOf(pending: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(pending).then((value) => {
    if (callFailed(pending)) throw STOPPED;
    return markupValue(value);
  });
}

/** What a step came to, as a `Waiting` resolves to it; a step that is itself waiting is followed. */
function held(result: unknown): { readonly value: unknown } | Promise<{ readonly value: unknown }> {
  return result instanceof Waiting ? result.made : { value: result };
}

/** `use` what `result` is worth once it has been made, which is now unless it is waiting. */
function onceMade(result: unknown, use: (value: unknown) => unknown): unknown {
  return result instanceof Waiting ? new Waiting(result.made.then((made) => held(use(made.value)))) : use(result);
}

/** `use` what `result` is worth once it is there: made, and answered if it is still on its way. */
function onceThere(result: unknown, use: (value: unknown) => unknown): unknown {
  if (result instanceof Waiting) return new Waiting(result.made.then((made) => held(onceThere(made.value, use))));
  if (isPending(result)) return new Waiting(answerOf(result).then((value) => held(use(value))));
  return use(result);
}

/**
 * What a handler hands back to whoever called it: the value, or a promise of
 * it when it had to wait. One that stopped at a failed logic call resolves
 * to nothing, because that failure has been said; any other failure is the
 * promise's, as it is for a handler that is one call.
 */
function handedBack(result: unknown): unknown {
  if (!(result instanceof Waiting)) return result;
  return result.made.then(
    (made) => made.value,
    (reason: unknown) => {
      if (reason === STOPPED) return undefined;
      throw reason;
    }
  );
}

/**
 * Work `count` things out one after another: `step(i)` works out the i-th,
 * and `take(i, value)` is given what it is worth once that is there. A loop
 * for as long as nothing waits, so a long list costs no depth. Worth nothing
 * itself; waiting, when a step was.
 */
function inTurn(
  count: number,
  step: (i: number) => unknown,
  take: (i: number, value: unknown) => void,
  from = 0
): unknown {
  for (let i = from; i < count; i++) {
    const result = step(i);
    if (result instanceof Waiting || isPending(result)) {
      return onceThere(result, (value) => {
        take(i, value);
        return inTurn(count, step, take, i + 1);
      });
    }
    take(i, result);
  }
  return undefined;
}

/** `evaluateArguments` for a handler: each value is there before the next is worked out. */
function waitedArguments(
  nodes: Expression[],
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown {
  const values: unknown[] = [];
  return onceMade(
    inTurn(
      nodes.length,
      (i) => {
        const node = nodes[i];
        return waited(node.type === 'SpreadElement' ? node.argument : node, context, locals, depth);
      },
      (i, value) => {
        if (nodes[i].type === 'SpreadElement') spreadInto(values, value);
        else values.push(value);
      }
    ),
    () => values
  );
}

/**
 * A block body's statements from `from` on, then its `return`.
 *
 * Each statement is made before the next, in the order written. What a
 * statement is worth is not waited for: `{ load(); busy = true }` sets `busy`
 * when `load` has been called, not when it has answered, as it always has.
 * In `{ save(currentDraft()); close() }` the first statement has to wait for
 * the draft before it can call `save`, and `close()` follows that call.
 */
function waitedStatements(
  statements: Expression[],
  from: number,
  returns: Expression | undefined,
  block: SoftNRenderContext,
  scope: SoftNLocalScope,
  depth: number
): unknown {
  for (let i = from; i < statements.length; i++) {
    const result = waited(statements[i], block, scope, depth + 1);
    if (result instanceof Waiting) {
      return onceMade(result, () => waitedStatements(statements, i + 1, returns, block, scope, depth));
    }
  }
  return returns ? waited(returns, block, scope, depth + 1) : undefined;
}

/**
 * `evaluate` for a handler. What it answers is the expression's value, or a
 * `Waiting` when a value it needed was still on its way; `handedBack` makes
 * of that what a caller is given. A form with no part to wait for (a name, a
 * literal, `count++`, an arrow) is `evaluate`'s.
 */
function waited(
  expr: Expression,
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined,
  depth: number
): unknown {
  // Prevent infinite recursion
  if (depth > MAX_EVAL_DEPTH) return evaluate(expr, context, locals, depth);

  switch (expr.type) {
    case 'BinaryExpression': {
      const { operator } = expr;
      if (operator === '&&' || operator === '||' || operator === '??') {
        // Decided by what the left side answered, and only then is the
        // right side worked out, or not.
        return onceThere(waited(expr.left, context, locals, depth + 1), (left) => {
          const decided = operator === '&&' ? !left : operator === '||' ? Boolean(left) : left != null;
          return decided ? left : waited(expr.right, context, locals, depth + 1);
        });
      }
      return onceThere(waited(expr.left, context, locals, depth + 1), (left) =>
        onceThere(waited(expr.right, context, locals, depth + 1), (right) => binaryValue(operator, left, right))
      );
    }

    case 'UnaryExpression':
      // `void load()` asks for no value, and waits for none.
      if (expr.operator === 'void') {
        return onceMade(waited(expr.argument, context, locals, depth + 1), () => undefined);
      }
      return onceThere(waited(expr.argument, context, locals, depth + 1), (arg) => unaryValue(expr.operator, arg));

    case 'MemberExpression':
      return onceMade(waited(expr.object, context, locals, depth + 1), (made) => {
        const named = !expr.computed && expr.property.type === 'Identifier' ? expr.property.name : undefined;
        // `.then` and its kin are the promise's own, not what it comes to.
        if (named !== undefined && PROMISE_METHODS.has(named) && isPending(made)) return memberValue(made, named);
        return onceThere(made, (obj) => {
          if (obj == null) return undefined;
          if (expr.computed) {
            return onceThere(waited(expr.property, context, locals, depth + 1), (key) => memberValue(obj, key));
          }
          return named === undefined ? undefined : memberValue(obj, named);
        });
      });

    case 'CallExpression': {
      const { callee } = expr;
      // The arguments, each there before the next is asked for, then the call.
      // What the call answers is not waited for here: that is for whoever
      // needs it.
      const call = (fn: unknown, thisObj: unknown): unknown => {
        if (fn == null) {
          reportMissingFunction(expr, fn, context);
          return undefined;
        }
        return onceMade(waitedArguments(expr.arguments, context, locals, depth + 1), (args) =>
          callValue(expr, fn, thisObj, args as unknown[], context, locals)
        );
      };

      if (callee.type !== 'MemberExpression') {
        return onceThere(waited(callee, context, locals, depth + 1), (fn) => call(fn, undefined));
      }
      return onceMade(waited(callee.object, context, locals, depth + 1), (made) => {
        const named = !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : undefined;
        // `load().then(…)` is asked of the promise, as it is written.
        if (named !== undefined && PROMISE_METHODS.has(named) && isPending(made)) {
          return call(methodOf(made, named), made);
        }
        return onceThere(made, (thisObj) => {
          if (thisObj == null) return call(undefined, thisObj);
          if (callee.computed) {
            return onceThere(waited(callee.property, context, locals, depth + 1), (key) =>
              call(methodOf(thisObj, key), thisObj)
            );
          }
          return call(named === undefined ? undefined : methodOf(thisObj, named), thisObj);
        });
      });
    }

    case 'ConditionalExpression':
      return onceThere(waited(expr.test, context, locals, depth + 1), (test) =>
        waited(test ? expr.consequent : expr.alternate, context, locals, depth + 1)
      );

    case 'NewExpression':
      return onceThere(waited(expr.callee, context, locals, depth + 1), (ctor) => {
        if (!mayConstruct(ctor)) return undefined;
        return onceMade(waitedArguments(expr.arguments, context, locals, depth + 1), (args) => new ctor(...(args as unknown[])));
      });

    case 'AssignmentExpression': {
      // `n = total()`: the person's variable is given the value.
      const path = assignmentPath(expr, context, locals);
      if (!path) return undefined;
      return onceThere(waited(expr.right, context, locals, depth + 1), (right) =>
        assign(expr, path, right, context, locals, depth)
      );
    }

    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      const { properties } = expr;
      return onceMade(
        inTurn(
          properties.length,
          (i) => {
            const prop = properties[i];
            if (prop.type === 'SpreadElement') return waited(prop.argument, context, locals, depth + 1);
            const { computedKey } = prop;
            if (computedKey) {
              // The key, then the value, as one step worth the pair.
              return onceThere(waited(computedKey, context, locals, depth + 1), (key) =>
                onceThere(waited(prop.value, context, locals, depth + 1), (value) => [getSafeMemberKey(key), value])
              );
            }
            return isBlockedPropertyKey(prop.key) ? undefined : waited(prop.value, context, locals, depth + 1);
          },
          (i, value) => {
            const prop = properties[i];
            if (prop.type === 'SpreadElement') {
              spreadKeys(obj, value);
            } else if (prop.computedKey) {
              const [key, worth] = value as [string | null, unknown];
              if (key !== null) obj[key] = worth;
            } else if (!isBlockedPropertyKey(prop.key)) {
              obj[prop.key] = value;
            }
          }
        ),
        () => obj
      );
    }

    case 'ArrayExpression':
      return waitedArguments(expr.elements, context, locals, depth + 1);

    case 'SpreadElement':
      // Spread elements should be handled in their parent context (object/array)
      return waited(expr.argument, context, locals, depth + 1);

    case 'TemplateLiteral': {
      const values: unknown[] = [];
      return onceMade(
        inTurn(
          templateHoles(expr),
          (i) => waited(expr.expressions[i], context, locals, depth + 1),
          (_i, value) => {
            values.push(value);
          }
        ),
        () => templateText(expr, values)
      );
    }

    default:
      return evaluate(expr, context, locals, depth);
  }
}

/**
 * `[3]` or `["theme"]`: one step of a state path. A key is written in double
 * quotes with a backslash before each quote and backslash in it, which is how
 * `parseStatePath` reads one, so a key may hold anything: a `]`, a quote, a
 * dot, nothing at all. Written bare between its quotes, `answers["it]em"]`
 * was split at the first `]` and the write went to a key called `"it`.
 */
export function pathStep(position: number | string): string {
  return typeof position === 'number' ? `[${position}]` : `["${position.replace(/[\\"]/g, '\\$&')}"]`;
}

/** Where in the app's state the value of `scope.names[at]` lives, or null when it has no place there. */
function placeInState(scope: SoftNLocalScope, at: number): string | null {
  const suffix = scope.suffixes?.[at];
  if (scope.list === undefined || scope.position === undefined || suffix === undefined) return null;
  return scope.list + pathStep(scope.position) + suffix;
}

/**
 * A copy of the layers `locals`, for one element to keep: its handlers read
 * their names from it, and the names are read again when the element's
 * binding has written (`localsToReadAgain`).
 */
export function ownLocals(locals: SoftNLocalScope | undefined): SoftNLocalScope | undefined {
  return locals && { ...locals, values: [...locals.values], parent: ownLocals(locals.parent) };
}

/**
 * For each name in `locals` that stands for a place in the app's state, how
 * to read it again once that state has been written: `todo` of `#each (todo
 * in todos)`, after `:bind={todo.done}` has written `todos[1].done`, is the
 * row as it now is.
 *
 * `locals` is an element's own (`ownLocals`), and `drawn` the state the page
 * was drawn from. A name is read again only where that state holds, at the
 * name's place, the very value the name is bound to; the item of a Map, a
 * count or a prop's list has a path spelled for it and nothing there.
 */
export function localsToReadAgain(
  locals: SoftNLocalScope | undefined,
  drawn: Record<string, unknown>
): Array<(state: Record<string, unknown>) => void> {
  const again: Array<(state: Record<string, unknown>) => void> = [];
  for (let scope = locals; scope; scope = scope.parent) {
    const { list, position, suffixes } = scope;
    if (list === undefined || position === undefined || !suffixes) continue;
    const values = scope.values as unknown[];
    suffixes.forEach((suffix, at) => {
      if (suffix === undefined) return;
      const path = parseStatePath(list + pathStep(position) + suffix);
      if (!Object.is(readStatePath(drawn, path), values[at])) return;
      again.push((state) => {
        values[at] = readStatePath(state, path);
      });
    });
  }
  return again;
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
    // `answers[q.id]`: an index that is itself a path is spelled; anything else is not.
    const index = spelledTarget(expr.property);
    return index.includes('…') ? `${object}[…]` : `${object}[${index}]`;
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

/** What an index that finds no place in state came to, for a message. */
function spelledIndex(key: unknown): string {
  if (key === undefined) return 'nothing (undefined)';
  if (key === null) return 'null';
  if (typeof key === 'string') return `"${key}", a key no page may write`;
  if (isPending(key)) return 'a value that is still on its way (a logic call’s answer: put it in a variable first, then use the variable)';
  if (typeof key === 'object') return Array.isArray(key) ? 'a list' : 'a record';
  return typeof key === 'function' ? 'a function' : String(key);
}

/** Why `target` has no path in state, when no name the page bound is the reason. */
function whyUnwritten(target: Expression, context: SoftNRenderContext, locals: SoftNLocalScope | undefined): string {
  const members: Expression[] = [];
  let root = target;
  while (root.type === 'MemberExpression') {
    members.unshift(root);
    root = root.object;
  }
  if (root.type === 'Identifier') {
    for (const member of members) {
      if (member.type !== 'MemberExpression' || !member.computed) continue;
      const index = indexOf(member.property, context, locals);
      if (index.step !== null) continue;
      const how = index.threw ? 'could not be worked out' : `came to ${spelledIndex(index.value)}`;
      return `the index in "${spelledTarget(member)}" ${how}, and a place in state is found by text or a number.`;
    }
  }
  return 'only a name or a property path, such as form.name or rows[i].qty, is a place in state.';
}

/**
 * Report, once, a write that was not made because its target has no place
 * in the app's state: `:bind={answers[q.id]}` while `q.id` is nothing, an
 * assignment to `rows[pick()].qty` in a handler, where `pick()` answers a
 * promise. A `:bind` like these used to say nothing at all, and an
 * assignment said so in development only.
 *
 * Not kept to development, for the reason `reportUnplacedWrite` gives.
 */
export function reportUnwritten(
  target: Expression,
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined = context.locals
): void {
  if (reportUnplacedWrite(target, locals) || reportedUnplacedWrites.has(target)) return;
  reportedUnplacedWrites.add(target);
  console.error(
    `[SoftN] "${spelledTarget(target)}" on line ${target.loc?.line ?? '?'} was not written: ` + whyUnwritten(target, context, locals)
  );
}

/**
 * What `[property]` is as a step of a state path: `step` is null where it
 * finds no place, with what it came to or that working it out threw.
 *
 * Any expression is worked out, against what the template bound here:
 * `answers[q.id]`, `todos[count - 1]`. Only a bare name used to be, so those
 * two had no path, and a control bound to one wrote nothing and said nothing.
 * A key no template may read (BLOCKED_MEMBER_KEYS) is no place to write.
 */
function indexOf(
  property: Expression,
  context: SoftNRenderContext,
  locals: SoftNLocalScope | undefined
): { step: string | null; value?: unknown; threw?: true } {
  let value: unknown;
  if (property.type === 'Literal') {
    value = property.value;
  } else {
    try {
      value = evaluate(property, context, locals, 0);
    } catch {
      // A path is asked for where nothing else is being worked out (each
      // drawing of an `#each`), so an index that throws has no place, and
      // does not take the page with it.
      return { step: null, threw: true };
    }
  }
  if (typeof value === 'number') return { step: pathStep(value), value };
  if (typeof value === 'string' && !BLOCKED_MEMBER_KEYS.has(value)) return { step: pathStep(value), value };
  return { step: null, value };
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

    // Handle computed properties like items[0], items[index] or answers[q.id]
    if (expr.computed) {
      // Resolve the index, do not name it.
      //
      // This returned `todos[i]` — the identifier's spelling — so a :bind
      // inside `#each (todo, i in todos)` wrote every row's edit to a literal
      // key called "i". The real row was never touched and a junk entry
      // appeared beside the list, so typing in the second row changed nothing
      // visible and quietly corrupted the data behind it. An index that
      // comes to nothing (data not loaded yet) still went to that key; it
      // has no place now, and the write is reported.
      if (context || expr.property.type === 'Literal') {
        const { step } = indexOf(expr.property, context as SoftNRenderContext, locals);
        return step === null ? null : objectPath + step;
      }
      // Without a context there is nothing to resolve against; the caller
      // gets the old placeholder rather than a silently wrong path.
      if (expr.property.type === 'Identifier') return `${objectPath}[${expr.property.name}]`;
    }
  }

  return null;
}
