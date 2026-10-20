/**
 * A start removes the folders earlier runs left behind, and nothing that
 * may still be in use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRunning, ownedTempDir, removeOrphans } from './owned-temp-dir.mjs';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-owned-temp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('only folders whose owner has ended are removed', (t) => {
  const dir = scratch(t);
  for (const name of ['p-4242-aaaaaa', 'p-5151-bbbbbb', `p-${process.pid}-cccccc`, 'p-dddddd', 'p-12abcd', 'other-4242-eeeeee']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'state.json'), '{}');
  }
  const removed = removeOrphans('p-', dir, (pid) => pid === 5151);
  assert.deepEqual(removed, ['p-4242-aaaaaa']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['other-4242-eeeeee', `p-${process.pid}-cccccc`, 'p-12abcd', 'p-5151-bbbbbb', 'p-dddddd'].sort());
});

test('a new folder carries this process id, and a run sees it as its own', (t) => {
  const dir = scratch(t);
  const made = ownedTempDir('p-', dir);
  assert.match(path.basename(made), new RegExp(`^p-${process.pid}-`));
  assert.deepEqual(removeOrphans('p-', dir), []);
  assert.equal(fs.existsSync(made), true);
});

test('this process is running, and an id no process has is not', () => {
  assert.equal(isRunning(process.pid), true);
  assert.equal(isRunning(2 ** 31 - 2), false);
});
