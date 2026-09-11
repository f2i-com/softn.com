/**
 * Studio's desktop editor at 200 % zoom. STU-07 and TEST_PLAN.md §1.
 *
 * The audit's STU-07 note was that 200 % zoom had not been verified in a
 * browser: the top bar's Run / Publish / Export bundle and the chat
 * composer beneath it are laid out with fixed heights and could, once
 * everything is twice the size, end up under one another or off the right
 * edge. The zoom-200 project emulates the zoom the way a browser does it
 * (the CSS viewport halves, the device pixel ratio doubles), and this spec
 * asserts the geometry: every primary action is inside the viewport, and
 * none of their boxes intersects the composer's.
 *
 * Which assertion catches which regression:
 *   STU-07  a primary action clipped by the viewport, or overlapped by the
 *           chat composer, at 960×540 CSS px with DPR 2.
 *
 * This spec runs only in the zoom-200 project (see playwright.config.ts).
 */
import { expect, test, type Locator } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { openStudioWithDemo } from '../helpers/editors';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  await expect(locator, `${what} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

test('the primary actions stay on screen and clear of the chat composer at 200 % zoom', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  expect(dpr, 'the zoom-200 project doubles the device pixel ratio').toBe(2);

  await openStudioWithDemo(page);

  // The chat panel is closed after an import; open it from the rail, so the
  // composer is on screen beside the actions it must not cover. If it is
  // already open the click would close it, so check first.
  const composer = page.locator('textarea').first();
  if (!(await composer.isVisible())) await page.getByTitle('AI', { exact: true }).click();
  await expect(composer).toBeVisible();

  const actions: Array<[string, Locator]> = [
    ['Run', page.getByRole('button', { name: 'Run', exact: true })],
    ['Publish', page.getByRole('button', { name: 'Publish', exact: true })],
    ['Export bundle', page.getByRole('button', { name: 'Export bundle', exact: true })],
  ];
  const composerBox = await boxOf(composer, 'the chat composer');

  for (const [name, locator] of actions) {
    const box = await boxOf(locator, name);
    expect(box.x, `${name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.y, `${name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} ends inside the viewport (x)`).toBeLessThanOrEqual(viewport!.width + 0.5);
    expect(box.y + box.height, `${name} ends inside the viewport (y)`).toBeLessThanOrEqual(viewport!.height + 0.5);
    expect(intersects(box, composerBox), `${name} is not overlapped by the chat composer`).toBe(false);
    // And it is the element that receives a click at its centre — nothing
    // is painted over it.
    const onTop = await page.evaluate(
      ({ x, y, label }) => {
        const el = document.elementFromPoint(x, y);
        const button = el?.closest('button');
        return Boolean(button && button.textContent?.trim() === label);
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2, label: name }
    );
    expect(onTop, `${name} is the element at its own centre`).toBe(true);
  }

  // The composer itself is usable: on screen and not clipped at the bottom.
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(viewport!.height + 0.5);

  await log.attach('studio-zoom');
  expect(log.uncaught).toEqual([]);
});
