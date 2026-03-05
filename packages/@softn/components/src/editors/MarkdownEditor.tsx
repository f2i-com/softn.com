/**
 * MarkdownEditor Component
 *
 * A markdown editor with live preview.
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';

export interface MarkdownEditorProps {
  /** Current value */
  value?: string;
  /** Default value */
  defaultValue?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the editor is disabled */
  disabled?: boolean;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** View mode: edit, preview, or split */
  viewMode?: 'edit' | 'preview' | 'split';
  /** Show toolbar */
  showToolbar?: boolean;
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

// Simple markdown to HTML converter
function markdownToHtml(markdown: string): string {
  let html = markdown;

  // Escape HTML
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Headers
  html = html.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Images
  html = html.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1" style="max-width: 100%;" />'
  );

  // Blockquotes
  html = html.replace(/^>\s+(.*)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^\s*[-*+]\s+(.*)$/gm, '<li>$1</li>');

  // Ordered lists
  html = html.replace(/^\s*\d+\.\s+(.*)$/gm, '<li>$1</li>');

  // Wrap consecutive li elements in ul/ol
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Horizontal rules
  html = html.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr />');

  // Paragraphs (wrap remaining text)
  html = html.replace(/^(?!<[a-z])(.*[^\s].*)$/gm, '<p>$1</p>');

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

interface ToolbarButton {
  label: string;
  icon: string;
  action: (
    text: string,
    selStart: number,
    selEnd: number
  ) => { text: string; selStart: number; selEnd: number };
}

const toolbarButtons: ToolbarButton[] = [
  {
    label: 'Bold',
    icon: 'B',
    action: (text, start, end) => {
      const selected = text.substring(start, end) || 'bold text';
      const newText = text.substring(0, start) + `**${selected}**` + text.substring(end);
      return { text: newText, selStart: start + 2, selEnd: start + 2 + selected.length };
    },
  },
  {
    label: 'Italic',
    icon: 'I',
    action: (text, start, end) => {
      const selected = text.substring(start, end) || 'italic text';
      const newText = text.substring(0, start) + `*${selected}*` + text.substring(end);
      return { text: newText, selStart: start + 1, selEnd: start + 1 + selected.length };
    },
  },
  {
    label: 'Heading',
    icon: 'H',
    action: (text, start, end) => {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const newText = text.substring(0, lineStart) + '## ' + text.substring(lineStart);
      return { text: newText, selStart: start + 3, selEnd: end + 3 };
    },
  },
  {
    label: 'Link',
    icon: '🔗',
    action: (text, start, end) => {
      const selected = text.substring(start, end) || 'link text';
      const newText = text.substring(0, start) + `[${selected}](url)` + text.substring(end);
      return {
        text: newText,
        selStart: start + selected.length + 3,
        selEnd: start + selected.length + 6,
      };
    },
  },
  {
    label: 'Code',
    icon: '</>',
    action: (text, start, end) => {
      const selected = text.substring(start, end) || 'code';
      const newText = text.substring(0, start) + `\`${selected}\`` + text.substring(end);
      return { text: newText, selStart: start + 1, selEnd: start + 1 + selected.length };
    },
  },
  {
    label: 'List',
    icon: '•',
    action: (text, start, end) => {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const newText = text.substring(0, lineStart) + '- ' + text.substring(lineStart);
      return { text: newText, selStart: start + 2, selEnd: end + 2 };
    },
  },
  {
    label: 'Quote',
    icon: '"',
    action: (text, start, end) => {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const newText = text.substring(0, lineStart) + '> ' + text.substring(lineStart);
      return { text: newText, selStart: start + 2, selEnd: end + 2 };
    },
  },
];

export function MarkdownEditor({
  value,
  defaultValue = '',
  placeholder = 'Write your markdown here...',
  disabled = false,
  readOnly = false,
  viewMode: initialViewMode = 'split',
  showToolbar = true,
  minHeight = '300px',
  maxHeight = '600px',
  onChange,
  className,
  style,
}: MarkdownEditorProps): React.ReactElement {
  const [content, setContent] = useState(value ?? defaultValue);
  const [viewMode, setViewMode] = useState(initialViewMode);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (value !== undefined) {
      setContent(value);
    }
  }, [value]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setContent(newValue);
      onChange?.(newValue);
    },
    [onChange]
  );

  const handleToolbarClick = useCallback(
    (button: ToolbarButton) => {
      if (!textareaRef.current) return;

      const textarea = textareaRef.current;
      const { text, selStart, selEnd } = button.action(
        content,
        textarea.selectionStart,
        textarea.selectionEnd
      );

      setContent(text);
      onChange?.(text);

      // Restore focus and selection
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(selStart, selEnd);
      }, 0);
    },
    [content, onChange]
  );

  const htmlPreview = useMemo(() => markdownToHtml(content), [content]);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    borderRadius: '0.5rem',
    background: 'var(--color-surface, #16161a)',
    overflow: 'hidden',
    ...style,
  };

  const toolbarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    padding: '0.5rem',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    background: 'var(--color-gray-800, #1e1e23)',
    flexWrap: 'wrap',
  };

  const toolbarButtonStyle: React.CSSProperties = {
    padding: '0.375rem 0.5rem',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    borderRadius: '0.25rem',
    background: 'var(--color-surface, #16161a)',
    cursor: 'pointer',
    fontSize: '0.875rem',
    fontWeight: 500,
    minWidth: '2rem',
    textAlign: 'center',
  };

  const viewModeButtonStyle = (active: boolean): React.CSSProperties => ({
    ...toolbarButtonStyle,
    background: active ? 'var(--color-primary-500, #6366f1)' : 'var(--color-surface, #16161a)',
    color: active ? '#ffffff' : 'var(--color-text, #ececf0)',
    borderColor: active ? 'var(--color-primary-500, #6366f1)' : 'var(--color-border, rgba(255, 255, 255, 0.08))',
  });

  const editorContainerStyle: React.CSSProperties = {
    display: 'flex',
    flex: 1,
    minHeight,
    maxHeight,
    overflow: 'hidden',
  };

  const textareaStyle: React.CSSProperties = {
    flex: 1,
    padding: '1rem',
    border: 'none',
    outline: 'none',
    resize: 'none',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '0.875rem',
    lineHeight: '1.6',
    background: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #ececf0)',
    overflow: 'auto',
    display: viewMode === 'preview' ? 'none' : 'block',
  };

  const previewStyle: React.CSSProperties = {
    flex: 1,
    padding: '1rem',
    borderLeft: viewMode === 'split' ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : 'none',
    overflow: 'auto',
    background: 'var(--color-surface, #16161a)',
    display: viewMode === 'edit' ? 'none' : 'block',
  };

  const previewContentStyle: React.CSSProperties = {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: '0.9375rem',
    lineHeight: '1.7',
    color: 'var(--color-text, #e4e4e7)',
  };

  return (
    <div className={className} style={containerStyle}>
      {showToolbar && (
        <div style={toolbarStyle}>
          {!disabled &&
            !readOnly &&
            toolbarButtons.map((button) => (
              <button
                key={button.label}
                type="button"
                title={button.label}
                style={toolbarButtonStyle}
                onClick={() => handleToolbarClick(button)}
              >
                {button.icon}
              </button>
            ))}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            style={viewModeButtonStyle(viewMode === 'edit')}
            onClick={() => setViewMode('edit')}
          >
            Edit
          </button>
          <button
            type="button"
            style={viewModeButtonStyle(viewMode === 'split')}
            onClick={() => setViewMode('split')}
          >
            Split
          </button>
          <button
            type="button"
            style={viewModeButtonStyle(viewMode === 'preview')}
            onClick={() => setViewMode('preview')}
          >
            Preview
          </button>
        </div>
      )}
      <div style={editorContainerStyle}>
        <textarea
          ref={textareaRef}
          value={content}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          onChange={handleChange}
          style={textareaStyle}
          spellCheck={true}
        />
        <div style={previewStyle}>
          <div
            style={previewContentStyle}
            dangerouslySetInnerHTML={{
              __html: htmlPreview || '<p style="color: var(--color-text-muted, #a1a1aa);">Preview will appear here...</p>',
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default MarkdownEditor;
