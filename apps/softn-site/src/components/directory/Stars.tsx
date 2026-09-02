import React, { useState } from 'react';

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

/** Five stars a visitor can press. `mine` is what they gave before, if anything. */
export function StarInput({ mine, onRate, busy }: { mine: number | null; onRate: (stars: number) => void; busy?: boolean }): React.ReactElement {
  const [hover, setHover] = useState(0);
  const shown = hover || mine || 0;
  return (
    <div className="star-input" role="radiogroup" aria-label="Rate this app">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={mine === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          className={`star-btn ${n <= shown ? 'on' : ''}`}
          disabled={busy}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onFocus={() => setHover(n)}
          onBlur={() => setHover(0)}
          onClick={() => onRate(n)}
        >
          <Star size={26} fill={n <= shown ? 1 : 0} />
        </button>
      ))}
      <span className="star-input-hint">{mine ? `You gave ${mine}` : 'Tap to rate'}</span>
    </div>
  );
}
