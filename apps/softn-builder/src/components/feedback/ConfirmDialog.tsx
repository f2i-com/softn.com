/**
 * The Builder's own yes-or-no question (utils/confirm.ts): what `window.confirm`
 * was, as a dialog of the page's, so it asks in the desktop app too.
 */

import React, { useId } from 'react';
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

function Question({ request }: { request: ConfirmRequest }) {
  const no = () => answerConfirm(request.id, false);
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
