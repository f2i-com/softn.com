import React from 'react';

/**
 * The SoftN mark, drawn rather than loaded.
 *
 * studio-icon.png is a blue tile from the old palette, and blue is not a colour
 * this product uses any more — beside a coral accent it reads as another app's
 * logo pasted in. Drawing it keeps the two accents meaning what they mean
 * everywhere else: the brackets are coral because they are the language, and the
 * dot is mint because it is the thing that runs. It also inherits the theme, so
 * the mark is correct in light mode instead of glowing.
 *
 * The PNG is still what the PWA installs with — a manifest icon has to be a
 * bitmap — so the two want regenerating together if this ever changes.
 */
export function Mark({ size = 44, radius }: { size?: number; radius?: number }): React.ReactElement {
  const r = radius ?? Math.round(size * 0.27);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="SoftN">
      <rect width="32" height="32" rx={(r / size) * 32} fill="var(--studio-bg-muted)" />
      <path
        d="M9 11.5 5.5 16 9 20.5"
        fill="none"
        stroke="var(--studio-accent)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M23 11.5 26.5 16 23 20.5"
        fill="none"
        stroke="var(--studio-accent)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="2.8" fill="var(--studio-live)" />
    </svg>
  );
}
