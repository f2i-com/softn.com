/**
 * Where an app's logic starts in what the engine compiles, and where in it a
 * syntax error is.
 *
 * Every runtime compiles code of SoftN's own ahead of the app's: the bridges,
 * the timers, the values the host hands in and, for a page given the
 * document, the document shell. Since 0.0.29 ZIPP counts the positions it
 * reports (each frame of an error's stack, and the `at` a syntax error ends
 * with) from the first character it is given, and takes an origin for them
 * as Node's `vm.Script` does: a name, and an offset added to every line. The
 * runtimes give it the name `logic` and minus the lines of their own code, so
 * the logic's first line is line 1 (`at save (logic:12:5)`).
 *
 * The logic is the app's as compiled: its logic files joined, their imports
 * inlined. For an app with one logic file those are that file's lines; for
 * one with several they are not lines of any one file, so a syntax error is
 * shown with its line quoted rather than numbered.
 *
 * Nothing here imports acorn: the script worker uses it as it is built.
 */

/** The name an app's logic has in the positions the engine reports. */
export const LOGIC_SCRIPT_NAME = 'logic';

/** `setScriptOrigin`'s arguments: Node's `filename`, `lineOffset` and `columnOffset`. */
export interface ScriptOrigin {
  name: string;
  lineOffset: number;
  columnOffset: number;
}

/** Line terminators, as JavaScript (the engine and acorn) counts lines. */
const LINE_BREAK = /\r\n?|\n|\u2028|\u2029/g;

/** The longest line quoted whole. */
const MAX_QUOTED = 120;

/** The position a syntax error from the engine ends with: `\n    at logic:2:9`. */
const ENGINE_POSITION = /\n[ \t]*at ([^\n]*):(\d+):(\d+)$/;

/**
 * `prefix` with a line of its own for the logic after it: the engine moves
 * the columns of the first line it compiles only, which is the prefix's.
 */
export function endLine(prefix: string): string {
  return prefix === '' || prefix.endsWith('\n') ? prefix : `${prefix}\n`;
}

/** The origin of logic compiled after `prefix`, which ends a line (endLine). */
export function logicOrigin(prefix: string): ScriptOrigin {
  return { name: LOGIC_SCRIPT_NAME, lineOffset: 0 - (prefix.match(LINE_BREAK)?.length ?? 0), columnOffset: 0 };
}

/**
 * `said` with the line `line` of `code` quoted after it, or, past the last
 * line with anything on it, with the end of the logic named instead. Null
 * when that line is blank.
 */
export function quoteLogicLine(said: string, code: string, line: number, atEnd = line > code.trimEnd().split(LINE_BREAK).length): string | null {
  if (atEnd) return `${said}, at the end of the logic: a brace, bracket or string opened before it is never closed`;
  const text = code.split(LINE_BREAK)[line - 1]?.trim();
  if (!text) return null;
  const quoted = text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED - 1)}…` : text;
  return `${said}, at this line of the logic: ${quoted}`;
}

/**
 * A syntax error's message without the position the engine ended it with,
 * and the line of the logic that position names (null for one in anything
 * else, or for none).
 */
export function engineSyntaxPosition(message: string): { said: string; line: number | null } {
  const at = ENGINE_POSITION.exec(message);
  if (!at) return { said: message, line: null };
  return { said: message.slice(0, at.index), line: at[1] === LOGIC_SCRIPT_NAME ? Number(at[2]) : null };
}

/**
 * `error` as the engine threw it, with the line of `code` its position names
 * quoted in place of the position. Anything else is returned as it was. The
 * thrown value keeps its kind: the engine throws its message as a string.
 */
export function placeEngineSyntaxError(error: unknown, code: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/SyntaxError/.test(`${error instanceof Error ? error.name : ''} ${message}`)) return error;
  const { said, line } = engineSyntaxPosition(message);
  const placed = line === null ? null : quoteLogicLine(said, code, line);
  if (placed === null) return error;
  if (!(error instanceof Error)) return placed;
  const replacement = new Error(placed);
  replacement.name = error.name;
  return replacement;
}
