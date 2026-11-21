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

export type CodeEditorLanguage =
  | 'html'
  | 'css'
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'php'
  | 'sql'
  | 'rust'
  | 'shell'
  | 'markdown'
  | 'json'
  | 'plain';

/** Syntax highlight language for any editable text file in the project. */
export function codeLanguageFor(path: string | undefined): CodeEditorLanguage {
  if (!path) return 'javascript';
  const lower = path.toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  if (/\.(?:php|phtml)$/.test(lower)) return 'php';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.rs')) return 'rust';
  if (/\.(?:tsx?|mts|cts)$/.test(lower)) return 'typescript';
  if (/\.(?:m?js|cjs|jsx|logic)$/.test(lower)) return 'javascript';
  if (/\.(?:css|scss|less)$/.test(lower)) return 'css';
  if (lower.endsWith('.json') || lower.endsWith('.xdb')) return 'json';
  if (/\.(?:html?|ui|xml|svg)$/.test(lower)) return 'html';
  if (/\.(?:md|markdown)$/.test(lower)) return 'markdown';
  if (/\.(?:toml|ya?ml|ini|conf|cfg|env|sh|bash|zsh)$/.test(lower) || /(?:^|\/)(?:\.htaccess|dockerfile|makefile)$/.test(lower)) return 'shell';
  return 'plain';
}

/** Human-readable badge label for a file's syntax mode. */
export function codeLanguageLabelFor(path: string | undefined): string {
  switch (codeLanguageFor(path)) {
    case 'python':
      return 'Python';
    case 'php':
      return 'PHP';
    case 'sql':
      return 'SQL';
    case 'rust':
      return 'Rust';
    case 'shell':
      return 'Config';
    case 'markdown':
      return 'Markdown';
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
