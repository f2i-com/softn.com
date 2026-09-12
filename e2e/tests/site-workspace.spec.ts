/**
 * The landing page teaches with the same Fieldnotes bundle visitors can run
 * and download. These checks use the built, same-origin deployment and real
 * browser storage; no AI provider, mocked application records, or API keys.
 */
import { expect, test, type Locator } from '@playwright/test';
import { watchConsole } from '../helpers/console';

const BUNDLE_PATH = '/examples/Fieldnotes.softn';

async function expectLoadedImage(image: Locator): Promise<void> {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node) => {
    const img = node as HTMLImageElement;
    return img.complete && img.naturalWidth > 0;
  }), { message: 'The real workspace screenshot must load' }).toBe(true);
}

test.describe('landing workspace and the Fieldnotes teaching app', () => {
  test('workspace screenshots support keyboard navigation and show the current example', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Your idea\.\s*A working app\.\s*Yours to change\./);

      const preview = page.getByRole('tab', { name: 'App preview', exact: true });
      const data = page.getByRole('tab', { name: 'Data collections', exact: true });
      await expect(preview).toHaveAttribute('aria-selected', 'true');
      await expect(data).toHaveAttribute('tabindex', '-1');
      const previewPanel = page.getByRole('tabpanel', { name: 'App preview', exact: true });
      await expectLoadedImage(previewPanel.getByRole('img'));
      await expect(previewPanel.getByRole('img')).toHaveAttribute('alt', /Fieldnotes/i);
      const previewSource = await previewPanel.getByRole('img').getAttribute('src');

      await preview.focus();
      await preview.press('ArrowRight');
      await expect(data).toBeFocused();
      await expect(data).toHaveAttribute('aria-selected', 'true');
      await expect(preview).toHaveAttribute('tabindex', '-1');
      const dataPanel = page.getByRole('tabpanel', { name: 'Data collections', exact: true });
      await expectLoadedImage(dataPanel.getByRole('img'));
      await expect(dataPanel.getByRole('img')).toHaveAttribute('alt', /Fieldnotes/i);
      const dataSource = await dataPanel.getByRole('img').getAttribute('src');
      expect(dataSource, 'Changing the tab must change the actual screenshot').not.toBe(previewSource);
      await expect(dataPanel.getByRole('link', { name: 'View full-size screenshot: Data collections' })).toHaveAttribute('href', dataSource!);

      await data.press('Home');
      await expect(preview).toBeFocused();
      await expect(preview).toHaveAttribute('aria-selected', 'true');
      await preview.press('End');
      await expect(data).toBeFocused();
      await data.press('ArrowRight');
      await expect(preview).toBeFocused();
      await expectLoadedImage(previewPanel.getByRole('img'));
      await expect(page.locator('.workspace-preview')).not.toContainText(/Glamour/i);
      await expect(page.locator('.workspace-preview img[alt*="Glamour" i]')).toHaveCount(0);
      await testInfo.attach('landing-workspace', { body: await page.screenshot(), contentType: 'image/png' });
      expect(log.uncaught).toEqual([]);
    } finally {
      await log.attach('landing-workspace');
    }
  });

  test('the walkthrough links run, edit, and download the same shipped bundle', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    try {
      await page.goto('/#try-it');
      const example = page.locator('#try-it');
      await expect(example.getByRole('heading', { name: 'One small app. The whole workflow.' })).toBeVisible();
      const tryLink = example.getByRole('link', { name: /Try Fieldnotes/ });
      const builderLink = example.getByRole('link', { name: /Open example in Builder/ });
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
      await page.locator('#try-it').getByRole('link', { name: /Try Fieldnotes/ }).click();
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
