/**
 * PermissionBar — the non-blocking form of a permission request.
 *
 * The app is already on screen and already running when this appears, with the
 * capabilities it declared withheld until Allow. So it is not a gate, and
 * nothing here may be worded as though the app is waiting on it. A modal that
 * has to be answered before anything is visible asks people to trust a bundle
 * they have not been allowed to look at yet.
 *
 * One bar for every host that runs one bundle — the web runtime, the desktop
 * loader and the single-app shell — so a bundle is asked in the same words
 * wherever it is opened. What differs between hosts (a browser asks separately
 * for the camera; "on this site" means nothing on a desktop) is `wording`.
 */

import React, { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Capability, PermissionConfig } from '@softn/core';
import { diffCapabilities, type PreviousBuild } from './consent';
import { CONSENT_STYLES } from './consentStyles';
import { PermissionPrompt } from './PermissionPrompt';

/**
 * The words that differ between hosts. Everything left out is the browser
 * host's wording, which is what the web runtime and the single-app shell use.
 */
export interface ConsentWording {
  /** How the bar's sentence names a capability ("the internet", "your files"). */
  phrases?: Partial<Record<Capability, string>>;
  /** The detail dialog's label and description for a capability. */
  details?: Partial<Record<Capability, { label?: string; description?: string }>>;
  /**
   * The dialog's sentence about the device's own camera/microphone prompt.
   * Omitted: the browser's. `null`: say nothing, for a host that has no such
   * prompt to point to.
   */
  deviceNote?: string | null;
}

/** What a host needs to raise the bar. Absent once a grant exists. */
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

export interface PermissionBarProps extends ConsentRequest {
  /** Measured height, so the host can reserve room for the bar. */
  onHeightChange?: (px: number) => void;
  /**
   * The element the app renders in. Allow unmounts the bar with the focused
   * button in it; focus goes back to where it was in the app — the field
   * being typed in, caret and all — or to this element, never to <body>. It
   * must be focusable (tabIndex={-1} will do).
   */
  appRootRef?: RefObject<HTMLElement | null>;
  wording?: ConsentWording;
  /** Added to the bar's class, for a host that styles or finds it by its own name. */
  className?: string;
}

/**
 * Capability names as a visitor would say them, in a browser.
 *
 * Camera, mic and qr are phrased as what the app receives rather than as a
 * device being switched on. <Camera>, <Microphone> and <QRReader> call
 * getUserMedia themselves and permission.json does not describe that call, so
 * they are held on consent state instead — for a bundle that raises this bar,
 * Allow is what releases them. It is not the browser's own camera prompt and
 * not the operating system's camera switch, and must not read as either.
 *
 * Keyed by `Capability`, so a capability added to the schema without words
 * here is a build error instead of a bar that says 'a capability called
 * "webusb"'.
 */
export const CAPABILITY_PHRASE: Record<Capability, string> = {
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

/** The desktop loader's words: no browser, no site. */
export const DESKTOP_WORDING: ConsentWording = {
  phrases: {
    storage: 'its own shared database online',
    accel: "this computer's engine for the code it generates",
  },
  details: {
    ai: { description: 'Download and run machine-learning models on this computer.' },
    gpu: { description: 'Run computations on your graphics hardware.' },
    accel: {
      description:
        'Run the numeric code it generates (an emulator, a signal kernel) on the runtime’s own engine, bound to its own data only, so it runs many times faster.',
    },
    storage: {
      description:
        'Keep records in this app’s own shared database online — a scoreboard, shared notes — which anyone running the app can read and add to.',
    },
  },
  deviceNote:
    'Your system may ask you separately before the camera or microphone turns on. This covers what the app’s own code may do with what it gets.',
};

function describe(capabilities: string[], wording?: ConsentWording): string {
  const phrases = capabilities.map(
    // Naming it badly beats not naming it — the same call PermissionPrompt
    // makes for an undescribed row, and loud enough that the gap gets noticed.
    (key) =>
      wording?.phrases?.[key as Capability] ?? CAPABILITY_PHRASE[key as Capability] ?? `a capability called "${key}"`,
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

/**
 * Only the text-shaped input types carry a selection. `selectionStart` on a
 * checkbox or a colour picker throws rather than answering null.
 */
function isTextEntry(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return /^(?:text|search|url|tel|password|email|)$/i.test(el.type);
}

/**
 * Put focus and caret back where the app had them.
 *
 * Only the element is remembered, never the offsets: a browser keeps an
 * input's selection across a blur, so reading it here — after the person has
 * finished typing and pressed Allow — is the position they actually left.
 * Reading before `focus()` matters too, because focusing a text field can
 * collapse the selection to its end.
 *
 * False when there is nothing to restore or the element has gone: the grant
 * reloads the script against the granted config, so a field the bundle
 * renders conditionally may not survive it.
 */
function restoreFocus(element: HTMLElement | null): boolean {
  if (!element || !element.isConnected) return false;
  const selection = isTextEntry(element)
    ? { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection ?? ('none' as const) }
    : null;
  element.focus({ preventScroll: true });
  if (selection && selection.start !== null && selection.end !== null && isTextEntry(element)) {
    try {
      element.setSelectionRange(selection.start, selection.end, selection.direction);
    } catch {
      // Still in the document but no longer takes a selection. Focus landed.
    }
  }
  return document.activeElement === element;
}

export function PermissionBar({
  appName,
  appIcon,
  config,
  capabilities,
  previous,
  onAllow,
  onHeightChange,
  appRootRef,
  wording,
  className,
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
    if (!onHeightChange) return;
    const el = barRef.current;
    if (!el) {
      onHeightChange(0);
      return;
    }
    const report = (): void => onHeightChange(el.offsetHeight);
    report();
    if (typeof ResizeObserver === 'undefined') return;
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

  // Where focus goes after Allow. The last thing inside the app to take focus
  // is tracked as it happens rather than read at Allow: by the time the click
  // handler runs, focus is already on the Allow button, and a keyboard user
  // tabbed away from the field before that. The bar's own controls and its
  // dialog are skipped — they disappear on Allow.
  const allowedRef = useRef(false);
  const lastAppFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = appRootRef?.current;
    if (!root) return;
    const remember = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === root) return;
      if (target.closest('[data-softn-consent]')) return;
      lastAppFocusRef.current = target;
    };
    root.addEventListener('focusin', remember);
    return () => root.removeEventListener('focusin', remember);
  }, [appRootRef]);
  // Allow unmounts the bar, taking the focused button with it. Only after an
  // Allow: an unmount for any other reason — the tab closing, StrictMode's
  // rehearsal on arrival — must not move focus anywhere.
  useEffect(
    () => () => {
      if (!allowedRef.current) return;
      if (!restoreFocus(lastAppFocusRef.current)) appRootRef?.current?.focus({ preventScroll: true });
    },
    [appRootRef],
  );
  const allow = useCallback(() => {
    allowedRef.current = true;
    onAllow();
  }, [onAllow]);
  // Stable: the dialog's focus effect depends on it, and a fresh function on
  // every render of the bar (each height report re-renders the host) re-ran
  // that effect and pulled focus back to Not now mid-Tab.
  const closeDetails = useCallback(() => setShowDetails(false), []);

  // A bundle that asks for nothing has nothing to consent to; the hosts already
  // withhold the bar in that case, and this is the second line of it.
  if (capabilities.length === 0) return null;

  const sentence = describe(capabilities, wording);
  // Against the build opened before this one, when there was one: what an
  // update adds is the part that must not slide past a familiar request.
  const change = previous ? diffCapabilities(capabilities, previous.capabilities) : null;
  const changeText = !change || !previous
    ? ''
    : change.added.length > 0
      ? `New since v${previous.version}: ${describe(change.added, wording)}.`
      : change.removed.length > 0
        ? `No longer asks for ${describe(change.removed, wording)}, as v${previous.version} did.`
        : `The same as v${previous.version}.`;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CONSENT_STYLES }} />
      {collapsed ? (
        <div ref={barRef} className="softn-consent-chip-strip" data-softn-consent="">
          <span className="softn-consent-chip-note">Running with permissions off.</span>
          <button
            ref={chipRef}
            type="button"
            className="softn-consent-chip"
            title={`${appName} asked to use ${sentence}`}
            onClick={() => {
              restoredRef.current = true;
              setCollapsed(false);
            }}
          >
            {SHIELD}
            Review permissions
          </button>
        </div>
      ) : (
        // status, not alert: alert is assertive and would interrupt the screen
        // reader at the exact moment the app is announcing its own content, on
        // every launch. Nothing here is urgent — the app is running, and it is
        // running in the safe state, so a person who never reads the bar loses
        // nothing.
        <div
          ref={barRef}
          className={className ? `softn-consent-bar ${className}` : 'softn-consent-bar'}
          role="status"
          data-softn-consent=""
        >
          <span className="softn-consent-icon">{SHIELD}</span>
          <span className="softn-consent-msg" title={`This app wants to use ${sentence}.${changeText ? ` ${changeText}` : ''}`}>
            This app wants to use <b>{sentence}</b>.
            {change && change.added.length > 0 && (
              <>
                {' '}
                New since v{previous!.version}: <b>{describe(change.added, wording)}</b>.
              </>
            )}
            {change && change.added.length === 0 && change.removed.length > 0 && <> No longer asks for {describe(change.removed, wording)}, as v{previous!.version} did.</>}
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
                already was, and the dismissal is not recorded anywhere. */}
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
            <button type="button" className="softn-consent-btn softn-consent-allow" onClick={allow}>
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
          wording={wording}
          onAllow={() => {
            setShowDetails(false);
            allow();
          }}
          onClose={closeDetails}
        />
      )}
    </>
  );
}
