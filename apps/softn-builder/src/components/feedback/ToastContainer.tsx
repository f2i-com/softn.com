/**
 * ToastContainer - Renders toast notifications
 */

import React from 'react';
import { useNotificationStore, type Notification } from '../../stores/notificationStore';

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 16,
  right: 16,
  zIndex: 10000,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
};

const typeStyles: Record<Notification['type'], React.CSSProperties> = {
  success: {
    background: '#059669',
    color: '#fff',
    borderLeft: '4px solid #047857',
  },
  error: {
    background: '#dc2626',
    color: '#fff',
    borderLeft: '4px solid #b91c1c',
  },
  warning: {
    background: '#d97706',
    color: '#fff',
    borderLeft: '4px solid #b45309',
  },
  info: {
    background: '#2563eb',
    color: '#fff',
    borderLeft: '4px solid #1d4ed8',
  },
};

const toastStyle: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  maxWidth: 360,
  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  pointerEvents: 'auto',
  animation: 'slideInRight 0.2s ease-out',
};

const closeButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  opacity: 0.7,
  fontSize: 16,
  padding: '0 0 0 8px',
  lineHeight: 1,
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

  if (notifications.length === 0) return null;

  return (
    <div style={containerStyle}>
      {notifications.map((notif) => (
        <div
          key={notif.id}
          style={{ ...toastStyle, ...typeStyles[notif.type] }}
        >
          <span>{typeIcons[notif.type]}</span>
          <span style={{ flex: 1 }}>{notif.message}</span>
          <button
            style={closeButtonStyle}
            onClick={() => removeNotification(notif.id)}
            title="Dismiss"
          >
            {'\u00D7'}
          </button>
        </div>
      ))}
    </div>
  );
}
