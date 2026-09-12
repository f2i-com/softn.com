import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { appRoot, openDesktopBuild } from './harness';

const fixture = zipSync({
  'manifest.json': strToU8(JSON.stringify({ name: 'Desktop styles', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } })),
  'ui/main.ui': strToU8('<style>.desktop-style-proof { background-color: rgb(12, 78, 99); padding: 24px; display: grid; gap: 18px; }</style><App><div className="desktop-style-proof"><h1>Desktop styles loaded</h1><Button>Styled action</Button></div></App>'),
});

// Tauri nonces styles present at build time and adds those nonces to style-src.
// This uses the actual desktop frontend, with equivalent document headers, to
// exercise styles emitted later by SoftNRenderer, components and the iframe.
for (const surface of ['builder', 'runtime'] as const) {
for (const simulatePreviousConfig of [true, false]) {
  test(`${surface}: ${simulatePreviousConfig ? 'reproduces dynamic app CSS blocked by the previous Tauri style nonce' : 'renders app CSS and layout with the current desktop policy'}`, async ({ page }) => {
    const violations = await openDesktopBuild(page, surface, fixture, simulatePreviousConfig);
    if (surface === 'builder') {
      await expect(page.getByText('Desktop styles', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
    }
    const host = surface === 'builder' ? page.frameLocator('iframe[title="Device Preview"]') : page;
    const proof = host.locator('.desktop-style-proof');
    await expect(proof).toBeVisible();
    if (simulatePreviousConfig) {
      await expect(proof).not.toHaveCSS('background-color', 'rgb(12, 78, 99)');
      expect(violations.some((message) => message.includes('nonce-desktop-style'))).toBe(true);
    } else {
      await expect(proof).toHaveCSS('background-color', 'rgb(12, 78, 99)');
      await expect(proof).toHaveCSS('padding', '24px');
      await expect(proof).toHaveCSS('display', 'grid');
      await expect(host.locator('body')).toHaveCSS('margin', '0px');
      expect(violations).toEqual([]);
    }
  });
}
}

test('runtime: Fieldnotes follows the shell theme without resetting a draft and restores the saved choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  // An old standalone-runtime choice must not override the current shell.
  await page.addInitScript(() => localStorage.setItem('softn-theme-preference', 'dark'));
  const bundle = new Uint8Array(await readFile(path.resolve(appRoot, '../softn-site/public/examples/Fieldnotes.softn')));
  const violations = await openDesktopBuild(page, 'runtime', bundle);
  const app = page.locator('.fn');
  const input = page.getByLabel('Task name', { exact: true });
  await expect(app).toBeVisible();
  await expect(app).toHaveCSS('background-color', 'rgb(246, 245, 241)');
  await expect(input).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(input).toHaveCSS('color-scheme', 'light');
  await input.fill('Keep this draft while changing theme');

  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await expect(app).toHaveCSS('background-color', 'rgb(23, 32, 25)');
  await expect(input).toHaveCSS('background-color', 'rgb(24, 34, 26)');
  await expect(input).toHaveCSS('color-scheme', 'dark');
  await expect(input).toHaveValue('Keep this draft while changing theme');

  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await expect(app).toHaveCSS('background-color', 'rgb(246, 245, 241)');
  await expect(input).toHaveCSS('color-scheme', 'light');
  await expect(input).toHaveValue('Keep this draft while changing theme');
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Switch to light mode', exact: true })).toBeVisible();
  await expect(app).toHaveCSS('background-color', 'rgb(23, 32, 25)');
  await expect(input).toHaveCSS('background-color', 'rgb(24, 34, 26)');
  await expect(input).toHaveCSS('color-scheme', 'dark');
  expect(violations).toEqual([]);
});
