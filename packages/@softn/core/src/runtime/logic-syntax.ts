/**
 * Where in the logic a syntax error is.
 *
 * Up to 0.0.28 ZIPP reported a script that does not compile as `SyntaxError:
 * unexpected token Semi` and nothing more: no line, no column. The page
 * showed that, and Studio's check handed it to the AI, which then had the
 * whole of the logic to search. Since 0.0.29 its message ends with the
 * position (`\n    at logic:2:9`), counted from the logic's first line
 * (logic-origin.ts), and the line there is quoted with the message in its
 * place. The host-JavaScript engine's position counts its own preamble, so
 * for it the failed compile is read once more by acorn, which core ships for
 * that engine, and the line acorn stops at is quoted.
 *
 * Quoted, not numbered: what is compiled is the app's logic files joined, with
 * their imports inlined, so a line number would count lines of a text the
 * author never wrote. acorn is loaded only when a compile fails that the
 * engine has not placed, so a page whose logic compiles never loads it; where
 * it cannot be loaded, the message stays as the engine wrote it. The script
 * worker places ZIPP's errors with logic-origin.ts alone: its copy of core is
 * served as it is built, where `acorn` is a name no browser can resolve.
 */

import { engineSyntaxPosition, placeEngineSyntaxError, quoteLogicLine } from './logic-origin';

/**
 * `error` as the engine threw it, with the line of `code` that does not
 * compile quoted after its message. Anything that is not a syntax error, or
 * that neither the engine nor acorn places, is returned as it was. The thrown
 * value keeps its kind: the engine throws its message as a string, and a host
 * may show it as one.
 */
export async function placeSyntaxError(error: unknown, code: string): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (!/SyntaxError/.test(`${name} ${message}`)) return error;
  const engine = engineSyntaxPosition(message);
  if (engine.line !== null) return placeEngineSyntaxError(error, code);
  let at: { pos?: number; loc?: { line?: number } } | undefined;
  try {
    const acorn = await import('acorn');
    acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
    });
  } catch (fault) {
    at = fault as typeof at;
  }
  const line = at?.loc?.line;
  if (line === undefined) return error;
  // The host-JavaScript engine's message carries a position of its own, in
  // the script with its preamble: a line the author cannot find. So does a
  // ZIPP position in anything but the logic.
  const said = engine.said.replace(/ \(\d+:\d+\)$/, '');
  const placed = quoteLogicLine(said, code, line, (at?.pos ?? 0) >= code.trimEnd().length);
  if (placed === null) return error;
  if (!(error instanceof Error)) return placed;
  const replacement = new Error(placed);
  replacement.name = error.name;
  return replacement;
}
