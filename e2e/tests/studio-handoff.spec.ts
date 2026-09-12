/**
 * Studio → Run → the runtime, and Studio → Publish → the publish page, on
 * the built deployment. SHR-01, SHR-02 and QA-01 in the audit.
 *
 * What went wrong before: Studio opened the receiver with
 * `window.open(url, '_blank', 'noopener')`, read the null that a noopener
 * open returns on success as "popup blocked", and navigated the editor to
 * the same address — two receiver pages and no Studio. And the publish
 * hand-off was addressed to the site's root, which the site's router shows
 * as the home page, so the bundle never reached the publish form.
 *
 * The isolated check the audit shipped (check_browser_handoff.py) proved
 * the browser premise on about:blank pages. This is the application half:
 * the real Run and Publish buttons, the real staged hand-off in IndexedDB,
 * the real receiver pages served by the real router at their deployed paths.
 *
 * Which assertion catches which regression:
 *   SHR-02  `editorUrlAfterStaging` / `mainFrameNavigations` — the editor
 *           is not navigated by staging or by opening the receiver, and
 *           exactly two pages exist afterwards; the receiver's `window.opener` is null.
 *   SHR-01  the ready link's href is `/publish?from=handoff&handoff=<id>`
 *           and the opened page lands on /publish with the bundle's file
 *           name in the form, not on the home page.
 */
import { expect, test, type Page, type FrameLocator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { watchConsole } from '../helpers/console';
import { DEMO } from '../helpers/demo';

/** A hand-off id as the protocol mints them (a UUID or 32 hex chars). */
const HANDOFF_ID = /[A-Za-z0-9-]{16,64}/;

/**
 * Open the demo in Studio through `?open=` and wait until the editor is
 * up with Run enabled. Studio strips `open` from the address once it has
 * acted on it, so the settled URL is the bare editor URL — recorded here as
 * the baseline every navigation check compares against.
 */
async function openStudioWithDemo(page: Page): Promise<string> {
  await page.goto(`/studio/?open=${DEMO.url}`);
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeVisible({ timeout: 60_000 });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/studio\/$/);
  return page.url();
}

/** Count top-level navigations of the editor from this moment on, same-document ones included. */
function countMainFrameNavigations(page: Page): () => string[] {
  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url());
  });
  return () => seen;
}

test.describe('Studio hands a bundle to the runtime and to the publish page', () => {
  test('Fieldnotes keeps its CSS through preview refresh, theme changes and saved-project restoration', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await page.goto('/studio/?open=/examples/Fieldnotes.softn');
    const preview = page.locator('[data-softn-preview-content="true"]');
    const assertStyles = async (dark = false) => {
      await expect(preview.getByRole('heading', { name: 'Make space for what matters.', exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(preview.locator('.fn')).toHaveCSS('background-color', dark ? 'rgb(23, 32, 25)' : 'rgb(246, 245, 241)');
      await expect(preview.locator('.fn')).toHaveCSS('color', dark ? 'rgb(237, 240, 231)' : 'rgb(36, 40, 32)');
      await expect(preview.locator('#fn-title')).toHaveCSS('background-color', dark ? 'rgb(24, 34, 26)' : 'rgb(255, 255, 255)');
      await expect(preview.locator('.fn h1')).toHaveCSS('font-family', /Georgia/i);
      await expect(preview.locator('.fn-columns')).toHaveCSS('display', 'grid');
    };
    await assertStyles();
    await preview.locator('#fn-title').fill('A task created in Studio preview');
    await preview.getByRole('button', { name: /Add task/ }).click();
    await expect(preview.locator('[aria-label="Total tasks"]')).toHaveText('6');
    await preview.locator('#fn-title').fill('Unsubmitted text');
    await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
    await expect(preview.locator('#fn-title')).toHaveValue('');
    await expect(preview.locator('[aria-label="Total tasks"]')).toHaveText('6');
    await assertStyles();
    await preview.locator('#fn-title').fill('Keep this draft while changing appearance');
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await assertStyles(true);
    await expect(preview.locator('#fn-title')).toHaveValue('Keep this draft while changing appearance');
    await expect(preview.locator('[aria-label="Total tasks"]')).toHaveText('6');
    await expect(page.getByRole('status', { name: /Saved to this browser/ })).toBeVisible();
    await page.reload();
    await assertStyles(true);
    await expect(preview.locator('[aria-label="Total tasks"]')).toHaveText('5');
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await assertStyles();
    await log.attach('studio-fieldnotes-css');
    expect(log.uncaught).toEqual([]);
  });

  test('one app keeps its helper logic, assets, seed records and diagram through Studio, Builder and runtime', async ({ page, context }, testInfo) => {
    const schema = {
      version: 1,
      collections: [{ name: 'tasks', position: { x: 180, y: 150 } }],
      relationships: [{ sourceCollection: 'tasks', sourceField: '', targetCollection: 'tasks', type: 'many-to-many' }],
    };
    const seed = {
      collection: 'tasks', schema: { fields: [{ name: 'title', type: 'string', required: true }] },
      records: [{ id: 'portable-task', collection: 'tasks', data: { title: 'A portable seed record' }, created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z', deleted: false }],
    };
    const files = {
      'manifest.json': JSON.stringify({
        name: 'PortableNotes', version: '1.0.0', main: 'ui/main.ui',
        files: { ui: ['ui/main.ui'], logic: ['logic/helpers.logic', 'logic/main.logic'], xdb: ['data/tasks.xdb'], assets: ['images/logo.svg'] },
        builder: { schema }, config: { theme: { mode: 'light' } },
      }),
      'permission.json': JSON.stringify({ permissions: {} }),
      'ui/main.ui': '<logic src="../logic/main.logic" /><data><collection name="tasks" as="tasks" /></data><App><Stack padding={24}><Text>{portableTitle}</Text><Image src={asset("images/logo.svg")} alt="Portable logo" width={48} height={48} /><Text>{seedTitle}</Text><Button onClick={increment}>Clicked {count}</Button></Stack></App>',
      'logic/helpers.logic': 'let helperTitle = "One app, three workspaces";',
      'logic/main.logic': 'let portableTitle = helperTitle;\nlet count = 0;\nlet seedTitle = "";\nfunction increment() { count = count + 1; }\nfunction _init() { let rows = db.query("tasks"); seedTitle = rows.length ? rows[0].data.title : "Missing seed"; }',
      'images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="12" fill="#6a714b" /></svg>',
      'data/tasks.xdb': JSON.stringify(seed),
    };
    const fixture = zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
    await page.route(url => url.pathname === '/examples/PortableNotes.softn', route => route.fulfill({ body: Buffer.from(fixture), contentType: 'application/zip' }));
    const studioLog = watchConsole(page, testInfo);
    await page.goto('/studio/?open=/examples/PortableNotes.softn');
    const preview = page.locator('[data-softn-preview-content="true"]');
    const verifyApp = async (host: Page | FrameLocator | ReturnType<Page['locator']>) => {
      await expect(host.getByText('One app, three workspaces', { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(host.getByText('A portable seed record', { exact: true })).toBeVisible();
      const logo = host.getByRole('img', { name: 'Portable logo', exact: true });
      await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await host.getByRole('button', { name: 'Clicked 0', exact: true }).click();
      await expect(host.getByRole('button', { name: 'Clicked 1', exact: true })).toBeVisible();
    };
    await verifyApp(preview);
    const previewBounds = await preview.boundingBox();
    const toolbarBounds = await page.getByRole('toolbar', { name: 'Preview controls' }).boundingBox();
    expect(previewBounds!.y + previewBounds!.height, 'Preview controls must not cover app buttons').toBeLessThanOrEqual(toolbarBounds!.y);
    const [studioDownload] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('button', { name: 'Export bundle', exact: true }).click(),
    ]);
    const studioFile = testInfo.outputPath('studio', 'PortableNotes.softn');
    await studioDownload.saveAs(studioFile);
    const studioArchive = unzipSync(new Uint8Array(await readFile(studioFile)));
    expect(JSON.parse(strFromU8(studioArchive['manifest.json'])).builder.schema).toEqual(schema);
    for (const path of ['logic/helpers.logic', 'permission.json', 'images/logo.svg', 'data/tasks.xdb']) {
      expect(strFromU8(studioArchive[path])).toBe(files[path as keyof typeof files]);
    }

    const builder = await context.newPage();
    const builderLog = watchConsole(builder, testInfo);
    await builder.goto('/builder/');
    const chooser = builder.waitForEvent('filechooser');
    await builder.getByRole('button', { name: 'Open', exact: true }).click();
    await (await chooser).setFiles(studioFile);
    await expect(builder.getByTitle('PortableNotes', { exact: true })).toBeVisible();
    await builder.getByRole('button', { name: 'Preview', exact: true }).click();
    await verifyApp(builder.frameLocator('iframe')).catch(async error => {
      await builderLog.attach('roundtrip-builder');
      throw error;
    });
    await builder.getByRole('button', { name: 'Data', exact: true }).click();
    await expect(builder.getByRole('table').getByRole('textbox').first()).toHaveValue('A portable seed record');
    await builder.getByRole('tab', { name: 'Relationships (1)', exact: true }).click();
    await expect(builder.getByRole('list', { name: 'Relationships', exact: true })).toContainText('tasks');
    await builder.getByTitle('Export .softn bundle (Ctrl+Shift+E)').click();
    const [builderDownload] = await Promise.all([
      builder.waitForEvent('download'), builder.getByRole('dialog', { name: 'Export Bundle', exact: true }).getByRole('button', { name: 'Export .softn', exact: true }).click(),
    ]);
    const builderFile = testInfo.outputPath('builder', 'PortableNotes.softn');
    await builderDownload.saveAs(builderFile);
    const builderArchive = unzipSync(new Uint8Array(await readFile(builderFile)));
    expect(JSON.parse(strFromU8(builderArchive['manifest.json'])).builder.schema).toEqual(schema);
    expect(JSON.parse(strFromU8(builderArchive['data/tasks.xdb'])).records).toEqual(seed.records);
    for (const path of ['logic/helpers.logic', 'images/logo.svg']) expect(strFromU8(builderArchive[path])).toBe(files[path as keyof typeof files]);
    // Builder may omit an empty declaration; neither form requests a capability.
    const declaration = builderArchive['permission.json'];
    expect(declaration ? JSON.parse(strFromU8(declaration)) : { permissions: {} }).toEqual({ permissions: {} });

    await page.getByTitle('Back to home', { exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles(builderFile);
    await verifyApp(preview);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const status = page.getByRole('status').filter({ hasText: 'is ready for the runtime' });
    const [runtime] = await Promise.all([
      context.waitForEvent('page'), status.getByRole('link', { name: 'Open in a new tab' }).click(),
    ]);
    const runtimeLog = watchConsole(runtime, testInfo);
    await verifyApp(runtime);
    await studioLog.attach('roundtrip-studio');
    await builderLog.attach('roundtrip-builder');
    await runtimeLog.attach('roundtrip-runtime');
    expect(studioLog.uncaught).toEqual([]);
    expect(builderLog.uncaught).toEqual([]);
    expect(runtimeLog.uncaught).toEqual([]);
  });

  test('Run stages the bundle, leaves the editor where it is, and the ready link opens the runtime with the app', async ({ page, context }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openStudioWithDemo(page);
    const navigations = countMainFrameNavigations(page);

    await page.getByRole('button', { name: 'Run', exact: true }).click();

    // Staging is announced, not navigated to.
    const status = page.getByRole('status').filter({ hasText: 'is ready for the runtime' });
    await expect(status).toBeVisible({ timeout: 30_000 });
    await expect(status).toContainText(DEMO.name);
    const editorUrlAfterStaging = page.url();
    expect(editorUrlAfterStaging, 'staging must not move the editor').toBe(editorUrl);
    expect(navigations(), 'staging must not navigate the editor, not even same-document').toEqual([]);
    expect(context.pages(), 'staging must not open a tab of its own').toHaveLength(1);

    // The way out is a link the person clicks: new tab, no opener, addressed to the runtime.
    const link = status.getByRole('link', { name: 'Open in a new tab' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/web/\\?open=handoff&handoff=${HANDOFF_ID.source}$`));
    await expect(status.getByRole('link', { name: 'Open here' })).toHaveAttribute('href', href!);

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    const popupLog = watchConsole(popup, testInfo);

    // The receiver is the runtime, it has no handle on the editor, and the app is on screen.
    await popup.waitForLoadState('domcontentloaded');
    expect(await popup.evaluate(() => window.opener === null), 'rel=noopener: the receiver must not hold the editor').toBe(true);
    await expect(popup).toHaveURL(/\/web\//);
    await expect(popup.getByText(DEMO.firstScreenText)).toBeVisible({ timeout: 60_000 });
    await expect(popup).toHaveTitle(DEMO.name);
    await expect(popup.getByText('Nothing was handed')).toHaveCount(0);

    // And the editor is still the editor.
    expect(context.pages()).toHaveLength(2);
    expect(page.url()).toBe(editorUrl);
    expect(navigations()).toEqual([]);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();

    await log.attach('studio');
    await popupLog.attach('runtime');
    expect(log.uncaught, 'no uncaught exception in Studio').toEqual([]);
    expect(popupLog.uncaught, 'no uncaught exception in the runtime').toEqual([]);
  });

  test('Publish stages the bundle and the ready link lands on /publish with the bundle in the form', async ({ page, context }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openStudioWithDemo(page);
    const navigations = countMainFrameNavigations(page);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();

    const status = page.getByRole('status').filter({ hasText: 'is ready for the publish page' });
    await expect(status).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(editorUrl);
    expect(navigations()).toEqual([]);

    // SHR-01: the publish route, not the site root.
    const link = status.getByRole('link', { name: 'Open in a new tab' });
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/publish\\?from=handoff&handoff=${HANDOFF_ID.source}$`));
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    const popupLog = watchConsole(popup, testInfo);
    await popup.waitForLoadState('domcontentloaded');
    expect(await popup.evaluate(() => window.opener === null), 'rel=noopener: the receiver must not hold the editor').toBe(true);
    await expect(popup).toHaveURL(/\/publish(\?|$)/);

    // The form has the bundle: its file name and what the inspection read from it.
    await expect(popup.getByRole('heading', { name: 'Put an app in the directory' })).toBeVisible({ timeout: 30_000 });
    const dropzone = popup.locator('.dropzone-file');
    await expect(dropzone).toBeVisible({ timeout: 30_000 });
    await expect(dropzone).toContainText(`${DEMO.name}.softn`);
    await expect(dropzone).toContainText(`${DEMO.name} v${DEMO.version}`);
    await expect(popup.getByText('Nothing was handed')).toHaveCount(0);
    await expect(popup.getByRole('alert')).toHaveCount(0);

    // The editor is untouched.
    expect(context.pages()).toHaveLength(2);
    expect(page.url()).toBe(editorUrl);
    expect(navigations()).toEqual([]);

    await log.attach('studio');
    await popupLog.attach('publish');
    expect(log.uncaught).toEqual([]);
    expect(popupLog.uncaught).toEqual([]);
  });

  test('a hand-off id that was never staged is reported by the publish page, with the ordinary form still there', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await page.goto('/publish?from=handoff&handoff=00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('alert')).toContainText('Nothing was handed', { timeout: 30_000 });
    await expect(page.getByText('Drop .softn files here')).toBeVisible();
    // One-shot: the address no longer carries the claim.
    await expect(page).toHaveURL(/\/publish$/);
    await log.attach('publish');
    expect(log.uncaught).toEqual([]);
  });
});
