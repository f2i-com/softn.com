/**
 * Typewriter Component
 *
 * Types out text character by character with optional looping,
 * deletion, and a blinking cursor.
 */

import * as React from 'react';

export interface TypewriterProps {
  /** The text(s) to type out. When an array, cycles through each text. */
  text: string | string[];
  /** Typing speed in milliseconds per character */
  speed?: number;
  /** Deletion speed in milliseconds per character */
  deleteSpeed?: number;
  /** Pause duration in milliseconds after finishing a text before deleting */
  pauseDuration?: number;
  /** Whether to loop through the texts (defaults to true for arrays) */
  loop?: boolean;
  /** Whether to show the blinking cursor */
  cursor?: boolean;
  /** The character to use for the cursor */
  cursorChar?: string;
  /** Callback invoked when all text has been typed (or at end of each cycle) */
  onComplete?: () => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const CURSOR_STYLE_ID = 'softn-typewriter-cursor-style';

function ensureCursorStyles(): void {
  if (document.getElementById(CURSOR_STYLE_ID)) return;
  const styleEl = document.createElement('style');
  styleEl.id = CURSOR_STYLE_ID;
  styleEl.textContent = `
    @keyframes softn-typewriter-blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }
  `;
  document.head.appendChild(styleEl);
}

export function Typewriter({
  text,
  speed = 50,
  deleteSpeed = 30,
  pauseDuration = 1500,
  loop,
  cursor = true,
  cursorChar = '|',
  onComplete,
  className,
  style,
}: TypewriterProps): React.ReactElement {
  const texts = Array.isArray(text) ? text : [text];
  const shouldLoop = loop !== undefined ? loop : texts.length > 1;

  const [displayedText, setDisplayedText] = React.useState('');
  const textIndexRef = React.useRef(0);
  const charIndexRef = React.useRef(0);
  const isDeletingRef = React.useRef(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = React.useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Inject cursor blink keyframes on mount
  React.useEffect(() => {
    if (cursor) ensureCursorStyles();
  }, [cursor]);

  React.useEffect(() => {
    // Reset state when text prop changes
    textIndexRef.current = 0;
    charIndexRef.current = 0;
    isDeletingRef.current = false;
    setDisplayedText('');

    const tick = () => {
      const currentTextIndex = textIndexRef.current;
      const currentText = texts[currentTextIndex] ?? '';
      const isDeleting = isDeletingRef.current;

      if (!isDeleting) {
        // Typing forward
        if (charIndexRef.current < currentText.length) {
          charIndexRef.current += 1;
          setDisplayedText(currentText.slice(0, charIndexRef.current));
          timeoutRef.current = setTimeout(tick, speed);
        } else {
          // Finished typing this text
          onCompleteRef.current?.();
          if (texts.length === 1 && !shouldLoop) {
            // Single text, no loop: done
            return;
          }
          // Pause, then start deleting
          isDeletingRef.current = true;
          timeoutRef.current = setTimeout(tick, pauseDuration);
        }
      } else {
        // Deleting backward
        if (charIndexRef.current > 0) {
          charIndexRef.current -= 1;
          setDisplayedText(currentText.slice(0, charIndexRef.current));
          timeoutRef.current = setTimeout(tick, deleteSpeed);
        } else {
          // Finished deleting, move to next text
          isDeletingRef.current = false;
          const nextIndex = currentTextIndex + 1;

          if (nextIndex >= texts.length) {
            if (shouldLoop) {
              textIndexRef.current = 0;
              timeoutRef.current = setTimeout(tick, speed);
            }
            // Not looping and exhausted all texts: stop
            return;
          } else {
            textIndexRef.current = nextIndex;
            timeoutRef.current = setTimeout(tick, speed);
          }
        }
      }
    };

    timeoutRef.current = setTimeout(tick, speed);

    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
    // We intentionally use a serialized version of texts to avoid re-running
    // on every render when an inline array literal is passed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(texts), speed, deleteSpeed, pauseDuration, shouldLoop]);

  const cursorStyle: React.CSSProperties = {
    animation: 'softn-typewriter-blink 1s step-end infinite',
    marginLeft: '1px',
    fontWeight: 'normal',
  };

  return (
    <span className={className} style={style}>
      {displayedText}
      {cursor && <span style={cursorStyle}>{cursorChar}</span>}
    </span>
  );
}

export default Typewriter;
