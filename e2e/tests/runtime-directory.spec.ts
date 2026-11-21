/**
 * The runtime and the directory are one workspace: opening a published app
 * must preserve apps already running, and the library survives a reload.
 * Uses the deployment's seeded Urbanward and the shipped Fieldnotes bundle.
 */
import { expect, test, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { DEMO } from '../helpers/demo';

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
  const demoSlug = DEMO.name.toLowerCase();
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/apps/${demoSlug}/bundle.softn`) bundleRequests.push(request.url());
  });

  try {
    // The shelf shows the directory's six trending apps, and the seeded apps
    // tie on everything but the second each was seeded in, which the
    // machine's speed decides: Urbanward was on it in one run and not in the
    // next. A run of it puts it first, as one would on a live directory.
    const run = await page.request.post(`/api/apps/${demoSlug}/runs`, { data: { stage: 'open' } });
    expect(run.ok(), await run.text()).toBe(true);

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
    await expect(explore.getByRole('link', { name: `About ${DEMO.name}`, exact: true })).toHaveAttribute('href', `/app/${demoSlug}`);

    const runDemo = explore.getByRole('button', { name: `Run ${DEMO.name}`, exact: true });
    await runDemo.click();
    const game = page.getByText(DEMO.firstScreenText, { exact: true });
    await expect(game).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.softn-frame-name-label')).toHaveText(DEMO.name);
    await expectNoHorizontalOverflow(page);
    await page.locator('.softn-frame-home').click();

    await expect(page.locator('.softn-launcher-run')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Stop Fieldnotes', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Stop ${DEMO.name}`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Open ${DEMO.name}`, exact: true })).toBeVisible();
    expect(bundleRequests).toHaveLength(1);

    await runDemo.click();
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
    await expect(page.getByRole('button', { name: `Open ${DEMO.name}`, exact: true })).toBeVisible();
    await expect(page.locator('.softn-launcher-card')).toHaveCount(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await testInfo.attach('runtime-saved-library', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('runtime-directory');
  }
});
