/**
 * Every host that runs a bundle hands the renderer the app's Python project.
 *
 * The composer returns a Python app's modules as `python`, beside the markup,
 * and the renderer runs them only when it is given that prop. For a while the
 * shared `processBundle` was typed as three of the composition's fields, each
 * host passed on exactly those three, and a Python app opened in the web
 * runtime, the single-app shell or the desktop loader as a page with no logic
 * at all — while the Builder's preview and every engine test worked, because
 * they build the prop themselves. Rendering each host needs the engine and a
 * browser; this reads each render site instead, so a host that drops the prop
 * again fails here, by name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './release-packages.mjs';

/** Each host's file that renders a bundle, and how it forwards the project. */
const HOSTS = [
  { file: 'apps/softn-web/src/App.tsx', forwards: /python=\{tab\.python\}/ },
  { file: 'apps/softn-web/src/components/AppRunner.tsx', forwards: /python=\{python\}/ },
  { file: 'packages/@softn/single-shell/src/SingleApp.tsx', forwards: /python=\{app\.python\}/ },
  { file: 'apps/softn-loader/src/App.tsx', forwards: /python=\{python\}/ },
  // FormLogic's host spreads the whole composition into the renderer.
  { file: 'apps/formlogic-host/src/main.tsx', forwards: /<SoftNWithXDB \{\.\.\.composed\}/ },
];

for (const { file, forwards } of HOSTS) {
  test(`${file} forwards the Python project to the renderer`, () => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, forwards);
  });
}

test('processBundle is declared as the whole composition, not a subset of its fields', () => {
  const source = fs.readFileSync(path.join(root, 'packages/@softn/runtime-shell/src/bundleProcessor.ts'), 'utf8');
  assert.match(source, /export function processBundle\([^)]*\): ComposedBundleSource \{/s);
});
