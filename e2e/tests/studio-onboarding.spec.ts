/**
 * Studio's first visit.
 *
 * With no AI provider configured and the setup not skipped — a fresh
 * browser, which is what every Playwright context is — Studio opens on its
 * onboarding step with working web starters, optional provider setup and
 * a way to browse the rest of the workspace.
 */
import { expect, test } from '@playwright/test';
import { watchConsole } from '../helpers/console';

test('a first visit to Studio offers web starters, AI setup and examples', async ({
  page,
}, testInfo) => {
  const log = watchConsole(page, testInfo);
  try {
    await page.goto('/studio/');
    const heading = page.getByRole('heading', { name: 'Create your first app', exact: true });
    await expect(heading).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Connect an AI provider', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Vanilla JS starter' })).toBeVisible();

    await page.getByRole('button', { name: 'Explore examples without AI', exact: true }).click();
    await expect(heading).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'SoftN', exact: true }).first()
    ).toBeVisible();
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('studio-onboarding');
  }
});
