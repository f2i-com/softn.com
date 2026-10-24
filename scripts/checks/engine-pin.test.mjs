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

const source = JSON.parse(fs.readFileSync(new URL('../../packages/@softn/core/wasm-zipp/SOURCE.json', import.meta.url), 'utf8'));
const cargo = fs.readFileSync(new URL('../../apps/softn-host-rust/Cargo.toml', import.meta.url), 'utf8');
const lock = fs.readFileSync(new URL('../../apps/softn-host-rust/Cargo.lock', import.meta.url), 'utf8');
const cargoTag = cargo.match(/^zipp-vm\s*=\s*\{[^}]*tag\s*=\s*"([^"]+)"/m)?.[1];

test('the browser engine is a verified ZIPP release install, not a local build', () => {
  assert.equal(source.build, 'release', 'wasm-zipp/SOURCE.json build (npm run fetch:zipp)');
  const script = fileURLToPath(new URL('../../packages/@softn/core/scripts/fetch-zipp-release.mjs', import.meta.url));
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
  // The profile the browser engine is built with (the installer requires it
  // of the module), which carries the step budget and the regex ceiling.
  assert.ok(/features\s*=\s*\[[^\]]*"safe-sandbox"/.test(dependency[1]), 'the host runs untrusted logic on ZIPP\'s safe-sandbox profile');
  assert.ok(/default-features\s*=\s*false/.test(dependency[1]), 'the JIT, which safe-sandbox excludes, is not taken by default');
});

// A tag names a commit only until it moves; the lock records which one cargo
// built, and that has to be the commit the browser engine reports.
// Every crate cargo takes from the ZIPP repository is held to it, not only the
// two named: 0.0.23 brought zipp-numparse in through zipp-vm.
test('Cargo.lock resolves zipp-vm, zipp-regress and every other ZIPP crate to that release\'s commit', () => {
  const repository = source.repository.replace(/\.git$/, '');
  const fromZipp = [...lock.matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "[^"]*"\s+source = "git\+([^?#"]+)[^"]*"/g)]
    .filter((entry) => entry[2].replace(/\.git$/, '') === repository)
    .map((entry) => entry[1]);
  for (const name of ['zipp-vm', 'zipp-regress']) assert.ok(fromZipp.includes(name), `Cargo.lock has ${name} from ${repository}`);
  for (const name of fromZipp) {
    const entry = lock.match(new RegExp(`\\[\\[package\\]\\]\\s+name = "${name}"\\s+version = "[^"]*"\\s+source = "([^"]+)"`));
    assert.ok(entry, `Cargo.lock has ${name}`);
    const pinned = entry[1].match(/^git\+([^?#]+)\?tag=([^#]+)#([0-9a-f]{40})$/);
    assert.ok(pinned, `${name} comes from a git tag: ${entry[1]}`);
    assert.equal(pinned[1].replace(/\.git$/, ''), repository, `${name} repository`);
    assert.equal(pinned[2], cargoTag, `${name} is locked at the Cargo tag`);
    assert.equal(pinned[3], source.revision, `${name} is locked at commit ${pinned[3]}, the installed engine was built from ${source.revision}`);
  }
});

// softn-runner's guest (apps/softn-runner) is the PHP host's server engine
// compiled for WASI, so it moves with the other two: its build refuses any
// other commit, and this says so before anyone builds it.
test('softn-runner\'s guest takes zipp-vm from the same release and commit, with the browser engine\'s profile', () => {
  const guestCargo = fs.readFileSync(new URL('../../apps/softn-runner/guest/Cargo.toml', import.meta.url), 'utf8');
  const guestLock = fs.readFileSync(new URL('../../apps/softn-runner/guest/Cargo.lock', import.meta.url), 'utf8');
  const dependency = guestCargo.match(/^zipp-vm\s*=\s*\{([^}]*)\}/m);
  assert.ok(dependency, 'apps/softn-runner/guest/Cargo.toml declares zipp-vm');
  assert.equal(dependency[1].match(/tag\s*=\s*"([^"]+)"/)?.[1], source.release, 'the guest\'s zipp-vm tag');
  assert.ok(/features\s*=\s*\[[^\]]*"safe-sandbox"/.test(dependency[1]) && /default-features\s*=\s*false/.test(dependency[1]), 'the guest runs on safe-sandbox, without the JIT');
  const sources = [...guestLock.matchAll(/^source = "(git\+[^"]+)"$/gm)].map((entry) => entry[1]);
  assert.ok(sources.length > 0, 'the guest\'s Cargo.lock takes crates from ZIPP');
  const repository = source.repository.replace(/\.git$/, '');
  for (const entry of sources) {
    const pinned = entry.match(/^git\+([^?#]+)\?tag=([^#]+)#([0-9a-f]{40})$/);
    assert.ok(pinned && pinned[1].replace(/\.git$/, '') === repository, `the guest takes git crates only from ZIPP's tags: ${entry}`);
    assert.equal(pinned[2], source.release, 'locked at the release tag');
    assert.equal(pinned[3], source.revision, `locked at commit ${pinned[3]}, the installed engine was built from ${source.revision}`);
  }
});
