import React from 'react';

/**
 * The SoftN mark, drawn rather than loaded: coral brackets for the language,
 * a mint dot for the thing that runs, on a tile of the theme's raised ground.
 * The same mark Studio and Builder draw for themselves, now drawn from the
 * shared tokens so it is right in both themes everywhere it appears.
 *
 * The PWA icons are still bitmaps of it — a manifest icon has to be — so the
 * two want regenerating together if this ever changes.
 */
export function Mark({ size = 24, radius, title = 'SoftN' }: { size?: number; radius?: number; title?: string }): React.ReactElement {
  const r = radius ?? Math.round(size * 0.27);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={title}>
      <rect className="softn-mark-ground" width="32" height="32" rx={(r / size) * 32} />
      <path
        className="softn-mark-bracket"
        d="M9 11.5 5.5 16 9 20.5"
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="softn-mark-bracket"
        d="M23 11.5 26.5 16 23 20.5"
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="softn-mark-dot" cx="16" cy="16" r="2.8" />
    </svg>
  );
}
