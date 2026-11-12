/**
 * ToastContainer - the messages (toasts), as the status bar shows them
 *
 * A message used to float over the bottom right of the page for some
 * seconds, on top of the controls of the Properties and Hierarchy panels.
 * It is part of the status bar now (components/StatusBar.tsx renders this
 * in its row), in the page's flow: the bar is the one part of the screen
 * that is not a control. The bar shows the newest message; the others, the
 * whole of a long message and a message's particulars are in a panel the
 * person opens above the bar.
 *
 * The look is in styles/builder.css, under "Status bar and messages": the
 * bar measures itself there, which an inline style cannot.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useNotificationStore, type Notification } from '../../stores/notificationStore';

type Kind = Notification['type'];

// Drawn, not typed: the warning and information signs are emoji in some
// systems' fonts, and an emoji takes no colour from the page.
const kindDrawings: Record<Kind, React.ReactNode> = {
  success: <path d="M3.5 8.5l3 3 6-7" />,
  error: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.5l6 10.75H2z" />
      <path d="M8 6.75v3M8 11.5v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.5M8 5v.1" />
    </>
  ),
};

function KindIcon({ kind }: { kind: Kind }) {
  return (
    <svg className="bl-status-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kindDrawings[kind]}
    </svg>
  );
}

function DismissButton({ notif, onDismiss }: { notif: Notification; onDismiss: (id: string) => void }) {
  return (
    <button
      type="button"
      className="bl-status-x"
      onClick={() => onDismiss(notif.id)}
      title="Dismiss"
      aria-label={`Dismiss ${notif.type} notification`}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}

/**
 * What the control that opens the panel says for a message, or null when the
 * bar already shows all there is of it.
 */
export function showLabel(details: string[] | undefined, cut: boolean): string | null {
  const count = details?.length ?? 0;
  if (count === 1) return 'Show it';
  if (count > 1) return `Show all ${count}`;
  return cut ? 'Show it all' : null;
}

/** The messages the panel holds and those that have arrived since, oldest first. */
function withArrivals(held: Notification[], current: Notification[]): Notification[] {
  const known = new Set(held.map((notif) => notif.id));
  const arrivals = current.filter((notif) => !known.has(notif.id));
  return arrivals.length > 0 ? [...held, ...arrivals] : held;
}

// What an open dialog counts as its Tab stops (useModalFocus, in
// packages/@softn/editor-shared): the two have to agree on which stop is the
// dialog's last, where Tab goes on to a message's buttons.
const MODAL_STOPS = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]';

function stopsOf(modal: Element): HTMLElement[] {
  return Array.from(modal.querySelectorAll<HTMLElement>(MODAL_STOPS))
    .filter((item) => !item.closest('[hidden], [inert]') && getComputedStyle(item).display !== 'none');
}

/**
 * Whether the button is what a press at its middle would reach: a dialog the
 * bar does not know of lays its shade over the bar, and the focus is not
 * sent under it. Only where there is a layout to ask.
 */
function onTop(button: HTMLElement): boolean {
  if (document.documentElement.clientWidth === 0) return true;
  const box = button.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return hit !== null && button.contains(hit);
}

interface ToastContainerProps {
  /**
   * A dialog is open over the page. The bar keeps to one line then
   * (builder.css), so the strip the dialogs leave free for it is all it
   * needs: how much of a message fits is asked again when this changes.
   */
  modalOpen?: boolean;
}

export function ToastContainer({ modalOpen = false }: ToastContainerProps) {
  const current = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // The panel's messages, and null while it is closed. A message leaves the
  // store when its seconds are up; one the person has opened the panel to
  // read stays in the panel until they dismiss it or close the panel.
  const [held, setHeld] = useState<Notification[] | null>(null);
  const list = held ? withArrivals(held, current) : current;
  const open = held !== null && list.length > 0;
  const newest = list.length > 0 ? list[list.length - 1] : null;
  const others = list.length - 1;

  const scopeRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!held) return;
    const next = withArrivals(held, current);
    if (next.length === 0) setHeld(null);
    else if (next !== held) setHeld(next);
  }, [held, current]);

  const closePanel = useCallback((returnFocus: boolean) => {
    setHeld(null);
    const opener = openerRef.current;
    if (returnFocus && opener?.isConnected) opener.focus();
  }, []);

  const togglePanel = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (open) {
      closePanel(true);
      return;
    }
    openerRef.current = event.currentTarget;
    setHeld(current);
  };

  const dismiss = useCallback((id: string) => {
    // A button of the panel goes with its message: the focus goes to the
    // panel first, so it is not dropped on the page with the panel left open.
    if (panelRef.current?.contains(document.activeElement)) panelRef.current.focus();
    setHeld((now) => now && now.filter((notif) => notif.id !== id));
    removeNotification(id);
  }, [removeNotification]);

  const runAction = (notif: Notification) => {
    // An action's button goes with its message wherever it was pressed, the
    // bar's too.
    panelRef.current?.focus();
    dismiss(notif.id);
    notif.action?.onClick();
  };

  // Whether the bar had to cut the newest message short. Its two lines are
  // the stylesheet's to give, so this asks the text itself.
  const [cut, setCut] = useState(false);
  const newestId = newest?.id;
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) {
      setCut(false);
      return;
    }
    const measure = () => setCut(text.scrollHeight > text.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [newestId, modalOpen]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // The keyboard, for as long as there is a message. An open dialog or sheet
  // keeps Tab to itself and closes on Escape, by a listener on the document
  // (useModalFocus); this one is on the window, in the capture phase, so it
  // hears the key first. A message's buttons are stops of the dialog's round
  // of Tab, after its last and before its first, so a message shown while a
  // dialog is open can be answered without a pointer. Escape closes the
  // open panel alone.
  const hasMessage = list.length > 0;
  useEffect(() => {
    if (!hasMessage) return;
    const scope = scopeRef.current;
    if (!scope) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        closePanel(true);
        return;
      }
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const active = document.activeElement;
      const mine = Array.from(scope.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (active && scope.contains(active)) {
        // From the last of them Tab is the dialog's again, or the page's.
        const last = event.shiftKey ? mine[0] : mine[mine.length - 1];
        if (active !== last) event.stopPropagation();
        return;
      }
      const modal = active?.closest('[aria-modal="true"]');
      if (!modal) return;
      const stops = stopsOf(modal);
      const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
      const next = event.shiftKey ? mine[mine.length - 1] : mine[0];
      if (active !== edge || !next || !onTop(next)) return;
      event.preventDefault();
      event.stopPropagation();
      next.focus();
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, [hasMessage, open, closePanel]);

  useEffect(() => {
    if (!open) return;
    const scope = scopeRef.current;
    if (!scope) return;
    const within = (target: EventTarget | null) => target instanceof Node && scope.contains(target);
    const pointerDown = (event: PointerEvent) => {
      if (!within(event.target)) closePanel(false);
    };
    const focusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (within(next)) return;
      // Going to another window is not leaving the panel.
      if (next === null && !document.hasFocus()) return;
      closePanel(false);
    };
    window.addEventListener('pointerdown', pointerDown, true);
    scope.addEventListener('focusout', focusOut);
    return () => {
      window.removeEventListener('pointerdown', pointerDown, true);
      scope.removeEventListener('focusout', focusOut);
    };
  }, [open, closePanel]);

  const show = newest ? showLabel(newest.details, cut) : null;

  return (
    <div ref={scopeRef} className="bl-status-msg">
      {/* Always in the page, so a screen reader is listening before the first
          message arrives rather than being handed a region that appeared with
          it. Every message is said here; the bar shows the newest. */}
      <div className="bl-status-live" aria-live="polite" aria-relevant="additions">
        {list.map((notif) => (
          <div
            key={notif.id}
            className="bl-status-said"
            data-kind={notif.type}
            data-older={notif === newest ? undefined : ''}
            role={notif.type === 'error' ? 'alert' : 'status'}
            aria-atomic="true"
          >
            <KindIcon kind={notif.type} />
            <span ref={notif === newest ? textRef : undefined} className="bl-status-text">{notif.message}</span>
          </div>
        ))}
      </div>
      {newest && (
        <>
          {newest.action && (
            <button type="button" className="bl-status-btn" onClick={() => runAction(newest)}>
              <span>{newest.action.label}</span>
            </button>
          )}
          {show && (
            <button type="button" className="bl-status-btn" data-quiet="" data-toast-details="" aria-expanded={open} aria-controls={panelId} onClick={togglePanel}>
              <span>{show}</span>
            </button>
          )}
          {others > 0 && (
            <button
              type="button"
              className="bl-status-btn bl-status-count"
              data-quiet=""
              data-toast-others=""
              aria-expanded={open}
              aria-controls={panelId}
              onClick={togglePanel}
            >
              {/* "+2" is what is drawn; the rest of its name is said, not drawn. */}
              <span>+{others}</span>
              <span className="bl-status-unseen"> {others === 1 ? 'more message' : 'more messages'}</span>
            </button>
          )}
          <DismissButton notif={newest} onDismiss={dismiss} />
        </>
      )}
      {open && (
        <div ref={panelRef} id={panelId} className="bl-status-panel" role="group" aria-label="Messages" tabIndex={-1}>
          <div className="bl-status-panel-head">
            <span className="bl-eyebrow">{list.length === 1 ? '1 message' : `${list.length} messages`}</span>
            <button type="button" className="bl-mini" onClick={() => closePanel(true)}>
              Close
            </button>
          </div>
          <ul className="bl-status-list">
            {[...list].reverse().map((notif) => (
              <li key={notif.id} className="bl-status-item" data-kind={notif.type}>
                <KindIcon kind={notif.type} />
                <div className="bl-status-item-text">
                  {notif.message}
                  {notif.details && notif.details.length > 0 && (
                    <ul className="bl-status-details">
                      {notif.details.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {notif.action && (
                  <button type="button" className="bl-status-btn" onClick={() => runAction(notif)}>
                    <span>{notif.action.label}</span>
                  </button>
                )}
                <DismissButton notif={notif} onDismiss={dismiss} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
