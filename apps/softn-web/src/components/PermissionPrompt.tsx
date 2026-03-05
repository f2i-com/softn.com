/**
 * PermissionPrompt — consent UI for app permission requests.
 *
 * Shows which capabilities an app is requesting and lets the user
 * Allow or Deny before the app starts executing.
 */

import React from 'react';
import type { PermissionConfig } from '@softn/core';

interface PermissionPromptProps {
  appName: string;
  appIcon?: string;
  permissions: PermissionConfig;
  onAllow: () => void;
  onDeny: () => void;
}

/** Human-readable descriptions for each permission category */
const PERMISSION_INFO: Record<string, { label: string; description: string; icon: React.ReactNode }> = {
  net: {
    label: 'Network Access',
    description: 'Send and receive data over the internet (fetch, WebSocket).',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  camera: {
    label: 'Camera Access',
    description: 'Use your device camera to capture photos or video.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
    ),
  },
  files: {
    label: 'File System Access',
    description: 'Read or write files on your device.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  qr: {
    label: 'QR Code Scanner',
    description: 'Scan QR codes using your device camera.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
        <rect x="14" y="14" width="3" height="3" />
        <line x1="21" y1="14" x2="21" y2="21" />
        <line x1="14" y1="21" x2="21" y2="21" />
      </svg>
    ),
  },
};

function getRequestedPermissions(config: PermissionConfig): Array<{ key: string; info: typeof PERMISSION_INFO[string]; detail?: string }> {
  const result: Array<{ key: string; info: typeof PERMISSION_INFO[string]; detail?: string }> = [];
  const perms = config.permissions;

  for (const [key, value] of Object.entries(perms)) {
    if (!value || !value.enabled) continue;
    const info = PERMISSION_INFO[key];
    if (!info) continue;

    let detail: string | undefined;
    if (key === 'net' && 'allowed_hosts' in value && Array.isArray(value.allowed_hosts) && value.allowed_hosts.length > 0) {
      detail = `Hosts: ${value.allowed_hosts.join(', ')}`;
    }
    if (key === 'files' && 'scopes' in value && Array.isArray(value.scopes) && value.scopes.length > 0) {
      detail = `Scopes: ${value.scopes.join(', ')}`;
    }
    if (key === 'camera' && 'modes' in value && Array.isArray(value.modes) && value.modes.length > 0) {
      detail = `Modes: ${value.modes.join(', ')}`;
    }

    result.push({ key, info, detail });
  }

  return result;
}

export function PermissionPrompt({ appName, appIcon, permissions, onAllow, onDeny }: PermissionPromptProps): React.ReactElement {
  const requested = getRequestedPermissions(permissions);

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0c0c0e',
      zIndex: 20,
      padding: '2rem',
    }}>
      <div style={{
        maxWidth: '440px',
        width: '100%',
        background: '#16161a',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '14px',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
        padding: '2rem',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1.5rem',
        }}>
          {appIcon ? (
            <img
              src={appIcon}
              alt=""
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                objectFit: 'cover',
                border: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            />
          ) : (
            <div style={{
              width: '40px',
              height: '40px',
              borderRadius: '10px',
              background: 'rgba(99, 102, 241, 0.15)',
              border: '1px solid rgba(99, 102, 241, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
            </div>
          )}
          <div>
            <div style={{
              color: '#ececf0',
              fontWeight: 600,
              fontSize: '1.0625rem',
              letterSpacing: '-0.02em',
            }}>
              {appName}
            </div>
            <div style={{
              color: '#7a7a86',
              fontSize: '0.75rem',
              marginTop: '2px',
            }}>
              requests the following permissions
            </div>
          </div>
        </div>

        {/* Permission list */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          marginBottom: '1.5rem',
        }}>
          {requested.length > 0 ? requested.map(({ key, info, detail }) => (
            <div key={key} style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.75rem',
              padding: '0.75rem 1rem',
              background: 'rgba(255, 255, 255, 0.02)',
              borderRadius: '8px',
              border: '1px solid rgba(255, 255, 255, 0.04)',
            }}>
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(99, 102, 241, 0.1)',
                border: '1px solid rgba(99, 102, 241, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                color: '#818cf8',
                marginTop: '1px',
              }}>
                {info.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  color: '#ececf0',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                }}>
                  {info.label}
                </div>
                <div style={{
                  color: '#7a7a86',
                  fontSize: '0.75rem',
                  lineHeight: 1.5,
                  marginTop: '2px',
                }}>
                  {info.description}
                </div>
                {detail && (
                  <div style={{
                    color: '#5a5a66',
                    fontSize: '0.6875rem',
                    fontFamily: 'monospace',
                    marginTop: '4px',
                    wordBreak: 'break-all',
                  }}>
                    {detail}
                  </div>
                )}
              </div>
            </div>
          )) : (
            <div style={{
              padding: '0.75rem 1rem',
              color: '#5a5a66',
              fontSize: '0.8125rem',
              textAlign: 'center',
            }}>
              No specific permissions requested.
            </div>
          )}
        </div>

        {/* Buttons */}
        <div style={{
          display: 'flex',
          gap: '0.75rem',
          justifyContent: 'flex-end',
        }}>
          <button
            onClick={onDeny}
            style={{
              padding: '0.5rem 1.25rem',
              background: '#1e1e23',
              color: '#ececf0',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '0.8125rem',
              fontWeight: 500,
              letterSpacing: '-0.01em',
              transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#2a2a30';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#1e1e23';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            Deny
          </button>
          <button
            onClick={onAllow}
            style={{
              padding: '0.5rem 1.25rem',
              background: '#4f46e5',
              color: '#ffffff',
              border: '1px solid rgba(99, 102, 241, 0.4)',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '0.8125rem',
              fontWeight: 500,
              letterSpacing: '-0.01em',
              transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#4338ca';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(79, 70, 229, 0.3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#4f46e5';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
