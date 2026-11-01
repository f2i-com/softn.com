/**
 * What a person sees when something fails, on the built deployment.
 *
 * Each of these used to be a page that said nothing: a page whose own code was
 * missing was blank or "Loading…" for ever, a record that was not kept looked
 * kept, a page that did not parse played as an empty app, and a handler that
 * threw or ran until the engine stopped it said so to the console alone. A
 * real browser is the check for all of them: a notice on every app is only
 * seen on a real render.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { uiBundle } from '../helpers/bundle';
import { watchConsole } from '../helpers/console';
import { DEMO } from '../helpers/demo';

/** The seeded example, which declares nothing and draws at once. */
const SLUG = 'twenty48';

/** What this file has published, to take back: the specs share one directory, and run in its listing. */
const published: Array<{ slug: string; editKey: string }> = [];

test.afterEach(async ({ request }) => {
  for (const { slug, editKey } of published.splice(0)) {
    const gone = await request.delete(`/api/apps/${slug}`, { headers: { 'X-Edit-Key': editKey } });
    expect(gone.ok(), await gone.text()).toBe(true);
  }
});

/** Publish a bundle built here, and the slug the directory gave it. */
async function publish(request: APIRequestContext, listing: string, bundle: Buffer): Promise<string> {
  const answer = await request.post('/api/apps', {
    multipart: { bundle: { name: `${listing}.softn`, mimeType: 'application/octet-stream', buffer: bundle }, name: listing },
  });
  expect(answer.ok(), await answer.text()).toBe(true);
  const { app, editKey } = await answer.json();
  published.push({ slug: app.slug, editKey });
  return app.slug;
}

const ENTRY = /\/assets\/index-[^/]+\.js$/;

test.describe('a page whose code did not arrive', () => {
  for (const [what, address] of [
    ['the site', '/'],
    ['the runtime', '/web/'],
    ['Builder', '/builder/'],
    ['Studio', '/studio/'],
    ['a play page', `/play/${SLUG}`],
  ] as const) {
    for (const [how, answer] of [
      // As a half-finished upload leaves it: not there yet, or there and cut short.
      ['missing', { status: 404, contentType: 'text/plain', body: 'Not found' }],
      ['cut short', { status: 200, contentType: 'text/javascript', body: 'export const a = {' }],
    ] as const) {
      test(`${what} says so and offers a reload when its code is ${how}`, async ({ page }, testInfo) => {
        const log = watchConsole(page, testInfo);
        await page.route(ENTRY, (route) => route.fulfill(answer));
        await page.goto(address);
        const notice = page.getByRole('alert');
        await expect(notice).toContainText('This page could not load', { timeout: 30_000 });
        await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible();
        // Under the page's real policy: refused, the script that says this would not have run.
        expect(log.errors.filter((line) => /Content Security Policy/i.test(line))).toEqual([]);

        await page.unroute(ENTRY);
        await notice.getByRole('button', { name: 'Reload' }).click();
        await expect(notice).toHaveCount(0, { timeout: 30_000 });
        await log.attach('entry-missing');
      });
    }
  }

  test('code that arrived and threw is not called missing', async ({ page }) => {
    await page.route(ENTRY, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("ran, and failed");' }));
    const thrown = page.waitForEvent('pageerror');
    await page.goto('/web/');
    await thrown;
    await expect(page.getByRole('alert').filter({ hasText: 'This page could not load' })).toHaveCount(0);
  });
});

test.describe('the storage notice', () => {
  const NOT_SAVED = 'Records are not being saved';

  test('says nothing on an app that is saving normally', async ({ page }) => {
    for (const address of [`/play/${SLUG}`, `/web/app/${SLUG}`]) {
      await page.goto(address);
      await expect(page.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-xdb-storage]')).toHaveCount(0);
    }
  });

  test('says so where the browser refuses site data, and leaves room for the app', async ({ page, request }) => {
    const slug = await publish(request, 'E2E Fills The Window', uiBundle({ name: 'E2E Fills The Window', ui: '<App><Text>Top of the app</Text></App>' }));
    // As Chromium's "block all cookies" and Firefox refuse it: the property itself throws.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    for (const address of [`/play/${slug}`, `/web/app/${slug}`]) {
      await page.goto(address);
      await expect(page.getByText('Top of the app')).toBeVisible({ timeout: 60_000 });
      const notice = page.getByRole('alert').filter({ hasText: NOT_SAVED });
      await expect(notice).toBeVisible();
      // Beside the app, not over it, and the app's own root sized for what is left.
      const noticeBox = (await notice.boundingBox())!;
      const appBox = (await page.locator('.softn-app').first().boundingBox())!;
      expect(appBox.y).toBeGreaterThanOrEqual(noticeBox.y + noticeBox.height - 1);
      expect(appBox.y + appBox.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);
    }
  });
});

test.describe('what fails in an app', () => {
  test('a page that does not parse says where, in both shells', async ({ page, request }) => {
    const slug = await publish(request, 'E2E Broken Page', uiBundle({ name: 'E2E Broken Page', ui: '<App><Text>{a</Text></App>' }));
    for (const address of [`/play/${slug}`, `/web/app/${slug}`]) {
      await page.goto(address);
      const notice = page.locator('[data-softn-notice="failure"]');
      await expect(notice).toContainText('This page has a mistake', { timeout: 60_000 });
      await expect(notice).toContainText('ui/main.ui, line 1, column 7: Unclosed tag: <Text>');
    }
  });

  test('a page that partly parsed keeps what it drew', async ({ page, request }) => {
    const slug = await publish(request, 'E2E Partly Drawn', uiBundle({ name: 'E2E Partly Drawn', ui: '<App>\n  <Text>Still drawn</Text>\n  <Text>{1 +}</Text>\n</App>' }));
    await page.goto(`/play/${slug}`);
    await expect(page.locator('[data-softn-notice="failure"]')).toContainText('line 3', { timeout: 60_000 });
    await expect(page.getByText('Still drawn')).toBeVisible();
  });

  test('a handler that throws is said, and one that never ends stops the app with a way back', async ({ page, request }) => {
    const slug = await publish(request, 'E2E Failing App', uiBundle({
      name: 'E2E Failing App',
      ui: '<logic src="../logic/main.logic" />\n<App><Text>{"Pressed " + pressed}</Text><Button @click={fails}>Fail</Button><Button @click={spins}>Spin</Button></App>',
      logic: 'let pressed = 0\nfunction fails() { pressed = pressed + 1; throw new Error("the sum is off") }\nfunction spins() { while (true) {} }\n',
    }));
    for (const address of [`/play/${slug}`, `/web/app/${slug}`]) {
      await page.goto(address);
      await expect(page.getByText('Pressed 0')).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Fail', exact: true }).click();
      const notice = page.locator('[data-softn-notice="failure"]');
      await expect(notice).toContainText('failed in fails');
      await expect(notice).toContainText('the sum is off');
      await expect(notice).toHaveCount(1);
      await expect(page.getByText('Pressed 1')).toBeVisible();

      await page.getByRole('button', { name: 'Spin', exact: true }).click();
      await expect(notice).toContainText('This app has stopped', { timeout: 30_000 });
      // The way back stays: dismissed, it left an app that ignored every press and said nothing.
      await expect(notice.getByRole('button')).toHaveText(['Reload']);
      await notice.getByRole('button', { name: 'Reload' }).click();
      await expect(page.getByText('Pressed 0')).toBeVisible({ timeout: 60_000 });
      await expect(notice).toHaveCount(0);
    }
  });

  test('an app on a worker that stops keeps its screen and gets the same way back', async ({ page, request }) => {
    const slug = await publish(request, 'E2E Worker App', uiBundle({
      name: 'E2E Worker App',
      config: { execution: 'worker' },
      ui: '<logic src="../logic/main.logic" />\n<App><Text>{"Pressed " + pressed}</Text><Button @click={press}>Press</Button><Button @click={spins}>Spin</Button></App>',
      logic: 'let pressed = 0\nfunction press() { pressed = pressed + 1 }\nfunction spins() { while (true) {} }\n',
    }));
    const uncaught: string[] = [];
    page.on('pageerror', (error) => uncaught.push(error.message));
    for (const address of [`/play/${slug}`, `/web/app/${slug}`]) {
      await page.goto(address);
      await expect(page.getByText('Pressed 0')).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Press', exact: true }).click();
      await expect(page.getByText('Pressed 1')).toBeVisible();

      await page.getByRole('button', { name: 'Spin', exact: true }).click();
      const notice = page.locator('[data-softn-notice="failure"]');
      await expect(notice).toContainText('This app has stopped', { timeout: 30_000 });
      await expect(page.getByText('Pressed 1')).toBeVisible();
      await expect(notice.getByRole('button')).toHaveText(['Reload']);
      // A press on what is left of it is ignored, in the page too.
      await page.getByRole('button', { name: 'Press', exact: true }).click();
      await expect(page.getByText('Pressed 1')).toBeVisible();
      await expect.poll(() => uncaught).toEqual([]);

      await notice.getByRole('button', { name: 'Reload' }).click();
      await expect(page.getByText('Pressed 0')).toBeVisible({ timeout: 60_000 });
      await expect(notice).toHaveCount(0);
      // A new worker: the one that stopped answers nothing.
      await page.getByRole('button', { name: 'Press', exact: true }).click();
      await expect(page.getByText('Pressed 1')).toBeVisible();
    }
  });
});

test('Reload on a stopped app leaves the apps running beside it', async ({ page }) => {
  await page.goto('/web/?open=%2Fexamples%2FFieldnotes.softn');
  await expect(page.getByRole('heading', { name: 'Make space for what matters.', exact: true })).toBeVisible({ timeout: 60_000 });
  // Typed and not saved: what a reload of the runtime's page would take with it.
  await page.locator('#fn-title').fill('an unfinished task');
  await page.locator('.softn-frame-home').click();

  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'spinner.softn',
    mimeType: 'application/octet-stream',
    buffer: uiBundle({
      name: 'E2E Spinner',
      ui: '<logic src="../logic/main.logic" />\n<App><Text>{"Pressed " + pressed}</Text><Button @click={press}>Press</Button><Button @click={spins}>Spin</Button></App>',
      logic: 'let pressed = 0\nfunction press() { pressed = pressed + 1 }\nfunction spins() { while (true) {} }\n',
    }),
  });
  await page.getByRole('button', { name: 'Press', exact: true }).click();
  await expect(page.getByText('Pressed 1')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  const notice = page.locator('[data-softn-notice="failure"]');
  await expect(notice).toContainText('This app has stopped', { timeout: 30_000 });
  await notice.getByRole('button', { name: 'Reload' }).click();

  await expect(page.getByText('Pressed 0')).toBeVisible({ timeout: 60_000 });
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: 'Press', exact: true }).click();
  await expect(page.getByText('Pressed 1')).toBeVisible();

  await page.locator('.softn-frame-home').click();
  await page.locator('.softn-launcher-run-open').filter({ hasText: 'Fieldnotes' }).click();
  await expect(page.locator('#fn-title')).toHaveValue('an unfinished task');
});

test.describe('the address an app is at', () => {
  test('a directory app keeps its own, whatever its bundle calls itself, and a reload finds it', async ({ page, request }) => {
    // The listing's name is not the manifest's: the bar used to take the manifest's.
    const slug = await publish(request, 'E2E Team Board', uiBundle({ name: 'notes', ui: '<App><Text>The team board</Text></App>' }));
    await page.goto(`/web/app/${slug}`);
    await expect(page.getByText('The team board')).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`/web/app/${slug}$`));
    await page.reload();
    await expect(page.getByText('The team board')).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`/web/app/${slug}$`));
  });

  test('an old address opens the app, and the bar and the library take its real slug', async ({ page }) => {
    await page.goto(`/web/app/${DEMO.name}`);
    await expect(page.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`/web/app/${SLUG}$`));
    await page.reload();
    await expect(page.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`/web/app/${SLUG}$`));
  });

  test('an app opened by a link keeps an address that opens it in another browser', async ({ page, browser }) => {
    await page.goto(`/web/?open=/demos/${DEMO.name}.softn`);
    await expect(page.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`/web/app/~${DEMO.name}\\?from=`));
    const address = page.url();

    const elsewhere = await browser.newContext();
    const other = await elsewhere.newPage();
    await other.goto(address);
    await expect(other.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await elsewhere.close();
  });

  test('an app from a file with a slash in its name comes back on a reload, with the same address', async ({ page }) => {
    await page.goto('/web/');
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'named.softn',
      mimeType: 'application/octet-stream',
      buffer: uiBundle({ name: 'Notes v1.2/Draft', ui: '<App><Text>The draft</Text></App>' }),
    });
    await expect(page.getByText('The draft')).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/web\/app\/~Notes%20v1\.2~2FDraft$/);
    await page.reload();
    await expect(page.getByText('The draft')).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/web\/app\/~Notes%20v1\.2~2FDraft$/);
  });
});

test('a play page is cross-origin isolated, each policy sent once', async ({ page, browserName }) => {
  const answer = await page.goto(`/play/${SLUG}`);
  const sent = (await answer!.headersArray()).filter((header) => /^cross-origin-(opener|embedder)-policy$/i.test(header.name));
  expect(sent.map((header) => header.name.toLowerCase()).sort()).toEqual(['cross-origin-embedder-policy', 'cross-origin-opener-policy']);
  // WebKit has no COEP `credentialless`, so it is isolated on no page of any site that sends it.
  if (browserName !== 'webkit') expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
});
