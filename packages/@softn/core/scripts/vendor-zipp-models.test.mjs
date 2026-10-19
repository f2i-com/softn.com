import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VENDOR_DIR, checkVendored } from './vendor-zipp-models.mjs';

test('the vendored ZIPP model stack is exactly what SOURCE.json records', () => {
  assert.deepEqual(checkVendored(), []);
  const source = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'SOURCE.json'), 'utf8'));
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  // The Python a plugin installs is hashed by its own plugin.json as well; the
  // two records must agree, or the worker would refuse what this test accepts.
  const plugin = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'model-plugins/plugins/qwen3/plugin.json'), 'utf8'));
  for (const [file, digest] of Object.entries(plugin.sources)) {
    assert.equal(source.files[`model-plugins/plugins/qwen3/${file}`], digest, file);
  }
});

test('a changed, missing or extra file is named', (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-zipp-models-'));
  t.after(() => {
    assert.ok(path.basename(copy).startsWith('softn-zipp-models-'));
    fs.rmSync(copy, { recursive: true, force: true });
  });
  fs.cpSync(VENDOR_DIR, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'model-plugins/plugins/qwen3/graph.py'), '\n');
  fs.rmSync(path.join(copy, 'gpu-lab/NOTICE'));
  fs.writeFileSync(path.join(copy, 'gpu-lab/extra.mjs'), 'export {};');
  const problems = checkVendored(copy);
  assert.ok(problems.some((p) => p.startsWith('model-plugins/plugins/qwen3/graph.py is not the vendored')), problems.join('\n'));
  assert.ok(problems.includes('gpu-lab/NOTICE is missing'), problems.join('\n'));
  assert.ok(problems.includes('gpu-lab/extra.mjs is not a vendored file'), problems.join('\n'));
});
