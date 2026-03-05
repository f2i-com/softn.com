/**
 * CodeEditor Component
 *
 * A simple code editor with syntax highlighting using CSS.
 * For a more full-featured editor, integrate Monaco or CodeMirror.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';

export interface CodeEditorProps {
  /** Current value */
  value?: string;
  /** Default value */
  defaultValue?: string;
  /** Language for syntax highlighting */
  language?:
    | 'javascript'
    | 'typescript'
    | 'json'
    | 'html'
    | 'css'
    | 'python'
    | 'sql'
    | 'markdown'
    | 'plain';
  /** Placeholder text */
  placeholder?: string;
  /** Whether the editor is disabled */
  disabled?: boolean;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Show line numbers */
  lineNumbers?: boolean;
  /** Tab size */
  tabSize?: number;
  /** Minimum height */
  minHeight?: string;
  /** Maximum height */
  maxHeight?: string;
  /** Change handler */
  onChange?: (value: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// Basic syntax highlighting patterns
const highlightPatterns: Record<string, { pattern: RegExp; className: string }[]> = {
  javascript: [
    { pattern: /(\/\/.*$)/gm, className: 'comment' },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, className: 'string' },
    {
      pattern:
        /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this)\b/g,
      className: 'keyword',
    },
    { pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, className: 'literal' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
  ],
  typescript: [
    { pattern: /(\/\/.*$)/gm, className: 'comment' },
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, className: 'string' },
    {
      pattern:
        /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|interface|type|enum|implements|extends|public|private|protected|readonly)\b/g,
      className: 'keyword',
    },
    { pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, className: 'literal' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
    { pattern: /:\s*(string|number|boolean|any|void|never|unknown|object)\b/g, className: 'type' },
  ],
  json: [
    { pattern: /("(?:[^"\\]|\\.)*")\s*:/g, className: 'property' },
    { pattern: /:\s*("(?:[^"\\]|\\.)*")/g, className: 'string' },
    { pattern: /\b(true|false|null)\b/g, className: 'literal' },
    { pattern: /\b(-?\d+\.?\d*)\b/g, className: 'number' },
  ],
  html: [
    { pattern: /(&lt;!--[\s\S]*?--&gt;)/g, className: 'comment' },
    { pattern: /(&lt;\/?[a-zA-Z][a-zA-Z0-9]*)/g, className: 'tag' },
    { pattern: /\s([a-zA-Z-]+)=/g, className: 'attribute' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
  ],
  css: [
    { pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'comment' },
    { pattern: /([.#]?[a-zA-Z_-][a-zA-Z0-9_-]*)\s*\{/g, className: 'selector' },
    { pattern: /([a-zA-Z-]+)\s*:/g, className: 'property' },
    { pattern: /:\s*([^;{}]+)/g, className: 'value' },
  ],
  python: [
    { pattern: /(#.*$)/gm, className: 'comment' },
    { pattern: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, className: 'string' },
    { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, className: 'string' },
    {
      pattern:
        /\b(def|class|if|elif|else|for|while|return|import|from|as|try|except|finally|with|lambda|yield|raise|pass|break|continue|and|or|not|in|is)\b/g,
      className: 'keyword',
    },
    { pattern: /\b(True|False|None)\b/g, className: 'literal' },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
  ],
  sql: [
    { pattern: /(--.*$)/gm, className: 'comment' },
    { pattern: /('(?:[^'\\]|\\.)*')/g, className: 'string' },
    {
      pattern:
        /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MIN|MAX|INTO|VALUES|SET)\b/gi,
      className: 'keyword',
    },
    { pattern: /\b(\d+\.?\d*)\b/g, className: 'number' },
  ],
  markdown: [
    { pattern: /^(#{1,6}\s.*$)/gm, className: 'heading' },
    { pattern: /(\*\*[^*]+\*\*|__[^_]+__)/g, className: 'bold' },
    { pattern: /(\*[^*]+\*|_[^_]+_)/g, className: 'italic' },
    { pattern: /(`[^`]+`)/g, className: 'code' },
    { pattern: /(\[.*?\]\(.*?\))/g, className: 'link' },
  ],
  plain: [],
};

const highlightColors: Record<string, string> = {
  comment: '#a1a1aa',
  string: '#34d399',
  keyword: '#a78bfa',
  literal: '#f87171',
  number: '#fb923c',
  type: '#38bdf8',
  property: '#22d3ee',
  tag: '#a1a1aa',
  attribute: '#fb923c',
  selector: '#a78bfa',
  value: '#34d399',
  heading: '#a78bfa',
  bold: '#e4e4e7',
  italic: '#a1a1aa',
  code: '#f87171',
  link: '#6366f1',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightCode(code: string, language: string): string {
  let html = escapeHtml(code);
  const patterns = highlightPatterns[language] || [];

  for (const { pattern, className } of patterns) {
    html = html.replace(pattern, (match) => {
      const color = highlightColors[className] || '#e4e4e7';
      return `<span style="color: ${color}">${match}</span>`;
    });
  }

  return html;
}

export function CodeEditor({
  value,
  defaultValue = '',
  language = 'plain',
  placeholder = 'Enter code...',
  disabled = false,
  readOnly = false,
  lineNumbers = true,
  tabSize = 2,
  minHeight = '200px',
  maxHeight = '500px',
  onChange,
  className,
  style,
}: CodeEditorProps): React.ReactElement {
  const [code, setCode] = useState(value ?? defaultValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value !== undefined) {
      setCode(value);
    }
  }, [value]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setCode(newValue);
      onChange?.(newValue);
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const spaces = ' '.repeat(tabSize);
        const newValue = code.substring(0, start) + spaces + code.substring(end);
        setCode(newValue);
        onChange?.(newValue);

        // Move cursor after the inserted spaces
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + tabSize;
        }, 0);
      }
    },
    [code, onChange, tabSize]
  );

  const handleScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  const lines = code.split('\n');
  const highlightedCode = highlightCode(code, language);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '0.875rem',
    lineHeight: '1.5',
    border: '1px solid var(--color-border, #3f3f46)',
    borderRadius: '0.5rem',
    background: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #e4e4e7)',
    overflow: 'hidden',
    ...style,
  };

  const lineNumbersStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '3rem',
    background: 'var(--color-surface, #16161a)',
    borderRight: '1px solid var(--color-border, #3f3f46)',
    padding: '0.75rem 0',
    textAlign: 'right',
    color: 'var(--color-text-muted, #a1a1aa)',
    userSelect: 'none',
    overflow: 'hidden',
  };

  const editorAreaStyle: React.CSSProperties = {
    position: 'relative',
    marginLeft: lineNumbers ? '3rem' : 0,
    minHeight,
    maxHeight,
    overflow: 'auto',
  };

  const sharedTextStyle: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    padding: '0.75rem',
    margin: 0,
    border: 'none',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    overflowWrap: 'break-word',
  };

  const highlightStyle: React.CSSProperties = {
    ...sharedTextStyle,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    pointerEvents: 'none',
    color: 'var(--color-text, #e4e4e7)',
  };

  const textareaStyle: React.CSSProperties = {
    ...sharedTextStyle,
    position: 'relative',
    width: '100%',
    minHeight: '100%',
    background: 'transparent',
    color: 'transparent',
    caretColor: 'var(--color-text, #e4e4e7)',
    resize: 'none',
    outline: 'none',
    overflow: 'hidden',
  };

  return (
    <div className={className} style={containerStyle}>
      {lineNumbers && (
        <div style={lineNumbersStyle}>
          {lines.map((_, i) => (
            <div key={i} style={{ padding: '0 0.5rem' }}>
              {i + 1}
            </div>
          ))}
        </div>
      )}
      <div style={editorAreaStyle}>
        <div
          ref={highlightRef}
          style={highlightStyle}
          dangerouslySetInnerHTML={{ __html: highlightedCode + '\n' }}
        />
        <textarea
          ref={textareaRef}
          value={code}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          style={textareaStyle}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>
    </div>
  );
}

export default CodeEditor;
