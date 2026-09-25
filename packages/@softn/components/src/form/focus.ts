/**
 * Focus rings for form controls whose focusable element is not what the user
 * sees: Checkbox, Radio and Switch draw a box or a track over a native input
 * at opacity 0, so the browser's own outline — and the theme's
 * `:focus-visible` rule — lands on something invisible, and the drawn control
 * has to show focus itself.
 */

/**
 * A solid two-tone ring: a gap in the page colour, then the primary. Visible
 * on a checked control whose border is already the primary, which a
 * translucent glow was not.
 */
export const focusRing =
  '0 0 0 2px var(--color-bg, transparent), 0 0 0 4px var(--color-primary-500, rgb(99, 102, 241))';

/**
 * Whether focus on `element` should be shown: keyboard focus, not the focus a
 * mouse click leaves behind. Where the browser cannot answer
 * (`:focus-visible` unsupported), assume it should.
 */
export function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}
