/**
 * Publish through the site, keep the edit key, and survive a failed lookup.
 * SITE-01 (P0) and QA-01 in the audit.
 *
 * What went wrong before: the publish page's "Your apps" list converted
 * every failed `getApp` into "not found" and forgot the key of every slug
 * the lookups did not return. A 500, a rate limit or a dropped connection
 * while the page loaded deleted the only proof of ownership — silently,
 * during a read-only listing refresh.
 *
 * This publishes a real bundle to the disposable local directory (the
 * topology server's API, whose state is thrown away with the run), reads
 * the key the page shows, and then makes the app's lookup fail from the
 * browser's side with a request interception — the API itself is fine,
 * which is exactly the case in which a key must not be touched.
 *
 * Which assertion catches which regression:
 *   SITE-01  `keysAfterFailure` is byte-for-byte `keysBefore`, and the row
 *            says "could not be checked" with a "Try again" action instead
 *            of disappearing.
 */
import { expect, test } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { DEMO, SITE_KEYS_STORAGE, demoFileExists } from '../helpers/demo';

test.describe('publishing keeps its key through a failed lookup', () => {
  test.skip(!demoFileExists(), `${DEMO.file} is missing; run npm run fetch:demos`);

  test('publish → key shown → Your apps lists it → lookup fails → key kept, row says so, retry offered', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await page.goto('/publish');
    await expect(page.getByRole('heading', { name: 'Put an app in the directory' })).toBeVisible({ timeout: 30_000 });

    // The bundle, through the form's own file input.
    await page.locator('input[type="file"][accept*=".softn"]').setInputFiles(DEMO.file);
    const dropzone = page.locator('.dropzone-file');
    await expect(dropzone).toContainText(`${DEMO.name} v${DEMO.version}`, { timeout: 30_000 });

    // A name of this run's own, so the slug is not the seeded example's.
    const appName = `E2E ${DEMO.name} ${Date.now().toString(36)}`;
    const nameField = page.getByPlaceholder('What it is called');
    await expect(nameField).toHaveValue(DEMO.name);
    await nameField.fill(appName);
    const category = page.locator('form.publish-form select').first();
    await expect(category).toBeVisible();
    const firstReal = await category.locator('option').evaluateAll((options) => (options as HTMLOptionElement[]).map((o) => o.value).find((v) => v !== ''));
    expect(firstReal, 'the directory has categories to choose from').toBeTruthy();
    await category.selectOption(firstReal!);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();

    // Published: the key is shown once and kept in this browser.
    await expect(page.getByRole('heading', { name: `${appName} is live.` })).toBeVisible({ timeout: 60_000 });
    const key = (await page.locator('.keybox-key').textContent())?.trim() ?? '';
    expect(key.length, 'an edit key is shown').toBeGreaterThan(16);
    const pageHref = await page.getByRole('link', { name: 'Open its page' }).getAttribute('href');
    const slug = pageHref?.match(/^\/app\/([^/?#]+)/)?.[1];
    expect(slug, `the app's page link names its slug (${pageHref})`).toBeTruthy();

    const keysBefore = await page.evaluate((storage) => localStorage.getItem(storage), SITE_KEYS_STORAGE);
    expect(keysBefore, 'the key is kept in localStorage').not.toBeNull();
    expect(JSON.parse(keysBefore!)[slug!]).toBe(key);

    // A reload lists it under Your apps, from the same key store.
    await page.goto('/publish');
    const yours = page.locator('section.yours');
    await expect(yours).toBeVisible({ timeout: 30_000 });
    await expect(yours.getByRole('link', { name: appName, exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(yours.getByText('could not be checked')).toHaveCount(0);

    // Now the lookup fails — from the browser's side, so the server's state is not in question.
    await page.route(`**/api/apps/${slug}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'injected by the e2e gate' }) }));
    await page.goto('/publish');
    await expect(yours).toBeVisible({ timeout: 30_000 });
    const failure = yours.getByRole('status').filter({ hasText: 'could not be checked' });
    await expect(failure).toBeVisible({ timeout: 30_000 });
    await expect(failure).toContainText('The keys are kept');
    await expect(failure.getByRole('button', { name: 'Try again' })).toBeVisible();
    const row = yours.locator('li.yours-item.is-unavailable');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(slug!);
    await expect(row).toContainText('Could not be checked');
    // No forget action is offered for an app that merely could not be reached.
    await expect(row.getByRole('button', { name: 'Forget this key' })).toHaveCount(0);

    // SITE-01: the key store is untouched, byte for byte.
    const keysAfterFailure = await page.evaluate((storage) => localStorage.getItem(storage), SITE_KEYS_STORAGE);
    expect(keysAfterFailure).toBe(keysBefore);

    // And once the lookup works again, Try again brings the row back without a reload.
    await page.unroute(`**/api/apps/${slug}`);
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(yours.getByRole('link', { name: appName, exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(yours.getByText('could not be checked')).toHaveCount(0);
    expect(await page.evaluate((storage) => localStorage.getItem(storage), SITE_KEYS_STORAGE)).toBe(keysBefore);

    await log.attach('publish');
    expect(log.uncaught).toEqual([]);
  });
});
