import React, { useRef, useState } from 'react';

function Star({ fill, size = 14 }: { fill: number; size?: number }): React.ReactElement {
  // fill is 0..1 of the star, so a 4.5 average shows half a fifth star.
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="star">
      <defs>
        <linearGradient id={id} x1="0" x2="1">
          <stop offset={`${Math.round(fill * 100)}%`} stopColor="currentColor" />
          <stop offset={`${Math.round(fill * 100)}%`} stopColor="transparent" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z"
        fill={`url(#${id})`}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Five stars showing an average, with the count beside them. */
export function Stars({ average, count, size = 14, showCount = true }: { average: number; count: number; size?: number; showCount?: boolean }): React.ReactElement {
  return (
    <span className="stars" title={count > 0 ? `${average.toFixed(1)} from ${count} rating${count === 1 ? '' : 's'}` : 'No ratings yet'}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} size={size} fill={Math.max(0, Math.min(1, average - i))} />
      ))}
      {showCount && (
        <span className="stars-count">
          {count > 0 ? `${average.toFixed(1)} · ${count}` : 'no ratings'}
        </span>
      )}
    </span>
  );
}

/**
 * Five stars a visitor can press. `mine` is what they gave before, if anything.
 *
 * A radio group to a screen reader, so it is one stop in the tab order (the
 * star last moved to, else the one given, else the first) and the arrow keys,
 * Home and End move within it. They move and light the stars without voting:
 * a vote is a request that replaces the visitor's last one, and a keyboard
 * user crossing from one star to the fourth would otherwise have voted three
 * times. Enter, Space or a click gives the star that has focus. While a vote
 * is on its way the stars refuse another but stay enabled: a disabled button
 * loses focus, and the keyboard user was left outside the group.
 */
export function StarInput({ mine, onRate, busy }: { mine: number | null; onRate: (stars: number) => void; busy?: boolean }): React.ReactElement {
  const [hover, setHover] = useState(0);
  const [current, setCurrent] = useState<number | null>(null);
  const stars = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hover || mine || 0;
  const stop = current ?? mine ?? 1;
  const moveTo = (n: number) => {
    const to = ((n - 1 + 5) % 5) + 1;
    setCurrent(to);
    stars.current[to - 1]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent, n: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') moveTo(n + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') moveTo(n - 1);
    else if (e.key === 'Home') moveTo(1);
    else if (e.key === 'End') moveTo(5);
    else return;
    e.preventDefault();
  };
  return (
    <div className="star-input" role="radiogroup" aria-label="Rate this app">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          ref={(el) => {
            stars.current[n - 1] = el;
          }}
          type="button"
          role="radio"
          aria-checked={mine === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          aria-disabled={busy ? true : undefined}
          tabIndex={n === stop ? 0 : -1}
          className={`star-btn ${n <= shown ? 'on' : ''}`}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onFocus={() => {
            setHover(n);
            setCurrent(n);
          }}
          onBlur={() => setHover(0)}
          onKeyDown={(e) => onKeyDown(e, n)}
          onClick={() => {
            if (!busy) onRate(n);
          }}
        >
          <Star size={26} fill={n <= shown ? 1 : 0} />
        </button>
      ))}
      <span className="star-input-hint">{mine ? `You gave ${mine}` : 'Tap to rate'}</span>
    </div>
  );
}
