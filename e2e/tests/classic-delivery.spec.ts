import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from '../helpers/offlineSite';
import { clickIn, keepShadowRoots, textIn } from '../helpers/container';

// Resolve the exact hashed files the deployed worker uses, including split
// helpers whose filenames don't tell us which renderer owns them.
async function classicGroups(request: APIRequestContext, scope: string) {
  const script = await (await request.get(scope + 'sw.js')).text();
  const config = JSON.parse(/^self\.__SOFTN_SW__=(.+);$/m.exec(script)![1]);
  const groups: Record<string, string[]> = {};
  for (const [group, urls] of Object.entries(config.classicAssets as Record<string, string[]>)) {
    groups[group] = urls.map(url => new URL(url, scope).pathname);
  }
  expect(groups.renderer.length).toBeGreaterThan(0);
  expect(groups.controls).toContainEqual(expect.stringMatching(/\/controls-[^/]+\.js$/));
  return groups;
}

async function cachedPaths(page: Page) {
  return page.evaluate(async () => {
    const keys = await Promise.all((await caches.keys()).map(async name => (await caches.open(name)).keys()));
    return keys.flat().map(item => new URL(item.url).pathname);
  });
}

for (const host of ['web', 'builder', 'studio']) {
  test(`a web project in ${host} downloads zero classic renderer or component assets`, async ({ page, request, offlineSite }) => {
    const scope = offlineSite.origin + '/' + host + '/';
    const groups = await classicGroups(request, scope);
    const classic = new Set(Object.values(groups).flat());
    await keepShadowRoots(page);
    await page.goto(scope + '?open=/examples/RatioBar.softn&view=preview');
    await expect.poll(() => textIn(page, '#water'), { timeout: 60_000 }).toBe('320 g');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect(page.locator('.softn-runner-loading')).toBeHidden();
    await clickIn(page, '#more');
    await expect.poll(() => textIn(page, '#water')).toBe('336 g');
    expect([...offlineSite.requestedPaths].filter(path => classic.has(path))).toEqual([]);
    expect((await cachedPaths(page)).filter(path => classic.has(path))).toEqual([]);
  });
}

test('Runtime installs the classic groups Fieldnotes needs and reopens both formats after disconnection', async ({ page, request, offlineSite }) => {
  test.setTimeout(150_000);
  const scope = offlineSite.origin + '/web/';
  const groups = await classicGroups(request, scope);
  await keepShadowRoots(page);
  await page.goto(scope + '?open=/examples/TrailPack.softn');
  await expect.poll(() => textIn(page, '#summary'), { timeout: 60_000 }).toBe('0 of 5 packed');
  await expect(page.locator('.softn-runner-loading')).toBeHidden();
  await clickIn(page, '#pack-water');
  await expect.poll(() => textIn(page, '#summary')).toBe('1 of 5 packed');
  const home = page.locator('.softn-frame-home').first();
  await home.click();
  const trail = page.getByRole('button', { name: 'Open Trail Pack', exact: true });
  await expect(trail).toHaveAccessibleDescription(/Offline ready/i, { timeout: 60_000 });
  expect(groups.renderer.filter(path => offlineSite.requestedPaths.has(path))).toEqual([]);

  await page.goto(scope + '?open=/examples/Fieldnotes.softn');
  await page.locator('#fn-title').fill('Keep my offline notes');
  await page.getByRole('button', { name: /Add task/ }).click();
  await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('6');
  await home.click();
  const classic = page.getByRole('button', { name: 'Open Fieldnotes', exact: true });
  await expect(classic).toHaveAccessibleDescription(/Classic SoftN.*Offline ready/i, { timeout: 60_000 });
  const cached = new Set(await cachedPaths(page));
  expect(groups.renderer.every(path => cached.has(path))).toBe(true);
  // Fieldnotes uses HTML inputs and a native select inside its classic App.
  expect([...offlineSite.requestedPaths].filter(path => /\/(?:controls|scene3d|games)-[^/]+\.js$/.test(path))).toEqual([]);

  offlineSite.disconnect();
  await page.reload();
  await classic.click();
  await expect(page.getByText('Keep my offline notes', { exact: true })).toBeVisible();
  await page.locator('#fn-title').fill('Added while offline');
  await page.getByRole('button', { name: /Add task/ }).click();
  await expect(page.locator('[aria-label="Total tasks"]')).toHaveText('7');
  await home.click();
  await trail.click();
  await expect.poll(() => textIn(page, '#summary')).toBe('1 of 5 packed');
  await expect(page.locator('.softn-runner-loading')).toBeHidden();
  await clickIn(page, '#pack-snack');
  await expect.poll(() => textIn(page, '#summary')).toBe('2 of 5 packed');
});
