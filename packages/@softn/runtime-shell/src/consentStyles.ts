/**
 * The consent bar's and dialog's styles.
 *
 * Runtime chrome, so every colour is a literal. A var(--color-*) here would
 * resolve from whichever theme the bundle picked, and even the brand's own
 * --ink/--paper are custom properties an app's stylesheet could redefine; the
 * bar would then read as the app's own UI, or be repainted by it, which is the
 * one thing a consent surface must never do.
 *
 * The literals are the brand's (packages/@softn/brand/src/tokens.css), in both
 * of its themes. The light set is chosen by the host's own `data-theme` on
 * <html>, which the runtime stamps and a bundle cannot reach, so the bar
 * matches the frame bar above it instead of being a dark strip on a light
 * page. Allow is the brand's primary button — the ink, inverted — and the
 * focus ring is mint, as it is on every SoftN surface.
 */
export const CONSENT_STYLES = `
  @keyframes softn-consent-fade-in { from { opacity: 0; } to { opacity: 1; } }

  .softn-consent-bar, .softn-consent-chip-strip, .softn-consent-overlay {
    --softn-consent-bg: #161a20;
    --softn-consent-bg-2: #1d222a;
    --softn-consent-ground: #101317;
    --softn-consent-line: #262c36;
    --softn-consent-line-strong: #333b47;
    --softn-consent-text: #f2f0ec;
    --softn-consent-dim: #8b94a2;
    --softn-consent-invert: #f2f0ec;
    --softn-consent-invert-hover: #ffffff;
    --softn-consent-on-invert: #101317;
    --softn-consent-focus: #35e0c0;
    --softn-consent-inset: rgba(255, 255, 255, 0.03);
    --softn-consent-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
    font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  }
  :root[data-theme='light'] .softn-consent-bar,
  :root[data-theme='light'] .softn-consent-chip-strip,
  :root[data-theme='light'] .softn-consent-overlay {
    --softn-consent-bg: #ffffff;
    --softn-consent-bg-2: #eef1f6;
    --softn-consent-ground: #f4f6f9;
    --softn-consent-line: #d5dce5;
    --softn-consent-line-strong: #bcc6d2;
    --softn-consent-text: #14181d;
    --softn-consent-dim: #5a6472;
    --softn-consent-invert: #14181d;
    --softn-consent-invert-hover: #000000;
    --softn-consent-on-invert: #f4f6f9;
    --softn-consent-focus: #0f766e;
    --softn-consent-inset: rgba(20, 24, 29, 0.03);
    --softn-consent-shadow: 0 20px 40px rgba(20, 24, 29, 0.08);
  }

  .softn-consent-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 46px;
    padding: 0.5rem 0.875rem;
    background: var(--softn-consent-bg);
    border-bottom: 1px solid var(--softn-consent-line);
    color: var(--softn-consent-text);
    font-size: 0.8125rem;
    letter-spacing: -0.01em;
    user-select: none;
  }
  .softn-consent-icon { display: flex; flex-shrink: 0; color: var(--softn-consent-dim); }
  .softn-consent-msg {
    flex: 1;
    min-width: 0;
    line-height: 1.4;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
  }
  .softn-consent-msg b { color: var(--softn-consent-text); font-weight: 600; }
  .softn-consent-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }

  .softn-consent-btn {
    height: 32px;
    padding: 0 0.875rem;
    border-radius: 8px;
    font: inherit;
    font-weight: 500;
    letter-spacing: -0.01em;
    white-space: nowrap;
    cursor: pointer;
    transition: background 180ms cubic-bezier(0.16, 1, 0.3, 1), border-color 180ms cubic-bezier(0.16, 1, 0.3, 1), color 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  /* The app's own focus styles do not reach out here — the bar sits outside
     the app root on purpose — so it draws its own ring. */
  .softn-consent-btn:focus-visible,
  .softn-consent-chip:focus-visible { outline: 2px solid var(--softn-consent-focus); outline-offset: 2px; }

  .softn-consent-allow {
    background: var(--softn-consent-invert);
    color: var(--softn-consent-on-invert);
    border: 1px solid var(--softn-consent-invert);
    font-weight: 600;
  }
  .softn-consent-allow:hover { background: var(--softn-consent-invert-hover); border-color: var(--softn-consent-invert-hover); }
  .softn-consent-later {
    background: var(--softn-consent-bg-2);
    color: var(--softn-consent-text);
    border: 1px solid var(--softn-consent-line-strong);
  }
  .softn-consent-later:hover { border-color: var(--softn-consent-dim); }
  .softn-consent-more {
    background: transparent; border: none; color: var(--softn-consent-text); padding: 0 0.375rem;
    text-decoration: underline; text-decoration-color: var(--softn-consent-dim); text-underline-offset: 3px;
  }
  .softn-consent-more:hover { text-decoration-color: var(--softn-consent-text); }

  /* The dismissed state is a strip in the same flex column as the bar, not a
     button floating over the app: a corner button covered the app's own
     top-right control (measured on Glamour Studio's Settings), and in flow it
     is measured by the same observer, so the app is sized around it. It says
     what it is — an icon alone read as decoration — and that the app is
     running with what it asked for switched off. */
  .softn-consent-chip-strip {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 3px 6px 3px 0.875rem;
    background: var(--softn-consent-bg);
    border-bottom: 1px solid var(--softn-consent-line);
    color: var(--softn-consent-dim);
    font-size: 0.75rem;
  }
  .softn-consent-chip-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .softn-consent-chip {
    display: inline-flex; align-items: center; gap: 0.375rem;
    height: 28px;
    padding: 0 0.625rem;
    border-radius: 8px;
    background: transparent;
    border: 1px solid var(--softn-consent-line-strong);
    color: var(--softn-consent-text);
    font: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    animation: softn-consent-fade-in 250ms cubic-bezier(0.16, 1, 0.3, 1) both;
    transition: border-color 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-consent-chip svg { color: var(--softn-consent-dim); }
  .softn-consent-chip:hover { border-color: var(--softn-consent-dim); }

  /* A phone gets two rows: one sentence over one row of buttons. Side by side
     at 320px the sentence is down to a couple of words before the ellipsis. */
  @media (max-width: 560px) {
    .softn-consent-bar {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: start;
      align-content: center;
      row-gap: 0.5rem; column-gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      font-size: 0.75rem;
    }
    .softn-consent-icon { grid-column: 1; grid-row: 1; margin-top: 1px; }
    .softn-consent-msg { grid-column: 2; grid-row: 1; -webkit-line-clamp: 3; }
    .softn-consent-actions { grid-column: 1 / -1; grid-row: 2; justify-content: flex-end; }
  }
  /* 44px targets on touch and at phone width. Both queries: pointer:coarse
     does not match a desktop browser under touch emulation, which is how the
     bar was once measured at 32px on a 375px viewport. */
  @media (pointer: coarse), (max-width: 560px) {
    .softn-consent-bar { min-height: 58px; }
    .softn-consent-btn { height: 44px; }
    /* The chip is the only way back to the bar once it has been dismissed, so
       it is the one target here that must not be the smallest. */
    .softn-consent-chip { height: 44px; padding: 0 0.875rem; }
  }

  /* ── The detail dialog ── */
  .softn-consent-overlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    overflow-y: auto;
    padding: 1rem;
    background: var(--softn-consent-ground);
    color: var(--softn-consent-text);
  }
  .softn-consent-dialog {
    font-size: 0.875rem;
    letter-spacing: -0.01em;
    max-width: 440px;
    width: 100%;
    margin: auto 0;
    background: var(--softn-consent-bg);
    border: 1px solid var(--softn-consent-line);
    border-radius: 14px;
    box-shadow: var(--softn-consent-shadow);
    padding: clamp(1.25rem, 5vw, 2rem);
    animation: softn-consent-fade-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .softn-consent-dialog-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem; }
  .softn-consent-dialog-icon {
    width: 40px; height: 40px; flex-shrink: 0;
    border-radius: 10px; object-fit: cover;
    border: 1px solid var(--softn-consent-line);
  }
  .softn-consent-dialog-icon--blank {
    display: flex; align-items: center; justify-content: center;
    background: var(--softn-consent-bg-2); color: var(--softn-consent-dim);
  }
  .softn-consent-dialog-title {
    font-family: "Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif;
    font-weight: 700; font-size: 1.125rem; letter-spacing: -0.02em;
  }
  .softn-consent-dialog-sub { color: var(--softn-consent-dim); font-size: 0.8125rem; margin-top: 2px; line-height: 1.45; }
  .softn-consent-list { list-style: none; margin: 0 0 1.25rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .softn-consent-row {
    display: flex; align-items: flex-start; gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    background: var(--softn-consent-inset);
    border: 1px solid var(--softn-consent-line);
    border-radius: 10px;
  }
  .softn-consent-row--empty { justify-content: center; color: var(--softn-consent-dim); font-size: 0.8125rem; }
  .softn-consent-row-icon {
    width: 32px; height: 32px; flex-shrink: 0; margin-top: 1px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px; background: var(--softn-consent-bg-2); color: var(--softn-consent-dim);
  }
  .softn-consent-row-text { flex: 1; min-width: 0; }
  .softn-consent-row-label { font-size: 0.875rem; font-weight: 600; letter-spacing: -0.01em; }
  .softn-consent-row-desc { color: var(--softn-consent-dim); font-size: 0.8125rem; line-height: 1.5; margin-top: 2px; }
  .softn-consent-row-detail {
    color: var(--softn-consent-dim); font-size: 0.75rem; margin-top: 4px; word-break: break-all;
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .softn-consent-note { color: var(--softn-consent-dim); font-size: 0.75rem; line-height: 1.5; margin: -0.5rem 0 1.25rem; }
  .softn-consent-dialog-actions { display: flex; gap: 0.625rem; justify-content: flex-end; }
  .softn-consent-dialog-actions .softn-consent-btn { height: 40px; padding: 0 1.125rem; }
  .softn-consent-overlay .softn-consent-btn:focus-visible { outline: 2px solid var(--softn-consent-focus); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .softn-consent-bar *, .softn-consent-chip, .softn-consent-dialog { transition: none !important; animation: none !important; }
  }
`;
