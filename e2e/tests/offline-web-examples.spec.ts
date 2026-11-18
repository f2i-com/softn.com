import { expect } from '@playwright/test';
import { test } from '../helpers/offlineSite';
import { clickIn, keepShadowRoots, textIn } from '../helpers/container';
import { cachedWasm, fullEngine, liteEngine, requestedWasm } from '../helpers/engines';

// These are the production bundles linked by the site and built from examples/offline-web-apps/.
const examples = [
  {
    name: 'Trail Pack', archive: 'TrailPack', framework: 'vanilla JS', output: '#summary',
    initial: '0 of 5 packed', online: ['#pack-water', '1 of 5 packed'], offline: ['#pack-snack', '2 of 5 packed'],
  },
  {
    name: 'Ratio Bar', archive: 'RatioBar', framework: 'React', output: '#water',
    initial: '320 g', online: ['#more', '336 g'], offline: ['#more', '352 g'],
  },
  {
    name: 'Swatchbook', archive: 'Swatchbook', framework: 'Vue', output: '#palette',
    initial: 'Tide pool', online: ['.choices button:nth-child(2)', 'Canyon'], offline: ['.choices button:last-child', 'Orchard'],
  },
];

test('Runtime Home finds both a classic SoftN app and a web app by name', async ({ page }) => {
  await keepShadowRoots(page);
  await page.goto('/web/?open=/examples/Fieldnotes.softn');
  await expect(page.locator('#fn-title')).toBeVisible({ timeout: 60_000 });
  await page.locator('#fn-title').fill('Test classic logic');
  await page.getByRole('button', { name: /Add task/ }).click();
  await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('6');

  await page.goto('/web/?open=/examples/TrailPack.softn');
  await expect.poll(() => textIn(page, '#summary'), { timeout: 60_000 }).toBe('0 of 5 packed');
  await page.locator('.softn-frame-home').first().click();
  const search = page.getByRole('searchbox', { name: 'Find a saved app' });
  const classic = page.getByRole('button', { name: 'Open Fieldnotes', exact: true });
  const web = page.getByRole('button', { name: 'Open Trail Pack', exact: true });
  await search.fill('FIELD');
  await expect(classic).toHaveAccessibleDescription(/Classic SoftN/);
  await expect(web).toHaveCount(0);
  await search.fill('trail');
  await expect(web).toHaveAccessibleDescription(/Web app/);
  await expect(classic).toHaveCount(0);
  await search.fill('missing');
  await expect(page.getByText('No saved apps match “missing”.')).toBeVisible();
  await search.fill('');
  await expect(classic).toBeVisible();
  await expect(web).toBeVisible();
});

for (const editor of ['builder', 'studio']) {
  test(`a new ${editor} workspace installs without the full engine`, async ({ page, context }) => {
    const requests = requestedWasm(context);
    await page.goto('/' + editor + '/');
    await expect(page.getByRole('button', {
      name: editor === 'studio' ? 'Explore examples without AI' : 'New',
      exact: true,
    })).toBeVisible({ timeout: 60_000 });
    // Editors let existing pages keep their version. Wait for installation rather than
    // requiring this first, already-loaded tab to be under service worker control.
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    expect((await cachedWasm(page)).filter((path) => fullEngine.test(path))).toEqual([]);
    expect([...requests].filter((path) => fullEngine.test(path))).toEqual([]);
  });
}

for (const app of examples) {
  test(`${app.name} (${app.framework}) installs and reopens offline with only the lite engine`, async ({ context, page, offlineSite }) => {
    test.setTimeout(180_000);
    const requests = requestedWasm(context);
    await keepShadowRoots(page);
    await page.goto(offlineSite.origin + '/web/?open=/examples/' + app.archive + '.softn');
    const value = () => textIn(page, app.output);
    await expect.poll(value, { timeout: 60_000 }).toBe(app.initial);
    await clickIn(page, app.online[0]);
    await expect.poll(value).toBe(app.online[1]);

    await page.locator('.softn-frame-home').first().click();
    const card = page.getByRole('button', { name: 'Open ' + app.name, exact: true });
    await expect(card.locator('.softn-launcher-offline')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
    await expect(card).toHaveAccessibleDescription(/Lite JavaScript/);
    const enginePath = (path: string) => /\/zipp[-_]/.test(path);
    const liteOnly = [expect.stringMatching(liteEngine)];
    expect((await cachedWasm(page)).filter(enginePath)).toEqual(liteOnly);
    expect([...requests].filter(enginePath)).toEqual(liteOnly);

    offlineSite.disconnect();
    await page.reload();
    await card.click();
    await expect.poll(value, { timeout: 60_000 }).toBe(app.online[1]);
    // This is a fresh Worker. Its framework handlers still run with the network disconnected.
    await clickIn(page, app.offline[0]);
    await expect.poll(value).toBe(app.offline[1]);
    expect([...requests].filter(enginePath)).toEqual(liteOnly);
  });
}
