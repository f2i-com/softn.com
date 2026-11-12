/**
 * Carrying an app's variables from one engine to the next.
 *
 * When an app's logic changes while it is open (an editor's preview, a
 * permission that needs the logic loaded again), the new logic starts in a new
 * engine. What the person was doing lives in the old one: the counter they
 * clicked up, the text they typed, the record they opened. This module takes
 * that out of the old engine and puts it into the new one, or says why it
 * cannot, in which case the app starts clean. It never carries part.
 *
 * What is carried: the top-level variables that have moved since the logic
 * started, when all of them hold plain data (numbers, text, true and false,
 * nothing, lists and plain objects of those). A variable that has not moved
 * is left to the new logic's own starting value, so an edit to
 * `let speed = 5` is seen at once, and a large table loaded at the top level
 * is not copied for nothing.
 *
 * What refuses the whole carry, and why each must:
 *
 * - A moved variable that holds something other than plain data: an object
 *   made by a class, a Map, a Set, a Date, a typed array, a function inside
 *   a list. The engine hands such a value to the host as `null` or as its
 *   bare fields, so it would arrive broken.
 * - A Map, Set, Date or typed array anywhere in the variables that stay: the
 *   engine cannot say whether one has changed, so it cannot be known whether
 *   it would be lost.
 * - An object that a carried variable shares with a variable that stays.
 *   Carried, it would be a copy, and a change to one would no longer show in
 *   the other. (Objects shared among the carried variables are carried as
 *   one object: the rebuilding is done inside the new engine.)
 * - A variable whose new starting value has another shape than the value to
 *   be put in it: the new logic was written for the new shape.
 * - More to look through than a fixed number of values: the looking runs in
 *   the engine, on its budget.
 *
 * The engine-facing code is the same for the main-thread runtime and the
 * script worker; both call these functions with their own adapter.
 */

/** What this module asks of an engine. Both adapters answer all of it but the digests. */
export interface CarryEngine {
  evalSync(expression: string): unknown;
  getGlobalsBatch(indices: number[]): unknown[];
  getGlobalsFingerprint?(indices: number[]): number[] | null;
}

/** The state variables of a loaded script: names and slots, in step. */
export interface StateSlots {
  names: string[];
  indices: number[];
}

/**
 * How the variables stood when the logic had just started: digests where the
 * engine gives them (nothing is copied), else copies of the values.
 */
export interface StartMark {
  prints: number[] | null;
  values: unknown[] | null;
}

/**
 * Variables taken out of an engine, as the graph the engine wrote (see
 * `OUT`): sharing among them is kept. `roots` maps a variable to its node.
 */
export interface CarriedState {
  roots: Record<string, unknown>;
}

export type CarryOutResult = { ok: true; state: CarriedState; names: string[] } | { ok: false; why: string };
export type CarryInResult = { ok: true; carried: string[] } | { ok: false; why: string };

/** The most values looked through in one carry, in the engine. */
const LOOK_LIMIT = 200_000;
/** The most text a carried graph may be when it is handed to the new engine. */
const TEXT_LIMIT = 2_000_000;

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const BACKSLASH = String.fromCharCode(92);
const VALID_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// The mark is made at every load and is a module of its own, so that this
// one is fetched only when an open app's logic is replaced.
export { markStart } from './state-carry-mark';

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * The variables that hold something other than they did at the mark; all of
 * them when that cannot be told. `digested` says the engine's own digests
 * told it, which see inside an object made by a class; values read out by
 * the host do not (such an object reads as its bare fields on one engine and
 * as nothing on another), so without digests one cannot be left behind as
 * "not moved".
 */
function movedSince(engine: CarryEngine, slots: StateSlots, start: StartMark | null): { names: string[]; digested: boolean } {
  if (!start) return { names: [...slots.names], digested: false };
  try {
    if (start.prints) {
      const now = engine.getGlobalsFingerprint?.(slots.indices);
      if (now && now.length === start.prints.length) {
        // NaN is the engine saying it could not walk a value: taken as moved.
        return { names: slots.names.filter((_, i) => now[i] !== start.prints![i]), digested: true };
      }
    } else if (start.values) {
      const now = engine.getGlobalsBatch(slots.indices);
      return { names: slots.names.filter((_, i) => !sameJson(now[i], start.values![i])), digested: false };
    }
  } catch {
    // Falls through to "all".
  }
  return { names: [...slots.names], digested: false };
}

/**
 * Run in the old engine. Answers `[problem]` or `[null, roots]`, where each
 * root is a node: a primitive as itself, `["u"]` undefined, `["d", text]` a
 * number JSON has no word for, `["a", id, items]`, `["o", id, keys, values]`
 * and `["r", id]` for an object met before.
 */
const OUT = `function (moved, rest, limit, digested) {
  var left = limit, staying = new Set(), ids = new Map(), next = 1, problem = null;
  function named(v) {
    var n = Object.prototype.toString.call(v).slice(8, -1);
    return n === "Object" ? "an object made by a class" : (/^[AEIOU]/.test(n) ? "an " : "a ") + n;
  }
  function mark(v, depth) {
    if (v === null || typeof v !== "object" || staying.has(v)) return null;
    if (--left < 0 || depth > 64) return "too much to look through";
    staying.add(v);
    var i;
    if (Array.isArray(v)) {
      for (i = 0; i < v.length; i++) { var a = mark(v[i], depth + 1); if (a) return a; }
      return null;
    }
    var proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && (!digested || Object.prototype.toString.call(v) !== "[object Object]")) return named(v);
    var keys = Object.keys(v);
    for (i = 0; i < keys.length; i++) { var o = mark(v[keys[i]], depth + 1); if (o) return o; }
    return null;
  }
  function node(v, depth, top) {
    if (v === null) return null;
    var t = typeof v;
    if (t === "undefined") return ["u"];
    if (t === "string" || t === "boolean") return v;
    if (t === "number") return v === v && v !== Infinity && v !== -Infinity ? v : ["d", String(v)];
    if (t === "function") { problem = top ? "code" : "a function"; return null; }
    if (t !== "object") { problem = "a " + t; return null; }
    if (ids.has(v)) return ["r", ids.get(v)];
    if (staying.has(v)) { problem = "an object another variable also holds"; return null; }
    if (--left < 0 || depth > 64) { problem = "too much to look through"; return null; }
    var id = next++, i, out;
    ids.set(v, id);
    if (Array.isArray(v)) {
      out = [];
      for (i = 0; i < v.length; i++) { out.push(node(v[i], depth + 1, false)); if (problem) return null; }
      return ["a", id, out];
    }
    var proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) { problem = named(v); return null; }
    var keys = Object.keys(v);
    out = [];
    for (i = 0; i < keys.length; i++) { out.push(node(v[keys[i]], depth + 1, false)); if (problem) return null; }
    return ["o", id, keys, out];
  }
  var r, i;
  for (i = 0; i < rest.length; i++) {
    r = mark(rest[i][1], 0);
    if (r) return [[rest[i][0], r]];
  }
  var roots = [];
  for (i = 0; i < moved.length; i++) {
    problem = null;
    r = node(moved[i][1], 0, true);
    if (problem === "code") continue;
    if (problem) return [[moved[i][0], problem]];
    roots.push([moved[i][0], r]);
  }
  return [null, roots];
}`;

/**
 * Run in the new engine, before anything is written: what each variable to
 * be written holds now. `""` plain data, `"code"` a function, else its name.
 */
const KINDS = `function (held, limit) {
  var left = limit;
  function kind(v, depth, top) {
    if (v === null || v === undefined) return "";
    var t = typeof v;
    if (t === "function") return top ? "code" : "a function";
    if (t !== "object") return t === "number" || t === "string" || t === "boolean" ? "" : "a " + t;
    if (--left < 0 || depth > 64) return "too much to look through";
    var i, k;
    if (Array.isArray(v)) {
      for (i = 0; i < v.length; i++) { k = kind(v[i], depth + 1, false); if (k) return k; }
      return "";
    }
    var proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      var n = Object.prototype.toString.call(v).slice(8, -1);
      return n === "Object" ? "an object made by a class" : (/^[AEIOU]/.test(n) ? "an " : "a ") + n;
    }
    var keys = Object.keys(v);
    for (i = 0; i < keys.length; i++) { k = kind(v[keys[i]], depth + 1, false); if (k) return k; }
    return "";
  }
  var out = [];
  for (var i = 0; i < held.length; i++) out.push(kind(held[i], 0, true));
  return out;
}`;

/**
 * Run in the new engine: build the carried graph and put each root in its
 * variable. A list or object the variable already holds is filled where it
 * is, so whatever else in the new logic holds it sees the carried contents.
 */
const IN = `function (text, held, assign) {
  var roots = JSON.parse(text), made = new Map();
  function build(n, into) {
    if (n === null || typeof n !== "object") return n;
    var tag = n[0], i;
    if (tag === "u") return undefined;
    if (tag === "d") return Number(n[1]);
    if (tag === "r") return made.get(n[1]);
    if (made.has(n[1])) return made.get(n[1]);
    if (tag === "a") {
      var list = into || [];
      made.set(n[1], list);
      list.length = 0;
      for (i = 0; i < n[2].length; i++) list.push(build(n[2][i], null));
      return list;
    }
    var obj = into || {};
    made.set(n[1], obj);
    if (into) { var old = Object.keys(obj); for (i = 0; i < old.length; i++) delete obj[old[i]]; }
    for (i = 0; i < n[2].length; i++) obj[n[2][i]] = build(n[3][i], null);
    return obj;
  }
  function fits(n, v) {
    if (n === null || typeof n !== "object" || v === null || typeof v !== "object") return false;
    if (n[0] === "a") return Array.isArray(v);
    return n[0] === "o" && !Array.isArray(v);
  }
  var i, filled = new Set();
  for (i = 0; i < roots.length; i++) {
    var n = roots[i][1];
    if (!assign[i] || !fits(n, held[i]) || made.has(n[1]) || filled.has(held[i])) continue;
    filled.add(held[i]);
    build(n, held[i]);
  }
  for (i = 0; i < roots.length; i++) {
    var value = build(roots[i][1], null);
    if (assign[i] && value !== held[i]) assign[i](value);
  }
  return roots.length;
}`;

/**
 * Take the moved variables out of `engine`. `start` is the mark made when
 * its logic had just started (null: every variable is taken as moved).
 */
export function carryOut(engine: CarryEngine, slots: StateSlots, start: StartMark | null): CarryOutResult {
  const usable = slots.names.every((name) => VALID_NAME.test(name));
  if (!usable) return { ok: false, why: 'one of its variables has a name that cannot be written here' };
  if (slots.names.length === 0) return { ok: true, state: { roots: {} }, names: [] };
  const since = movedSince(engine, slots, start);
  const moved = new Set(since.names);
  // Looked through even when nothing moved: a Map or a Set among the
  // variables that stay may have changed without the engine saying so.
  const pairs = (names: string[]) => `[${names.map((name) => `[${JSON.stringify(name)}, typeof ${name} === "undefined" ? undefined : ${name}]`).join(',')}]`;
  const movedNames = slots.names.filter((name) => moved.has(name));
  const restNames = slots.names.filter((name) => !moved.has(name));
  let answer: unknown;
  try {
    answer = engine.evalSync(`(${OUT})(${pairs(movedNames)}, ${pairs(restNames)}, ${LOOK_LIMIT}, ${since.digested})`);
  } catch (error) {
    return { ok: false, why: `its variables could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(answer)) return { ok: false, why: 'its variables could not be read' };
  const problem = answer[0] as [string, string] | null;
  if (problem) return { ok: false, why: `\`${problem[0]}\` holds ${problem[1]}` };
  const roots: Record<string, unknown> = {};
  const names: string[] = [];
  for (const [name, node] of (answer[1] as Array<[string, unknown]>) ?? []) {
    roots[name] = node;
    names.push(name);
  }
  return { ok: true, state: { roots }, names };
}

/** A carried node as the plain value it stands for, sharing kept. */
function decode(node: unknown, made: Map<number, unknown>): unknown {
  if (node === null || typeof node !== 'object') return node;
  const tuple = node as unknown[];
  switch (tuple[0]) {
    case 'u':
      return undefined;
    case 'd':
      return Number(tuple[1]);
    case 'r':
      return made.get(tuple[1] as number);
    case 'a': {
      const list: unknown[] = [];
      made.set(tuple[1] as number, list);
      for (const item of tuple[2] as unknown[]) list.push(decode(item, made));
      return list;
    }
    default: {
      const object: Record<string, unknown> = {};
      made.set(tuple[1] as number, object);
      const keys = tuple[2] as string[];
      const values = tuple[3] as unknown[];
      keys.forEach((key, i) => {
        Object.defineProperty(object, key, { value: decode(values[i], made), enumerable: true, writable: true, configurable: true });
      });
      return object;
    }
  }
}

/** The plain values a carried state stands for, by variable. For a host that shows them; the engine takes the graph. */
export function carriedValues(state: CarriedState): Record<string, unknown> {
  const made = new Map<number, unknown>();
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(state.roots)) out[name] = decode(node, made);
  return out;
}

/**
 * Whether a carried value can stand where the new logic starts with `fresh`.
 * Nothing (null, undefined) fits anything and is fitted by anything: a
 * variable that starts empty says nothing of what it will hold. Otherwise the
 * kinds must agree, and an object must have every field the new logic starts
 * it with.
 */
export function shapeFits(carried: unknown, fresh: unknown, depth = 0): boolean {
  if (carried === null || carried === undefined || fresh === null || fresh === undefined) return true;
  if (typeof carried !== typeof fresh) return false;
  if (typeof fresh !== 'object') return true;
  if (Array.isArray(carried) !== Array.isArray(fresh)) return false;
  if (depth >= 6) return true;
  if (Array.isArray(fresh)) {
    const list = carried as unknown[];
    return fresh.length === 0 || list.length === 0 || shapeFits(list[0], fresh[0], depth + 1);
  }
  const have = carried as Record<string, unknown>;
  for (const [key, value] of Object.entries(fresh as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(have, key)) return false;
    if (!shapeFits(have[key], value, depth + 1)) return false;
  }
  return true;
}

/**
 * Put a carried state into `engine`, whose logic has just started. `slotOf`
 * answers the slot of a state variable of the new logic, or undefined for a
 * name that is not one (removed, or a function now). All or nothing: on a
 * refusal nothing has been written, and the engine stands as a clean start.
 */
export function carryIn(
  engine: CarryEngine,
  slotOf: (name: string) => number | undefined,
  state: CarriedState
): CarryInResult {
  const names: string[] = [];
  const indices: number[] = [];
  for (const name of Object.keys(state.roots)) {
    const index = slotOf(name);
    if (index === undefined || !VALID_NAME.test(name)) continue;
    names.push(name);
    indices.push(index);
  }
  if (names.length === 0) return { ok: true, carried: [] };
  const starting = `[${names.map((name) => `typeof ${name} === "undefined" ? undefined : ${name}`).join(',')}]`;
  let kinds: unknown;
  try {
    kinds = engine.evalSync(`(${KINDS})(${starting}, ${LOOK_LIMIT})`);
  } catch (error) {
    return { ok: false, why: `the new logic's variables could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(kinds) || kinds.length !== names.length) return { ok: false, why: "the new logic's variables could not be read" };
  // A name that is code now is the new logic's own, and is left to it.
  const taking = names.map((_, i) => kinds[i] !== 'code');
  for (let i = 0; i < names.length; i++) {
    if (taking[i] && kinds[i] !== '') return { ok: false, why: `\`${names[i]}\` now starts as ${String(kinds[i])}` };
  }
  const fresh = engine.getGlobalsBatch(indices);
  const slot = new Map(names.map((name, i) => [name, i]));
  const made = new Map<number, unknown>();
  // Every root goes to the engine, in the order it was written, so a node
  // that names an object of a variable not taken (removed from the new
  // logic, or code there now) still finds it; only the taken are written.
  const roots: Array<[string, unknown]> = [];
  const taken: string[] = [];
  const held: string[] = [];
  const assign: string[] = [];
  for (const [name, node] of Object.entries(state.roots)) {
    const value = decode(node, made);
    const i = slot.get(name);
    roots.push([name, node]);
    if (i === undefined || !taking[i]) {
      held.push('undefined');
      assign.push('null');
      continue;
    }
    if (!shapeFits(value, fresh[i])) return { ok: false, why: `\`${name}\` has changed shape` };
    taken.push(name);
    held.push(`typeof ${name} === "undefined" ? undefined : ${name}`);
    assign.push(`function (v) { ${name} = v; }`);
  }
  if (taken.length === 0) return { ok: true, carried: [] };
  const text = JSON.stringify(roots);
  if (text.length > TEXT_LIMIT) return { ok: false, why: 'it holds too much to carry' };
  // The two line separators end a line of source: written as their escapes.
  const literal = JSON.stringify(text).split(LINE_SEPARATOR).join(BACKSLASH + 'u2028').split(PARAGRAPH_SEPARATOR).join(BACKSLASH + 'u2029');
  try {
    engine.evalSync(`(${IN})(${literal}, [${held.join(',')}], [${assign.join(',')}])`);
  } catch (error) {
    return { ok: false, why: `the new logic would not take its variables (${error instanceof Error ? error.message : String(error)})` };
  }
  return { ok: true, carried: taken };
}
