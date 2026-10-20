/**
 * The deployment as a visitor on plain HTTP sees it from an address that is
 * not their own machine: a site on an intranet server, say. A browser
 * withholds part of the platform from such a page, which is not a secure
 * context: crypto.subtle, crypto.randomUUID, service workers. The play page
 * could not check the bundle it fetched and said "Unable to open this
 * application"; the runtime stopped at its first tab id and stayed blank;
 * and an editor could not hand a bundle on, since both ends hash it.
 *
 * Chromium is told that intranet.test is this machine, so the topology
 * server answers while the page's origin is neither localhost nor HTTPS.
 * Only Chromium has that switch, so the other engines skip.
 */
import { chromium, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { DEMO } from '../helpers/demo';
import { BUILDER_EXPORT_DIALOG, BUILDER_EXPORT_TITLE, openBuilderWithDemo } from '../helpers/editors';

/** The example's slug in the seeded directory. */
const SLUG = 'twenty48';

let browser: Browser | undefined;

/** A browser whose pages reach the server under test as http://intranet.test:<port>. */
async function insecureContext(baseURL: string | undefined): Promise<BrowserContext> {
  const served = new URL(baseURL!);
  browser = await chromium.launch({ args: [`--host-resolver-rules=MAP intranet.test ${served.hostname}`] });
  return browser.newContext({ baseURL: `http://intranet.test:${served.port}`, viewport: { width: 1280, height: 800 } });
}

test.describe('a page that is not a secure context', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'only Chromium can be told a host name is this machine');

  test.afterEach(async () => {
    await browser?.close();
    browser = undefined;
  });

  test('plays an app on its play page and opens it in the runtime', async ({ baseURL, request }, testInfo) => {
    const context = await insecureContext(baseURL);
    const listed = await (await request.get('/api/apps?perPage=50')).json();
    expect(listed.apps.map((app: { slug: string }) => app.slug), 'the seeded directory has the example').toContain(SLUG);

    const page = await context.newPage();
    const log = watchConsole(page, testInfo);
    await page.goto(`/play/${SLUG}`);
    expect(await page.evaluate(() => window.isSecureContext), 'the page is not a secure context').toBe(false);
    await expect(page.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Unable to open this application')).toHaveCount(0);

    await page.goto(`/web/app/${SLUG}`);
    await expect(page.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });

    await log.attach('insecure-origin');
    expect(log.uncaught).toEqual([]);
  });

  test('Builder hands a bundle to the runtime', async ({ baseURL }, testInfo) => {
    const context = await insecureContext(baseURL);
    const page = await context.newPage();
    const log = watchConsole(page, testInfo);
    await openBuilderWithDemo(page);
    await page.getByTitle(BUILDER_EXPORT_TITLE).click();
    await expect(page.getByRole('dialog', { name: BUILDER_EXPORT_DIALOG, exact: true })).toBeVisible();
    const open = page.getByRole('button', { name: 'Open in runtime…' });
    await expect(open).toBeEnabled({ timeout: 30_000 });
    await open.click();
    const status = page.getByRole('status').filter({ hasText: 'is ready for the runtime' });
    await expect(status).toBeVisible({ timeout: 30_000 });

    const [runtime] = await Promise.all([context.waitForEvent('page'), status.getByRole('link', { name: /Open in the runtime/ }).click()]);
    const runtimeLog = watchConsole(runtime, testInfo);
    await expect(runtime.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(runtime.getByText('Nothing was handed')).toHaveCount(0);

    await log.attach('builder');
    await runtimeLog.attach('runtime');
    expect(log.uncaught).toEqual([]);
    expect(runtimeLog.uncaught).toEqual([]);
  });
});
