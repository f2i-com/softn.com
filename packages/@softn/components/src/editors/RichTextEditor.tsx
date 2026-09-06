/**
 * RichTextEditor Component
 *
 * A simple WYSIWYG rich text editor using contentEditable.
 * For more advanced features, consider integrating Quill, TipTap, or Slate.
 */

import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { markupUrlJudge, sanitizeRichText, useEgressConfig } from '@softn/core';

export interface RichTextEditorProps {
  /** Current HTML value */
  value?: string;
  /** Default HTML value */
  defaultValue?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Accessible name for the editable region */
  ariaLabel?: string;
  /** Whether the editor is disabled */
  disabled?: boolean;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Show toolbar */
  showToolbar?: boolean;
  /** Minimum height */
  minHeight?: string;
  /** Maximum height */
  maxHeight?: string;
  /** Change handler (returns HTML) */
  onChange?: (html: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

interface ToolbarButton {
  label: string;
  icon: string;
  command: string;
  value?: string;
}

const toolbarButtons: ToolbarButton[] = [
  { label: 'Bold', icon: 'B', command: 'bold' },
  { label: 'Italic', icon: 'I', command: 'italic' },
  { label: 'Underline', icon: 'U', command: 'underline' },
  { label: 'Strikethrough', icon: 'S', command: 'strikeThrough' },
  { label: 'Heading 1', icon: 'H1', command: 'formatBlock', value: 'h1' },
  { label: 'Heading 2', icon: 'H2', command: 'formatBlock', value: 'h2' },
  { label: 'Heading 3', icon: 'H3', command: 'formatBlock', value: 'h3' },
  { label: 'Paragraph', icon: 'P', command: 'formatBlock', value: 'p' },
  { label: 'Bullet List', icon: '•', command: 'insertUnorderedList' },
  { label: 'Numbered List', icon: '1.', command: 'insertOrderedList' },
  { label: 'Quote', icon: '"', command: 'formatBlock', value: 'blockquote' },
  { label: 'Align Left', icon: '⬅', command: 'justifyLeft' },
  { label: 'Align Center', icon: '⬌', command: 'justifyCenter' },
  { label: 'Align Right', icon: '➡', command: 'justifyRight' },
  { label: 'Link', icon: '🔗', command: 'createLink' },
  { label: 'Unlink', icon: '⛓️‍💥', command: 'unlink' },
  { label: 'Clear Format', icon: '⌫', command: 'removeFormat' },
];

export function RichTextEditor({
  value,
  defaultValue = '',
  placeholder = 'Start writing...',
  ariaLabel = 'Rich text editor',
  disabled = false,
  readOnly = false,
  showToolbar = true,
  minHeight = '200px',
  maxHeight = '500px',
  onChange,
  className,
  style,
}: RichTextEditorProps): React.ReactElement {
  const editorRef = useRef<HTMLDivElement>(null);
  const initialContentRef = useRef(value ?? defaultValue);
  const [isEmpty, setIsEmpty] = useState(true);

  // Initialize content.
  //
  // What the markup may fetch. A value with `<img src="https://…">` is a
  // request to that host the moment it is assigned, and it is held to the
  // bundle's `net` like a `src` prop would be: withheld while the consent bar
  // is unanswered, and let through when the user allows — the grant arrives
  // as a re-render, and the value is sanitized again under it.
  const egress = useEgressConfig();
  const judge = useMemo(() => markupUrlJudge(egress), [egress]);

  // Sanitized on the way in: this value is normally a record loaded from XDB or
  // arriving over sync, and assigning it to innerHTML executes whatever markup
  // it carries on the host origin.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.innerHTML = sanitizeRichText(initialContentRef.current, judge);
    setIsEmpty(!(editor.textContent ?? '').trim());
    // Once, at mount: the value effect below handles every later change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update content when value prop changes externally, or when what it may
  // load does.
  useEffect(() => {
    if (value !== undefined && editorRef.current) {
      const currentHtml = editorRef.current.innerHTML;
      const safe = sanitizeRichText(value, judge);
      // Compare against the sanitized form, or a value that only differs in the
      // parts sanitization strips would rewrite the DOM on every render and
      // move the caret to the start each time.
      if (currentHtml !== safe) {
        editorRef.current.innerHTML = safe;
        setIsEmpty(!(editorRef.current.textContent ?? '').trim());
      }
    }
  }, [value, judge]);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      const html = sanitizeRichText(editorRef.current.innerHTML, judge);
      // Pasted HTML is not guaranteed to be inert. Only rewrite the DOM when
      // sanitization actually removed something so ordinary typing keeps its
      // selection and caret position.
      if (html !== editorRef.current.innerHTML) {
        editorRef.current.innerHTML = html;
      }
      const textContent = editorRef.current.textContent || '';
      setIsEmpty(!textContent.trim());
      onChange?.(html);
    }
  }, [onChange, judge]);

  const execCommand = useCallback(
    (command: string, value?: string) => {
      if (disabled || readOnly) return;

      editorRef.current?.focus();

      if (command === 'createLink') {
        const url = prompt('Enter URL:', 'https://');
        if (url) {
          document.execCommand(command, false, url);
        }
      } else if (command === 'formatBlock' && value) {
        document.execCommand(command, false, `<${value}>`);
      } else {
        document.execCommand(command, false, value);
      }

      handleInput();
    },
    [disabled, readOnly, handleInput]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Handle common keyboard shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'b':
            e.preventDefault();
            execCommand('bold');
            break;
          case 'i':
            e.preventDefault();
            execCommand('italic');
            break;
          case 'u':
            e.preventDefault();
            execCommand('underline');
            break;
        }
      }
    },
    [execCommand]
  );

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
    gap: '0.125rem',
    padding: '0.5rem',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    background: 'var(--color-gray-800, #1e1e23)',
    flexWrap: 'wrap',
  };

  const toolbarButtonStyle: React.CSSProperties = {
    padding: '0.375rem 0.5rem',
    border: '1px solid transparent',
    borderRadius: '0.25rem',
    background: 'transparent',
    cursor: disabled || readOnly ? 'not-allowed' : 'pointer',
    fontSize: '0.75rem',
    fontWeight: 600,
    minWidth: '1.75rem',
    textAlign: 'center',
    color: 'var(--color-text, #ececf0)',
    opacity: disabled || readOnly ? 0.5 : 1,
  };

  const toolbarButtonHoverStyle = {
    background: 'var(--color-gray-700, #3f3f46)',
    borderColor: 'var(--color-border, rgba(255, 255, 255, 0.08))',
  };

  const editorStyle: React.CSSProperties = {
    flex: 1,
    padding: '1rem',
    outline: 'none',
    minHeight,
    maxHeight,
    overflow: 'auto',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: '0.9375rem',
    lineHeight: '1.7',
    color: 'var(--color-text, #e4e4e7)',
    position: 'relative',
  };

  const placeholderStyle: React.CSSProperties = {
    position: 'absolute',
    top: '1rem',
    left: '1rem',
    color: 'var(--color-text-muted, #a1a1aa)',
    pointerEvents: 'none',
    fontStyle: 'italic',
  };

  return (
    <div className={className} style={containerStyle}>
      {showToolbar && (
        <div style={toolbarStyle} role="toolbar" aria-label="Text formatting">
          {toolbarButtons.map((button) => (
            <React.Fragment key={button.label}>
              {/* Add separator before alignment buttons and after list buttons */}
              {(button.command === 'justifyLeft' || button.command === 'createLink') && (
                <div
                  aria-hidden="true"
                  style={{
                    width: '1px',
                    height: '1.5rem',
                    background: 'var(--color-border, #3f3f46)',
                    margin: '0 0.25rem',
                  }}
                />
              )}
              <button
                type="button"
                title={button.label}
                aria-label={button.label}
                style={toolbarButtonStyle}
                onClick={() => execCommand(button.command, button.value)}
                onMouseEnter={(e) => {
                  if (!disabled && !readOnly) {
                    Object.assign(e.currentTarget.style, toolbarButtonHoverStyle);
                  }
                }}
                onMouseLeave={(e) => {
                  Object.assign(e.currentTarget.style, {
                    background: 'transparent',
                    borderColor: 'transparent',
                  });
                }}
                disabled={disabled || readOnly}
              >
                {button.icon}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column' }}>
        {isEmpty && !disabled && <div style={placeholderStyle}>{placeholder}</div>}
        <div
          ref={editorRef}
          role="textbox"
          aria-label={ariaLabel}
          aria-multiline="true"
          aria-disabled={disabled || undefined}
          aria-readonly={readOnly || undefined}
          contentEditable={!disabled && !readOnly}
          style={editorStyle}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          suppressContentEditableWarning
        />
      </div>
    </div>
  );
}

export default RichTextEditor;
