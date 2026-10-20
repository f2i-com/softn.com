/**
 * A build leaves out the parts of public/ that only the dev server reads:
 * SoftN Web's demos/ used to ride along in every build, 21 MB that nothing
 * in production requested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devOnlyPublicPlugin } from './dev-only-public.mjs';
import { repoRoot } from '../lib/paths.mjs';

test('the named folders are removed from the build output, and nothing else', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-dev-only-public-'));
  try {
    fs.mkdirSync(path.join(root, 'dist/demos/thumbs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/demos/index.json'), '[]');
    fs.writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html>');
    const plugin = devOnlyPublicPlugin(['demos']);
    assert.equal(plugin.apply, 'build', 'the dev server keeps serving the folder');
    plugin.configResolved({ root, build: { outDir: 'dist' } });
    plugin.closeBundle();
    assert.equal(fs.existsSync(path.join(root, 'dist/demos')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist/index.html')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SoftN Web leaves out its demo catalogue, which it reads only under the dev server', () => {
  const config = fs.readFileSync(path.join(repoRoot, 'apps/softn-web/vite.config.ts'), 'utf8');
  assert.match(config, /devOnlyPublicPlugin\(\['demos'\]\)/);
  const app = fs.readFileSync(path.join(repoRoot, 'apps/softn-web/src/App.tsx'), 'utf8');
  assert.match(app, /if \(!import\.meta\.env\.DEV\) return null;\s*try \{\s*const response = await fetch\(publicPath\('demos\/index\.json'/);
});
