import React from 'react';

/** The Play triangle, on buttons, cards and the hero thumbnail of an app's page. */
export function PlayGlyph({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/** The arrow out of the page: Play for a linked app, which opens its own site in a new tab. */
export function ExternalGlyph({ size = 13 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

/**
 * The arrow after a call to action. `cta-arrow` gives it the dimmer colour
 * and the nudge on hover that a `.cta` link draws; `null` leaves it the
 * colour of the text around it.
 */
export function Arrow({ className = 'cta-arrow' }: { className?: string | null }): React.ReactElement {
  return (
    <svg className={className ?? undefined} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
