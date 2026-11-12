/**
 * The guides at /docs/ and the product bar that links to them.
 *
 * /docs/ is static pages generated from docs/content/softn-docs.json, served
 * beside the apps (by the host in a deployment, by scripts/dev/dev-docs.mjs under
 * `npm run dev`). A guide that exists answers 200 with its article; one that
 * does not answers a real 404, so a stale link is seen as one by a crawler
 * and a person alike, rather than the site's front page with a 200.
 *
 * The bar is the same element on every surface, with the same six products on
 * the site as in the runtime, Studio and Builder, and it is the only bar a page
 * has: the front page's own places (all the apps, making one, how it works)
 * are the hero's actions, not a second row of links under the bar.
 * At a phone's 390 px every link must be on screen at once — the bar may
 * scroll sideways as a fallback, but at this width nothing should be hidden off
 * its edge, and the page itself must not scroll sideways.
 */
import { expect, test } from '@playwright/test';
import { watchConsole } from '../helpers/console';

const PRODUCTS = [
  { label: 'Apps', href: '/apps' },
  { label: 'Runtime', href: '/web/' },
  { label: 'Studio', href: '/studio/' },
  { label: 'Builder', href: '/builder/' },
  { label: 'Publish', href: '/publish' },
  { label: 'Docs', href: '/docs/' },
] as const;

/** The front page's own places: the hero's two buttons and the link beside them. */
const LANDING = [
  { label: /^Explore all apps/, href: '/apps' },
  { label: /^Create an app/, href: '#create' },
  { label: /^How it works$/, href: '#how' },
] as const;

test('/docs/ serves a guide, and a guide that does not exist is a 404', async ({ page }) => {
  const index = await page.goto('/docs/');
  expect(index?.status()).toBe(200);
  const guide = page.locator('a[href="/docs/getting-started/"]').first();
  await expect(guide).toBeVisible();

  const response = await page.goto('/docs/getting-started/');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toMatch(/text\/html/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('a[href="/docs/"]').first()).toBeAttached();

  const missing = await page.request.get('/docs/no-such-guide-e2e/');
  expect(missing.status()).toBe(404);
});

test.describe('at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [where, path, expected] of [['the site', '/', PRODUCTS], ['the runtime', '/web/', PRODUCTS]] as const) {
  test(`on ${where}, the product bar shows every destination without scrolling`, async ({
    page,
  }, testInfo) => {
    const log = watchConsole(page, testInfo);
    try {
      await page.goto(path);
      const bar = page.getByRole('navigation', { name: 'SoftN', exact: true }).first();
      await expect(bar).toBeVisible({ timeout: 30_000 });
      const links = bar.locator('.softn-bar-links a');
      await expect(links).toHaveCount(expected.length);
      for (const [i, product] of expected.entries()) {
        const link = links.nth(i);
        await expect(link).toHaveText(product.label);
        await expect(link).toHaveAttribute('href', product.href);
        await expect(link).toBeInViewport({ ratio: 1 });
      }
      const strip = bar.locator('.softn-bar-links');
      expect(
        await strip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        'the link strip does not scroll'
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        'the page does not scroll sideways'
      ).toBe(true);
      expect(log.uncaught).toEqual([]);
    } finally {
      await log.attach(`product-bar-390-${where.replace(/ /g, '-')}`);
    }
  });
  }

  test('on the front page, one bar, and the hero\'s own actions and the first app\'s Play are in the first screen', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    try {
      await page.goto('/');
      const bar = page.getByRole('navigation', { name: 'SoftN', exact: true });
      await expect(bar.first()).toBeVisible({ timeout: 30_000 });
      await expect(bar).toHaveCount(1);
      // The second row of links the front page had under the bar is gone, here and everywhere.
      await expect(page.getByRole('navigation', { name: 'On this page', exact: true })).toHaveCount(0);
      const hero = page.locator('#top');
      for (const place of LANDING) {
        const link = hero.getByRole('link', { name: place.label });
        await expect(link).toHaveAttribute('href', place.href);
        await expect(link).toBeInViewport({ ratio: 1 });
      }
      // A way to try an app without scrolling: the shelf's lead, and its Play, whole.
      await expect(hero.getByRole('link', { name: /^Play / }).first()).toBeInViewport({ ratio: 1, timeout: 30_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.goto('/apps');
      await expect(page.getByRole('navigation', { name: 'SoftN', exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('navigation', { name: 'On this page', exact: true })).toHaveCount(0);
      expect(log.uncaught).toEqual([]);
    } finally {
      await log.attach('landing-first-screen-390');
    }
  });
});