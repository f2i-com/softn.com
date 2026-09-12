import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { apiDir, copyDir, makeBundle, skip } from './helpers/harness.mjs';

// Exercise the real seeder with source and deployment layouts in one temporary
// checkout. A deployment inside a repo must not silently borrow its demos.
for (const [layout, enabled, expected] of [['source', true, ['layout-demo']], ['source', false, []], ['built', true, []]]) {
  test(`demo discovery: ${layout}, seeding ${enabled ? 'on' : 'off'}`, skip, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-seed-layout-'));
    try {
      const api = path.join(fixture, layout === 'source' ? 'apps/softn-api' : 'dist/api');
      copyDir(apiDir, api);
      const demos = path.join(fixture, 'apps/softn-web/public/demos');
      fs.mkdirSync(demos, { recursive: true });
      fs.writeFileSync(path.join(demos, 'Layout.softn'), makeBundle('Layout demo'));
      fs.writeFileSync(path.join(demos, 'index.json'), JSON.stringify([{ id: 'layout-demo', name: 'Layout demo', file: 'Layout.softn' }]));
      const data = path.join(fixture, 'data');
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ seedDemos: enabled }));
      const script = path.join(api, 'seed-check.php');
      fs.writeFileSync(script, `<?php
foreach (['http', 'db', 'catalog', 'bundle', 'apps', 'social', 'storage', 'seed', 'pages'] as $file) require __DIR__ . '/lib/' . $file . '.php';
Seed::ifEmpty();
echo json_encode(array_keys(Catalog::all()));
`);
      const result = spawnSync('php', [script], { encoding: 'utf8', env: { ...process.env, SOFTN_DATA_DIR: data } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    } finally {
      // Only remove the exact temporary directory created by this test.
      const resolved = path.resolve(fixture);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('softn-seed-layout-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
}
