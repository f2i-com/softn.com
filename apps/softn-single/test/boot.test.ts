/**
 * The page's loading wheel is drawn in the text colour around it.
 *
 * The wheel this page styles is also the one the shell draws on its own
 * loading screens, which take the ground they are drawn on: the app's box,
 * which is light for an app whose project declares light. Drawn in a fixed
 * near-white, it could not be seen there. The privately served page's
 * template draws it the same way (apps/softn-single-private/scripts/shell.mjs).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

it('draws the wheel from the text colour', () => {
  const wheel = /\.wheel\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  expect(wheel).toMatch(/border:\s*3px solid color-mix\(in srgb, currentColor \d+%, transparent\)/);
  expect(wheel).toMatch(/border-top-color:\s*currentColor/);
  expect(wheel).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});

it('keeps the boot screen dark, as a standalone deployment opens', () => {
  const page = /html,\s*body\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  expect(page).toMatch(/background:\s*#171821/);
  expect(page).toMatch(/color:\s*#f5f5f8/);
});
