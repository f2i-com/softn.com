/**
 * A field of the property panel that holds an expression.
 *
 * It was one line of text whatever it held, so a list of records three
 * hundred characters long showed its first thirty. It is a box in the mono
 * face that is as tall as what is in it: one line for `count > 0`, as many
 * as it takes for a list, up to a height past which it scrolls inside
 * (styles/builder.css, `.bl-pp-grow`).
 *
 * What is typed is kept in the field as it is typed and written to the
 * element once it reads as a whole expression: `count >` on its way to
 * `count > 0` is not something to put in a file, and throwing the keystroke
 * away, as the list field used to, left a field that could not be typed
 * into. While it is not whole the field says so in words beneath it.
 *
 * Nothing typed is laid out again unasked. Where the value is a list or a
 * record on one long line, a small button offers it with an entry to a
 * line, and only where that is shown to be the same expression
 * (utils/propValues.ts, overLines).
 */

import { useMemo, useRef, useState } from 'react';
import { overLines } from '../../utils/propValues';

/** What the field says while its text is not a whole expression. */
export const NOT_WHOLE = 'Not a whole expression yet, so it is not written to the page.';

/** Shorter than this, a list is read well enough on the line it is on, and no layout is offered. */
const LONG = 48;

interface ExpressionFieldProps {
  id: string;
  /** The expression as the element holds it, or empty. */
  shown: string;
  placeholder?: string;
  /** Enter `text`. Returns whether it was taken: not while it is no whole expression. */
  onInput: (text: string) => boolean;
  /** What the element would hold once `text` was entered, without entering it; null when it would not be taken. */
  written?: (text: string) => string | null;
  /** Ends the run of edits that Undo takes back as one step. */
  endEdit?: () => void;
}

export function ExpressionField({ id, shown, placeholder, onInput, written, endEdit }: ExpressionFieldProps) {
  const box = useRef<HTMLTextAreaElement>(null);
  // What is in the field where that is not what the element holds, with the
  // held value it stands over: when the element moves on by another route,
  // it is dropped. Either it is not written yet (`whole` false), or it is
  // the written expression with the space typed around it, which is not
  // taken out from under the caret: `a` then a space on the way to `a + b`
  // used to lose the space.
  const [typed, setTyped] = useState<{ text: string; over: string; whole: boolean } | null>(null);
  const kept = typed !== null && typed.over === shown ? typed : null;
  const value = kept !== null ? kept.text : shown;
  const pending = kept !== null && !kept.whole;

  const enter = (text: string) => {
    if (!onInput(text)) setTyped({ text, over: shown, whole: false });
    else setTyped(text !== text.trim() ? { text, over: text.trim(), whole: true } : null);
  };

  // One entry to a line, where that is the same expression and is what would be written.
  const laid = useMemo(() => (shown.length >= LONG ? overLines(shown) : null), [shown]);
  const offered = laid !== null && !pending && written?.(laid) === laid ? laid : null;
  const layOut = () => {
    if (offered === null) return;
    // A step of its own for Undo, apart from what was typed before and after.
    endEdit?.();
    onInput(offered);
    endEdit?.();
    setTyped(null);
    box.current?.focus();
  };

  return (
    <>
      {/* The box is as tall as the text: the text is drawn a second time, unseen, behind it. */}
      <div className="bl-pp-grow" data-value={value}>
        <textarea
          ref={box}
          id={id}
          className="bl-pp-control bl-pp-mono"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-invalid={pending || undefined}
          aria-describedby={pending ? `${id}-pending` : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => enter(e.target.value)}
          // The space typed around a written expression goes when the field is left.
          onBlur={() => setTyped((now) => (now?.whole ? null : now))}
        />
      </div>
      <div id={`${id}-pending`} className="bl-pp-pending" role="status" data-expression-pending={pending ? '' : undefined}>
        {pending ? NOT_WHOLE : ''}
      </div>
      {offered !== null && (
        <button type="button" className="bl-pp-link" data-action="lay-out" onClick={layOut} title="Puts each entry on a line of its own. Nothing else is changed.">
          Lay it out over lines
        </button>
      )}
    </>
  );
}
