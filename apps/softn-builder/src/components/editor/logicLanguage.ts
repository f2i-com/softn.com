/**
 * Which language a logic file is written in, as one pure function.
 *
 * The runtime decides this from the file name and nothing else: a logic file
 * ending `.py` is Python. The editor has to reach the same answer: read as
 * JavaScript, a Python `#` comment, a `'''` string and a decorator are
 * coloured as something else, in code whose indentation IS the program.
 *
 * In a module of its own so it can be read and tested without the editor.
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

export type CodeEditorLanguage = 'html' | 'css' | 'typescript' | 'javascript' | 'python' | 'json' | 'plain';

/** Syntax highlight language for any editable text file in the project. */
export function codeLanguageFor(path: string | undefined): CodeEditorLanguage {
  if (!path) return 'javascript';
  const lower = path.toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  if (/\.(?:tsx?|mts)$/.test(lower)) return 'typescript';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.json') || lower.endsWith('.xdb')) return 'json';
  if (/\.(?:html?|ui|vue)$/.test(lower)) return 'html';
  if (/\.(?:md|txt)$/.test(lower)) return 'plain';
  return 'javascript';
}

/** Human-readable badge label for a file's syntax mode. */
export function codeLanguageLabelFor(path: string | undefined): string {
  if (path && /\.jsx$/i.test(path)) return 'React JSX';
  if (path && /\.vue$/i.test(path)) return 'Vue component';
  switch (codeLanguageFor(path)) {
    case 'python':
      return 'Python';
    case 'typescript':
      return 'TypeScript';
    case 'css':
      return 'CSS';
    case 'json':
      return 'JSON';
    case 'html':
      return 'HTML';
    case 'plain':
      return 'Text';
    default:
      return 'JavaScript';
  }
}
