/**
 * Builder → Export dialog → the publish page, and → the runtime, on the
 * built deployment. SHR-01, SHR-02 and QA-01 in the audit, Builder's half.
 *
 * Builder's Export dialog had the same `window.open(…, 'noopener')` +
 * falsy-return fallback as Studio's TopBar, and the same site-root publish
 * address. The dialog now stages the bundle and shows a ready link;
 * clicking it is what opens the receiver. Pinned here against the real
 * dialog, the real hand-off store and the real receiver pages.
 *
 * Which assertion catches which regression:
 *   SHR-02  the editor's URL is unchanged after staging and after the link
 *           is clicked; there are exactly two pages; the receiver has no
 *           opener.
 *   SHR-01  the link's href is `/publish?from=handoff&handoff=<id>` and the
 *           receiver shows the publish form holding the bundle.
 */
import { expect, test, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { DEMO } from '../helpers/demo';

const HANDOFF_ID = /[A-Za-z0-9-]{16,64}/;

/** Open the demo in Builder through `?open=` and wait for the Export dialog to know its name. */
async function openBuilderWithDemo(page: Page): Promise<string> {
  await page.goto(`/builder/?open=${DEMO.url}`);
  // Builder strips `open` once it has fetched the bundle.
  await expect(page).toHaveURL(/\/builder\/$/, { timeout: 60_000 });
  // The bundle is loaded when the toolbar carries its name.
  await expect(page.getByTitle(DEMO.name, { exact: true })).toBeVisible({ timeout: 60_000 });
  return page.url();
}

async function openExportDialog(page: Page) {
  await page.getByTitle('Export .softn bundle (Ctrl+Shift+E)').click();
  const dialog = page.locator('div', { has: page.getByText('Export Bundle', { exact: true }) }).last();
  await expect(page.getByText('Export Bundle', { exact: true })).toBeVisible();
  // The preflight inspection has to finish before the hand-off buttons are enabled.
  const publish = page.getByRole('button', { name: 'Publish…' });
  await expect(publish).toBeEnabled({ timeout: 30_000 });
  return { dialog, publish };
}

test.describe('Builder hands a bundle to the publish page and to the runtime', () => {
  test('Publish… stages the bundle, keeps Builder open, and the link opens /publish with the bundle loaded', async ({ page, context }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openBuilderWithDemo(page);
    const { publish } = await openExportDialog(page);

    await publish.click();
    const status = page.getByRole('status').filter({ hasText: 'is ready for the publish page' });
    await expect(status).toBeVisible({ timeout: 30_000 });
    await expect(status).toContainText('Builder stays open');
    expect(page.url()).toBe(editorUrl);
    expect(context.pages()).toHaveLength(1);

    const link = status.getByRole('link', { name: /Open the publish page/ });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/publish\\?from=handoff&handoff=${HANDOFF_ID.source}$`));
    await expect(status.getByRole('link', { name: 'Open here instead' })).toHaveAttribute('href', href!);

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    const popupLog = watchConsole(popup, testInfo);
    await popup.waitForLoadState('domcontentloaded');
    expect(await popup.evaluate(() => window.opener === null), 'rel=noopener: the receiver must not hold the editor').toBe(true);
    await expect(popup).toHaveURL(/\/publish(\?|$)/);
    const dropzone = popup.locator('.dropzone-file');
    await expect(dropzone).toBeVisible({ timeout: 30_000 });
    await expect(dropzone).toContainText(`${DEMO.name}.softn`);
    await expect(dropzone).toContainText(`${DEMO.name} v${DEMO.version}`);
    await expect(popup.getByRole('alert')).toHaveCount(0);

    // Builder is still on its own page, editing.
    expect(context.pages()).toHaveLength(2);
    expect(page.url()).toBe(editorUrl);
    await expect(page.getByTitle(DEMO.name, { exact: true })).toBeVisible();

    await log.attach('builder');
    await popupLog.attach('publish');
    expect(log.uncaught).toEqual([]);
    expect(popupLog.uncaught).toEqual([]);
  });

  test('Open in runtime… stages the bundle and the link opens the runtime with the app rendered', async ({ page, context }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openBuilderWithDemo(page);
    await openExportDialog(page);

    await page.getByRole('button', { name: 'Open in runtime…' }).click();
    const status = page.getByRole('status').filter({ hasText: 'is ready for the runtime' });
    await expect(status).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(editorUrl);

    const link = status.getByRole('link', { name: /Open in the runtime/ });
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/web/\\?open=handoff&handoff=${HANDOFF_ID.source}$`));

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    const popupLog = watchConsole(popup, testInfo);
    await popup.waitForLoadState('domcontentloaded');
    expect(await popup.evaluate(() => window.opener === null), 'rel=noopener: the receiver must not hold the editor').toBe(true);
    await expect(popup).toHaveURL(/\/web\//);
    await expect(popup.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(popup.getByText('Nothing was handed')).toHaveCount(0);

    expect(context.pages()).toHaveLength(2);
    expect(page.url()).toBe(editorUrl);

    await log.attach('builder');
    await popupLog.attach('runtime');
    expect(log.uncaught).toEqual([]);
    expect(popupLog.uncaught).toEqual([]);
  });
});
