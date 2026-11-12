/**
 * A field of the property panel that holds code and is as tall as what is in it.
 *
 * A block's condition and list, an inline `if` and `each`, and a handler
 * were each one line of text whatever they held: `user && user.role ===
 * "admin" && !archived` showed its first thirty characters, and the rest was
 * found by arrowing through it. They are the box an expression got
 * (ExpressionField.tsx; styles/builder.css, `.bl-pp-grow`): one line for
 * `count > 0`, as many as it takes for more, wrapped where the panel ends.
 *
 * Unlike that field, what is typed here is written as it is typed, as these
 * fields always were: a condition half typed is what the block holds, and
 * the canvas says so.
 *
 * A block's header and an inline directive are one line in the file, so
 * Enter adds nothing there and a pasted line break becomes a space. A
 * handler may be several lines (`lines`).
 */

import type { TextareaHTMLAttributes } from 'react';

interface GrowingFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows' | 'className'> {
  id: string;
  value: string;
  onChange: (text: string) => void;
  /** Whether the text may run over several lines of its own. */
  lines?: boolean;
}

/** What is typed or pasted, as one line: each run of line breaks is a space. */
export function asOneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

export function GrowingField({ id, value, onChange, lines = false, ...rest }: GrowingFieldProps) {
  return (
    // The box is as tall as the text: the text is drawn a second time, unseen, behind it.
    <div className="bl-pp-grow" data-value={value}>
      <textarea
        id={id}
        className="bl-pp-control bl-pp-mono"
        rows={1}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        {...rest}
        onChange={(e) => onChange(lines ? e.target.value : asOneLine(e.target.value))}
        onKeyDown={(e) => {
          // Not the Enter that confirms an input method's candidate.
          if (!lines && e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) e.preventDefault();
          rest.onKeyDown?.(e);
        }}
      />
    </div>
  );
}
