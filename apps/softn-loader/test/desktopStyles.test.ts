/**
 * The shell's own screens stay the shell's.
 *
 * "Starting your app…" and the screen for an app that could not start are
 * drawn inside the content area, the box the app is drawn in. When an app's
 * project declares the other side from this shell's theme, that box is given
 * the app's ground and text colour (@softn/components, ThemeProvider), and a
 * screen written in the shell's own dim text would stand on it: the light
 * theme's grey on a dark app's ground. The screens carry the shell's ground
 * and text colour themselves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Without its comments, so a rule is found whatever is written above it.
const css = readFileSync(fileURLToPath(new URL('../src/desktop.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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

it('draws the shell’s own screens on the shell’s ground inside the app’s box', () => {
  const shell = rule('.desktop-shell');
  const screen = rule('.desktop-state');
  expect(shell.background).toBeTruthy();
  expect(shell.color).toBeTruthy();
  expect(screen.background).toBe(shell.background);
  expect(screen.color).toBe(shell.color);
});
