/**
 * Which language a logic file is written in, as one pure function.
 *
 * The runtime decides this from the file name and nothing else: a logic file
 * ending `.py` is Python. The editor has to reach the same answer, and not
 * only for the colours — Monaco's JavaScript mode marks correct Python as
 * broken from the first `def`, and its auto-indent fights code whose
 * indentation IS the program.
 *
 * In a module of its own so it can be read and tested without loading the
 * editor, which pulls in all of Monaco.
 */

/** A logic file with this name ending is Python; everything else is JavaScript. */
export const PYTHON_LOGIC_SUFFIX = '.py';

/**
 * The editor language for a logic file path. With no path there is no file
 * to say otherwise, and the answer is JavaScript.
 */
export function editorLanguageFor(path: string | undefined): 'javascript' | 'python' {
  return path !== undefined && path.toLowerCase().endsWith(PYTHON_LOGIC_SUFFIX)
    ? 'python'
    : 'javascript';
}
