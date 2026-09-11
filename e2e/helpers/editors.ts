/**
 * Opening the two editors on the demo, for the specs added after the gate.
 *
 * The hand-off specs each carry their own copy of this; these are the same
 * steps, kept once for the specs that only need an editor up and are not
 * about the hand-off. Both editors read `?open=` once, fetch the bundle from
 * /demos/ on the same origin, and take the parameter out of the address, so
 * the settled URL is the bare editor URL — what every "the editor stayed
 * put" assertion compares against.
 */
import { expect, type Page } from '@playwright/test';
import { DEMO } from './demo';

/** Open the demo in Builder and wait until the toolbar carries its name. */
export async function openBuilderWithDemo(page: Page): Promise<string> {
  await page.goto(`/builder/?open=${DEMO.url}`);
  await expect(page).toHaveURL(/\/builder\/$/, { timeout: 60_000 });
  await expect(page.getByTitle(DEMO.name, { exact: true })).toBeVisible({ timeout: 60_000 });
  return page.url();
}

/** The toolbar control that opens Builder's Export dialog. */
export const BUILDER_EXPORT_TITLE = 'Export .softn bundle (Ctrl+Shift+E)';

/**
 * Open the demo in Studio's desktop layout and wait until Run is enabled,
 * which is when the import has committed and the validator has passed it.
 */
export async function openStudioWithDemo(page: Page): Promise<string> {
  await page.goto(`/studio/?open=${DEMO.url}`);
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeVisible({ timeout: 60_000 });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/studio\/$/);
  return page.url();
}

/**
 * Open the demo in Studio's phone layout. There is no Run button on a phone;
 * the project's name in the compact header and the project-actions menu
 * trigger are what say the editor is up.
 */
export async function openMobileStudioWithDemo(page: Page): Promise<string> {
  await page.goto(`/studio/?open=${DEMO.url}`);
  await expect(page.getByRole('button', { name: 'Project actions' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(DEMO.name, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/studio\/$/);
  return page.url();
}
