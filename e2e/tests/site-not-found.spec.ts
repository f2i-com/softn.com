/**
 * The site's two new failure states, on the built deployment. SITE-04 and
 * UX-01 in the audit.
 *
 * What went wrong before: every path reached the site's bundle (the host
 * answers index.html for anything that is not a file), and the router showed
 * the home page for the ones it did not recognise, so a stale or mistyped
 * link looked like the front door with nothing said. And the directory's
 * listing had one look for "not loaded yet", "nothing matches" and "the
 * request failed", and a failed request blanked whatever was on screen.
 *
 * Which assertion catches which regression:
 *   SITE-04  an unknown path shows the not-found page — its heading names
 *            the path, and the three ways out are real links — rather than
 *            the home page; a failed listing keeps the previous cards on
 *            screen, says so, and offers Retry, which recovers without a
 *            reload.
 *
 * The failure is injected from the browser's side (a 500 for the listing
 * request only), so the server's state is not in question and the app
 * detail route is untouched.
 */
import { expect, test, type Route } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { SEARCH_DEMO } from '../helpers/demo';

/** The listing request and nothing else: /api/apps with a query, not /api/apps/<slug>. */
function isListingRequest(url: URL): boolean {
  return /\/api\/apps$/.test(url.pathname) && url.searchParams.has('perPage');
}

test.describe('the site says what happened', () => {
  test('an unknown path shows the not-found page with links out, not the home page', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await page.goto('/no/such/page');

    // The page's own content, not the footer, which links to the same places.
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'There is no page at /no/such/page.' })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveTitle(/Page not found/);
    await expect(main.getByRole('link', { name: 'Browse the apps' })).toHaveAttribute('href', '/apps');
    await expect(main.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('href', '/');
    await expect(main.getByRole('link', { name: 'Publish an app' })).toHaveAttribute('href', '/publish');
    // It is not the home page wearing a different title.
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toHaveCount(0);

    // The way out works through the router, without a full reload.
    await main.getByRole('link', { name: 'Browse the apps' }).click();
    await expect(page).toHaveURL(/\/apps$/);
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 30_000 });

    await log.attach('not-found');
    expect(log.uncaught).toEqual([]);
  });

  test('a failed listing keeps the previous results, says so, and Retry recovers in place', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await page.goto('/apps');
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 30_000 });
    const cards = page.locator('a.app-card-name');
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    const before = await cards.allTextContents();
    expect(before.length, 'the seeded directory lists apps').toBeGreaterThan(0);

    // From here the listing fails; the categories and the app pages do not.
    // One handler reference: `unroute` matches by identity, so a second
    // arrow function would leave the 500 in place.
    const failListing = (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'injected by the e2e gate' }) });
    await page.route(isListingRequest, failListing);

    const search = page.getByPlaceholder('Search apps — games, tools, anything');
    await search.fill(SEARCH_DEMO.query);
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp(`[?&]q=${SEARCH_DEMO.query}(&|$)`));

    const notice = page.getByRole('alert').filter({ hasText: 'Could not load the apps.' });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('injected by the e2e gate');
    await expect(notice).toContainText('The list below is the last one that loaded.');
    const retry = notice.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    // The previous cards are still there — not a blank, not a skeleton, not "No app matches".
    expect(await cards.allTextContents()).toEqual(before);
    await expect(page.getByText('No app matches that yet.')).toHaveCount(0);

    // Once the request works again, Retry brings the real answer without a reload.
    await page.unroute(isListingRequest, failListing);
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await retry.click();
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: new RegExp(`Matching .${SEARCH_DEMO.query}.`) })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('a.app-card-name', { hasText: SEARCH_DEMO.cardName }).first()).toBeVisible({ timeout: 30_000 });
    expect(navigations, 'Retry re-asks; it does not reload or navigate').toEqual([]);

    await log.attach('directory');
    expect(log.uncaught).toEqual([]);
  });
});
