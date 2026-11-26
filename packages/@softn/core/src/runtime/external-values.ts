/**
 * The host's functions a script calls by name: what the runtime declares for
 * them, and the declarations.
 *
 * A no-argument function the host injects whose answer is a plain value (a
 * wallet bridge's address, a theme flag) is declared in the script's
 * compilation as a function returning that value, read from a table the
 * runtime keeps in the VM and refreshes before each entry, so a new
 * implementation from the host reaches the script without recompiling it.
 * The main-thread runtime and the Web Worker runtime compile the same
 * declarations from here.
 */

import { TIMER_PREAMBLE_NAMES } from './logic-timers';

type ExternalFunctions = Record<string, (...args: unknown[]) => unknown>;

/** The table in the VM the declarations read their values from. */
export const EXTERNAL_VALUES_VAR = '__softnExternalValues';

/**
 * Names of variables added by BRIDGE_PREAMBLE that should not be treated
 * as user state variables.
 */
export const BRIDGE_VARS = new Set([
  'window',
  'navigator',
  'host',
  'softn',
  EXTERNAL_VALUES_VAR,
  ...TIMER_PREAMBLE_NAMES,
]);
const EXTERNAL_FUNCTION_RESERVED_NAMES = new Set([...BRIDGE_VARS, 'db', 'localStorage']);

/** A name safe to paste into generated source as an identifier. */
export const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export type ExternalPrimitive = string | number | boolean | null | undefined;
export const UNSUPPORTED_EXTERNAL_VALUE = Symbol('unsupported external value');
type ExternalValueRead = ExternalPrimitive | typeof UNSUPPORTED_EXTERNAL_VALUE;

/** Match the value JSON source generation used for external bridge snapshots. */
function normalizeExternalPrimitive(value: unknown): ExternalValueRead {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    // JSON.stringify was historically used for the injected return literal:
    // non-finite numbers became null and negative zero became zero.
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  return UNSUPPORTED_EXTERNAL_VALUE;
}

/** Read the current value of a no-argument host bridge without leaking errors. */
export function readExternalValue(externalFunctions: ExternalFunctions | null, name: string): ExternalValueRead {
  try {
    const fn = externalFunctions?.[name];
    if (typeof fn !== 'function') return UNSUPPORTED_EXTERNAL_VALUE;

    const result = fn();
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      // These VM globals are synchronous snapshots. Keep async bridges out of
      // them, and make sure a rejected promise cannot become unhandled.
      Promise.resolve(result).catch(() => {});
      return UNSUPPORTED_EXTERNAL_VALUE;
    }
    return normalizeExternalPrimitive(result);
  } catch {
    return UNSUPPORTED_EXTERNAL_VALUE;
  }
}

/**
 * The host functions that could be declared for a script: every name that can
 * safely become a declaration and is not served by another bridge (`xdb_*`,
 * `asset`). Nothing is called to say so.
 */
export function externalCandidates(externalFunctions: ExternalFunctions | null | undefined): string[] {
  return Object.keys(externalFunctions ?? {}).filter(
    (name) =>
      VALID_IDENTIFIER.test(name) && !EXTERNAL_FUNCTION_RESERVED_NAMES.has(name) && !name.startsWith('xdb_') && name !== 'asset'
  );
}

const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

/**
 * Whether `name` is written in `code` as a name of its own, not as part of a
 * longer one. Read as text, comments and strings included: a name found
 * where it is not used costs one read of a getter, where a name missed would
 * leave the logic calling a function that is not declared.
 */
export function namedInLogic(code: string, name: string): boolean {
  for (let at = code.indexOf(name); at !== -1; at = code.indexOf(name, at + 1)) {
    const before = at === 0 ? '' : code[at - 1];
    const after = code[at + name.length] ?? '';
    if (!IDENTIFIER_PART.test(before) && !IDENTIFIER_PART.test(after)) return true;
  }
  return false;
}

/**
 * The host functions that are declared, with their values now. Names that
 * cannot safely become declarations, or are served by another bridge
 * (`xdb_*`, `asset`), are skipped.
 *
 * With `code`, the logic that will be compiled, only the functions it names
 * are read. Reading one is calling it, and a host hands the page functions for
 * its markup as well (`@click={logout}`): every one of them was called with
 * no arguments as the app loaded, and those that answered nothing (an action
 * answers `undefined`) were then declared and called again before every call
 * into the logic, so `logout` ran as the app opened and at each click. A
 * function the logic does not name is one it cannot call, and is left alone.
 */
export function collectExternalValues(externalFunctions: ExternalFunctions | null, code?: string): {
  names: string[];
  values: ExternalPrimitive[];
} {
  const names: string[] = [];
  const values: ExternalPrimitive[] = [];
  for (const name of externalCandidates(externalFunctions)) {
    if (code !== undefined && !namedInLogic(code, name)) continue;
    const value = readExternalValue(externalFunctions, name);
    // Preserve the established bridge contract: only synchronous
    // primitive-valued getters become globals in this compilation.
    if (value === UNSUPPORTED_EXTERNAL_VALUE) continue;
    names.push(name);
    values.push(value);
  }
  return { names, values };
}

/** The table and a declaration for each name; empty when there are none. */
export function externalValuesPreamble(names: readonly string[], values: readonly ExternalPrimitive[]): string {
  if (names.length === 0) return '';
  const serialized = values.map((v) => (v === undefined ? 'undefined' : JSON.stringify(v))).join(',');
  let preamble = `let ${EXTERNAL_VALUES_VAR} = [${serialized}];\n`;
  for (let i = 0; i < names.length; i++) {
    preamble += `function ${names[i]}() { return ${EXTERNAL_VALUES_VAR}[${i}]; }\n`;
  }
  return preamble;
}

/**
 * The host-injected functions as the script sees them: a snapshot of every
 * synchronous primitive-valued getter, declared as a function returning its
 * value. This is the contract the main-thread runtime compiles (step 4 of its
 * loadScript), so a script hosted in a worker is handed the same
 * declarations. The worker's snapshot is taken once, at load: nothing
 * refreshes it afterwards, where the main thread refreshes its table on every
 * call — a known gap, acceptable for values that do not move while an app runs.
 * With `code`, only the functions the logic names are read (collectExternalValues).
 */
export function buildExternalValuesPreamble(
  externalFunctions: Record<string, (...args: unknown[]) => unknown> | null | undefined,
  code?: string
): string {
  if (!externalFunctions) return '';
  const { names, values } = collectExternalValues(externalFunctions, code);
  return externalValuesPreamble(names, values);
}
