/**
 * When an app may write the clipboard: from something the person did (a
 * click, a key press), and once they have answered the permission bar.
 *
 * The clipboard needs no declaration, and `navigator.clipboard.writeText`
 * was written with no question at all: an app on a timer, with no
 * permission.json, behind another app in the shelf, could replace whatever
 * the person copied (an address in a wallet app) every ten milliseconds.
 * Chromium, and so the desktop's WebView2, writes with page focus alone.
 * A copy button the person presses still copies.
 */

/** What an engine's clipboard bridge is given (LogicEngine.registerClipboardBridge). */
export interface ClipboardBridgeOptions {
  /** Why a write may not be made now, or null when it may. */
  refusal?: () => string | null;
  /** Where a write goes instead of the browser's clipboard (the worker hands it to the page). */
  write?: (text: string) => void;
}

/** Why the app may not write the clipboard now, or null. */
export function clipboardWriteRefusal(consentPending: boolean): string | null {
  if (consentPending) {
    return 'Copying to the clipboard waits until you answer the permission bar at the top of the app.';
  }
  const activation =
    typeof navigator === 'undefined' ? undefined : (navigator as { userActivation?: { isActive?: boolean } }).userActivation;
  if (activation && activation.isActive === false) {
    return 'The clipboard is written when the person asks: copy from a click or a key press.';
  }
  return null;
}
