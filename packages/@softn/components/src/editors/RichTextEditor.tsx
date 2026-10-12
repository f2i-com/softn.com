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

/** Commands that are on or off for the selection, reported as `aria-pressed`. */
const TOGGLE_COMMANDS = new Set(['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']);

/** Schemes a link may have: a web, mail or phone address, nothing a click would run. */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * The address typed into the link field, as the link's href, or null when it
 * is not one a link may have. Without a scheme it is a web address.
 */
function linkAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (!scheme) return /\s/.test(text) ? null : `https://${text}`;
  return LINK_SCHEMES.has(scheme[1].toLowerCase() + ':') ? text : null;
}

function queryState(command: string): boolean {
  try {
    return typeof document.queryCommandState === 'function' && document.queryCommandState(command);
  } catch {
    return false;
  }
}

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
  const editorId = React.useId();
  const initialContentRef = useRef(value ?? defaultValue);
  const [isEmpty, setIsEmpty] = useState(true);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState<Record<string, boolean>>({});
  // The Link button's field. It used `prompt()`, which a sandboxed frame
  // refuses, so the button did nothing where apps run. `linkRange` is the
  // selection when the field opened: focus in the field takes it from the
  // editor, and it is put back before the link is made.
  const [linking, setLinking] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkRange = useRef<Range | null>(null);
  const linkFieldRef = useRef<HTMLInputElement>(null);
  /** The toolbar is one tab stop; arrow keys move between its buttons. */
  const [toolbarIndex, setToolbarIndex] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const refreshPressed = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const command of TOGGLE_COMMANDS) next[command] = queryState(command);
    setPressed((prev) =>
      Object.keys(next).some((key) => prev[key] !== next[key]) ? next : prev
    );
  }, []);

  // Bold, italic and the rest follow the caret while the editor has focus.
  useEffect(() => {
    if (!focused) return;
    const onSelection = () => {
      const editor = editorRef.current;
      const selection = document.getSelection?.();
      if (editor && selection && selection.anchorNode && editor.contains(selection.anchorNode)) refreshPressed();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, [focused, refreshPressed]);

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

      if (command === 'createLink') {
        const selection = document.getSelection?.();
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        linkRange.current = range && editorRef.current?.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
        setLinkText('');
        setLinkError(null);
        setLinking(true);
        return;
      }

      editorRef.current?.focus();

      if (command === 'formatBlock' && value) {
        document.execCommand(command, false, `<${value}>`);
      } else {
        document.execCommand(command, false, value);
      }

      handleInput();
      refreshPressed();
    },
    [disabled, readOnly, handleInput, refreshPressed]
  );

  useEffect(() => {
    if (linking) linkFieldRef.current?.focus();
  }, [linking]);

  /** Focus back in the editor, on the selection it had when the link field opened. */
  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const range = linkRange.current;
    const selection = document.getSelection?.();
    if (range && selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);

  const closeLink = useCallback(() => {
    setLinking(false);
    setLinkError(null);
    restoreSelection();
  }, [restoreSelection]);

  const applyLink = useCallback(() => {
    const href = linkAddress(linkText);
    if (!href) {
      setLinkError('Enter a web, mail or phone address: https://…, mailto:… or tel:…');
      return;
    }
    setLinking(false);
    setLinkError(null);
    restoreSelection();
    const editor = editorRef.current;
    const range = linkRange.current;
    if (!editor) return;
    if (!range || range.collapsed) {
      // Nothing was selected: the address is the link's text, where the
      // caret was (or at the end).
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.textContent = href;
      if (range) range.insertNode(anchor);
      else editor.appendChild(anchor);
      const selection = document.getSelection?.();
      if (selection) {
        const after = document.createRange();
        after.setStartAfter(anchor);
        after.collapse(true);
        selection.removeAllRanges();
        selection.addRange(after);
      }
    } else {
      document.execCommand('createLink', false, href);
    }
    linkRange.current = null;
    handleInput();
    refreshPressed();
  }, [linkText, restoreSelection, handleInput, refreshPressed]);

  const handleLinkKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyLink();
    } else if (e.key === 'Escape') {
      // Prevented, so a Modal or Drawer around the editor stays open.
      e.preventDefault();
      closeLink();
    }
  };

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

  const handleToolbarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const count = toolbarButtons.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (toolbarIndex + 1) % count;
    else if (e.key === 'ArrowLeft') next = (toolbarIndex - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    if (next === null) return;
    e.preventDefault();
    setToolbarIndex(next);
    toolbarRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    // The editable area has no outline of its own, so the focus ring is the
    // container's border.
    border: focused
      ? '1px solid var(--color-primary-500, rgba(99, 102, 241, 0.9))'
      : '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    boxShadow: focused ? '0 0 0 3px var(--color-primary-100, rgba(99, 102, 241, 0.25))' : undefined,
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
    // A step off the surface, in either theme: `gray-800` was a dark strip
    // behind dark text in the light theme and a light one behind light text
    // in the dark.
    background: 'var(--color-surface-hover, rgba(255, 255, 255, 0.04))',
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
    background: 'var(--color-gray-100, rgba(255, 255, 255, 0.08))',
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

  const linkRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '0.375rem',
    padding: '0.5rem',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    background: 'var(--color-surface-hover, rgba(255, 255, 255, 0.04))',
  };

  const linkFieldStyle: React.CSSProperties = {
    flex: '1 1 12rem',
    minWidth: 0,
    padding: '0.375rem 0.5rem',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    borderRadius: '0.25rem',
    background: 'var(--color-surface, transparent)',
    color: 'var(--color-text, inherit)',
    font: 'inherit',
    fontSize: '0.8125rem',
  };

  const linkErrorStyle: React.CSSProperties = {
    flexBasis: '100%',
    fontSize: '0.75rem',
    color: 'var(--color-error-500, currentColor)',
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
        <div
          ref={toolbarRef}
          style={toolbarStyle}
          role="toolbar"
          aria-label="Text formatting"
          aria-controls={editorId}
          onKeyDown={handleToolbarKeyDown}
        >
          {toolbarButtons.map((button, index) => (
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
                aria-pressed={TOGGLE_COMMANDS.has(button.command) ? !!pressed[button.command] : undefined}
                aria-expanded={button.command === 'createLink' ? linking : undefined}
                tabIndex={index === toolbarIndex ? 0 : -1}
                onFocus={() => setToolbarIndex(index)}
                style={
                  pressed[button.command]
                    ? { ...toolbarButtonStyle, background: 'var(--color-primary-100, rgba(99, 102, 241, 0.2))' }
                    : toolbarButtonStyle
                }
                onClick={() => execCommand(button.command, button.value)}
                onMouseEnter={(e) => {
                  if (!disabled && !readOnly) {
                    Object.assign(e.currentTarget.style, toolbarButtonHoverStyle);
                  }
                }}
                onMouseLeave={(e) => {
                  Object.assign(e.currentTarget.style, {
                    background: pressed[button.command]
                      ? 'var(--color-primary-100, rgba(99, 102, 241, 0.2))'
                      : 'transparent',
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
      {linking && (
        <div role="group" aria-label="Add a link" style={linkRowStyle}>
          <input
            ref={linkFieldRef}
            type="url"
            inputMode="url"
            aria-label="Link address"
            aria-invalid={linkError ? true : undefined}
            aria-describedby={linkError ? `${editorId}-link-error` : undefined}
            placeholder="https://"
            value={linkText}
            onChange={(e) => {
              setLinkText(e.target.value);
              setLinkError(null);
            }}
            onKeyDown={handleLinkKeyDown}
            style={linkFieldStyle}
          />
          <button type="button" onClick={applyLink} style={toolbarButtonStyle}>
            Add link
          </button>
          <button type="button" onClick={closeLink} style={toolbarButtonStyle}>
            Cancel
          </button>
          {linkError && (
            <span id={`${editorId}-link-error`} role="alert" style={linkErrorStyle}>
              {linkError}
            </span>
          )}
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column' }}>
        {isEmpty && !disabled && (
          <div style={placeholderStyle} aria-hidden="true">
            {placeholder}
          </div>
        )}
        <div
          ref={editorRef}
          id={editorId}
          role="textbox"
          aria-label={ariaLabel}
          aria-placeholder={isEmpty ? placeholder : undefined}
          onFocus={() => {
            setFocused(true);
            refreshPressed();
          }}
          onBlur={() => setFocused(false)}
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
