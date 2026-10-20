/**
 * CodeEditor - the Builder's code editor: SoftN's own, from @softn/components.
 *
 * A real `<textarea>` laid over a highlighted copy of its text, so the browser
 * keeps caret, selection, IME, undo and screen readers, and the highlighting
 * is only paint. It is already in the Builder's bundle, since the canvas draws
 * every component. Monaco, which this used to wrap, was 99 MB of node_modules
 * and several megabytes of every Builder install (its TypeScript worker alone
 * 5.8 MB) for two panels.
 *
 * The colours are the brand's, as Monaco's themes had them: the language's
 * own marks (keywords, tags) in coral; strings and numbers in sand; names in
 * the ink; comments, attributes and punctuation in its dims (`.bl-code-editor`
 * in builder.css, which follows the page's theme by itself).
 */

import { CodeEditor as SoftnCodeEditor, type CodeEditorProps } from '@softn/components/editors';

interface Props {
  value: string;
  onChange?: (value: string) => void;
  /** `xml`/`html` for a page's source; `javascript` or `python` for logic. */
  language?: string;
  readOnly?: boolean;
  height?: string | number;
}

/** The highlighter's name for an editor language. A page's markup is read as HTML. */
export function highlightLanguage(language: string | undefined): NonNullable<CodeEditorProps['language']> {
  switch (language) {
    case 'xml':
    case 'html':
    case 'softn':
    case 'formlogic':
      return 'html';
    case 'javascript':
    case 'typescript':
    case 'python':
    case 'json':
    case 'css':
      return language;
    default:
      return 'plain';
  }
}

export function CodeEditor({ value, onChange, language = 'javascript', readOnly = false, height = '100%' }: Props) {
  const size = typeof height === 'number' ? `${height}px` : height;
  return (
    <SoftnCodeEditor
      className="bl-code-editor"
      value={value}
      onChange={onChange}
      language={highlightLanguage(language)}
      readOnly={readOnly}
      tabSize={2}
      minHeight={size}
      maxHeight={size}
      placeholder=""
      aria-label={language === 'xml' || language === 'html' ? 'Page source' : 'Logic'}
      style={{ height: size, border: 0, borderRadius: 0, boxShadow: 'none' }}
    />
  );
}
