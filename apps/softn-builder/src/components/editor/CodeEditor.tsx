/**
 * CodeEditor - Monaco editor wrapper for code editing
 */

import { useEffect, useRef, useState } from 'react';
import Editor, { OnMount, OnChange } from '@monaco-editor/react';
import { currentTheme, subscribeTheme, type Theme } from '@softn/brand';
import './monacoSetup';
import { MONACO_FONT_FAMILY, monacoThemeFor } from './monacoThemes';

interface Props {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  height?: string | number;
  theme?: 'light' | 'vs-dark';
}

export function CodeEditor({
  value,
  onChange,
  language = 'javascript',
  readOnly = false,
  height = '100%',
  theme,
}: Props) {
  // Left to itself, the editor follows the theme every SoftN app shares, so
  // a light page does not carry a dark editor or the other way round.
  const [shared, setShared] = useState<Theme>(currentTheme);
  useEffect(() => subscribeTheme(setShared), []);
  const monacoTheme = monacoThemeFor(shared === 'dark' ? 'dark' : 'light', theme);

  // The value as of this render. Monaco loads asynchronously, and a value
  // that changed while it loaded — opening a project replaces the logic the
  // dock was created with — was lost: the editor mounted with the first
  // value, showed the previous project's logic, and the first keystroke
  // wrote that back over the opened file. Mounting checks against this.
  const latestValue = useRef(value);
  latestValue.current = value;

  const handleEditorMount: OnMount = (editor, monaco) => {
    if (editor.getValue() !== latestValue.current) editor.setValue(latestValue.current);

    // Configure editor settings
    editor.updateOptions({
      minimap: { enabled: false },
      lineNumbers: 'on',
      fontSize: 13,
      fontFamily: MONACO_FONT_FAMILY,
      lineHeight: 20,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: 'line',
      cursorBlinking: 'smooth',
      smoothScrolling: true,
    });

    // Add SoftN/.logic syntax highlighting
    if (language === 'softn' || language === 'formlogic') {
      monaco.languages.register({ id: 'softn' });
      monaco.languages.setMonarchTokensProvider('softn', {
        tokenizer: {
          root: [
            [/<\/?[a-zA-Z][a-zA-Z0-9]*/, 'tag'],
            [/\{[^}]+\}/, 'variable'],
            [/@[a-zA-Z]+/, 'keyword'],
            [/:[a-zA-Z]+/, 'attribute'],
            [/"[^"]*"/, 'string'],
            [/'[^']*'/, 'string'],
            [/\b(let|const|function|if|else|return|for|while)\b/, 'keyword'],
            [/\b(true|false|null|undefined)\b/, 'constant'],
            [/\b[0-9]+\b/, 'number'],
            [/\/\/.*$/, 'comment'],
            [/\/\*/, 'comment', '@comment'],
          ],
          comment: [
            [/\*\//, 'comment', '@pop'],
            [/./, 'comment'],
          ],
        },
      });
    }
  };

  const handleChange: OnChange = (newValue) => {
    if (onChange && newValue !== undefined) {
      onChange(newValue);
    }
  };

  return (
    <Editor
      height={height}
      language={language === 'softn' || language === 'formlogic' ? 'javascript' : language}
      value={value}
      onChange={handleChange}
      onMount={handleEditorMount}
      theme={monacoTheme}
      options={{
        readOnly,
        domReadOnly: readOnly,
        // Monaco's word highlighter leaves its delayed lookup promise uncaught
        // when a model is disposed during a workspace/view switch. Avoid that
        // background lookup in these temporary editors; syntax highlighting,
        // selection highlighting and language completions remain available.
        occurrencesHighlight: 'off',
      }}
      loading={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            fontSize: 12,
            color: 'var(--dim)',
            background: 'var(--ink-2)',
          }}
          role="status"
        >
          Loading editor…
        </div>
      }
    />
  );
}
