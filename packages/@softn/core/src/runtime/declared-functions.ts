/**
 * The functions a script declares, read from its text, and stand-ins for them
 * that wait for the script.
 *
 * A page is drawn as soon as it is parsed, and its script's functions arrive
 * when the script has loaded: a moment for a small app on the main thread,
 * longer for one in a worker, and again whenever the script reloads (a
 * permission granted with Allow rebuilds the runtime). A tap in that gap found
 * no function and did nothing. Each stand-in is called in its place, waits
 * for the script, and calls the function of its name — or nothing, when the
 * script has none, or did not load.
 *
 * The names are read the way a person writing an app declares them —
 * `function name(`, `const name = (…) =>` or `= function`, Python's
 * `def name(` — not by running anything; a function declared some other way
 * is simply not stood in for, as before.
 */

const JS_FUNCTION = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
const JS_BOUND = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
const PY_DEF = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;

/** The function names `code` declares, in the order first seen. */
export function declaredFunctionNames(code: string): string[] {
  const names = new Set<string>();
  for (const pattern of [JS_FUNCTION, JS_BOUND, PY_DEF]) {
    for (const match of code.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

type ScriptFunction = (...args: unknown[]) => unknown;

/**
 * A stand-in for each name, which waits for `loaded` and then calls the
 * script's function of that name with the same arguments.
 */
export function standInFunctions(
  names: readonly string[],
  loaded: Promise<Record<string, ScriptFunction>>
): Record<string, ScriptFunction> {
  const standIns: Record<string, ScriptFunction> = {};
  for (const name of names) {
    standIns[name] = (...args: unknown[]) => loaded.then((functions) => functions[name]?.(...args));
  }
  return standIns;
}
