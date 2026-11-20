/**
 * Base ShadowRoot isolation CSS and optional `softn:ui.css` semantic design tokens.
 *
 * Unmodified compiled web apps receive ONLY `SHADOW_HOST_BASE_CSS` so their own
 * Tailwind / Bootstrap / custom CSS is never clobbered. Apps that link
 * `<link rel="stylesheet" href="softn:ui.css">` get the full ~4 KB token & utility sheet.
 */

/** The container's own element, styled from the root its frame is in: no sheet of the app's is in that root. */
export const FRAME_BASE_CSS = `
:host {
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  contain: content;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: inherit;
}
`;

/** The app's page, in the root the page is drawn in. */
export const PAGE_BASE_CSS = `
[data-softn-viewport] {
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
}
`;

export const SHADOW_HOST_BASE_CSS = FRAME_BASE_CSS + PAGE_BASE_CSS;

export const SOFTN_UI_CSS = `
:host, [data-softn-viewport] {
  --softn-bg: #ffffff;
  --softn-surface: #f8fafc;
  --softn-border: #e2e8f0;
  --softn-fg: #0f172a;
  --softn-muted: #64748b;
  --softn-primary: #2563eb;
  --softn-primary-fg: #ffffff;
  --softn-danger: #dc2626;
  --softn-radius: 8px;
  --softn-space-xs: 0.375rem;
  --softn-space-sm: 0.625rem;
  --softn-space-md: 1rem;
  --softn-space-lg: 1.5rem;
  background: var(--softn-bg);
  color: var(--softn-fg);
}
:host([data-theme="dark"]), [data-softn-docroot][data-theme="dark"], [data-softn-viewport][data-theme="dark"] {
  --softn-bg: #0f172a;
  --softn-surface: #1e293b;
  --softn-border: #334155;
  --softn-fg: #f8fafc;
  --softn-muted: #94a3b8;
  --softn-primary: #3b82f6;
  --softn-primary-fg: #ffffff;
  --softn-danger: #ef4444;
}
[data-softn-viewport] *, [data-softn-viewport] *::before, [data-softn-viewport] *::after {
  box-sizing: border-box;
}
.container { max-width: 960px; margin: 0 auto; padding: var(--softn-space-lg); }
.stack { display: flex; flex-direction: column; }
.row { display: flex; flex-direction: row; align-items: center; }
.between { justify-content: space-between; }
.wrap { flex-wrap: wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.gap-xs { gap: var(--softn-space-xs); }
.gap-sm { gap: var(--softn-space-sm); }
.gap-md { gap: var(--softn-space-md); }
.gap-lg { gap: var(--softn-space-lg); }
.card {
  background: var(--softn-surface);
  border: 1px solid var(--softn-border);
  border-radius: var(--softn-radius);
  padding: var(--softn-space-md);
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.55rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 999px;
  background: var(--softn-surface);
  border: 1px solid var(--softn-border);
  color: var(--softn-muted);
}
.muted { color: var(--softn-muted); }
button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.45rem 0.9rem;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: var(--softn-radius);
  border: 1px solid var(--softn-border);
  background: var(--softn-surface);
  color: var(--softn-fg);
  cursor: pointer;
}
button.primary, .btn.primary {
  background: var(--softn-primary);
  border-color: var(--softn-primary);
  color: var(--softn-primary-fg);
}
button.danger, .btn.danger {
  background: var(--softn-danger);
  border-color: var(--softn-danger);
  color: #ffffff;
}
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea {
  padding: 0.45rem 0.7rem;
  font-size: 0.875rem;
  border-radius: var(--softn-radius);
  border: 1px solid var(--softn-border);
  background: var(--softn-bg);
  color: var(--softn-fg);
}
dialog {
  background: var(--softn-bg);
  color: var(--softn-fg);
  border: 1px solid var(--softn-border);
  border-radius: var(--softn-radius);
  padding: var(--softn-space-lg);
}
`;
