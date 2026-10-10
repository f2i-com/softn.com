/**
 * From one panel of the workspace to the next, by the keyboard.
 *
 * Tab goes through every stop of every panel in turn, and stops for good in
 * a code editor, where it indents. F6 goes to the next panel and Shift+F6
 * to the one before, from anywhere: the panels are the parts of the
 * workspace App marks with `data-panel`, in the order they are laid out,
 * and the focus goes to where each one keeps its stop.
 */

const STOPS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Whether the element is drawn. Only where there is a layout to ask: a DOM with none draws nothing. */
function drawn(element: HTMLElement): boolean {
  if (document.documentElement.clientWidth === 0) return true;
  return element.getClientRects().length > 0;
}

/** Where the focus goes in a panel: into its code, where it is a code editor, or the first thing that takes it. */
function stopIn(panel: HTMLElement): HTMLElement | null {
  const usable = (element: HTMLElement) => !element.closest('[inert]') && drawn(element);
  const code = panel.querySelector<HTMLElement>('textarea.inputarea');
  if (code && usable(code)) return code;
  return [...panel.querySelectorAll<HTMLElement>(STOPS)].find(usable) ?? null;
}

/**
 * Put the focus in the panel after the one it is in (`step` 1), or the one
 * before (-1). False when there is no other panel to go to.
 */
export function focusPanel(step: 1 | -1): boolean {
  const stops = [...document.querySelectorAll<HTMLElement>('[data-panel]')]
    .map((panel) => ({ panel, stop: stopIn(panel) }))
    .filter((entry): entry is { panel: HTMLElement; stop: HTMLElement } => entry.stop !== null);
  if (stops.length === 0) return false;
  const active = document.activeElement;
  const at = stops.findIndex(({ panel }) => active !== null && panel.contains(active));
  const next = at === -1 ? (step === 1 ? 0 : stops.length - 1) : (at + step + stops.length) % stops.length;
  if (next === at) return false;
  stops[next].stop.focus({ preventScroll: false });
  return true;
}
