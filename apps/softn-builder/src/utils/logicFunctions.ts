/**
 * The functions a logic file defines, for the handler fields of the panel.
 *
 * A handler field was free text with a hint pointing at a "Logic tab" that
 * does not exist: nothing said which functions there were, and a misspelt
 * name was found only by clicking the button in the preview and watching
 * nothing happen. The panel now offers the linked file's functions and says,
 * without refusing anything, when a handler names one that is not there.
 *
 * Read with patterns rather than a parser, because the file is often
 * mid-edit and a parse error must not take the suggestions away. Only
 * top-level definitions count — a Python `def` in column 0, a JavaScript
 * `function` or arrow-function binding at the start of a line — since those
 * are what the runtime exposes to the markup.
 */

import type { LogicLanguage } from './logicFiles';

export interface LogicFunction {
  name: string;
  /** The parameter list as written, without the parentheses. */
  params: string;
}

const JS_FUNCTION = /^(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)[ \t]*\(([^)]*)\)/gm;
const JS_ARROW =
  /^(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))[ \t]*=>/gm;
const JS_FUNCTION_EXPRESSION =
  /^(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?function\b[^(]*\(([^)]*)\)/gm;
const PY_DEF = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]*)\)/gm;
/** `from helpers import a, b` in a Python module makes `a` and `b` its own. */
const PY_FROM_IMPORT = /^from[ \t]+[\w.]+[ \t]+import[ \t]+\(?([^)\n#]+)\)?/gm;

/** Every top-level function a logic file defines, in file order, each once. */
export function logicFunctions(content: string, language: LogicLanguage): LogicFunction[] {
  const found = new Map<string, LogicFunction & { at: number }>();
  const take = (pattern: RegExp, altParamsAt?: number) => {
    for (const match of content.matchAll(pattern)) {
      const name = match[1];
      if (found.has(name)) continue;
      const params = match[2] ?? (altParamsAt !== undefined ? match[altParamsAt] : undefined) ?? '';
      found.set(name, { name, params: params.replace(/\s+/g, ' ').trim(), at: match.index ?? 0 });
    }
  };
  if (language === 'python') {
    take(PY_DEF);
  } else {
    take(JS_FUNCTION);
    take(JS_ARROW, 3);
    take(JS_FUNCTION_EXPRESSION);
  }
  // In file order, however many patterns found them.
  return [...found.values()].sort((a, b) => a.at - b.at).map(({ name, params }) => ({ name, params }));
}

/**
 * Every name a handler may call without a warning: the functions of each
 * logic file in the language, and in Python the names a module imports.
 * JavaScript logic files are composed into one scope, so a helper's
 * functions are callable too; a Python module's are callable once imported.
 */
export function callableNames(contents: readonly string[], language: LogicLanguage): Set<string> {
  const names = new Set<string>(language === 'python' ? PYTHON_BUILTINS : JS_BUILTINS);
  for (const content of contents) {
    for (const fn of logicFunctions(content, language)) names.add(fn.name);
    if (language === 'python') {
      for (const match of content.matchAll(PY_FROM_IMPORT)) {
        for (const part of match[1].split(',')) {
          const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (alias && /^[A-Za-z_]\w*$/.test(alias)) names.add(alias);
        }
      }
    }
  }
  return names;
}

/** Globals a handler may call that no logic file defines. */
const JS_BUILTINS = ['alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'String', 'Number', 'Boolean'];
const PYTHON_BUILTINS = ['print', 'len', 'str', 'int', 'float', 'bool'];

/**
 * What a handler field inserts for a function. Bound by name, a handler is
 * called with the event, which a Python function taking no parameters
 * refuses with a TypeError; such a function is called through an arrow that
 * drops the event. JavaScript ignores an extra argument, so the name is
 * enough there.
 */
export function handlerFor(fn: LogicFunction, language: LogicLanguage): string {
  return language === 'python' && fn.params === '' ? `() => ${fn.name}()` : fn.name;
}

/**
 * The function a handler calls, when it is one name: `save`, `save()`,
 * `save(item)`, `() => save()`, `(e) => save(e)`, `e => save(e)`. Anything
 * else — a member call, an assignment, a statement — is not checked, and
 * gives null.
 */
export function handlerTarget(value: string): string | null {
  const text = value.trim().replace(/^\{([\s\S]*)\}$/, '$1').trim();
  const body = text.match(/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/)?.[1]?.trim() ?? text;
  const match = body.match(/^([A-Za-z_$][\w$]*)\s*(\(|$)/);
  if (!match) return null;
  if (match[2] !== '(') return match[1];
  // `save(` must close at the very end, or this is an expression such as
  // `save(a) || other()`, which is left alone.
  const rest = body.replace(/\s*;?\s*$/, '');
  let depth = 0;
  for (let i = match[0].length - 1; i < rest.length; i += 1) {
    if (rest[i] === '(') depth += 1;
    else if (rest[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === rest.length - 1 ? match[1] : null;
    }
  }
  return null;
}
