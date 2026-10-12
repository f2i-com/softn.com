/**
 * serve-topology.mjs says it "exits non-zero rather than pretending": a gate
 * whose server did not come up, or whose directory did not seed, must not
 * report success. Once PHP had been started it did: the failure called
 * process.exit(1), the script's own 'exit' handler then called
 * process.exit(0) to clean up, and the later code is the one the process
 * ends with.
 *
 * The root here is a stand-in whose API answers /api/health and nothing
 * else, so the server comes up and the seeding request fails. Needs `php`
 * on PATH, like the script; without it there is nothing to start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./serve-topology.mjs', import.meta.url));
const havePhp = spawnSync('php', ['-v'], { encoding: 'utf8' }).status === 0;

test('a directory that cannot be seeded ends the script with a failure', { skip: havePhp ? false : 'php is not on PATH' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-topology-test-'));
  t.after(() => {
    const checked = fs.realpathSync(root);
    assert.equal(path.dirname(checked), fs.realpathSync(os.tmpdir()));
    fs.rmSync(checked, { recursive: true, force: true });
  });
  for (const file of ['index.html', 'web/index.html', 'studio/index.html', 'builder/index.html', 'play/index.html', 'api/index.php', 'demos/index.json']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file.endsWith('.json') ? '[]' : '');
  }
  fs.writeFileSync(
    path.join(root, 'api/router.php'),
    `<?php
if (parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) === '/api/health') {
    header('Content-Type: application/json');
    echo '{"ok":true}';
    return true;
}
http_response_code(500);
echo 'this stand-in has no directory';
return true;
`,
  );

  const run = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', timeout: 60_000 });
  assert.match(run.stderr, /serve-topology: the directory (?:could not be seeded|did not answer its listing)/);
  assert.equal(run.status, 1, 'the failure is the exit code');
});
