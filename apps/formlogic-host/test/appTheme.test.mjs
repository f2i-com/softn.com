// node --test apps/formlogic-host/test/appTheme.test.mjs
// (Node 24 runs the TypeScript modules directly; they use only erasable syntax.)
//
// The side an embedded app is drawn in. Every other host hands the theme
// provider the project's `config.theme.mode`, and a project that declares
// "light" or "dark" is drawn in that side whatever the host's theme is; this
// frame handed it only FormLogic's `dark`, so the same project was dark in
// the web runtime and light in FormLogic. What the provider does with the
// two is tested where it lives (@softn/components, app-theme and the
// provider's own tests); here, that the frame reads the manifest without
// tripping on its shape and hands both over.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredThemeMode } from '../src/appTheme.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(here, '../src/main.tsx'), 'utf8');

test('the mode is read from the manifest as it stands', () => {
  assert.equal(declaredThemeMode({ config: { theme: { mode: 'dark' } } }), 'dark');
  assert.equal(declaredThemeMode({ config: { theme: { mode: 'light' } } }), 'light');
  assert.equal(declaredThemeMode({ config: { theme: { mode: 'system' } } }), 'system');
  // Handed over whatever it is: which words decide anything is the rule's (app-theme.ts), not this frame's.
  assert.equal(declaredThemeMode({ config: { theme: { mode: 'sepia' } } }), 'sepia');
});

test('a manifest that declares none, or is not shaped like one, declares nothing and does not throw', () => {
  for (const manifest of [{}, { config: {} }, { config: { theme: {} } }, { config: null }, { config: 'dark' }, { config: { theme: 'dark' } }, { config: { theme: null } }, { config: [] }, null, undefined, 'dark', 7, []]) {
    assert.equal(declaredThemeMode(manifest), undefined, JSON.stringify(manifest));
  }
});

test('the frame hands the provider the declared mode beside FormLogic\'s own', () => {
  const provider = /<ThemeProvider\b[^>]*>/.exec(main)?.[0] ?? '';
  assert.match(provider, /defaultDarkMode=\{event\.data\.dark === true\}/, 'FormLogic\'s theme is still what a project that declares nothing follows');
  assert.match(provider, /declaredMode=\{declaredThemeMode\(manifest\)\}/);
  // One app is the whole document here, so the side is written on the document and no box is named.
  assert.doesNotMatch(provider, /\bbox=/);
});
