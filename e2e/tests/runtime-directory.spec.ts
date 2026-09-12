/**
 * The runtime and the directory are one workspace: opening a published app
 * must preserve apps already running, and the library survives a reload.
 * Uses the deployment's seeded Blockfall and the shipped Fieldnotes bundle.
 */
import { expect, test, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/console';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const frame = page.locator('.softn-frame-bar');
  if (await frame.isVisible()) {
    expect(await frame.evaluate((element) => element.scrollWidth <= element.getBoundingClientRect().width + 1)).toBe(true);
  }
}

test('directory apps open alongside the current app and stay in the runtime library', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  const bundleRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/apps/blockfall/bundle.softn') bundleRequests.push(request.url());
  });

  try {
    await page.goto('/web/?open=%2Fexamples%2FFieldnotes.softn');
    await expect(page.getByRole('heading', { name: 'Make space for what matters.', exact: true })).toBeVisible({ timeout: 60_000 });
    const draft = `${testInfo.project.name} keeps this unfinished task`;
    await page.locator('#fn-title').fill(draft);
    await expectNoHorizontalOverflow(page);
    await page.locator('.softn-frame-home').click();

    await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop Fieldnotes', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Fieldnotes', exact: true })).toBeVisible();
    const explore = page.getByRole('region', { name: 'Explore apps', exact: true });
    await expect(explore.getByRole('link', { name: /Browse all apps/ })).toHaveAttribute('href', '/apps');
    await expect(explore.getByRole('link', { name: 'About Blockfall', exact: true })).toHaveAttribute('href', '/app/blockfall');

    const runBlockfall = explore.getByRole('button', { name: 'Run Blockfall', exact: true });
    await runBlockfall.click();
    // Blockfall uses the compiled renderer; .softn-app would find only the
    // hidden Fieldnotes tree and wait forever for the wrong app to be visible.
    const game = page.getByText('Seven shapes, one well, no mercy past level ten.', { exact: true });
    await expect(game).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.softn-frame-name-label')).toHaveText('Blockfall');
    await expectNoHorizontalOverflow(page);
    await page.locator('.softn-frame-home').click();

    await expect(page.locator('.softn-launcher-run')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Stop Fieldnotes', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop Blockfall', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Blockfall', exact: true })).toBeVisible();
    expect(bundleRequests).toHaveLength(1);

    await runBlockfall.click();
    await expect(game).toBeVisible();
    await page.locator('.softn-frame-home').click();
    await expect(page.locator('.softn-launcher-run')).toHaveCount(2);
    expect(bundleRequests).toHaveLength(1);

    // Returning to Fieldnotes preserves even unsaved input, proving the
    // directory action did not reload the page or silently restart its app.
    await page.locator('.softn-launcher-run-open').filter({ hasText: 'Fieldnotes' }).click();
    await expect(page.locator('#fn-title')).toHaveValue(draft);
    await page.locator('.softn-frame-home').click();
    await expectNoHorizontalOverflow(page);
    await testInfo.attach('runtime-two-apps', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });

    await page.reload();
    await expect(page.getByRole('button', { name: 'Open Fieldnotes', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Blockfall', exact: true })).toBeVisible();
    await expect(page.locator('.softn-launcher-card')).toHaveCount(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await testInfo.attach('runtime-saved-library', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('runtime-directory');
  }
});
