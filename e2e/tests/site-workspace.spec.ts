/**
 * The landing page leads with the apps, and teaches with the same Fieldnotes
 * bundle visitors can run and download. These checks use the built,
 * same-origin deployment and real browser storage; no AI provider, mocked
 * application records, or API keys.
 */
import { expect, test } from '@playwright/test';
import { watchConsole } from '../helpers/console';

const BUNDLE_PATH = '/examples/Fieldnotes.softn';

test.describe('landing workspace and the Fieldnotes teaching app', () => {
  test('the hero is the apps, under the two things a visitor came to do, and the steps start with playing one', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apps you can play, open and make your own.');
      const hero = page.locator('#top');
      await expect(hero.getByRole('link', { name: /^Explore all apps/ })).toHaveAttribute('href', '/apps');
      await expect(hero.getByRole('link', { name: /^Create an app/ })).toHaveAttribute('href', '#create');
      // The directory's featured shelf is the hero's picture: the deployment seeds it from the shipped examples.
      const cards = hero.locator('.featured-card');
      await expect(cards.first()).toBeVisible({ timeout: 30_000 });
      expect(await cards.count()).toBeGreaterThanOrEqual(3);
      // Nothing runs on the front page: no app is embedded in it.
      await expect(page.locator('iframe')).toHaveCount(0);

      // The page's own places, under the product bar, and each one lands.
      const sub = page.getByRole('navigation', { name: 'On this page', exact: true });
      await expect(sub.getByRole('link')).toHaveText(['Explore apps', 'Create', 'How it works']);
      await sub.getByRole('link', { name: 'How it works', exact: true }).click();
      const how = page.locator('#how');
      await expect(how).toBeInViewport();
      const steps = how.locator('.how-step');
      await expect(steps).toHaveCount(4);
      await expect(steps.locator('.how-name')).toHaveText(['Play an app', 'Open it up', 'Change it', 'Publish it']);
      await expect(steps.first().getByRole('link', { name: 'the directory', exact: true })).toHaveAttribute('href', '/apps');
      await expect(how.locator('img')).toHaveCount(0);

      // Four points, two by two, and nothing left over.
      const why = page.locator('#why .why');
      await expect(why).toHaveCount(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await testInfo.attach('landing-apps-hero', { body: await page.screenshot(), contentType: 'image/png' });
      expect(log.uncaught).toEqual([]);
    } finally {
      await log.attach('landing-apps-hero');
    }
  });

  test('the live sample stays separate from saved Fieldnotes tasks', async ({ page }) => {
    await page.goto(`/web/?open=${encodeURIComponent(BUNDLE_PATH)}`);
    await expect(page.locator('#fn-title')).toBeVisible({ timeout: 60_000 });
    await page.locator('#fn-title').fill('My saved runtime task');
    await page.getByRole('button', { name: /Add task/ }).click();
    await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('6');
    await page.goto('/web/?preview=fieldnotes');
    await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('5', { timeout: 60_000 });
    await expect(page.getByText('My saved runtime task', { exact: true })).toHaveCount(0);
    await page.locator('#fn-title').fill('Disposable preview task');
    await page.getByRole('button', { name: /Add task/ }).click();
    await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('6');
    await page.reload();
    await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('5', { timeout: 60_000 });
    await page.goto(`/web/?open=${encodeURIComponent(BUNDLE_PATH)}`);
    await expect(page.getByText('My saved runtime task', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Disposable preview task', { exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('6');
  });

  test('the walkthrough links run, edit, and download the same shipped bundle', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    try {
      await page.goto('/#try-it');
      const example = page.locator('#try-it');
      await expect(example.getByRole('heading', { name: 'Start with a working example' })).toBeVisible();
      const tryLink = example.getByRole('link', { name: /Try it first/ });
      const builderLink = example.getByRole('link', { name: /Open the example/ });
      const downloadLink = example.getByRole('link', { name: 'Download the .softn app', exact: true });

      const runtime = new URL((await tryLink.getAttribute('href'))!, page.url());
      expect(runtime.origin).toBe(new URL(page.url()).origin);
      expect(runtime.pathname).toBe('/web/');
      expect(runtime.searchParams.get('open')).toBe(BUNDLE_PATH);
      expect(runtime.searchParams.get('back')).toBe('/#try-it');
      const builder = new URL((await builderLink.getAttribute('href'))!, page.url());
      expect(builder.origin).toBe(runtime.origin);
      expect(builder.pathname).toBe('/builder/');
      expect(builder.searchParams.get('open')).toBe(BUNDLE_PATH);
      expect(builder.searchParams.get('view'), 'the example opens on its running preview').toBe('preview');
      await expect(downloadLink).toHaveAttribute('href', BUNDLE_PATH);
      await expect(downloadLink).toHaveAttribute('download', 'Fieldnotes.softn');

      // Exercise the browser's download, not just a link whose target might 404.
      const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
      expect(download.suggestedFilename()).toBe('Fieldnotes.softn');
      expect(await download.failure()).toBeNull();
      await expect(page).toHaveURL(/\/#try-it$/);
      expect(log.uncaught).toEqual([]);
    } finally {
      await log.attach('fieldnotes-links');
    }
  });

  test('Try Fieldnotes creates a task, updates its dashboard, and keeps completion after reload', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    try {
      await page.goto('/#try-it');
      await page.locator('#try-it').getByRole('link', { name: /Try it first/ }).click();
      await expect(page).toHaveURL(/\/web\//);
      await expect(page.getByRole('heading', { name: 'Make space for what matters.', exact: true })).toBeVisible({ timeout: 60_000 });
      const total = page.locator('[aria-label="Total tasks"]');
      const active = page.locator('[aria-label="Active tasks"]');
      const done = page.locator('[aria-label="Completed tasks"]');
      await expect(total).toHaveText(/^\d+$/);
      await expect(active).toHaveText(/^\d+$/);
      await expect(done).toHaveText(/^\d+$/);
      const before = {
        total: Number(await total.textContent()),
        active: Number(await active.textContent()),
        done: Number(await done.textContent()),
      };
      const title = `${testInfo.project.name} fieldnotes persistence check`;
      await page.locator('#fn-title').fill(title);
      await page.locator('#fn-lane').selectOption('Build');
      await page.getByRole('button', { name: /Add task/ }).click();

      const complete = page.getByRole('button', { name: `Complete ${title}`, exact: true });
      const reopen = page.getByRole('button', { name: `Reopen ${title}`, exact: true });
      await expect(complete).toBeVisible();
      await expect(page.locator('.fn-task').filter({ hasText: title })).toHaveCount(1);
      await expect(page.locator('#fn-title')).toHaveValue('');
      await expect(total).toHaveText(String(before.total + 1));
      await expect(active).toHaveText(String(before.active + 1));
      await expect(done).toHaveText(String(before.done));

      await complete.click();
      await expect(reopen).toBeVisible();
      await expect(active).toHaveText(String(before.active));
      await expect(done).toHaveText(String(before.done + 1));
      const filters = page.getByRole('group', { name: 'Filter tasks', exact: true });
      await filters.getByRole('button', { name: 'Active', exact: true }).click();
      await expect(reopen).toHaveCount(0);
      await filters.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(reopen).toBeVisible();

      // A fresh runtime must restore the stored record, not reseed away changes.
      await page.reload();
      await expect(reopen).toBeVisible({ timeout: 60_000 });
      await expect(complete).toHaveCount(0);
      await expect(page.locator('.fn-task').filter({ hasText: title })).toHaveCount(1);
      await expect(total).toHaveText(String(before.total + 1));
      await expect(done).toHaveText(String(before.done + 1));
      await expect(page.getByRole('alert')).toHaveCount(0);
      await testInfo.attach('fieldnotes-persisted-task', { body: await page.screenshot(), contentType: 'image/png' });
      expect(log.uncaught).toEqual([]);
    } finally {
      await log.attach('fieldnotes-runtime');
    }
  });
});
