/**
 * CodeEditor Component
 *
 * A textarea with syntax highlighting: the text is edited in a real
 * `<textarea>` whose own glyphs are transparent, laid exactly over a `<pre>`
 * that draws the same text in colour. The browser keeps doing everything a
 * text field does — caret, selection, IME, spellcheck-off, undo, screen
 * readers — and the highlighting is only paint.
 *
 * The two layers must agree character for character and pixel for pixel, or
 * the caret the user moves drifts away from the text they see. So:
 *
 * - the colours come from `tokenize` (./highlight), whose tokens join back to
 *   the source exactly, rendered as React text nodes — never HTML;
 * - both layers share one text style (font, size, line height, padding,
 *   `white-space: pre`, tab size) and the textarea is sized by the `<pre>`,
 *   so neither can wrap or scroll where the other does not;
 * - the gutter sits in the same scroll container, one number per line, and
 *   lines do not wrap, so a number stays beside its line.
 *
 * For a more full-featured editor, integrate Monaco or CodeMirror.
 */

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
} from 'react';
import { tokenize, type Token } from './highlight';
import { codeColor } from '../theme/code-palette';

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
  /** Accessible name for the text field, when no visible label names it */
  ariaLabel?: string;
  /** Accessible name (DOM attribute spelling) */
  'aria-label'?: string;
  /** Change handler */
  onChange?: (value: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

/**
 * Past this many characters the text is shown uncoloured. Scanning is linear,
 * but it runs on every keystroke, and a file this size is being pasted into a
 * textarea, not written in one.
 */
export const CODE_EDITOR_HIGHLIGHT_LIMIT = 200_000;

/** A layout effect in the browser; nothing (and no warning) on the server. */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const FONT_STACK =
  'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)';
const PADDING = '0.75rem';

function renderTokens(tokens: Token[]): React.ReactNode[] {
  return tokens.map((token, index) =>
    token.kind === 'plain' ? (
      <React.Fragment key={index}>{token.text}</React.Fragment>
    ) : (
      <span
        key={index}
        className={`softn-code-${token.kind}`}
        style={{ color: codeColor(token.kind) }}
      >
        {token.text}
      </span>
    )
  );
}

/** A value as the editor's text: nothing for null or undefined, a string otherwise. */
function asText(value: unknown): string {
  return value == null ? '' : String(value);
}

/** The start of the line `index` is on. */
function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

interface Edit {
  /** Range of the current text to replace. */
  from: number;
  to: number;
  insert: string;
  /** Selection afterwards, in the new text. */
  selectionStart: number;
  selectionEnd: number;
}

/** Indent (or with `outdent`, unindent) every line the selection touches. */
function indentLines(
  text: string,
  start: number,
  end: number,
  unit: string,
  outdent: boolean
): Edit | null {
  const from = lineStartOf(text, start);
  // A selection ending at the very start of a line does not include that line.
  const lastLineEnd = end > start && text[end - 1] === '\n' ? end - 1 : end;
  let to = text.indexOf('\n', lastLineEnd);
  if (to < 0) to = text.length;
  const lines = text.slice(from, to).split('\n');
  let firstDelta = 0;
  let total = 0;
  const changed = lines.map((line, index) => {
    if (!outdent) {
      if (index === 0) firstDelta = unit.length;
      total += unit.length;
      return unit + line;
    }
    const leading = /^[ \t]*/.exec(line)![0];
    const remove = line.startsWith('\t') ? 1 : Math.min(unit.length, leading.length);
    if (index === 0) firstDelta = -remove;
    total -= remove;
    return line.slice(remove);
  });
  if (outdent && total === 0) return null;
  const insert = changed.join('\n');
  return {
    from,
    to,
    insert,
    selectionStart: Math.max(from, start + firstDelta),
    selectionEnd: Math.max(from, end + total),
  };
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
  ariaLabel,
  'aria-label': ariaLabelAttribute,
  onChange,
  className,
  style,
}: CodeEditorProps): React.ReactElement {
  // With `onChange`, `value` is the text, and a parent that does not accept an
  // edit keeps it out. A `value` with no handler is a starting point that
  // follows the prop when it changes but can be typed over, as it always was.
  // A value bound from app state may arrive as null or a number; it is text here.
  const isControlled = value !== undefined && onChange !== undefined;
  const [internal, setInternal] = useState(() => asText(value ?? defaultValue));
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (value !== undefined) setInternal(asText(value));
  }
  const code = isControlled ? asText(value) : internal;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  /** Escape hands Tab back to the browser, so the field is never a keyboard trap. */
  const tabReleased = useRef(false);
  /** Where the caret goes once an edit made from a key handler has rendered. */
  const pendingSelection = useRef<{ value: string; start: number; end: number } | null>(null);
  const hintId = useId();

  const indent = Math.max(1, Math.min(16, Math.floor(Number(tabSize)) || 2));
  const indentUnit = ' '.repeat(indent);

  useIsomorphicLayoutEffect(() => {
    const pending = pendingSelection.current;
    const textarea = textareaRef.current;
    if (!pending || !textarea || textarea.value !== pending.value) return;
    textarea.setSelectionRange(pending.start, pending.end);
    pendingSelection.current = null;
  });

  const commit = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      pendingSelection.current = null;
      commit(e.target.value);
    },
    [commit]
  );

  /**
   * Apply an edit made from the keyboard. `insertText` goes through the
   * browser's own editing, so it lands on the undo stack and raises the input
   * event the change handler already listens to; where that is unavailable
   * the value is set and the caret placed after the next render.
   */
  const applyEdit = useCallback(
    (textarea: HTMLTextAreaElement, edit: Edit) => {
      const current = textarea.value;
      const next = current.slice(0, edit.from) + edit.insert + current.slice(edit.to);
      textarea.setSelectionRange(edit.from, edit.to);
      let native = false;
      try {
        native =
          typeof document.execCommand === 'function' &&
          document.execCommand('insertText', false, edit.insert);
      } catch {
        native = false;
      }
      if (native && textarea.value === next) {
        textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
        return;
      }
      pendingSelection.current = {
        value: next,
        start: edit.selectionStart,
        end: edit.selectionEnd,
      };
      commit(next);
    },
    [commit]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        tabReleased.current = true;
        return;
      }
      const released = tabReleased.current;
      tabReleased.current = false;
      if (readOnly || disabled || e.nativeEvent.isComposing) return;
      const textarea = e.currentTarget;
      const { selectionStart: start, selectionEnd: end, value: text } = textarea;

      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (released) return; // Let focus move on.
        e.preventDefault();
        const multiline = text.slice(start, end).includes('\n');
        if (e.shiftKey || multiline) {
          const edit = indentLines(text, start, end, indentUnit, e.shiftKey);
          if (edit) applyEdit(textarea, edit);
          return;
        }
        applyEdit(textarea, {
          from: start,
          to: end,
          insert: indentUnit,
          selectionStart: start + indentUnit.length,
          selectionEnd: start + indentUnit.length,
        });
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Keep the indentation of the line the caret is on.
        const lineStart = lineStartOf(text, start);
        const leading = /^[ \t]*/.exec(text.slice(lineStart, start))![0];
        if (!leading) return;
        e.preventDefault();
        const insert = '\n' + leading;
        applyEdit(textarea, {
          from: start,
          to: end,
          insert,
          selectionStart: start + insert.length,
          selectionEnd: start + insert.length,
        });
      }
    },
    [applyEdit, disabled, indentUnit, readOnly]
  );

  const highlighted = useMemo(
    () =>
      renderTokens(tokenize(code, code.length > CODE_EDITOR_HIGHLIGHT_LIMIT ? 'plain' : language)),
    [code, language]
  );

  const lineCount = useMemo(() => {
    let count = 1;
    for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) count++;
    return count;
  }, [code]);
  const gutterNumbers = useMemo(
    () => (lineNumbers ? Array.from({ length: lineCount }, (_, i) => i + 1).join('\n') : ''),
    [lineNumbers, lineCount]
  );
  const gutterDigits = Math.max(2, String(lineCount).length);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    fontFamily: FONT_STACK,
    fontSize: '0.875rem',
    lineHeight: '1.5',
    border: `1px solid ${focused ? 'var(--color-primary-500, #6366f1)' : 'var(--color-border, #3f3f46)'}`,
    boxShadow: focused ? '0 0 0 3px var(--color-primary-200, rgba(99, 102, 241, 0.35))' : undefined,
    borderRadius: '0.5rem',
    background: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #e4e4e7)',
    overflow: 'hidden',
    opacity: disabled ? 0.6 : undefined,
    cursor: disabled ? 'not-allowed' : undefined,
    ...style,
  };

  const scrollerStyle: React.CSSProperties = {
    minHeight,
    maxHeight,
    overflow: 'auto',
  };

  // The row the gutter and the code sit in is as tall as the code (or the
  // minimum) and as wide as the longest line, never the scroller's clamped
  // size: the textarea covers the code area exactly, so it never has more
  // text than room and never scrolls on its own, away from the colours.
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'stretch',
    minHeight,
    width: 'max-content',
    minWidth: '100%',
  };

  // Everything that decides where a glyph lands, shared by both layers.
  const sharedTextStyle: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    fontStyle: 'normal',
    lineHeight: 'inherit',
    letterSpacing: 'normal',
    wordSpacing: 'normal',
    textTransform: 'none',
    textIndent: 0,
    tabSize: indent,
    padding: PADDING,
    margin: 0,
    border: 0,
    boxSizing: 'border-box',
    whiteSpace: 'pre',
    overflowWrap: 'normal',
    wordBreak: 'normal',
    textAlign: 'left',
    direction: 'ltr',
  };

  const gutterStyle: React.CSSProperties = {
    ...sharedTextStyle,
    position: 'sticky',
    left: 0,
    zIndex: 1,
    flex: 'none',
    minWidth: `calc(${gutterDigits}ch + 1rem)`,
    paddingLeft: '0.5rem',
    paddingRight: '0.5rem',
    textAlign: 'right',
    background: 'var(--color-surface, #16161a)',
    borderRight: '1px solid var(--color-border, #3f3f46)',
    color: 'var(--color-text-muted, #a1a1aa)',
    userSelect: 'none',
  };

  const codeAreaStyle: React.CSSProperties = {
    position: 'relative',
    flex: '1 0 auto',
    minWidth: 0,
  };

  const highlightStyle: React.CSSProperties = {
    ...sharedTextStyle,
    position: 'relative',
    minWidth: '100%',
    width: 'max-content',
    pointerEvents: 'none',
    color: 'var(--color-text, #e4e4e7)',
    background: 'transparent',
  };

  const textareaStyle: React.CSSProperties = {
    ...sharedTextStyle,
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    background: 'transparent',
    color: 'transparent',
    caretColor: 'var(--color-text, #e4e4e7)',
    resize: 'none',
    outline: 'none',
    overflow: 'hidden',
    cursor: disabled ? 'not-allowed' : 'text',
  };

  const label = ariaLabel ?? ariaLabelAttribute ?? 'Code editor';

  return (
    <div className={className} style={containerStyle}>
      <div style={scrollerStyle} data-softn-code-scroller="">
        <div style={rowStyle}>
          {lineNumbers && (
            <div aria-hidden="true" style={gutterStyle} data-softn-code-gutter="">
              {gutterNumbers}
            </div>
          )}
          <div style={codeAreaStyle}>
            <pre aria-hidden="true" style={highlightStyle} data-softn-code-highlight="">
              {highlighted}
              {'\n'}
            </pre>
            <textarea
              ref={textareaRef}
              value={code}
              placeholder={placeholder}
              disabled={disabled}
              readOnly={readOnly}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                tabReleased.current = false;
              }}
              style={textareaStyle}
              aria-label={label}
              aria-describedby={readOnly || disabled ? undefined : hintId}
              wrap="off"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              data-gramm="false"
            />
            {!readOnly && !disabled && (
              <span id={hintId} hidden>
                Tab indents. Press Escape, then Tab, to move focus out of the editor.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CodeEditor;
