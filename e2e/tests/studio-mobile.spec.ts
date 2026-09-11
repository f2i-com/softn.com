/**
 * Studio on a phone: dashboard → project → the project-actions menu → Run.
 * STU-07 in the audit, and the 390 / 360 px widths of TEST_PLAN.md §1.
 *
 * What went wrong before: the mobile editor drew its own header and never
 * rendered the desktop TopBar, so on a phone there was no Run, no Publish
 * and no Export — a project could be previewed and could not leave the
 * device. The header now carries a menu (components/mobile/
 * MobileProjectMenu.tsx) with the same three actions from the same hook the
 * desktop bar uses, with menu semantics: the trigger says it opens a menu,
 * the items are menuitems, arrow keys move between them, Escape closes and
 * puts focus back on the trigger.
 *
 * The blueprint review gate that the mobile branch also renders is left
 * exactly where it is: an imported bundle has no blueprint, so it does not
 * appear in this journey, and nothing here bypasses it.
 *
 * Which assertion catches which regression:
 *   STU-07  the three actions are in the menu and reachable from the
 *           keyboard; Escape closes the menu and focus is on the trigger;
 *           Run stages the bundle, the ready link appears in the header's
 *           dock, and the editor's URL and page count are unchanged.
 *
 * This spec runs only in the mobile projects (see playwright.config.ts):
 * the desktop layout has no project-actions menu.
 */
import { expect, test } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { DEMO } from '../helpers/demo';
import { openMobileStudioWithDemo } from '../helpers/editors';

const HANDOFF_ID = /[A-Za-z0-9-]{16,64}/;

test('the phone editor reaches Run, Publish and Export through its menu, and Run stages without moving the editor', async ({ page, context }, testInfo) => {
  const log = watchConsole(page, testInfo);
  const viewport = page.viewportSize();
  expect(viewport, 'the mobile project sets a viewport').not.toBeNull();
  expect(viewport!.width, 'this spec is for the phone layout').toBeLessThan(768);

  // Through the dashboard: the import lands in the editor; Back to home
  // lists it; opening it from the list is the editor again.
  await openMobileStudioWithDemo(page);
  await page.getByRole('button', { name: 'Back to home' }).click();
  const openRow = page.getByRole('button', { name: `Open ${DEMO.name}`, exact: true });
  await expect(openRow).toBeVisible({ timeout: 30_000 });
  await openRow.click();
  const trigger = page.getByRole('button', { name: 'Project actions' });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/studio\/$/);
  const editorUrl = page.url();

  // The page fits the phone: nothing forces a horizontal scroll.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal overflow at this width').toBeLessThanOrEqual(0);

  // The menu, with its semantics.
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Project actions' });
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const run = menu.getByRole('menuitem', { name: 'Run', exact: true });
  const publish = menu.getByRole('menuitem', { name: 'Publish', exact: true });
  const exportItem = menu.getByRole('menuitem', { name: /Export bundle/ });
  await expect(run).toBeVisible();
  await expect(publish).toBeVisible();
  await expect(exportItem).toBeVisible();
  // Every item is inside the viewport: a menu wider than the phone is one
  // whose last action cannot be tapped.
  for (const item of [run, publish, exportItem]) {
    const box = await item.boundingBox();
    expect(box, 'the item has a box').not.toBeNull();
    expect(box!.x, 'the item starts on screen').toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, 'the item ends on screen').toBeLessThanOrEqual(viewport!.width + 0.5);
    expect(box!.height, 'a tap target of at least 44px').toBeGreaterThanOrEqual(44);
  }

  // Keyboard: focus went to the first item on open; arrows move; Escape
  // closes and returns focus to the trigger.
  await expect(run).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(publish).toBeFocused();
  await page.keyboard.press('End');
  await expect(exportItem).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(run).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // Run, from the menu. The validator passes the demo, so it is enabled.
  await trigger.click();
  await expect(run).toBeVisible();
  await expect(run).not.toHaveAttribute('aria-disabled', 'true');
  await run.click();
  await expect(menu).toHaveCount(0);

  const status = page.getByRole('status').filter({ hasText: 'is ready for the runtime' });
  await expect(status).toBeVisible({ timeout: 30_000 });
  await expect(status).toContainText(DEMO.name);
  const link = status.getByRole('link', { name: 'Open in a new tab' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
  const href = await link.getAttribute('href');
  expect(href).toMatch(new RegExp(`^/web/\\?open=handoff&handoff=${HANDOFF_ID.source}$`));
  // The dock fits the phone too.
  const linkBox = await link.boundingBox();
  expect(linkBox).not.toBeNull();
  expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(viewport!.width + 0.5);

  // And the editor stayed put: same address, one page, the header still there.
  expect(page.url()).toBe(editorUrl);
  expect(context.pages()).toHaveLength(1);
  await expect(trigger).toBeVisible();

  await log.attach('studio-mobile');
  expect(log.uncaught).toEqual([]);
});
