/**
 * One ZIPP release for the whole repository.
 *
 * The browser runtime runs `.logic` on the engine vendored under
 * packages/@softn/core/wasm-zipp/ (SOURCE.json names the release it was
 * built from); the Rust host (apps/softn-host-rust) runs the same language
 * on the `zipp-vm` crate, taken from ZIPP's release tag. This pins the two
 * to one version: bump SOURCE.json (npm run build:zipp-wasm) and the Cargo
 * tag together, or an app behaves one way in the browser and another on the
 * server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = JSON.parse(fs.readFileSync(new URL('../packages/@softn/core/wasm-zipp/SOURCE.json', import.meta.url), 'utf8'));
const cargo = fs.readFileSync(new URL('../apps/softn-host-rust/Cargo.toml', import.meta.url), 'utf8');

test('the Rust host takes zipp-vm from the release the vendored engine was built from', () => {
  const dependency = cargo.match(/^zipp-vm\s*=\s*\{([^}]*)\}/m);
  assert.ok(dependency, 'apps/softn-host-rust/Cargo.toml declares zipp-vm');
  const git = dependency[1].match(/git\s*=\s*"([^"]+)"/);
  const tag = dependency[1].match(/tag\s*=\s*"([^"]+)"/);
  assert.ok(git && tag, 'zipp-vm is a git dependency on a release tag, not a sibling checkout');
  assert.equal(git[1].replace(/\.git$/, ''), source.repository.replace(/\.git$/, ''), 'the same ZIPP repository');
  assert.equal(tag[1], `v${source.version}`, `Cargo tag ${tag[1]} vs vendored engine ${source.version}`);
  assert.ok(/features\s*=\s*\[[^\]]*"instrument"/.test(dependency[1]), 'the step budget stays on');
});
