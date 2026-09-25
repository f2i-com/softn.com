/**
 * Studio's first visit.
 *
 * With no AI provider configured and the setup not skipped — a fresh
 * browser, which is what every Playwright context is — Studio opens on its
 * onboarding step: "Connect an AI provider." with the provider setup, and a
 * way to look around without one. Skipping it takes the step away and leaves
 * the rest of the home page usable.
 */
import { expect, test } from '@playwright/test';
import { watchConsole } from '../helpers/console';

test('a first visit to Studio asks to connect an AI provider, and can be skipped', async ({
  page,
}, testInfo) => {
  const log = watchConsole(page, testInfo);
  try {
    await page.goto('/studio/');
    const heading = page.getByRole('heading', { name: 'Connect an AI provider.', exact: true });
    await expect(heading).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Just looking? The examples run without any AI.')).toBeVisible();

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
