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
 * The host functions that are declared, with their values now. Names that
 * cannot safely become declarations, or are served by another bridge
 * (`xdb_*`, `asset`), are skipped.
 */
export function collectExternalValues(externalFunctions: ExternalFunctions | null): {
  names: string[];
  values: ExternalPrimitive[];
} {
  const names: string[] = [];
  const values: ExternalPrimitive[] = [];
  for (const name of Object.keys(externalFunctions ?? {})) {
    if (!VALID_IDENTIFIER.test(name) || EXTERNAL_FUNCTION_RESERVED_NAMES.has(name)) continue;
    if (name.startsWith('xdb_') || name === 'asset') continue;
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
 */
export function buildExternalValuesPreamble(
  externalFunctions: Record<string, (...args: unknown[]) => unknown> | null | undefined
): string {
  if (!externalFunctions) return '';
  const { names, values } = collectExternalValues(externalFunctions);
  return externalValuesPreamble(names, values);
}
