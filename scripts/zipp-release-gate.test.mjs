/**
 * The release gate freezes one ZIPP release for a SoftN release run: the
 * zipp-vm tag Cargo.toml declares, only while it is ZIPP's latest release
 * (or with allow-older-zipp), with the digest of that release's SHA256SUMS.
 * GitHub is a stubbed fetch throughout. The workflows are read as text: each
 * job that builds installs that release before anything reads wasm-zipp/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, ZippReleaseError, sha256 } from '../packages/@softn/core/scripts/fetch-zipp-release.mjs';
import { outputLines, summaryLine, zippReleaseGate } from './zipp-release-gate.mjs';
import { root } from './release-packages.mjs';

const LATEST = `${REPOSITORY}/releases/latest/download/SHA256SUMS`;
const tagged = (tag) => `${REPOSITORY}/releases/download/${tag}/SHA256SUMS`;
const sumsFor = (version, digit) => Buffer.from(`${digit.repeat(64)}  zipp-wasm-${version}-web.zip\n${digit.repeat(64)}  zipp-wasm-${version}-web-python.zip\n`);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipp-release-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cargoToml(dir, tag) {
  const file = path.join(dir, 'Cargo.toml');
  fs.writeFileSync(file, `[dependencies]\nzipp-vm = { git = "${REPOSITORY}", tag = "${tag}", features = ["instrument"] }\n`);
  return file;
}

/** GitHub as it would answer, with v0.0.18 and v0.0.19 published and `latest` naming one of them. */
function github(latest) {
  const published = new Map([[tagged('v0.0.18'), sumsFor('0.0.18', '1')], [tagged('v0.0.19'), sumsFor('0.0.19', '2')]]);
  published.set(LATEST, published.get(tagged(latest)));
  const calls = [];
  const fetch = async (url) => (calls.push(url), published.has(url) ? new Response(published.get(url)) : new Response('', { status: 404 }));
  return { calls, fetch, published };
}

test('the declared release is the latest: its tag and SHA256SUMS digest are the outputs', async (t) => {
  const gh = github('v0.0.18');
  const outputs = await zippReleaseGate({ cargoToml: cargoToml(tempDir(t), 'v0.0.18'), fetch: gh.fetch });
  assert.deepEqual(outputs, { 'zipp-release': 'v0.0.18', 'zipp-sums-sha256': sha256(sumsFor('0.0.18', '1')), 'zipp-latest': 'v0.0.18', 'zipp-older-allowed': 'false' });
  assert.deepEqual(gh.calls, [LATEST, tagged('v0.0.18')], 'the latest redirect, then the tag\'s own SHA256SUMS; no API call');
  assert.equal(outputLines(outputs), `zipp-release=v0.0.18\nzipp-sums-sha256=${sha256(sumsFor('0.0.18', '1'))}\nzipp-latest=v0.0.18\nzipp-older-allowed=false\n`);
  assert.match(summaryLine(outputs), /^ZIPP release: v0\.0\.18, the latest release; SHA256SUMS sha256 [0-9a-f]{64}\n$/);
});

test('a newer ZIPP release fails the gate with what to do', async (t) => {
  await assert.rejects(
    zippReleaseGate({ cargoToml: cargoToml(tempDir(t), 'v0.0.18'), fetch: github('v0.0.19').fetch }),
    (error) => error instanceof ZippReleaseError && error.message === 'ZIPP v0.0.19 is published; bump apps/softn-host-rust/Cargo.toml zipp-vm tag and Cargo.lock, or release with allow-older-zipp',
  );
});

test('allow-older-zipp ships the declared release, with that release\'s own SHA256SUMS digest', async (t) => {
  const gh = github('v0.0.19');
  const outputs = await zippReleaseGate({ cargoToml: cargoToml(tempDir(t), 'v0.0.18'), allowOlder: true, fetch: gh.fetch });
  assert.deepEqual(outputs, { 'zipp-release': 'v0.0.18', 'zipp-sums-sha256': sha256(sumsFor('0.0.18', '1')), 'zipp-latest': 'v0.0.19', 'zipp-older-allowed': 'true' });
  assert.notEqual(outputs['zipp-sums-sha256'], sha256(gh.published.get(LATEST)), 'not the latest release\'s digest');
  assert.match(summaryLine(outputs), /, not the latest release v0\.0\.19 \(allow-older-zipp\);/);
});

test('a declared release that is newer than the latest (a pre-release) is refused the same way, and allowed the same way', async (t) => {
  await assert.rejects(
    zippReleaseGate({ cargoToml: cargoToml(tempDir(t), 'v0.0.19'), fetch: github('v0.0.18').fetch }),
    (error) => error instanceof ZippReleaseError && error.message === 'apps/softn-host-rust/Cargo.toml declares ZIPP v0.0.19, but ZIPP\'s latest release is v0.0.18; release once v0.0.19 is the latest, or release with allow-older-zipp',
  );
  const gh = github('v0.0.18');
  const outputs = await zippReleaseGate({ cargoToml: cargoToml(tempDir(t), 'v0.0.19'), allowOlder: true, fetch: gh.fetch });
  assert.deepEqual(outputs, { 'zipp-release': 'v0.0.19', 'zipp-sums-sha256': sha256(sumsFor('0.0.19', '2')), 'zipp-latest': 'v0.0.18', 'zipp-older-allowed': 'true' });
  assert.deepEqual(gh.calls, [LATEST, tagged('v0.0.18'), tagged('v0.0.19')], 'the declared tag\'s own SHA256SUMS');
  // Allowed only when it is published with its web-python bundle.
  await assert.rejects(zippReleaseGate({ cargoToml: cargoToml(tempDir(t), 'v0.0.20'), allowOlder: true, fetch: github('v0.0.18').fetch }), /releases\/download\/v0\.0\.20\/SHA256SUMS answered 404/);
});

test('a Cargo.toml without a zipp-vm release tag is refused before GitHub is asked', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'Cargo.toml');
  fs.writeFileSync(file, '[dependencies]\nzipp-vm = { path = "../../../zipp.org/crates/zipp-vm" }\n');
  const gh = github('v0.0.18');
  await assert.rejects(zippReleaseGate({ cargoToml: file, fetch: gh.fetch }), /declares no zipp-vm release tag/);
  assert.deepEqual(gh.calls, []);
});

test('the gate runs with no node_modules and writes GITHUB_OUTPUT and the step summary', (t) => {
  // A copy of the two scripts, and the one repository file the fetch script
  // imports (the WebAssembly section reader), in the layout they expect, far
  // from node_modules, with fetch stubbed before the gate loads: the release
  // gate job runs no npm ci.
  const tree = tempDir(t);
  for (const rel of ['scripts/zipp-release-gate.mjs', 'scripts/lib/zipp-engine-copy.mjs', 'packages/@softn/core/scripts/fetch-zipp-release.mjs']) {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(tree, rel));
  }
  fs.mkdirSync(path.join(tree, 'apps/softn-host-rust'), { recursive: true });
  fs.renameSync(cargoToml(tree, 'v0.0.18'), path.join(tree, 'apps/softn-host-rust/Cargo.toml'));
  const responses = path.join(tree, 'responses.json');
  const serve = (map) => fs.writeFileSync(responses, JSON.stringify(Object.fromEntries(Object.entries(map).map(([url, bytes]) => [url, bytes.toString('base64')]))));
  const stub = path.join(tree, 'stub-fetch.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs';\nconst r = JSON.parse(fs.readFileSync(process.env.STUB_RESPONSES, 'utf8'));\nglobalThis.fetch = async (url) => (url in r ? new Response(Buffer.from(r[url], 'base64')) : new Response('', { status: 404 }));\n`);
  assert.notEqual(spawnSync(process.execPath, ['--input-type=module', '-e', "await import('fflate')"], { cwd: tree }).status, 0, 'no node_modules is reachable from the copy');
  const output = path.join(tree, 'github-output');
  const summary = path.join(tree, 'step-summary');
  const gate = (env = {}) =>
    spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, path.join(tree, 'scripts/zipp-release-gate.mjs')], {
      cwd: tree,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, STUB_RESPONSES: responses, GITHUB_OUTPUT: output, ...env },
    });

  serve({ [LATEST]: sumsFor('0.0.18', '1'), [tagged('v0.0.18')]: sumsFor('0.0.18', '1') });
  const run = gate({ GITHUB_STEP_SUMMARY: summary });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(fs.readFileSync(output, 'utf8'), `zipp-release=v0.0.18\nzipp-sums-sha256=${sha256(sumsFor('0.0.18', '1'))}\nzipp-latest=v0.0.18\nzipp-older-allowed=false\n`);
  assert.match(fs.readFileSync(summary, 'utf8'), /^ZIPP release: v0\.0\.18/);

  // A newer latest: the job fails and writes no outputs, unless allow-older-zipp.
  serve({ [LATEST]: sumsFor('0.0.19', '2'), [tagged('v0.0.19')]: sumsFor('0.0.19', '2'), [tagged('v0.0.18')]: sumsFor('0.0.18', '1') });
  fs.rmSync(output);
  const refused = gate();
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /ZIPP v0\.0\.19 is published/);
  assert.ok(!fs.existsSync(output));
  const allowed = gate({ ALLOW_OLDER_ZIPP: 'true' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(fs.readFileSync(output, 'utf8'), /^zipp-release=v0\.0\.18\n.*zipp-latest=v0\.0\.19\nzipp-older-allowed=true\n$/s);
});

// ---------------------------------------------------------------------------
// The workflows: who resolves, who installs, and in which order
// ---------------------------------------------------------------------------
const workflow = (name) => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8').replace(/\r\n/g, '\n');

/** One job's text: from `  <id>:` under jobs: to the next job. */
function job(text, id) {
  const jobs = text.slice(text.indexOf('\njobs:\n'));
  const start = jobs.search(new RegExp(`\\n  ${id}:\\n`));
  assert.ok(start >= 0, `job ${id}`);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

/** Each string appears in the job, in this order. */
function inOrder(text, id, ...needles) {
  let at = -1;
  for (const needle of needles) {
    const found = text.indexOf(needle, at + 1);
    assert.ok(found > at, `${id}: "${needle}" comes after "${needles[needles.indexOf(needle) - 1] ?? '(start)'}"`);
    at = found;
  }
}

const INSTALL = 'run: node packages/@softn/core/scripts/fetch-zipp-release.mjs --ensure';

test('release.yml resolves ZIPP once in the gate and every job builds against that one release', () => {
  const release = workflow('release.yml');
  assert.ok(/\n {6}allow-older-zipp:\n/.test(release), 'a workflow_dispatch input');
  const gate = job(release, 'gate');
  // A dispatch retry of a tag from before the gate existed is refused by name, not with a missing module.
  inOrder(gate, 'gate', 'actions/setup-node@', '[[ ! -f scripts/zipp-release-gate.mjs ]]', 'exit 1', '\n          node scripts/zipp-release-gate.mjs\n');
  assert.ok(!gate.includes('run: npm ci'), 'the gate installs no dependencies');
  assert.ok(gate.includes('[allow-older-zipp]'), 'or the tag message asks for it');
  for (const output of ['zipp-release', 'zipp-sums-sha256', 'zipp-latest', 'zipp-older-allowed']) assert.ok(new RegExp(`\\n {6}${output}: \\$\\{\\{ steps\\.[\\w-]+\\.outputs\\.${output} \\}\\}`).test(gate), output);

  const verify = job(release, 'verify');
  assert.ok(verify.includes('zipp-release: ${{ needs.gate.outputs.zipp-release }}') && verify.includes('zipp-sums-sha256: ${{ needs.gate.outputs.zipp-sums-sha256 }}'), 'verify gets the frozen release');
  for (const id of ['e2e', 'website']) {
    const text = job(release, id);
    assert.ok(text.includes('ZIPP_RELEASE: ${{ needs.gate.outputs.zipp-release }}') && text.includes('ZIPP_SUMS_SHA256: ${{ needs.gate.outputs.zipp-sums-sha256 }}'), `${id} env`);
  }
  inOrder(job(release, 'e2e'), 'e2e', 'run: npm ci', INSTALL, 'npm run build:packages');
  const website = job(release, 'website');
  assert.ok(website.includes("needs.gate.result == 'success'"), 'a failed gate stops the release even when the tests are skipped');
  inOrder(website, 'website', 'run: npm ci', INSTALL, 'release-explainers.mjs --tag', 'run: npm run licenses:check', 'node packages/@softn/core/scripts/fetch-zipp-release.mjs --check --online', 'npm run package:formlogic-runtime', 'zipp/RELEASE-SHA256SUMS', 'name: Record the ZIPP release in the release notes', '>> release/RELEASE-NOTES.md', 'gh release create');
  assert.ok(website.includes('$ZIPP_SUMS_SHA256') && website.includes('zipp/SOURCE.json') && website.includes('zipp/zipp_wasm.d.ts'));
  assert.ok(website.includes('ZIPP_OLDER_ALLOWED: ${{ needs.gate.outputs.zipp-older-allowed }}') && website.includes('ZIPP_LATEST: ${{ needs.gate.outputs.zipp-latest }}'), 'the notes say when the release is not ZIPP\'s latest');
});

test('verify.yml and build.yml install the declared (or the passed) release before building', () => {
  const verifyYml = workflow('verify.yml');
  for (const input of ['zipp-release', 'zipp-sums-sha256']) assert.ok(new RegExp(`\\n {6}${input}:\\n(?: {8}.*\\n)*? {8}default: ''\\n`).test(verifyYml), `${input} input`);
  const verify = job(verifyYml, 'verify');
  assert.ok(verify.includes('ZIPP_RELEASE: ${{ inputs.zipp-release }}') && verify.includes('ZIPP_SUMS_SHA256: ${{ inputs.zipp-sums-sha256 }}'));
  inOrder(verify, 'verify', 'run: npm ci', INSTALL, 'npm run build:packages', 'npm run typecheck', 'npm test');
  const build = workflow('build.yml');
  inOrder(job(build, 'build-web'), 'build-web', 'run: npm ci', INSTALL, 'npm run build:packages', 'npm run package:formlogic-runtime');
  inOrder(job(build, 'build-tauri'), 'build-tauri', 'run: npm ci', INSTALL, 'npm run build:packages');
  assert.ok(!workflow('ci.yml').includes('zipp-'), 'ci.yml passes nothing: the declared release applies');
});
