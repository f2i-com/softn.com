import React, { useEffect, useId, useRef } from 'react';
import { describeFailure } from '../lib/failure';

/*
 * The runtime's own failure screen: an app would not open, a download failed,
 * a data import was refused. Drawn from the shared tokens like Home; danger
 * marks only the icon, and the one primary action is the ink inverted.
 */
const errorCardStyles = `
  @keyframes softn-shell-slide-up {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .softn-shell-error {
    position: absolute;
    inset: 0;
    z-index: 10;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(1rem, 4vw, 2rem);
    background: var(--ink);
    color: var(--paper);
    font-family: var(--body);
    animation: softn-shell-slide-up 350ms var(--ease) both;
  }
  .softn-shell-error-card {
    width: 100%;
    max-width: 520px;
    padding: clamp(1.25rem, 5vw, 2rem);
    background: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
  }
  .softn-shell-error-head { display: flex; align-items: flex-start; gap: 0.75rem; }
  .softn-shell-error-icon {
    width: 36px; height: 36px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--ink-3);
    color: var(--danger);
  }
  .softn-shell-error-title {
    margin: 0;
    font-family: var(--display);
    font-weight: 700;
    font-size: 1.1875rem;
    line-height: 1.25;
    letter-spacing: -0.02em;
    outline: none;
    padding-top: 0.3rem;
  }
  .softn-shell-error-hint {
    margin: 0.875rem 0 0;
    color: var(--dim);
    font-size: 0.9rem;
    line-height: 1.55;
  }
  .softn-shell-error-detail {
    margin: 1rem 0 0;
    padding: 0.75rem 0.875rem;
    border-radius: 8px;
    background: var(--inset);
    color: var(--dim);
    font-family: var(--mono);
    font-size: 0.78rem;
    line-height: 1.6;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .softn-shell-error-actions { display: flex; flex-wrap: wrap; gap: 0.625rem; margin-top: 1.375rem; }
  .softn-shell-error-btn {
    min-height: 2.5rem;
    padding: 0 1.125rem;
    border-radius: 8px;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--line-strong);
    background: transparent;
    color: var(--paper);
    transition: background 160ms var(--ease), border-color 160ms var(--ease);
  }
  .softn-shell-error-btn:hover { border-color: var(--dimmer); background: var(--ink-3); }
  .softn-shell-error-btn--primary { background: var(--paper); border-color: var(--paper); color: var(--ink); }
  .softn-shell-error-btn--primary:hover { background: var(--invert-hover); border-color: var(--invert-hover); }
  .softn-shell-error-btn:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
  @media (pointer: coarse) { .softn-shell-error-btn { min-height: 44px; } }
  @media (prefers-reduced-motion: reduce) { .softn-shell-error { animation: none; } }
`;

export function ErrorCard({
  error,
  onHome,
  onOpenFile,
}: {
  error: Error;
  onHome: () => void;
  /** Offered when the failure was the file itself. */
  onOpenFile?: () => void;
}): React.ReactElement {
  const view = describeFailure(error);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Whatever had focus — a card on Home, the frame bar — is hidden or gone
  // now, so focus comes here rather than falling to <body>: the heading, so a
  // screen reader reads the title first and Tab reaches the actions next.
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [error]);

  return (
    <div className="softn-shell-error" role="alert" aria-labelledby={titleId}>
      <style dangerouslySetInnerHTML={{ __html: errorCardStyles }} />
      <div className="softn-shell-error-card">
        <div className="softn-shell-error-head">
          <div className="softn-shell-error-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className="softn-shell-error-title">
            {view.title}
          </h2>
        </div>
        {view.hint && <p className="softn-shell-error-hint">{view.hint}</p>}
        {view.detail && view.detail !== view.hint && <p className="softn-shell-error-detail">{view.detail}</p>}
        <div className="softn-shell-error-actions">
          <button type="button" className="softn-shell-error-btn softn-shell-error-btn--primary" onClick={onHome}>
            Back to home
          </button>
          {view.offerAnotherFile && onOpenFile && (
            <button type="button" className="softn-shell-error-btn" onClick={onOpenFile}>
              Open another file
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
