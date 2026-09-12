/**
 * Directory search → an app's page → back → forward, on the built site.
 * The "Directory search → app → back/forward" journey of the audit's
 * TEST_PLAN.md §3: the filters live in the address, so history has to
 * bring them back, with the search box and the heading agreeing with it.
 *
 * The directory is the disposable one the topology server seeded from the
 * example bundles beside the site, so "snake" finds the Snake example and
 * nothing this run published.
 */
import { expect, test } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { SEARCH_DEMO } from '../helpers/demo';

test('cross-page section links reach the section and source stays readable on a phone', async ({ page }) => {
  await page.goto('/apps');
  await page.locator('footer a[href="/#language"]').click();
  const language = page.locator('#language');
  await expect(language).toBeFocused();
  await expect.poll(() => language.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeLessThan(100);

  await page.goto(`/apps?q=${SEARCH_DEMO.query}`);
  await page.locator('a.app-card-name', { hasText: SEARCH_DEMO.cardName }).first().click();
  await page.getByRole('button', { name: 'View source', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Wrap lines', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.source-current strong')).not.toBeEmpty();
  await page.setViewportSize({ width: 360, height: 780 });
  const files = page.getByLabel('File to read', { exact: true });
  await expect(files).toBeVisible();
  const options = await files.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  const script = options.find((name) => name.endsWith('.logic')) ?? options[options.length - 1];
  await files.selectOption(script);
  await expect(page.locator('.source-current strong')).toHaveText(script);
  await expect(page.getByRole('region', { name: `Source of ${script}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('search filters survive back and forward', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await page.goto('/apps');
  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 30_000 });

  const search = page.getByPlaceholder('Search apps — games, tools, anything');
  await search.fill(SEARCH_DEMO.query);
  await search.press('Enter');

  await expect(page).toHaveURL(new RegExp(`[?&]q=${SEARCH_DEMO.query}(&|$)`));
  const matching = page.getByRole('heading', { name: new RegExp(`Matching .${SEARCH_DEMO.query}.`) });
  await expect(matching).toBeVisible({ timeout: 30_000 });
  const card = page.locator('a.app-card-name', { hasText: SEARCH_DEMO.cardName }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const cardName = (await card.textContent())?.trim() ?? '';
  const searchUrl = page.url();

  await card.click();
  await expect(page).toHaveURL(/\/app\/[^/?#]+$/);
  await expect(page.locator('h1.app-title')).toHaveText(cardName, { timeout: 30_000 });

  // Back: the same search, in the address, the box and the heading; not a stale or empty list.
  await page.goBack();
  await expect(page).toHaveURL(searchUrl);
  await expect(search).toHaveValue(SEARCH_DEMO.query);
  await expect(matching).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('a.app-card-name', { hasText: SEARCH_DEMO.cardName }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Nothing matches.')).toHaveCount(0);

  // Forward: the app again.
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/[^/?#]+$/);
  await expect(page.locator('h1.app-title')).toHaveText(cardName, { timeout: 30_000 });

  await log.attach('directory');
  expect(log.uncaught).toEqual([]);
});

test('search sort and removable filters survive reloads at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/apps?q=${SEARCH_DEMO.query}`);
  const sort = page.getByRole('combobox', { name: 'Sort apps' });
  await sort.selectOption('trending');
  await expect(page).toHaveURL(new RegExp(`q=${SEARCH_DEMO.query}&sort=trending$`));
  await expect(sort).toHaveValue('trending');
  await page.getByRole('combobox', { name: 'Filter apps by category' }).selectOption('games');
  const active = page.getByRole('group', { name: 'Active filters' });
  await expect(active.getByRole('link', { name: 'Remove Category: Games', exact: true })).toBeVisible();
  await page.reload();
  await expect(sort).toHaveValue('trending');
  await expect(page.locator('a.app-card-name', { hasText: SEARCH_DEMO.cardName })).toBeVisible();
  await active.getByRole('link', { name: `Remove Search: ${SEARCH_DEMO.query}`, exact: true }).click();
  await expect(page).toHaveURL(/\/apps\?category=games$/);
  await expect(sort).toHaveValue('trending');
  await expect(page.getByRole('searchbox', { name: 'Search apps' })).toHaveValue('');
  await active.getByRole('link', { name: 'Clear all', exact: true }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(active).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 740 });
  const search = page.getByRole('searchbox', { name: 'Search apps' });
  await search.fill('a-long-search-term-that-must-not-push-the-search-button-off-the-screen');
  await search.press('Enter');
  await expect(page.getByText('No app matches that yet.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const searchButton = await page.getByRole('button', { name: 'Search', exact: true }).boundingBox();
  expect(searchButton!.x + searchButton!.width).toBeLessThanOrEqual(320);
});
