/**
 * ToastContainer - Renders toast notifications
 */

import React from 'react';
import { useNotificationStore, type Notification } from '../../stores/notificationStore';

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 40,
  right: 16,
  zIndex: 10000,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
};

// Graphite toasts with a rule in the kind's colour, as Studio draws them:
// they used to be solid Tailwind green, red and amber slabs, and an info toast
// was coral — the colour the brand keeps for the language.
const typeStyles: Record<Notification['type'], React.CSSProperties> = {
  success: { boxShadow: 'inset 3px 0 0 var(--mint), var(--bl-shadow-pop)' },
  error: { boxShadow: 'inset 3px 0 0 var(--danger), var(--bl-shadow-pop)' },
  warning: { boxShadow: 'inset 3px 0 0 var(--warn), var(--bl-shadow-pop)' },
  info: { boxShadow: 'inset 3px 0 0 var(--dim), var(--bl-shadow-pop)' },
};

const iconColors: Record<Notification['type'], string> = {
  success: 'var(--mint)',
  error: 'var(--danger)',
  warning: 'var(--warn)',
  info: 'var(--dim)',
};

const toastStyle: React.CSSProperties = {
  padding: '10px 12px 10px 16px',
  borderRadius: 8,
  background: 'var(--ink-2)',
  color: 'var(--paper)',
  fontFamily: 'var(--body)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.45,
  maxWidth: 380,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  pointerEvents: 'auto',
  animation: 'bl-toast-in 0.2s var(--ease)',
};

// The button sits inside the toast, so it reads as part of it only if it
// borrows the same radius and type scale; taking them from toastStyle rather
// than repeating the numbers keeps the two from drifting apart again.
const actionButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line-strong)',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  fontSize: toastStyle.fontSize,
  fontWeight: 600,
  padding: '4px 10px',
  whiteSpace: 'nowrap',
};

const closeButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--dim)',
  cursor: 'pointer',
  fontSize: 16,
  padding: '0 0 0 4px',
  lineHeight: 1,
};

// The particulars of a toast (what "Opened with 39 warnings" were): a list
// that scrolls inside the toast rather than running off the screen.
const detailsStyle: React.CSSProperties = {
  marginTop: 6,
  fontWeight: 400,
};

const detailsListStyle: React.CSSProperties = {
  margin: '6px 0 0',
  paddingLeft: 18,
  maxHeight: 220,
  overflowY: 'auto',
  fontSize: 12,
  overflowWrap: 'anywhere',
};

const typeIcons: Record<Notification['type'], string> = {
  success: '\u2713',
  error: '\u2717',
  warning: '\u26A0',
  info: '\u2139',
};

export function ToastContainer() {
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // Always in the page, so a screen reader is listening before the first
  // message arrives rather than being handed a region that appeared with it.
  return (
    <div style={containerStyle} aria-live="polite" aria-relevant="additions">
      {notifications.map((notif) => {
        const action = notif.action;
        return (
          <div
            key={notif.id}
            style={{ ...toastStyle, ...typeStyles[notif.type] }}
            role={notif.type === 'error' ? 'alert' : 'status'}
            aria-atomic="true"
          >
            <span aria-hidden="true" style={{ color: iconColors[notif.type], fontWeight: 700, alignSelf: notif.details ? 'flex-start' : undefined }}>{typeIcons[notif.type]}</span>
            {notif.details && notif.details.length > 0 ? (
              <div style={{ flex: 1, minWidth: 0 }}>
                {notif.message}
                <details data-toast-details="" style={detailsStyle}>
                  <summary style={{ cursor: 'pointer', color: 'var(--dim)' }}>
                    {notif.details.length === 1 ? 'Show it' : `Show all ${notif.details.length}`}
                  </summary>
                  <ul style={detailsListStyle}>
                    {notif.details.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </details>
              </div>
            ) : (
              <span style={{ flex: 1 }}>{notif.message}</span>
            )}
            {action && (
              <button
                type="button"
                style={actionButtonStyle}
                onClick={() => {
                  removeNotification(notif.id);
                  action.onClick();
                }}
              >
                {action.label}
              </button>
            )}
            <button
              type="button"
              style={closeButtonStyle}
              onClick={() => removeNotification(notif.id)}
              title="Dismiss"
              aria-label={`Dismiss ${notif.type} notification`}
            >
              {'\u00D7'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
