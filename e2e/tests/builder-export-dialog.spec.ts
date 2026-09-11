/**
 * Builder's Export dialog owns focus while it is open. UX-01 in the audit.
 *
 * What went wrong before: the overlay was a div with no dialog semantics —
 * Tab left it for the toolbar behind it, Escape did nothing, and closing
 * dropped focus on the body, so a keyboard user who opened Export was
 * somewhere on the page with no idea where. The dialog now has
 * `role="dialog"`, `aria-modal`, a Tab trap that wraps at both ends, an
 * Escape that closes it, and focus that is meant to go back to the control
 * that opened it.
 *
 * Which assertion catches which regression:
 *   UX-01  focus is inside the dialog once it opens; Tab from the last
 *          control lands on the first and Shift+Tab from the first lands on
 *          the last, and a long run of Tabs never leaves the dialog; Escape
 *          closes it; and — the second test — the toolbar's Export button
 *          has focus again afterwards.
 *
 * The dialog's controls change while it is open — the preflight inspection
 * enables the hand-off buttons when it finishes — so the wrap is checked
 * against the focusable set as it stands at each step, read from the DOM,
 * rather than against a fixed count.
 *
 * The second test is marked as an expected failure, because on the built
 * site it fails for a reason in the app, not in the dialog: App.tsx makes
 * the shell `inert` while the dialog is open and clears it in a passive
 * effect, and React runs the dialog's effect cleanup — where the opener is
 * refocused — before that effect runs, so `focus()` is called on a control
 * that is still inside an inert subtree and the browser ignores it. Focus
 * ends on the body, which is the state UX-01 was raised about. The fix is
 * the app's: clear `inert` in a layout effect (or refocus after the
 * commit), at which point this annotation must come off and the test
 * turns green — Playwright fails an expected-failure test that passes.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { BUILDER_EXPORT_TITLE, openBuilderWithDemo } from '../helpers/editors';

/** The same selector the dialog uses, so "first" and "last" mean what it means. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where focus is, described so a failure names the element. */
async function focused(page: Page): Promise<{ inDialog: boolean; tag: string; label: string; index: number; count: number }> {
  return page.evaluate((selector) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const active = document.activeElement as HTMLElement | null;
    const items = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hidden && el.style.display !== 'none' && el.getAttribute('aria-hidden') !== 'true')
      : [];
    return {
      inDialog: Boolean(dialog && active && dialog.contains(active)),
      tag: active?.tagName.toLowerCase() ?? 'none',
      label: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 40) ?? '',
      index: active ? items.indexOf(active) : -1,
      count: items.length,
    };
  }, FOCUSABLE);
}

/** Open the dialog from the keyboard, so the opener is a focused control. */
async function openFromKeyboard(page: Page): Promise<{ trigger: Locator; dialog: Locator }> {
  const trigger = page.getByTitle(BUILDER_EXPORT_TITLE);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Export Bundle' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  return { trigger, dialog };
}

test.describe('the Export dialog', () => {
  test('takes focus, traps Tab at both ends, and closes on Escape without moving the editor', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openBuilderWithDemo(page);
    const { dialog } = await openFromKeyboard(page);

    // Focus moved in, to the first control.
    await expect.poll(async () => (await focused(page)).inDialog, { message: 'focus moves into the dialog on open' }).toBe(true);
    let at = await focused(page);
    expect(at.count, 'the dialog has controls to move between').toBeGreaterThan(1);
    expect(at.index, 'the first control has focus').toBe(0);

    // Shift+Tab from the first wraps to the last.
    await page.keyboard.press('Shift+Tab');
    at = await focused(page);
    expect(at.inDialog, `Shift+Tab from the first control stays inside (now on ${at.tag} "${at.label}")`).toBe(true);
    expect(at.index).toBe(at.count - 1);

    // Tab from the last wraps to the first.
    await page.keyboard.press('Tab');
    at = await focused(page);
    expect(at.inDialog).toBe(true);
    expect(at.index).toBe(0);

    // A long run of Tabs — more than the dialog has controls — never leaves it.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      at = await focused(page);
      expect(at.inDialog, `Tab ${i + 1} left the dialog for ${at.tag} "${at.label}"`).toBe(true);
    }
    // And the page behind is inert to the pointer and the tab order alike.
    await expect(page.locator('[inert]').first()).toBeAttached();

    // Escape closes it; the page behind comes back; the editor has not moved.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[inert]')).toHaveCount(0);
    expect(page.url(), 'closing the dialog does not move the editor').toBe(editorUrl);

    await log.attach('builder');
    expect(log.uncaught).toEqual([]);
  });

  test('returns focus to the Export button when it closes', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await openBuilderWithDemo(page);

    // Focus is returned synchronously in the close effect, so a short wait
    // is enough to see it — and, while the app defect stands, keeps this
    // expected failure from costing the gate the full assertion timeout.
    const returned = { timeout: 2_000 };

    // Escape.
    const { trigger, dialog } = await openFromKeyboard(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused(returned);

    // The Close button.
    await openFromKeyboard(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused(returned);

    await log.attach('builder');
    expect(log.uncaught).toEqual([]);
  });
});
