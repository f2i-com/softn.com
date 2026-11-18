import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { previousClassicGroups } from './sw-classic-upgrade.js';

const tags = { Input: 'controls', Select: 'controls', Tabs: 'navigation' };
const ready = (features, format) => ({ format, offline: { ready: true, features } });

test('an update retrieves the renderer and groups the previous Runtime installed for a classic app', () => {
  assert.deepEqual(previousClassicGroups(ready(['Tabs', 'Input', 'Select', 'engine:full'], 'classic'), tags),
    ['renderer', 'navigation', 'controls', 'script']);
  assert.deepEqual(previousClassicGroups(ready(['Tabs']), tags), ['renderer', 'navigation']);
  assert.deepEqual(previousClassicGroups(ready([], 'classic'), tags), ['renderer']);
});

test('old web records carry a container tier and fresh or unfinished apps require no migration', () => {
  assert.deepEqual(previousClassicGroups(ready(['engine:lite']), tags), []);
  assert.deepEqual(previousClassicGroups(ready(['engine:javascript', 'three']), tags), []);
  assert.deepEqual(previousClassicGroups(ready([], 'web'), tags), []);
  assert.deepEqual(previousClassicGroups({ format: 'classic' }, tags), []);
  assert.deepEqual(previousClassicGroups({ offline: { ready: false, features: ['Input'] } }, tags), []);
});

test('the upgrade scanner reads a linked classic page that the old install had never visited', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./classic-upgrade-scan.ts', import.meta.url))],
    bundle: true, format: 'esm', write: false,
  });
  const { scan } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
  const archive = zipSync({
    'ui/main.ui': strToU8('<div><a href="settings.html">Settings</a></div>'),
    'ui/settings.html': strToU8('<div><button onclick="this.textContent = Date.now()">Save</button><tabs /></div>'),
    'assets/notes.txt': strToU8('The <Input> control is optional.'),
  });
  assert.deepEqual(scan(archive, tags).sort(), ['navigation', 'script']);
});
