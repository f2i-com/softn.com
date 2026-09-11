/**
 * Studio → Run → the runtime, and Studio → Publish → the publish page, on
 * the built deployment. SHR-01, SHR-02 and QA-01 in the audit.
 *
 * What went wrong before: Studio opened the receiver with
 * `window.open(url, '_blank', 'noopener')`, read the null that a noopener
 * open returns on success as "popup blocked", and navigated the editor to
 * the same address — two receiver pages and no Studio. And the publish
 * hand-off was addressed to the site's root, which the site's router shows
 * as the home page, so the bundle never reached the publish form.
 *
 * The isolated check the audit shipped (check_browser_handoff.py) proved
 * the browser premise on about:blank pages. This is the application half:
 * the real Run and Publish buttons, the real staged hand-off in IndexedDB,
 * the real receiver pages served by the real router at their deployed paths.
 *
 * Which assertion catches which regression:
 *   SHR-02  `editorUrlAfterStaging` / `mainFrameNavigations` — the editor
 *           is not navigated by staging or by opening the receiver, and
 *           exactly two pages exist afterwards; the receiver's `window.opener` is null.
 *   SHR-01  the ready link's href is `/publish?from=handoff&handoff=<id>`
 *           and the opened page lands on /publish with the bundle's file
 *           name in the form, not on the home page.
 */
import { expect, test, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { DEMO } from '../helpers/demo';

/** A hand-off id as the protocol mints them (a UUID or 32 hex chars). */
const HANDOFF_ID = /[A-Za-z0-9-]{16,64}/;

/**
 * Open the demo in Studio through `?open=` and wait until the editor is
 * up with Run enabled. Studio strips `open` from the address once it has
 * acted on it, so the settled URL is the bare editor URL — recorded here as
 * the baseline every navigation check compares against.
 */
async function openStudioWithDemo(page: Page): Promise<string> {
  await page.goto(`/studio/?open=${DEMO.url}`);
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeVisible({ timeout: 60_000 });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/studio\/$/);
  return page.url();
}

/** Count top-level navigations of the editor from this moment on, same-document ones included. */
function countMainFrameNavigations(page: Page): () => string[] {
  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url());
  });
  return () => seen;
}

test.describe('Studio hands a bundle to the runtime and to the publish page', () => {
  test('Run stages the bundle, leaves the editor where it is, and the ready link opens the runtime with the app', async ({ page, context }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openStudioWithDemo(page);
    const navigations = countMainFrameNavigations(page);

    await page.getByRole('button', { name: 'Run', exact: true }).click();

    // Staging is announced, not navigated to.
    const status = page.getByRole('status').filter({ hasText: 'is ready for the runtime' });
    await expect(status).toBeVisible({ timeout: 30_000 });
    await expect(status).toContainText(DEMO.name);
    const editorUrlAfterStaging = page.url();
    expect(editorUrlAfterStaging, 'staging must not move the editor').toBe(editorUrl);
    expect(navigations(), 'staging must not navigate the editor, not even same-document').toEqual([]);
    expect(context.pages(), 'staging must not open a tab of its own').toHaveLength(1);

    // The way out is a link the person clicks: new tab, no opener, addressed to the runtime.
    const link = status.getByRole('link', { name: 'Open in a new tab' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/web/\\?open=handoff&handoff=${HANDOFF_ID.source}$`));
    await expect(status.getByRole('link', { name: 'Open here' })).toHaveAttribute('href', href!);

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    const popupLog = watchConsole(popup, testInfo);

    // The receiver is the runtime, it has no handle on the editor, and the app is on screen.
    await popup.waitForLoadState('domcontentloaded');
    expect(await popup.evaluate(() => window.opener === null), 'rel=noopener: the receiver must not hold the editor').toBe(true);
    await expect(popup).toHaveURL(/\/web\//);
    await expect(popup.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(popup).toHaveTitle(DEMO.name);
    await expect(popup.getByText('Nothing was handed')).toHaveCount(0);

    // And the editor is still the editor.
    expect(context.pages()).toHaveLength(2);
    expect(page.url()).toBe(editorUrl);
    expect(navigations()).toEqual([]);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();

    await log.attach('studio');
    await popupLog.attach('runtime');
    expect(log.uncaught, 'no uncaught exception in Studio').toEqual([]);
    expect(popupLog.uncaught, 'no uncaught exception in the runtime').toEqual([]);
  });

  test('Publish stages the bundle and the ready link lands on /publish with the bundle in the form', async ({ page, context }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openStudioWithDemo(page);
    const navigations = countMainFrameNavigations(page);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();

    const status = page.getByRole('status').filter({ hasText: 'is ready for the publish page' });
    await expect(status).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(editorUrl);
    expect(navigations()).toEqual([]);

    // SHR-01: the publish route, not the site root.
    const link = status.getByRole('link', { name: 'Open in a new tab' });
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/publish\\?from=handoff&handoff=${HANDOFF_ID.source}$`));
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    const popupLog = watchConsole(popup, testInfo);
    await popup.waitForLoadState('domcontentloaded');
    expect(await popup.evaluate(() => window.opener === null), 'rel=noopener: the receiver must not hold the editor').toBe(true);
    await expect(popup).toHaveURL(/\/publish(\?|$)/);

    // The form has the bundle: its file name and what the inspection read from it.
    await expect(popup.getByRole('heading', { name: 'Put an app in the directory' })).toBeVisible({ timeout: 30_000 });
    const dropzone = popup.locator('.dropzone-file');
    await expect(dropzone).toBeVisible({ timeout: 30_000 });
    await expect(dropzone).toContainText(`${DEMO.name}.softn`);
    await expect(dropzone).toContainText(`${DEMO.name} v${DEMO.version}`);
    await expect(popup.getByText('Nothing was handed')).toHaveCount(0);
    await expect(popup.getByRole('alert')).toHaveCount(0);

    // The editor is untouched.
    expect(context.pages()).toHaveLength(2);
    expect(page.url()).toBe(editorUrl);
    expect(navigations()).toEqual([]);

    await log.attach('studio');
    await popupLog.attach('publish');
    expect(log.uncaught).toEqual([]);
    expect(popupLog.uncaught).toEqual([]);
  });

  test('a hand-off id that was never staged is reported by the publish page, with the ordinary form still there', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await page.goto('/publish?from=handoff&handoff=00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('alert')).toContainText('Nothing was handed', { timeout: 30_000 });
    await expect(page.getByText('Drop .softn files here')).toBeVisible();
    // One-shot: the address no longer carries the claim.
    await expect(page).toHaveURL(/\/publish$/);
    await log.attach('publish');
    expect(log.uncaught).toEqual([]);
  });
});
