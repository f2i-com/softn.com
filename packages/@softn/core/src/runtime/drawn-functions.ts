/**
 * What a function the page calls while it is drawn may read.
 *
 * State the markup never names is kept in the engine and not mirrored to the
 * page (see `partitionStateVars` in script-runtime.ts): nothing on the page
 * could read it, and mirroring it costs. But a function called from the
 * markup is how a page reads state. `<p>{label()}</p>` over
 * `function label() { return "n is " + n }` puts `n` on the screen though no
 * markup names it. Left unmirrored, a change to `n` told the page nothing,
 * the page was not drawn again, and the paragraph stood at its first value.
 *
 * So what such a function may read is observed too. This module is the part
 * of that with no engine in it: which names of a page may be called while it
 * is drawn, and what a function of that name may read, followed through the
 * logic. The main-thread runtime and the worker both ask it.
 *
 * The logic is read as text and the reading errs one way. A name too many is
 * mirrored for nothing, which costs a little speed; a name too few freezes
 * part of the page with nothing to say why. Where the text cannot be followed
 * at all the answer is "unknown", and the runtime mirrors everything, as it
 * does for a host that never asked for less.
 */

import type { SoftNDocument } from '../parser/ast';

/** A name as the engine reads one: Unicode, as `collectObservedStateNames` scans. */
const NAME = /[\p{ID_Start}$_][\p{ID_Continue}$_]*/gu;

/**
 * Whether a prop is one a component calls when something happens: `onClick`,
 * `onTick`. The renderer decides with this which functions a prop's
 * expression is given, the ones that tell the page afterwards or the ones
 * that answer at once, so the page scan below cannot disagree with it about
 * what runs while the page is drawn.
 */
export function isCallbackProp(name: string): boolean {
  return name.startsWith('on') && name.length > 2;
}

/**
 * Props a component pulls through on a clock of its own, not while it is
 * drawn: `<PixelCanvas getFrame={frameSource} />` asks for a frame at every
 * display frame, `<AudioStream getSamples={sampleSource} />` whenever its
 * buffer runs low. Drawing the page again does nothing for either, so the
 * function is not followed, as an event's handler is not.
 *
 * It matters because of what such a function reads. It is how an emulator
 * reaches its canvas, and `frameSource` reads the whole machine: followed, it
 * mirrored every one of Pocket's 266 held-back names and SoftDOS's 405, which
 * is the cost this partition exists to spare them.
 *
 * Named here one by one, and nothing is inferred from how a prop is spelt.
 * A prop like these that is missing from the list is followed like any other
 * function a component is handed, which costs that app speed; a prop wrongly
 * taken for one would freeze a formatter's output, which is the worse mistake.
 */
const PULLED_PROPS: ReadonlySet<string> = new Set(['getFrame', 'getSamples']);

// ============================================================================
// The page: which names may be called while it is drawn
// ============================================================================

type Node = Record<string, unknown>;

/**
 * Where in the page an expression stands: where the page is drawn with it,
 * where an event's handler is, or elsewhere inside a handler.
 */
type Place = 'drawn' | 'handler' | 'event';

/** What kind of node `value` is, if it is one. */
function kindOf(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? (value as Node).type : undefined;
}

function addNames(text: string, into: Set<string>): void {
  for (const match of text.matchAll(NAME)) into.add(match[0]);
}

/** The names in a handler's block body, except those written as a call. */
function addNamesNotCalled(text: string, into: Set<string>): void {
  for (const match of text.matchAll(NAME)) {
    if (!/^\s*\(/.test(text.slice(match.index + match[0].length))) into.add(match[0]);
  }
}

/**
 * Every name a page could call while it is drawn: the names its expressions
 * are written with, except what an event runs.
 *
 * `@click={() => start()}` calls `start` on a click, and `@tick={tick}`
 * calls `tick` on a tick. Neither is called to draw the page, and what such a
 * function reads is the large state this exists to keep in the engine: a
 * game's `tick` reads all of it. So the handler itself, and a name written as
 * a call inside one, are left out. Any other name in a handler stays in:
 * `@click={() => show(rowLabel)}` hands `rowLabel` to something that may call
 * it later, while the page is drawn.
 *
 * A function a component is handed is one the page may call while it is
 * drawn, whether the prop calls it (`format={(value) => money(value)}`) or
 * names it (`format={money}`): a chart asks its formatter as it draws. The
 * two props a component pulls through on its own clock are the exception,
 * and are read as an event's handler is (see `PULLED_PROPS`).
 *
 * Only expressions are read. The renderer looks a function up for a name in
 * an expression and for nothing else, so the words of a paragraph, of a
 * `class` or of the style block call nothing; counted, the "rotate" and
 * "hold" of a game's key legend passed for calls to `rotate()` and `hold()`,
 * and all that those read was mirrored for it. Nor are the words of the
 * document's own structure read: every node carries `loc.start`, and `start`
 * is what half of all games call a function. (The scan for observed state
 * does read all of those, and is right to: there a word too many costs
 * nothing worth having.)
 *
 * Returns null when the page cannot be walked, meaning "any name at all".
 */
export function collectDrawnNames(doc: SoftNDocument): ReadonlySet<string> | null {
  const { script: _script, logic: _logic, ...page } = doc;
  const names = new Set<string>();
  try {
    readPage(page, names, new Set(), 'drawn');
  } catch {
    // Cyclic, or deeper than the stack: nothing can be shown not to be called.
    return null;
  }
  return names;
}

function readPage(value: unknown, into: Set<string>, open: Set<object>, place: Place): void {
  if (value === null || typeof value !== 'object') return;
  if (open.has(value)) throw new Error('The page refers to itself');
  open.add(value);
  // Only the handler itself stands where the handler is, not what is inside it.
  const inside: Place = place === 'handler' ? 'event' : place;
  if (Array.isArray(value)) {
    for (const item of value) readPage(item, into, open, inside);
  } else {
    const node = value as Node;
    if (node.type === 'Identifier') {
      // `@click={start}` is the function the event calls. Any other name is one the page may call.
      if (place !== 'handler' && typeof node.name === 'string') into.add(node.name);
    } else {
      // `onTick={tick}` is called when something happens, `getFrame={frameSource}`
      // when the canvas wants a frame: neither while the page is drawn.
      const callback =
        node.type === 'Prop' &&
        typeof node.name === 'string' &&
        (isCallbackProp(node.name) || PULLED_PROPS.has(node.name));
      // `@click={busy ? wait : save}`, `@click={ready && save}`: either may be the handler.
      const choice =
        place === 'handler' &&
        (node.type === 'ConditionalExpression' ||
          (node.type === 'BinaryExpression' && ['&&', '||', '??'].includes(node.operator as string)));
      for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        const child = node[key];
        if (node.type === 'Element' && key === 'events' && Array.isArray(child)) {
          for (const event of child) readPage((event as Node | null)?.handler, into, open, 'handler');
        } else if (node.type === 'Prop' && key === 'value' && kindOf(child) === 'expression') {
          readPage((child as Node).value, into, open, callback ? 'handler' : 'drawn');
        } else if (node.type === 'CallExpression' && key === 'callee' && place !== 'drawn' && kindOf(child) === 'Identifier') {
          // `start()`, `() => start()`: called when the event happens.
        } else if (node.type === 'MemberExpression' && key === 'property' && node.computed !== true) {
          // `user.name`: a key, which is never looked up as a name.
        } else if (node.type === 'ArrowFunctionExpression' && key === 'body' && typeof child === 'string') {
          // A block body is kept as its text.
          if (place === 'drawn') addNames(child, into);
          else addNamesNotCalled(child, into);
        } else {
          readPage(child, into, open, choice && key !== 'test' ? 'handler' : inside);
        }
      }
    }
  }
  open.delete(value);
}

// ============================================================================
// The logic: its text as tokens
// ============================================================================

interface Token {
  /** `value` is a number, a regular expression or the start of a template. */
  kind: 'word' | 'punct' | 'string' | 'value';
  /** The word, the punctuation, or what a string says. */
  text: string;
  /** Whether a line break stands between this and the token before it. */
  nl: boolean;
  /** For a bracket, where its partner is; otherwise -1. */
  match: number;
}

/** Longest first, so that `=` is only ever an assignment. */
const OPERATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
];

const NUMBER = /0[xXbBoO][\da-fA-F_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?/y;
const NAME_AT = /[\p{ID_Start}$_][\p{ID_Continue}$_]*/uy;

/** Words after which a `/` begins a regular expression rather than dividing. */
const BEFORE_A_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '${': '}' };

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === text;
}

/**
 * The logic as tokens, with comments and what strings say left out of the
 * names, and every bracket matched to its partner.
 *
 * Returns null where the text does not hold together: a string or a comment
 * left open, a bracket without its partner. That is this reader losing its
 * place, most likely in a regular expression it took for a division, and
 * nothing read after that point could be trusted.
 */
function tokenize(code: string): Token[] | null {
  const tokens: Token[] = [];
  /** The brackets open at this point, as indices into `tokens`. */
  const open: number[] = [];
  let i = 0;
  let nl = false;

  const push = (kind: Token['kind'], text: string): Token => {
    const token: Token = { kind, text, nl, match: -1 };
    tokens.push(token);
    nl = false;
    return token;
  };

  /** Read on through a template's text from `at`: to its end, or to the next `${`. False if it never ends. */
  const template = (at: number): boolean => {
    let j = at;
    while (j < code.length) {
      const ch = code[j];
      if (ch === '\\') {
        j += 2;
      } else if (ch === '`') {
        i = j + 1;
        return true;
      } else if (ch === '$' && code[j + 1] === '{') {
        open.push(tokens.length);
        push('punct', '${');
        i = j + 2;
        return true;
      } else {
        j++;
      }
    }
    return false;
  };

  while (i < code.length) {
    const ch = code[i];

    if (ch === '\n') {
      nl = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\uFEFF' || ch === '\u00A0') {
      i++;
      continue;
    }

    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end === -1) return null;
      if (code.slice(i, end).includes('\n')) nl = true;
      i = end + 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) {
        if (code[j] === '\n') return null;
        j += code[j] === '\\' ? 2 : 1;
      }
      if (j >= code.length) return null;
      push('string', code.slice(i + 1, j));
      i = j + 1;
      continue;
    }

    if (ch === '`') {
      push('value', '`');
      if (!template(i + 1)) return null;
      continue;
    }

    if (ch === '/') {
      const before = tokens[tokens.length - 1];
      const regexHere =
        before === undefined ||
        (before.kind === 'word' && BEFORE_A_REGEX.has(before.text)) ||
        (before.kind === 'punct' && ![')', ']', '}', '++', '--'].includes(before.text));
      if (regexHere) {
        let j = i + 1;
        let inClass = false;
        while (j < code.length && code[j] !== '\n' && (inClass || code[j] !== '/')) {
          if (code[j] === '\\') j++;
          else if (code[j] === '[') inClass = true;
          else if (code[j] === ']') inClass = false;
          j++;
        }
        // One that does not close on its line was a division after all.
        if (j < code.length && code[j] === '/') {
          j++;
          while (j < code.length && /[A-Za-z]/.test(code[j])) j++;
          push('value', '/');
          i = j;
          continue;
        }
      }
    }

    NUMBER.lastIndex = i;
    if ((ch >= '0' && ch <= '9') || (ch === '.' && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      const number = NUMBER.exec(code);
      if (number) {
        push('value', '0');
        i += number[0].length;
        continue;
      }
    }

    NAME_AT.lastIndex = i;
    const name = NAME_AT.exec(code);
    if (name) {
      push('word', name[0]);
      i += name[0].length;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      open.push(tokens.length);
      push('punct', ch);
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const partner = open.pop();
      if (partner === undefined || CLOSERS[tokens[partner].text] !== ch) return null;
      const inTemplate = tokens[partner].text === '${';
      tokens[partner].match = tokens.length;
      push('punct', ch).match = partner;
      i++;
      // The `}` that ends `${…}` hands back to the template's text.
      if (inTemplate && !template(i)) return null;
      continue;
    }

    const operator = OPERATORS.find((candidate) => code.startsWith(candidate, i));
    push('punct', operator ?? ch);
    i += operator ? operator.length : 1;
  }

  return open.length === 0 ? tokens : null;
}

// ============================================================================
// The logic: its statements, and where each name is given a function
// ============================================================================

/** One statement at the top of the logic: a function, a class, a declaration, or anything else. */
interface Chunk {
  /** Every name written in it, which is every name it may read. */
  words: Set<string>;
  /** The names written where something is called. */
  called: Set<string>;
  /** Why what it reads cannot be told, when it cannot. */
  unknown: string | null;
}

interface Outline {
  /** The functions and classes declared at the top, by name. */
  functions: Map<string, Chunk[]>;
  /** The variables declared at the top, by name. */
  variables: Map<string, Chunk[]>;
  /** Where a name is given a function to hold, wherever it is written: `name() {…}`, `name: () => …`, `x.name = function…`. */
  made: Map<string, Chunk[]>;
  /** Where a name is given anything at all: `name = …`, `name: …`. */
  assigned: Map<string, Chunk[]>;
}

/** Words that take an operand, so that a line break after one ends nothing. */
const TAKES_AN_OPERAND = new Set([
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'else',
  'do',
  'case',
  'extends',
  'await',
  'yield',
  'let',
  'const',
  'var',
  'function',
  'class',
  'async',
]);

/** Words that are followed by `(…) {` without being the name of a function. */
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return']);

function file(map: Map<string, Chunk[]>, name: string, chunk: Chunk): void {
  const list = map.get(name);
  if (!list) map.set(name, [chunk]);
  else if (list[list.length - 1] !== chunk) list.push(chunk);
}

function outline(tokens: Token[], functionNames: ReadonlySet<string>): Outline {
  const result: Outline = { functions: new Map(), variables: new Map(), made: new Map(), assigned: new Map() };

  /** Whether a function begins at `at`: `function…`, `async…`, `(…) => …`, `x => …`, or the name of one declared. */
  const functionAt = (at: number): boolean => {
    const token = tokens[at];
    if (!token) return false;
    if (token.kind === 'word') {
      if (token.text === 'function' || token.text === 'async' || token.text === 'class') return true;
      const after = tokens[at + 1];
      if (isPunct(after, '=>')) return true;
      // `fmt: formatScore`, `this.fmt = formatScore`: the function itself, not what calling it gives.
      return functionNames.has(token.text) && !(after?.kind === 'punct' && ['(', '.', '?.', '['].includes(after.text));
    }
    return isPunct(token, '(') && isPunct(tokens[token.match + 1], '=>');
  };

  /** Read the tokens from `start` to `end` as one statement. */
  const read = (start: number, end: number): Chunk => {
    const chunk: Chunk = { words: new Set(), called: new Set(), unknown: null };
    const cannotTell = (why: string) => {
      chunk.unknown ??= why;
    };
    for (let k = start; k <= end; k++) {
      const token = tokens[k];
      const next = tokens[k + 1];
      if (token.kind === 'word') {
        const word = token.text;
        chunk.words.add(word);
        if (isPunct(next, '(')) {
          chunk.called.add(word);
          // `describe() {…}` in a class or a record, `function inner() {…}`.
          if (!NOT_A_METHOD.has(word) && isPunct(tokens[next!.match + 1], '{')) file(result.made, word, chunk);
        } else if (
          (isPunct(next, '?.') && isPunct(tokens[k + 2], '(')) ||
          (next?.kind === 'value' && next.text === '`') ||
          (isPunct(next, '.') &&
            ['call', 'apply', 'bind'].includes(tokens[k + 2]?.text ?? '') &&
            isPunct(tokens[k + 3], '('))
        ) {
          chunk.called.add(word);
        }
        if (isPunct(next, '=') || isPunct(next, ':')) {
          file(result.assigned, word, chunk);
          if (functionAt(k + 2)) file(result.made, word, chunk);
        }
        if (word === 'eval' && isPunct(next, '(')) cannotTell('it calls eval');
        else if (word === 'Function') cannotTell('it makes a function from text');
        else if (word === 'globalThis') cannotTell('it reads globalThis');
        else if ((word === 'window' || word === 'self') && isPunct(next, '[')) {
          cannotTell(`it reads ${word} by a name worked out as it runs`);
        } else if (word === 'Proxy' || word === 'Reflect') cannotTell(`it uses ${word}`);
        else if (word === 'with' && isPunct(next, '(')) cannotTell('it uses with');
      } else if (token.kind === 'string') {
        // `"fmt": function () {…}`, `api["fmt"] = function () {…}`: a name all the same.
        const value = isPunct(next, ':') ? k + 2 : isPunct(next, ']') && isPunct(tokens[k + 2], '=') ? k + 3 : -1;
        if (value !== -1 && /^[\p{ID_Start}$_][\p{ID_Continue}$_]*$/u.test(token.text)) {
          file(result.assigned, token.text, chunk);
          if (functionAt(value)) file(result.made, token.text, chunk);
        }
      } else if (token.kind === 'punct' && (token.text === ']' || token.text === ')') && isPunct(next, '(')) {
        // `handlers[kind](x)`, `pick(kind)(x)`: what is called has no name to
        // follow. `(function () {…})()` is written out where it is called,
        // and `(fmt)(x)` has its name, so those are read like anything else.
        const before = tokens[token.match - 1];
        const grouping =
          before === undefined ||
          (before.kind === 'word' && BEFORE_A_REGEX.has(before.text)) ||
          (before.kind === 'punct' && ![')', ']', '}'].includes(before.text));
        if (!(token.text === ')' && grouping && functionAt(token.match + 1))) {
          cannotTell('it calls a function it finds as it runs');
        }
      }
    }
    return chunk;
  };

  /** Whether `token` can be the last of a statement, so that a line break after it may end one. */
  const endsAValue = (token: Token): boolean =>
    token.kind === 'word'
      ? !TAKES_AN_OPERAND.has(token.text)
      : token.kind !== 'punct' || [')', ']', '}', '++', '--'].includes(token.text);

  /** Whether `token`, first on its line, begins a statement rather than carrying the last one on. */
  const beginsAStatement = (token: Token): boolean =>
    token.kind === 'word'
      ? !['in', 'of', 'instanceof'].includes(token.text)
      : token.kind === 'string' ||
        (token.kind === 'value' && token.text !== '`') ||
        (token.kind === 'punct' && ['{', '!', '~', '++', '--', ';'].includes(token.text));

  /** The last token of the statement that begins at `start`. */
  const statementEnd = (start: number): number => {
    let j = start;
    for (;;) {
      if (tokens[j].match > j) j = tokens[j].match;
      if (isPunct(tokens[j], ';')) return j;
      const next = tokens[j + 1];
      if (!next) return j;
      if (next.nl && endsAValue(tokens[j]) && beginsAStatement(next)) return j;
      j++;
    }
  };

  let i = 0;
  while (i < tokens.length) {
    const start = i;
    let end = -1;
    let names: string[] = [];
    let into = result.functions;

    // `function name(…) {…}`, with `async` before it or `*` after.
    let j = i;
    if (tokens[j].kind === 'word' && tokens[j].text === 'async' && tokens[j + 1]?.text === 'function') j++;
    if (tokens[j].kind === 'word' && tokens[j].text === 'function') {
      j++;
      if (isPunct(tokens[j], '*')) j++;
      const name = tokens[j];
      const params = tokens[j + 1];
      if (name?.kind === 'word' && isPunct(params, '(') && isPunct(tokens[params.match + 1], '{')) {
        names = [name.text];
        end = tokens[params.match + 1].match;
      }
    } else if (tokens[i].kind === 'word' && tokens[i].text === 'class' && tokens[i + 1]?.kind === 'word') {
      // `class Name extends Other {…}`: the body is the first `{` at this level.
      for (let k = i + 2; k < tokens.length && !isPunct(tokens[k], ';'); k++) {
        if (isPunct(tokens[k], '{')) {
          names = [tokens[i + 1].text];
          end = tokens[k].match;
          break;
        }
        if (tokens[k].match > k) k = tokens[k].match;
      }
    } else if (tokens[i].kind === 'word' && ['let', 'const', 'var'].includes(tokens[i].text)) {
      end = statementEnd(i);
      into = result.variables;
      // Each declarator: a name, or a pattern whose every word may be one.
      let k = i + 1;
      while (k <= end) {
        const binding = tokens[k];
        if (binding.kind === 'word') {
          names.push(binding.text);
        } else if (isPunct(binding, '{') || isPunct(binding, '[')) {
          for (let inner = k + 1; inner < binding.match; inner++) {
            if (tokens[inner].kind === 'word') names.push(tokens[inner].text);
          }
          k = binding.match;
        } else {
          break;
        }
        k++;
        while (k <= end && !isPunct(tokens[k], ',')) {
          if (tokens[k].match > k) k = tokens[k].match;
          k++;
        }
        k++;
      }
    }

    if (end === -1) end = statementEnd(i);
    const chunk = read(start, end);
    for (const name of names) file(into, name, chunk);
    i = end + 1;
  }

  return result;
}

// ============================================================================
// What the drawn functions may read
// ============================================================================

export interface DrawnReadsInput {
  /**
   * The logic as it is compiled, imports joined in, with the functions the
   * host hands the script written out before it. Not needed for Python.
   */
  code: string;
  /** Every name the engine holds as a function: the script's functions and its classes. */
  functionNames: readonly string[];
  /**
   * The names a page may call while it is drawn, from {@link collectDrawnNames}.
   * Null when the host did not say, and every name must be supposed.
   */
  drawn: ReadonlySet<string> | null;
  /** The logic is Python, which this does not read. */
  python?: boolean;
}

export type DrawnReads =
  | {
      known: true;
      /** The functions the page may call while it is drawn. */
      functions: string[];
      /** Every name they may read. More than the state among them: a name too many costs nothing here. */
      names: ReadonlySet<string>;
    }
  | {
      known: false;
      functions: string[];
      /** Why it could not be worked out, for whoever is asking why everything is mirrored. */
      why: string;
    };

/**
 * The names the functions a page calls while it is drawn may read.
 *
 * A function may read every name in its body; every name in the body of a
 * function, a class or a top-level declaration it names, and so on through
 * them; and, for a name it writes after a dot or calls, what is written
 * wherever that name is given a function to hold: a method of a class or a
 * record, `x.name = function…`. Names are followed whether or not they turn
 * out to be state, and a whole statement is read for any part of it, so the
 * answer is larger than the truth and never smaller in the ways it is
 * followed.
 *
 * It is unknown, and the runtime mirrors everything, when the logic is
 * Python; when its text cannot be read to the end; when a function the
 * engine holds is not to be found in it; and when something on the way calls
 * a function it finds as it runs (`handlers[kind](x)`), or reads a global by
 * a name it works out, or uses `eval`.
 *
 * What it cannot see: a function held in state that is put there by code
 * nothing drawn names, and reached without a name (`list.push(() => …)` in
 * one place, `list[0]()` is caught, `for (const f of list) f()` is not).
 */
export function readsOfDrawnFunctions(input: DrawnReadsInput): DrawnReads {
  const { drawn } = input;
  const functions = drawn ? input.functionNames.filter((name) => drawn.has(name)) : [...input.functionNames];
  if (functions.length === 0) return { known: true, functions, names: new Set() };
  if (input.python) return { known: false, functions, why: 'the logic is Python, which is not read for what a function reads' };

  const tokens = tokenize(input.code);
  if (!tokens) return { known: false, functions, why: 'the logic could not be read to its end' };

  const functionNames = new Set(input.functionNames);
  const { functions: declared, variables, made, assigned } = outline(tokens, functionNames);

  // The engine read the same text and found these functions in it. One this
  // reading did not find is this reading having lost its place.
  for (const name of functionNames) {
    if (!declared.has(name)) {
      return { known: false, functions, why: `the function ${name} was not found where the logic is written` };
    }
  }

  const names = new Set<string>();
  const called = new Set<string>();
  const reached = new Set<Chunk>();
  const queue: string[] = [];
  let unknown: string | null = null;

  const follow = (chunks: Chunk[] | undefined): void => {
    if (!chunks) return;
    for (const chunk of chunks) {
      if (reached.has(chunk)) continue;
      reached.add(chunk);
      unknown ??= chunk.unknown;
      for (const word of chunk.words) {
        if (!names.has(word)) {
          names.add(word);
          queue.push(word);
        }
      }
      // A name now known to be called is looked at again: see below.
      for (const word of chunk.called) {
        if (!called.has(word)) {
          called.add(word);
          queue.push(word);
        }
      }
    }
  };

  for (const name of functions) {
    names.add(name);
    called.add(name);
    queue.push(name);
  }
  while (queue.length > 0 && unknown === null) {
    const word = queue.pop()!;
    follow(declared.get(word));
    follow(variables.get(word));
    follow(made.get(word));
    // A name that is called holds a function, wherever it got one: `fmt =
    // makeFormatter()` is then somewhere to look. A name that is only read
    // is not followed to every place it is assigned, or `score` would lead
    // to the tick that adds to it and so to everything.
    if (called.has(word)) follow(assigned.get(word));
  }

  if (unknown !== null) return { known: false, functions, why: unknown };
  return { known: true, functions, names };
}
