/**
 * The shell's own screens take their ground and text from where they are
 * drawn.
 *
 * "Loading" and "Unable to open this application" are drawn on the page
 * before the app is known, and inside `.application-content`, the box the app
 * is drawn in, while it starts. The page is coloured for the side the app's
 * project declares where a server knows it (a directory's play page, the
 * privately served page), and that box is given the app's ground and text
 * colour when that side is not the deployment's (@softn/components,
 * ThemeProvider). The shell painted both screens a fixed dark of its own
 * over them, so a light app on a dark deployment opened light, turned dark
 * while it loaded, and turned light again. Its "Try again" button is drawn
 * from the text colour, so it reads on either side.
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

const HEX = /#[0-9a-f]{3,8}\b/i;

it.each(['.single-app', '.application-content .loading'])('%s draws on the ground it is drawn on, in its text colour', (selector) => {
  const declared = rule(selector);
  expect(declared.background ?? 'transparent').toBe('transparent');
  expect(declared.color ?? 'inherit').toBe('inherit');
  expect(declared['background-color']).toBeUndefined();
});

it('draws the button on the shell’s screens from the text colour, not a dark of its own', () => {
  const button = rule('.loading button');
  expect(button.background).toMatch(/currentColor/);
  expect(button.background).not.toMatch(HEX);
  expect(button.border ?? button['border-color']).toMatch(/currentColor/);
});
