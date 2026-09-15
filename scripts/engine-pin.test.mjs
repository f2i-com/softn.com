/**
 * One ZIPP release for the whole repository.
 *
 * The browser runtime runs `.logic` on the engine installed under
 * packages/@softn/core/wasm-zipp/ from a ZIPP release (npm run fetch:zipp;
 * SOURCE.json names the release and the commit it was built from); the Rust
 * host (apps/softn-host-rust) runs the same language on the `zipp-vm` crate,
 * taken from that release's tag. This pins the two to one release and one
 * commit: move the Cargo tag (and Cargo.lock) and the installed release
 * together, or an app behaves one way in the browser and another on the
 * server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = JSON.parse(fs.readFileSync(new URL('../packages/@softn/core/wasm-zipp/SOURCE.json', import.meta.url), 'utf8'));
const cargo = fs.readFileSync(new URL('../apps/softn-host-rust/Cargo.toml', import.meta.url), 'utf8');
const lock = fs.readFileSync(new URL('../apps/softn-host-rust/Cargo.lock', import.meta.url), 'utf8');
const cargoTag = cargo.match(/^zipp-vm\s*=\s*\{[^}]*tag\s*=\s*"([^"]+)"/m)?.[1];

test('the browser engine is a verified ZIPP release install, not a local build', () => {
  assert.equal(source.build, 'release', 'wasm-zipp/SOURCE.json build (npm run fetch:zipp)');
  const script = fileURLToPath(new URL('../packages/@softn/core/scripts/fetch-zipp-release.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ZIPP_/i.test(key)));
  const check = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', env });
  assert.equal(check.status, 0, `fetch-zipp-release.mjs --check:\n${check.stdout}${check.stderr}`);
});

test('the Rust host takes zipp-vm from the release the browser engine was installed from', () => {
  const dependency = cargo.match(/^zipp-vm\s*=\s*\{([^}]*)\}/m);
  assert.ok(dependency, 'apps/softn-host-rust/Cargo.toml declares zipp-vm');
  const git = dependency[1].match(/git\s*=\s*"([^"]+)"/);
  assert.ok(git && cargoTag, 'zipp-vm is a git dependency on a release tag, not a sibling checkout');
  assert.equal(git[1].replace(/\.git$/, ''), source.repository.replace(/\.git$/, ''), 'the same ZIPP repository');
  assert.equal(cargoTag, source.release, `Cargo tag ${cargoTag} vs installed engine ${source.release}`);
  assert.ok(/features\s*=\s*\[[^\]]*"instrument"/.test(dependency[1]), 'the step budget stays on');
});

// A tag names a commit only until it moves; the lock records which one cargo
// built, and that has to be the commit the browser engine reports.
test('Cargo.lock resolves zipp-vm and zipp-regress to that release\'s commit', () => {
  for (const name of ['zipp-vm', 'zipp-regress']) {
    const entry = lock.match(new RegExp(`\\[\\[package\\]\\]\\s+name = "${name}"\\s+version = "[^"]*"\\s+source = "([^"]+)"`));
    assert.ok(entry, `Cargo.lock has ${name}`);
    const pinned = entry[1].match(/^git\+([^?#]+)\?tag=([^#]+)#([0-9a-f]{40})$/);
    assert.ok(pinned, `${name} comes from a git tag: ${entry[1]}`);
    assert.equal(pinned[1].replace(/\.git$/, ''), source.repository.replace(/\.git$/, ''), `${name} repository`);
    assert.equal(pinned[2], cargoTag, `${name} is locked at the Cargo tag`);
    assert.equal(pinned[3], source.revision, `${name} is locked at commit ${pinned[3]}, the installed engine was built from ${source.revision}`);
  }
});
