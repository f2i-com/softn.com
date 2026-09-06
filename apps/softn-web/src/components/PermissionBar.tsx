/**
 * PermissionBar — the non-blocking form of a permission request.
 *
 * The app is already on screen and already running when this appears, with the
 * capabilities it declared withheld until Allow. So it is not a gate, and
 * nothing here may be worded as though the app is waiting on it. A modal that
 * has to be answered before anything is visible asks people to trust a bundle
 * they have not been allowed to look at yet.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { PermissionConfig } from '@softn/core';
import type { Capability } from '../lib/bundleProcessor';
import { diffCapabilities, type PreviousBuild } from '../lib/consentDiff';
import { PermissionPrompt } from './PermissionPrompt';

/** What a tab needs to raise the bar. Absent once a grant exists. */
export interface ConsentRequest {
  /** The config the app will get on Allow — the declared one, not a rebuild. */
  config: PermissionConfig;
  /** requestedCapabilities(config): the list the grant is written from. */
  capabilities: string[];
  appName: string;
  appIcon?: string;
  /**
   * The build of this app opened before this one, when there was one: the
   * bar says what this build asks for that it did not, so an update cannot
   * add a capability under a familiar-looking request.
   */
  previous?: PreviousBuild;
  onAllow: () => void;
}

interface PermissionBarProps extends ConsentRequest {
  /** Measured height, so the tab can reserve room for the bar. */
  onHeightChange: (px: number) => void;
}

/**
 * Capability names as a visitor would say them.
 *
 * Camera, mic and qr are phrased as what the app receives rather than as a
 * device being switched on. <Camera>, <Microphone> and <QRReader> call
 * getUserMedia themselves and permission.json does not describe that call, so
 * they are held on consent state instead — for a bundle that raises this bar,
 * Allow is what releases them. It is not the browser's own camera prompt and
 * not the operating system's camera switch, and must not read as either: a
 * bundle that declares nothing raises no bar, and its components are held by
 * the same default-false consent state with no Allow anywhere to change it.
 *
 * Keyed by `Capability`, which is the same list requestedCapabilities filters
 * on. That is the point: this is the sixth place a new capability has to be
 * added, and typing it here is what turns the sixth into a build error instead
 * of a bar that says 'a capability called "webusb"'.
 */
const CAPABILITY_PHRASE: Record<Capability, string> = {
  net: 'the internet',
  camera: 'pictures from your camera',
  mic: 'recordings from your microphone',
  files: 'your files',
  qr: 'QR codes it scans',
  ai: 'AI models it downloads',
  gpu: 'your graphics card',
  sync: 'your other devices',
  storage: 'its own database on this site',
  accel: "your browser's engine for the code it generates",
};

function describe(capabilities: string[]): string {
  const phrases = capabilities.map(
    // Naming it badly beats not naming it — the same call PermissionPrompt
    // makes for an undescribed row, and loud enough that the gap gets noticed.
    (key) => CAPABILITY_PHRASE[key as Capability] ?? `a capability called "${key}"`,
  );
  if (phrases.length <= 1) return phrases[0] ?? '';
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

const SHIELD = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z" />
  </svg>
);

const permissionBarStyles = `
  @keyframes softn-consent-fade-in { from { opacity: 0; } to { opacity: 1; } }

  .softn-consent-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 46px;
    padding: 0.5rem 0.875rem;
    background:
            #161a20;
    border-bottom: 1px solid #262c36;
    /* Runtime chrome, so the colours are fixed. Every var(--color-*) here would
       resolve from whichever theme the bundle picked — DeviceKit renders light,
       Promptly Unemployed renders dark — and the bar would read as the app's
       own UI, which is the one thing a consent surface must never do. */
    color: #f2f0ec;
    font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
    font-size: 0.8125rem;
    letter-spacing: -0.01em;
    user-select: none;
  }
  .softn-consent-icon { display: flex; flex-shrink: 0; color: #8b94a2; }
  .softn-consent-msg {
    flex: 1;
    min-width: 0;
    line-height: 1.4;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
  }
  .softn-consent-msg b { color: #f2f0ec; font-weight: 500; }
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
    transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  /* .softn-app *:focus-visible does not reach out here — the bar sits outside
     the app root on purpose, so it draws its own ring. */
  .softn-consent-btn:focus-visible,
  .softn-consent-chip:focus-visible { outline: 2px solid #8b94a2; outline-offset: 2px; }

  .softn-consent-allow {
    background: #f2f0ec; color: #101317; border: 1px solid #f2f0ec;
  }
  .softn-consent-allow:hover {
    background: #ffffff; transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }
  .softn-consent-later {
    background: #1d222a; color: #f2f0ec; border: 1px solid #333b47;
  }
  .softn-consent-later:hover { background: #262c36; transform: translateY(-1px); }
  .softn-consent-more {
    background: transparent; border: none; color: #f2f0ec; padding: 0 0.375rem;
    text-decoration: underline dotted; text-underline-offset: 3px;
  }
  .softn-consent-more:hover { color: #ffffff; }

  /* The dismissed state is a strip in the same flex column as the bar, not a
     button floating over the app.
     It was position:absolute, 30px square in the top-right corner with
     z-index 12 — which is exactly where an app puts its own top-right control.
     Measured: the chip's rect covered Glamour Studio's Settings button and
     elementFromPoint returned the chip, so pressing Settings reopened the
     permission bar instead. Being in flow costs about twelve pixels against
     the full bar; it buys back every click in the corner underneath it, and
     the strip is measured by the same observer so the app root is sized around
     it rather than under it. */
  .softn-consent-chip-strip {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 3px 6px;
    background: #161a20;
    border-bottom: 1px solid #1c212a;
  }
  .softn-consent-chip {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px;
    background: rgba(22, 26, 32, 0.72);
    border: 1px solid #333b47;
    color: #8b94a2;
    cursor: pointer;
    opacity: 0.55;
    animation: softn-consent-fade-in 250ms cubic-bezier(0.16, 1, 0.3, 1) both;
    transition: opacity 180ms cubic-bezier(0.16, 1, 0.3, 1),
                background 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .softn-consent-chip:hover, .softn-consent-chip:focus-visible {
    opacity: 1; background: rgba(22, 26, 32, 0.92);
  }

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
  /* Matches the 44px targets TabBar already gives its controls.
     Both queries, not just pointer:coarse. A phone-width viewport is the
     reliable signal: pointer:coarse depends on the browser reporting a
     touch-capable primary input, and it does not match in a desktop browser
     driven under touch emulation — which is how this was measured at 32px on a
     375px viewport in the first place. Whichever matches, the target is 44px. */
  @media (pointer: coarse), (max-width: 560px) {
    .softn-consent-bar { min-height: 58px; }
    .softn-consent-btn { height: 44px; }
    /* 44px, the same as the buttons above, and not the 40px it was: the chip is
       the only way back to the bar once it has been dismissed, so it is the one
       target here that must not be the smallest. */
    .softn-consent-chip { width: 44px; height: 44px; opacity: 0.8; }
  }
  @media (prefers-reduced-motion: reduce) {
    .softn-consent-bar *, .softn-consent-chip { transition: none !important; animation: none !important; }
  }
`;

export function PermissionBar({
  appName,
  appIcon,
  config,
  capabilities,
  previous,
  onAllow,
  onHeightChange,
}: PermissionBarProps): React.ReactElement | null {
  const [collapsed, setCollapsed] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const firstBtnRef = useRef<HTMLButtonElement>(null);
  const restoredRef = useRef(false);

  // Measured, never assumed. The height feeds --softn-tab-bar-height, which is
  // how @softn/components sizes an app root; a CSS guess that is wrong by one
  // wrapped line puts the bundle's own footer that far below the fold, and the
  // copy wraps at a width that depends on how many capabilities were asked for.
  useEffect(() => {
    const el = barRef.current;
    if (!el) {
      onHeightChange(0);
      return;
    }
    const report = (): void => onHeightChange(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed, onHeightChange]);

  // Both controls that change this state unmount themselves in doing so.
  // Without this, focus falls to <body> and a keyboard user is dropped at the
  // top of the document instead of on the control that replaced the one they
  // pressed. Skipped on first render: nothing here may steal focus on arrival,
  // which is the modal behaviour being removed.
  useEffect(() => {
    if (collapsed) chipRef.current?.focus();
    else if (restoredRef.current) firstBtnRef.current?.focus();
  }, [collapsed]);

  // A bundle that asks for nothing has nothing to consent to; App.tsx already
  // withholds the bar in that case, and this is the second line of it.
  if (capabilities.length === 0) return null;

  const sentence = describe(capabilities);
  // Against the build opened before this one, when there was one: what an
  // update adds is the part that must not slide past a familiar request.
  const change = previous ? diffCapabilities(capabilities, previous.capabilities) : null;
  const changeText = !change || !previous
    ? ''
    : change.added.length > 0
      ? `New since v${previous.version}: ${describe(change.added)}.`
      : change.removed.length > 0
        ? `No longer asks for ${describe(change.removed)}, as v${previous.version} did.`
        : `The same as v${previous.version}.`;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: permissionBarStyles }} />
      {collapsed ? (
        <div ref={barRef} className="softn-consent-chip-strip">
          <button
            ref={chipRef}
            type="button"
            className="softn-consent-chip"
            aria-label="Review what this app asked permission for"
            title="Permissions"
            onClick={() => {
              restoredRef.current = true;
              setCollapsed(false);
            }}
          >
            {SHIELD}
          </button>
        </div>
      ) : (
        // status, not alert: alert is assertive and would interrupt the screen
        // reader at the exact moment the app is announcing its own content, on
        // every launch. Nothing here is urgent — the app is running, and it is
        // running in the safe state, so a user who never reads the bar loses
        // nothing. The cost is that first appearance may go unannounced;
        // discoverability is carried by focus order instead.
        <div ref={barRef} className="softn-consent-bar" role="status">
          <span className="softn-consent-icon">{SHIELD}</span>
          <span className="softn-consent-msg" title={`This app wants to use ${sentence}.${changeText ? ` ${changeText}` : ''}`}>
            This app wants to use <b>{sentence}</b>.
            {change && change.added.length > 0 && (
              <>
                {' '}
                New since v{previous!.version}: <b>{describe(change.added)}</b>.
              </>
            )}
            {change && change.added.length === 0 && change.removed.length > 0 && <> No longer asks for {describe(change.removed)}, as v{previous!.version} did.</>}
            {change && change.added.length === 0 && change.removed.length === 0 && <> The same as v{previous!.version}.</>}
          </span>
          <span className="softn-consent-actions">
            <button
              ref={firstBtnRef}
              type="button"
              className="softn-consent-btn softn-consent-more"
              onClick={() => setShowDetails(true)}
            >
              What this means
            </button>
            {/* "Not now", not "Deny": nothing is refused and nothing aborts —
                the app carries on with its capabilities withheld, exactly as it
                already was. A word implying a verdict would misdescribe what
                the button did, and the dismissal is not recorded anywhere. */}
            <button
              type="button"
              className="softn-consent-btn softn-consent-later"
              onClick={() => {
                restoredRef.current = false;
                setCollapsed(true);
              }}
            >
              Not now
            </button>
            <button type="button" className="softn-consent-btn softn-consent-allow" onClick={onAllow}>
              Allow
            </button>
          </span>
        </div>
      )}
      {showDetails && (
        <PermissionPrompt
          appName={appName}
          appIcon={appIcon}
          permissions={config}
          onAllow={() => {
            setShowDetails(false);
            onAllow();
          }}
          onClose={() => setShowDetails(false)}
        />
      )}
    </>
  );
}
