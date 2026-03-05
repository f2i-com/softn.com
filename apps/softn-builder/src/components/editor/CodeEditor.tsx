/**
 * CodeEditor - Monaco editor wrapper for code editing
 */

import Editor, { OnMount, OnChange } from '@monaco-editor/react';

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
  theme = 'light',
}: Props) {
  const handleEditorMount: OnMount = (editor, monaco) => {
    // Configure editor settings
    editor.updateOptions({
      minimap: { enabled: false },
      lineNumbers: 'on',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: 'line',
      cursorBlinking: 'smooth',
      smoothScrolling: true,
    });

    // Add SoftN/FormLogic syntax highlighting
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
      theme={theme === 'vs-dark' ? 'vs-dark' : 'light'}
      options={{
        readOnly,
        domReadOnly: readOnly,
      }}
      loading={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#94a3b8',
          }}
        >
          Loading editor...
        </div>
      }
    />
  );
}
