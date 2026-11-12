import React, { useEffect, useState } from 'react';

/**
 * What an opening app's screen says once the wait has gone on: that it is
 * still waiting, why that can be, and a button that stops it.
 *
 * The screen was a spinner over "Opening Notes…" for as long as the download
 * took to answer, and the download panel under it only appears once the first
 * bytes have arrived. On a connection that had dropped, or a server that was
 * not answering, nothing on the screen changed, ever: a person could not tell
 * a slow app from a stuck one, and the way out was Close in the bar above,
 * which says nothing about being the way out of this.
 *
 * Nothing is shown for a load that is over in ordinary time.
 */
export const SLOW_OPEN_MS = 8000;

const STYLES = `
  .softn-slow-open {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    max-width: 22rem;
    padding-inline: 1rem;
    text-align: center;
    color: var(--dim);
    font-family: var(--body);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .softn-slow-open p { margin: 0; }
  .softn-slow-open-cancel {
    min-height: 2.5rem;
    padding: 0 1.125rem;
    border-radius: 8px;
    border: 1px solid var(--line-strong);
    background: transparent;
    color: var(--paper);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .softn-slow-open-cancel:hover { border-color: var(--dimmer); background: var(--ink-3); }
  .softn-slow-open-cancel:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
  @media (pointer: coarse) { .softn-slow-open-cancel { min-height: 44px; } }
`;

export function SlowOpen({
  onCancel,
  afterMs = SLOW_OPEN_MS,
}: {
  /** Stop waiting: close the tab the app was opening in. Without it the notice is words alone. */
  onCancel?: () => void;
  afterMs?: number;
}): React.ReactElement | null {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  if (!slow) return null;
  return (
    <div className="softn-slow-open" role="status">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <p>This is taking longer than usual. The connection may be slow, or it may have dropped.</p>
      {onCancel && (
        <button type="button" className="softn-slow-open-cancel" onClick={onCancel}>
          Stop waiting
        </button>
      )}
    </div>
  );
}
