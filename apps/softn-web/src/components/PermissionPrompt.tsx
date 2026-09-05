/**
 * PermissionPrompt — the full disclosure behind the consent bar.
 *
 * Opened from "What this means", never on arrival: the app is already on
 * screen and already running with its declared capabilities withheld, so this
 * gates nothing. It names every capability the bundle asked for, including any
 * this build has no description for, and offers the same Allow the bar does.
 */

import React, { useEffect, useId, useRef } from 'react';
import type { PermissionConfig } from '@softn/core';

interface PermissionPromptProps {
  appName: string;
  appIcon?: string;
  permissions: PermissionConfig;
  onAllow: () => void;
  /** Dismiss the dialog. Records nothing: not answering is not an answer. */
  onClose: () => void;
}

/** Stands in for a capability this build has no description for. */
const UNDESCRIBED_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

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
  mic: {
    label: 'Microphone Access',
    description: 'Listen through your device microphone and record what it hears.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    ),
  },
  files: {
    label: 'File System Access',
    description: 'Open files you choose, and save files the app makes to your device.',
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
  // ai, gpu and sync are enforced by the runtime and were missing here, so a
  // bundle asking for them was described to the user as "No specific permissions
  // requested" — the dialog granted what it declined to name. sync is the one
  // that matters most: it replicates the app's database to peers.
  ai: {
    label: 'AI Models',
    description: 'Download and run machine-learning models in your browser.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="8" width="14" height="12" rx="2" />
        <path d="M12 8V4M9 4h6" />
        <circle cx="9.5" cy="13.5" r="1" />
        <circle cx="14.5" cy="13.5" r="1" />
      </svg>
    ),
  },
  gpu: {
    label: 'GPU Compute',
    description: 'Run computations on your graphics hardware via WebGPU.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
      </svg>
    ),
  },
  sync: {
    label: 'Peer-to-Peer Sync',
    description: "Replicate this app's database to other devices over the network.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.6-4.2" />
        <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.6 4.2" />
        <path d="M20 4v5h-5M4 20v-5h5" />
      </svg>
    ),
  },
  accel: {
    label: 'Host Acceleration',
    description: "Run the numeric code it generates (an emulator, a signal kernel) on your browser's own engine, bound to its own data only, so it runs many times faster.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  storage: {
    label: 'Server Storage',
    description: "Keep records in this app's own database on this site — a scoreboard, shared notes — which anyone running the app can read and add to.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
    ),
  },
};

function getRequestedPermissions(config: PermissionConfig): Array<{ key: string; info: typeof PERMISSION_INFO[string]; detail?: string }> {
  const result: Array<{ key: string; info: typeof PERMISSION_INFO[string]; detail?: string }> = [];
  const perms = config.permissions;

  for (const [key, value] of Object.entries(perms)) {
    if (!value || !value.enabled) continue;
    // A key with no entry above used to be skipped, which is how ai, gpu and
    // sync came to be enforced by the runtime and described to the user as "No
    // specific permissions requested" — the dialog granted what it declined to
    // name. Naming it badly is better than not naming it, and an undescribed
    // row is loud enough that the missing entry gets noticed.
    const info = PERMISSION_INFO[key] ?? {
      label: `${key} access`,
      description: 'This app asks for a capability this version of SoftN cannot describe.',
      icon: UNDESCRIBED_ICON,
    };

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
    if (key === 'mic' && 'maxSeconds' in value && typeof value.maxSeconds === 'number' && value.maxSeconds > 0) {
      detail = `Up to ${value.maxSeconds}s per recording`;
    }

    result.push({ key, info, detail });
  }

  return result;
}

export function PermissionPrompt({ appName, appIcon, permissions, onAllow, onClose }: PermissionPromptProps): React.ReactElement {
  const requested = getRequestedPermissions(permissions);
  const titleId = useId();
  const descId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // This asks for consent, so it has to behave like the dialog it looks like.
  // It was a bare <div>: Chrome computed it as role "generic", focus stayed on
  // whatever was behind it, a screen reader was never told it had appeared, and
  // Escape did nothing. Focus lands on Close — the option that changes nothing
  // — rather than on the button that grants an untrusted bundle the network.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // preventScroll, or the browser scrolls this button into view and the
    // dialog opens part-way down: on a 640px-tall viewport the card is taller
    // than the screen, and the app's name and the first capability it asked
    // for would be above the fold on arrival.
    closeRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      // Keep Tab inside the dialog; behind it sits the whole runtime, and
      // tabbing into an app that has not been granted anything yet is exactly
      // what a modal is for preventing.
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Allow unmounts the bar and the "What this means" button with it, so the
      // opener can be a detached node by now; focusing one drops the keyboard
      // user at the top of the document. AppRunner takes focus in that case.
      if (opener?.isConnected) opener.focus?.();
    };
  }, [onClose]);

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      // Top-aligned and scrollable, not centred. A four-capability bundle in a
      // 640px-tall viewport made a 763px card, and centring put both buttons
      // and the app name off-screen with no way to scroll to them — the dialog
      // could be neither allowed nor dismissed on a phone.
      alignItems: 'flex-start',
      justifyContent: 'center',
      overflowY: 'auto',
      background: '#0c0c0e',
      zIndex: 20,
      padding: '1rem',
    }}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={{
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
            <div id={titleId} style={{
              color: '#ececf0',
              fontWeight: 600,
              fontSize: '1.0625rem',
              letterSpacing: '-0.02em',
            }}>
              {appName}
            </div>
            <div id={descId} style={{
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

        {/* <Camera>, <Microphone> and <QRReader> call getUserMedia themselves
            and consult no permission.json, so the browser's own prompt — not
            this one — is what stands in front of the hardware. Saying so is the
            difference between a bar people can trust and one that is caught
            claiming a viewfinder is off while it is visibly running. */}
        {requested.some(({ key }) => key === 'camera' || key === 'mic' || key === 'qr') && (
          <div style={{
            color: '#5a5a66',
            fontSize: '0.6875rem',
            lineHeight: 1.5,
            marginTop: '-0.75rem',
            marginBottom: '1.5rem',
          }}>
            Your browser asks you separately before the camera or microphone actually turns on.
            This covers what the app&rsquo;s own code may do with what it gets.
          </div>
        )}

        {/* Buttons */}
        <div style={{
          display: 'flex',
          gap: '0.75rem',
          justifyContent: 'flex-end',
        }}>
          <button
            ref={closeRef}
            onClick={onClose}
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
            Not now
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
