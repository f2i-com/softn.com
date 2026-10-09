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

// ---------------------------------------------------------------------------
// Making the function a handler names
// ---------------------------------------------------------------------------

const JS_RESERVED = new Set(
  ('break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
    'import in instanceof let new null return static super switch this throw true try typeof var void while with yield await async').split(' ')
);
const PYTHON_RESERVED = new Set(
  ('False None True and as assert async await break class continue def del elif else except finally for from global if import ' +
    'in is lambda nonlocal not or pass raise return try while with yield').split(' ')
);

/** Whether `name` can be the name of a function in a logic file of this language. */
export function isFunctionName(name: string, language: LogicLanguage): boolean {
  if (language === 'python') return /^[A-Za-z_]\w*$/.test(name) && !PYTHON_RESERVED.has(name);
  return /^[A-Za-z_$][\w$]*$/.test(name) && !JS_RESERVED.has(name);
}

/**
 * How many arguments a handler passes the function it calls: `save()` none,
 * `remove(task.id, "now")` two, and a bare `save` none (the event it would
 * be handed is not something the function was written to take).
 */
export function callArgumentCount(handler: string): number {
  const text = handler.trim().replace(/^\{([\s\S]*)\}$/, '$1').trim();
  const body = text.match(/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/)?.[1]?.trim() ?? text;
  const open = body.indexOf('(');
  if (open === -1) return 0;
  let depth = 0;
  let quote: string | null = null;
  let count = 0;
  let any = false;
  for (let i = open; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; any = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; if (depth > 1) any = true; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return any ? count + 1 : 0;
      continue;
    }
    if (depth === 1 && ch === ',') count += 1;
    else if (!/\s/.test(ch)) any = true;
  }
  return 0;
}

/**
 * Whether a logic file ends where a new top-level function can be written:
 * not inside a string, a comment, a bracket or a block left open, where what
 * was added would land in the middle of it. Read by scanning, since the file
 * is often mid-edit and nothing here may run it.
 */
export function endsFinished(content: string, language: LogicLanguage): boolean {
  let depth = 0;
  let i = 0;
  const n = content.length;
  if (language === 'python') {
    while (i < n) {
      const ch = content[i];
      if (ch === '#') {
        while (i < n && content[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const triple = content.startsWith(ch.repeat(3), i);
        const close = triple ? ch.repeat(3) : ch;
        i += close.length;
        let closed = false;
        while (i < n) {
          if (content[i] === '\\') { i += 2; continue; }
          if (content.startsWith(close, i)) { i += close.length; closed = true; break; }
          // A string in one pair of quotes ends with its line.
          if (!triple && content[i] === '\n') break;
          i += 1;
        }
        if (!closed) return false;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) return false;
    // A block with no body yet, or a line carried on to the next.
    const last = content.split('\n').map((line) => line.replace(/#.*$/, '').trimEnd()).filter((line) => line !== '').pop() ?? '';
    return !last.endsWith(':') && !last.endsWith('\\');
  }

  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && content[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      let closed = false;
      while (i < n) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === ch) { i += 1; closed = true; break; }
        if (ch !== '`' && content[i] === '\n') break;
        i += 1;
      }
      if (!closed) return false;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    i += 1;
  }
  return depth === 0;
}

const PARAMETER_NAMES = ['first', 'second', 'third'];

/**
 * `content` with an empty function called `name` added at its end, taking
 * `parameters` arguments; or null where that could not be right (see
 * {@link isFunctionName} and {@link endsFinished}), or the file has one
 * already.
 */
export function withNewFunction(content: string, name: string, parameters: number, language: LogicLanguage): string | null {
  if (!isFunctionName(name, language) || !endsFinished(content, language)) return null;
  if (logicFunctions(content, language).some((fn) => fn.name === name)) return null;
  const params = Array.from({ length: parameters }, (_, i) => PARAMETER_NAMES[i] ?? `arg${i + 1}`).join(', ');
  const start = content === '' || content.endsWith('\n') ? content : `${content}\n`;
  return language === 'python'
    ? `${start}${start === '' ? '' : '\n\n'}def ${name}(${params}):\n    pass\n`
    : `${start}${start === '' ? '' : '\n'}function ${name}(${params}) {\n}\n`;
}
