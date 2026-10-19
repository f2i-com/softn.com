/**
 * Keys a script asked the host to keep from the browser.
 *
 * A script's key handler runs after the browser has acted on the event — in
 * the VM, or in a worker a message away — so it cannot cancel the default
 * itself. A game that reads the arrow keys watches the page scroll under it;
 * one that uses Space, Tab or the function keys fights the browser for each
 * of them. `softn.input.captureKeys(...)` names the keys the script wants
 * whole, and the window listeners cancel the default for those before the
 * event is forwarded.
 *
 * The capture never reaches a text field, so typing in the app's own inputs
 * is untouched, and never applies to a key pressed with the system modifier
 * or to a Ctrl+letter chord, so the browser's own shortcuts keep working.
 *
 * Each app's keys are its own. A page can hold more than one app — Studio's
 * preview beside another, or a reload whose old runtime is still being
 * cleaned up — and with one list for the page, the second app's keys
 * replaced the first's, and the first app to close released the other's.
 * The keys kept from the browser are every app's together.
 */

/** The keys each app asked for, by the runtime that asked. */
const captured = new Map<object, Set<string>>();

/**
 * Replace the keys `owner` captures; an empty list releases them. Entries
 * are `KeyboardEvent.key` or `.code` values.
 */
export function setCapturedKeys(owner: object, keys: Iterable<string>): void {
  const names = new Set<string>();
  for (const key of keys) {
    const name = String(key);
    if (name !== '') names.add(name);
  }
  if (names.size > 0) captured.set(owner, names);
  else captured.delete(owner);
}

/** Release the keys `owner` captured, and only those. */
export function clearCapturedKeys(owner: object): void {
  captured.delete(owner);
}

/** How many different keys are captured, by every owner together. */
export function capturedKeyCount(): number {
  const all = new Set<string>();
  for (const names of captured.values()) for (const name of names) all.add(name);
  return all.size;
}

function isCaptured(key: string, code: string): boolean {
  for (const names of captured.values()) {
    if (names.has(key) || names.has(code)) return true;
  }
  return false;
}

/** Whether the event's target takes typed text, which capture must leave alone. */
function targetIsEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false;
  const element = target as Element & { isContentEditable?: boolean };
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
}

/**
 * Whether this event's default action should be cancelled before the script
 * sees it: a captured key, on its way somewhere other than a text field, with
 * no modifier that makes it the browser's.
 */
export function shouldCaptureKey(event: Event): boolean {
  if (captured.size === 0) return false;
  if (typeof KeyboardEvent === 'undefined' || !(event instanceof KeyboardEvent)) return false;
  if (event.type !== 'keydown' && event.type !== 'keyup') return false;
  if (event.metaKey) return false;
  if (event.ctrlKey && event.key.length === 1) return false;
  if (!isCaptured(event.key, event.code)) return false;
  return !targetIsEditable(event.target);
}

/**
 * The list a `input.captureKeys` host call carries: a JSON array of names,
 * or a comma-separated string. Anything else is an empty list.
 */
export function parseCapturedKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((k) => String(k)).filter((k) => k !== '');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const text = raw.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed.map((k) => String(k)).filter((k) => k !== '') : [];
    } catch {
      return [];
    }
  }
  return text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
}
