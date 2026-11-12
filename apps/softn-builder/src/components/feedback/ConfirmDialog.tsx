/**
 * The Builder's own yes-or-no question (utils/confirm.ts): what `window.confirm`
 * was, as a dialog of the page's, so it asks in the desktop app too.
 */

import React, { useEffect, useId, useState } from 'react';
import { useModalFocus } from '@softn/editor-shared/useModalFocus';
import { answerConfirm, useConfirmStore, type ConfirmRequest } from '../../utils/confirm';

// The overlay, frame and title are classes in styles/builder.css.
const styles: Record<string, React.CSSProperties> = {
  dialog: {
    width: 460,
  },
  body: {
    padding: '20px 24px 8px',
  },
  message: {
    margin: '10px 0 0',
    fontSize: 14,
    lineHeight: 1.5,
    color: 'var(--dim)',
    // The messages carry their own paragraphs.
    whiteSpace: 'pre-line',
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '16px 24px 20px',
  },
};

/** Containers whose one tab stop is the row last used in them: the keyboard goes back to that row. */
const ROVING = '[role="tree"], [role="menu"], [role="listbox"], [role="tablist"], [role="toolbar"]';

/**
 * Where the keyboard goes when nothing around the asker is left: the view the workspace is
 * showing, in the toolbar's switch (Design, Data, Preview, Code), which is always there and
 * says where the person is; a toolbar with one view has its first button.
 */
const HOME = ['[data-tool="views"] [aria-pressed="true"]', '.bl-tool:not([disabled])'];

/** Something around what asked the question: the element, and how to find the one that takes its place if it is drawn anew. */
export interface Place {
  element: Element;
  /** A selector for it by its role and its name, where it has both. */
  again: string | null;
}

/** What has the focus and everything around it, nearest first. */
export function placesAround(start: Element | null): Place[] {
  const places: Place[] = [];
  for (let at = start; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    const role = at.getAttribute('role');
    const name = at.getAttribute('aria-label');
    places.push({ element: at, again: role && name ? `[role="${role}"][aria-label="${name.replace(/["\\]/g, '\\$&')}"]` : null });
  }
  return places;
}

/**
 * Where the keyboard goes once a question is answered and what asked it has
 * gone: the file that was deleted, the row of a menu that closed before the
 * question was put. The dialog gives the focus back to what had it, and when
 * that is no longer in the page the focus fell to the page's body: the next
 * Tab started from the top of the site's own links, and a screen reader was
 * left nowhere. It goes to the nearest thing around the asker that is still
 * there and takes the focus (the tree the file was in, the panel, the sheet),
 * and failing any, to the toolbar's view switch.
 */
export function focusAfterQuestion(around: readonly Place[]): void {
  const lost = () => {
    const active = document.activeElement;
    return !(active instanceof HTMLElement || active instanceof SVGElement) || active === document.body || !active.isConnected;
  };
  if (!lost()) return;
  for (const { element, again } of around) {
    // The place itself, or the one drawn in its stead: the Files tree is drawn anew when a file leaves it.
    const place = element.isConnected ? element : again ? document.querySelector(again) : null;
    if (!place || place.closest('[inert]')) continue;
    const target = place.matches(ROVING)
      ? place.querySelector<HTMLElement>('[tabindex="0"]') ?? place.querySelector<HTMLElement>('[tabindex]')
      : place instanceof HTMLElement && place.hasAttribute('tabindex') ? place : null;
    if (!target) continue;
    target.focus();
    if (!lost()) return;
  }
  for (const selector of HOME) {
    const home = document.querySelector<HTMLElement>(selector);
    if (!home || home.closest('[inert]')) continue;
    home.focus();
    if (!lost()) return;
  }
}

function Question({ request }: { request: ConfirmRequest }) {
  const no = () => answerConfirm(request.id, false);
  // What had the focus when the question was put, and everything around it, nearest first:
  // read as the dialog is first drawn, before the focus moves into it.
  const [around] = useState<Place[]>(() => placesAround(document.activeElement));
  useEffect(() => () => {
    // After the dialog has gone and has given the focus back, and after the page behind it
    // is in reach again.
    setTimeout(() => focusAfterQuestion(around), 0);
  }, [around]);
  // Where the focus starts is where Enter goes: the way back when going on loses something.
  const dialogRef = useModalFocus(true, no, request.danger ? '[data-confirm="cancel"]' : '[data-confirm="ok"]');
  const titleId = useId();
  const messageId = useId();
  return (
    <div className="bl-overlay" style={{ zIndex: 1100 }} onClick={no}>
      <div
        ref={dialogRef}
        className="bl-dialog"
        style={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={styles.body}>
          <h2 id={titleId} className="bl-dialog-title" style={{ margin: 0 }}>{request.title}</h2>
          <p id={messageId} style={styles.message}>{request.message}</p>
        </div>
        <div style={styles.actions}>
          <button type="button" className="bl-btn" data-confirm="cancel" onClick={no}>
            {request.cancelLabel}
          </button>
          <button
            type="button"
            className={request.danger ? 'bl-btn bl-btn-danger' : 'bl-btn bl-btn-primary'}
            data-confirm="ok"
            onClick={() => answerConfirm(request.id, true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog() {
  const head = useConfirmStore((state) => state.queue[0] ?? null);
  if (!head) return null;
  // One question at a time, each with its own focus handling: the next one
  // mounts afresh when this one is answered.
  return <Question key={head.id} request={head} />;
}
