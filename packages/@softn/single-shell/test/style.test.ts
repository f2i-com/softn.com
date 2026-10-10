/**
 * The shell's own screens stay the shell's.
 *
 * "Loading" and "Unable to open this application" are drawn inside
 * `.application-content`, the box the app is drawn in. When an app's project
 * declares the other side from the deployment's `theme`, that box is given
 * the app's ground and text colour (@softn/components, ThemeProvider). The
 * shell's screens were written for the shell's dark page, and their button
 * keeps a dark background of its own: in a light app's box "Try again" became
 * dark text on a dark button. They carry the page's colours themselves now,
 * so they look as they did wherever they are drawn.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Without its comments, so a rule is found whatever is written above it.
const css = readFileSync(fileURLToPath(new URL('../src/style.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule with exactly this selector. */
function rule(selector: string): Record<string, string> {
  const pattern = new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const body = css.match(pattern)?.[1] ?? '';
  return Object.fromEntries(
    body
      .split(';')
      .map((line) => line.split(':').map((part) => part.trim()))
      .filter((parts) => parts.length === 2 && parts[0])
  );
}

it('draws the shell’s own screens in the shell’s colours inside the app’s box', () => {
  const page = rule('.single-app');
  const screen = rule('.application-content .loading');
  expect(page.background).toBeTruthy();
  expect(page.color).toBeTruthy();
  expect(screen.background).toBe(page.background);
  expect(screen.color).toBe(page.color);
});
