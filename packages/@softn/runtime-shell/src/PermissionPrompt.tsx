/**
 * PermissionPrompt — the full disclosure behind the consent bar.
 *
 * Opened from "What this means", never on arrival: the app is already on
 * screen and already running with its declared capabilities withheld, so this
 * gates nothing. It names every capability the bundle asked for, including any
 * this build has no description for, and offers the same Allow the bar does.
 *
 * Shared by every host that runs one bundle (the web runtime, the desktop
 * loader, the single-app shell). What differs between them — whether it is a
 * browser that asks separately for the camera, where "server storage" lives —
 * comes in through `wording` (see PermissionBar's ConsentWording).
 */

import React, { useEffect, useId, useRef } from 'react';
import type { PermissionConfig } from '@softn/core';
import { CONSENT_STYLES } from './consentStyles';
import type { ConsentWording } from './PermissionBar';

export interface PermissionPromptProps {
  appName: string;
  appIcon?: string;
  permissions: PermissionConfig;
  onAllow: () => void;
  /** Dismiss the dialog. Records nothing: not answering is not an answer. */
  onClose: () => void;
  /** The host's words for what differs between hosts. */
  wording?: ConsentWording;
}

const svg = (children: React.ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** Stands in for a capability this build has no description for. */
const UNDESCRIBED_ICON = svg(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </>,
);

/**
 * What each capability is called and what it lets an app do, in the words a
 * browser host uses. Sentence case, like every label in the product. Keyed
 * by every name in core's CAPABILITIES (apps/softn-web/test/capability-schema
 * holds it to that): a capability the runtime enforces but this list cannot
 * describe is a dialog granting what it declines to name.
 */
export const PERMISSION_INFO: Record<string, { label: string; description: string; icon: React.ReactNode }> = {
  net: {
    label: 'Network access',
    description: 'Send and receive data over the internet (fetch, WebSocket).',
    icon: svg(
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>,
    ),
  },
  camera: {
    label: 'Camera',
    description: 'Use your device camera to capture photos or video.',
    icon: svg(
      <>
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </>,
    ),
  },
  mic: {
    label: 'Microphone',
    description: 'Listen through your device microphone and record what it hears.',
    icon: svg(
      <>
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </>,
    ),
  },
  files: {
    label: 'Files',
    description: 'Open files you choose, and save files the app makes to your device.',
    icon: svg(<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />),
  },
  qr: {
    label: 'QR code scanner',
    description: 'Scan QR codes using your device camera.',
    icon: svg(
      <>
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
        <rect x="14" y="14" width="3" height="3" />
        <line x1="21" y1="14" x2="21" y2="21" />
        <line x1="14" y1="21" x2="21" y2="21" />
      </>,
    ),
  },
  // ai, gpu and sync are enforced by the runtime and were once missing here, so
  // a bundle asking for them was described as "No specific permissions
  // requested" — the dialog granted what it declined to name. sync is the one
  // that matters most: it replicates the app's database to peers.
  ai: {
    label: 'AI models',
    description: 'Download and run machine-learning models in your browser.',
    icon: svg(
      <>
        <rect x="5" y="8" width="14" height="12" rx="2" />
        <path d="M12 8V4M9 4h6" />
        <circle cx="9.5" cy="13.5" r="1" />
        <circle cx="14.5" cy="13.5" r="1" />
      </>,
    ),
  },
  gpu: {
    label: 'GPU compute',
    description: 'Run computations on your graphics hardware via WebGPU.',
    icon: svg(
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
      </>,
    ),
  },
  sync: {
    label: 'Peer-to-peer sync',
    description: "Replicate this app's database to other devices over the network.",
    icon: svg(
      <>
        <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.6-4.2" />
        <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.6 4.2" />
        <path d="M20 4v5h-5M4 20v-5h5" />
      </>,
    ),
  },
  accel: {
    label: 'Host acceleration',
    description: "Run the numeric code it generates (an emulator, a signal kernel) on your browser's own engine, bound to its own data only, so it runs many times faster.",
    icon: svg(<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />),
  },
  storage: {
    label: 'Server storage',
    description: "Keep records in this app's own database on this site — a scoreboard, shared notes — which anyone running the app can read and add to.",
    icon: svg(
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>,
    ),
  },
};

/** The sentence under the list when a bundle asks for the camera or microphone, in a browser. */
export const BROWSER_DEVICE_NOTE =
  'Your browser asks you separately before the camera or microphone actually turns on. This covers what the app’s own code may do with what it gets.';

interface RequestedRow {
  key: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  detail?: string;
}

function getRequestedPermissions(config: PermissionConfig, wording?: ConsentWording): RequestedRow[] {
  const result: RequestedRow[] = [];
  const perms = config.permissions;

  for (const [key, value] of Object.entries(perms)) {
    if (!value || !value.enabled) continue;
    // A key with no entry above used to be skipped, which is how ai, gpu and
    // sync came to be enforced by the runtime and described to the user as "No
    // specific permissions requested". Naming it badly is better than not
    // naming it, and an undescribed row is loud enough to get noticed.
    const base = PERMISSION_INFO[key] ?? {
      label: `${key} access`,
      description: 'This app asks for a capability this version of SoftN cannot describe.',
      icon: UNDESCRIBED_ICON,
    };
    const override = wording?.details?.[key as keyof NonNullable<ConsentWording['details']>];

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

    result.push({
      key,
      label: override?.label ?? base.label,
      description: override?.description ?? base.description,
      icon: base.icon,
      detail,
    });
  }

  return result;
}

const APP_ICON_PLACEHOLDER = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </svg>
);

export function PermissionPrompt({ appName, appIcon, permissions, onAllow, onClose, wording }: PermissionPromptProps): React.ReactElement {
  const requested = getRequestedPermissions(permissions, wording);
  const titleId = useId();
  const descId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const deviceNote = wording?.deviceNote === undefined ? BROWSER_DEVICE_NOTE : wording.deviceNote;

  // This asks for consent, so it has to behave like the dialog it looks like:
  // role dialog, focus moved in, Tab kept inside, Escape to leave. Focus lands
  // on Not now — the option that changes nothing — rather than on the button
  // that grants an untrusted bundle the network.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // preventScroll, or the browser scrolls this button into view and the
    // dialog opens part-way down: on a short viewport the card is taller than
    // the screen, and the app's name and the first capability it asked for
    // would be above the fold on arrival.
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
      // opener can be a detached node by now. PermissionBar puts focus back
      // into the app in that case.
      if (opener?.isConnected) opener.focus?.();
    };
  }, [onClose]);

  return (
    // Top-aligned and scrollable, not centred: a four-capability bundle in a
    // 640px-tall viewport made a 763px card, and centring put both buttons
    // and the app name off-screen with no way to scroll to them.
    <div className="softn-consent-overlay" data-softn-consent="">
      <style dangerouslySetInnerHTML={{ __html: CONSENT_STYLES }} />
      <div
        ref={cardRef}
        className="softn-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <div className="softn-consent-dialog-head">
          {appIcon ? (
            <img className="softn-consent-dialog-icon" src={appIcon} alt="" />
          ) : (
            <div className="softn-consent-dialog-icon softn-consent-dialog-icon--blank">{APP_ICON_PLACEHOLDER}</div>
          )}
          <div>
            <div id={titleId} className="softn-consent-dialog-title">{appName}</div>
            <div id={descId} className="softn-consent-dialog-sub">
              {requested.length > 0 ? 'wants to use the following. None of it is on until you allow it.' : 'asks for no permissions.'}
            </div>
          </div>
        </div>

        <ul className="softn-consent-list">
          {requested.length > 0 ? (
            requested.map(({ key, label, description, icon, detail }) => (
              <li key={key} className="softn-consent-row">
                <div className="softn-consent-row-icon">{icon}</div>
                <div className="softn-consent-row-text">
                  <div className="softn-consent-row-label">{label}</div>
                  <div className="softn-consent-row-desc">{description}</div>
                  {detail && <div className="softn-consent-row-detail">{detail}</div>}
                </div>
              </li>
            ))
          ) : (
            <li className="softn-consent-row softn-consent-row--empty">No specific permissions requested.</li>
          )}
        </ul>

        {/* <Camera>, <Microphone> and <QRReader> call getUserMedia themselves
            and consult no permission.json, so the host's own prompt — not this
            one — is what stands in front of the hardware. Saying so is the
            difference between a bar people can trust and one that is caught
            claiming a viewfinder is off while it is visibly running. */}
        {deviceNote && requested.some(({ key }) => key === 'camera' || key === 'mic' || key === 'qr') && (
          <p className="softn-consent-note">{deviceNote}</p>
        )}

        <div className="softn-consent-dialog-actions">
          <button ref={closeRef} type="button" className="softn-consent-btn softn-consent-later" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="softn-consent-btn softn-consent-allow" onClick={onAllow}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
