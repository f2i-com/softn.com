import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { DECISIONS, PACKAGES, engineLabel, packageById, root, vendoredEngineLabel } from './release-packages.mjs';
import { CHANGELOG_MARKER, FRONT_DOOR, NOTES_MARKER, changelogSection, downloadsTable, releaseGuide, releaseNotes, startHere } from './release-explainers.mjs';

const ctx = { tag: 'v9.9.9', engine: 'v0.0.18' };

test('every release package is fully described, in plain words', () => {
  assert.equal(PACKAGES.length, 6);
  const ids = new Set();
  for (const pkg of PACKAGES) {
    assert.ok(!ids.has(pkg.id), `duplicate id ${pkg.id}`);
    ids.add(pkg.id);
    for (const field of ['id', 'title', 'pattern', 'what', 'guide', 'sizeNote']) {
      assert.equal(typeof pkg[field], 'string', `${pkg.id}.${field}`);
      assert.ok(pkg[field].length > 0, `${pkg.id}.${field} is empty`);
    }
    for (const field of ['chooseIf', 'notIf', 'steps', 'requirements', 'inside', 'moreGuides']) {
      assert.ok(Array.isArray(pkg[field]), `${pkg.id}.${field}`);
    }
    assert.ok(pkg.chooseIf.length >= 2 && pkg.notIf.length >= 2, `${pkg.id}: reasons for and against`);
    assert.equal(pkg.steps.length, 5, `${pkg.id}: five deploy steps`);
    assert.ok(pkg.requirements.length >= 2, `${pkg.id}: requirements`);
    assert.ok(pkg.inside.length >= 4, `${pkg.id}: folder by folder`);
    for (const item of pkg.inside) assert.ok(item.path && item.what, `${pkg.id}: inside entry`);
    // The detailed guide the explainer points to is one of the files it lists.
    const listed = pkg.inside.map((i) => i.path).join(', ');
    assert.ok(listed.includes(pkg.guide), `${pkg.id}: ${pkg.guide} is listed under "inside"`);
    for (const guide of pkg.moreGuides) assert.ok(listed.includes(guide), `${pkg.id}: ${guide} is listed`);
    // The file name pattern and the real name agree.
    const name = pkg.archive(ctx.tag, ctx.engine);
    assert.equal(name, pkg.pattern.replace('<tag>', ctx.tag).replace('<engine>', ctx.engine));
    assert.match(name, /^softn-.*\.zip$/);
  }
  // Every archive another explainer sends the reader to exists.
  const patterns = PACKAGES.map((p) => p.pattern);
  for (const pkg of PACKAGES) {
    for (const text of [...pkg.notIf, ...pkg.chooseIf]) {
      for (const named of text.match(/`softn-[^`]+\.zip`/g) ?? []) {
        assert.ok(patterns.includes(named.slice(1, -1)), `${pkg.id} names ${named}, which no package produces`);
      }
    }
  }
  for (const d of DECISIONS) packageById(d.answer);
  assert.equal(new Set(DECISIONS.map((d) => d.answer)).size, PACKAGES.length, 'every package has a decision row');
});

test('the engine label is a version, a tag or a short commit, never a URL', () => {
  assert.equal(engineLabel({ release: 'v0.0.18' }), 'v0.0.18');
  assert.equal(engineLabel({ version: '0.0.18' }), 'v0.0.18');
  assert.equal(engineLabel({ release: 'https://github.com/x/y/releases/v0.0.14', revision: 'abcdef1234567890' }), 'abcdef12');
  assert.equal(engineLabel({}), 'unknown');
  assert.match(vendoredEngineLabel(), /^v\d+\.\d+\.\d+/);
});

test('the README.md in every archive names its archive, its guide and the release, and reads as one document', () => {
  assert.equal(FRONT_DOOR, 'README.md');
  for (const pkg of PACKAGES) {
    const text = startHere(pkg.id, ctx);
    const name = pkg.archive(ctx.tag, ctx.engine);
    assert.ok(text.startsWith(`# Start here: ${pkg.title}\n`), `${pkg.id}: title`);
    assert.ok(text.includes(`\`${name}\``), `${pkg.id}: names ${name}`);
    assert.ok(text.includes(ctx.tag), `${pkg.id}: names the release`);
    assert.ok(text.includes(`\`${pkg.guide}\` in this folder`), `${pkg.id}: points at ${pkg.guide}`);
    for (const heading of ['## What this is', '## Is this the right download?', '## What is inside', '## Deploy in five steps', '## What you need', '## Check the download', '## Read next']) {
      assert.ok(text.includes(`\n${heading}\n`), `${pkg.id}: ${heading}`);
    }
    assert.ok(!text.includes('<tag>') && !text.includes('<engine>'), `${pkg.id}: placeholders filled`);
    assert.ok(text.includes(`${name}.sha256`), `${pkg.id}: checksum file named`);
  }
  assert.throws(() => startHere('site', { tag: 'nope' }), /tag must look like/);
  assert.throws(() => startHere('nope', ctx), /Unknown release package/);
});

test('RELEASE-GUIDE.md compares all six and the notes carry the same table and the tag\'s changelog', () => {
  const guide = releaseGuide(ctx);
  const table = downloadsTable(ctx);
  assert.ok(guide.startsWith(`# SoftN ${ctx.tag}: which download do I need?`));
  assert.ok(guide.includes(table));
  for (const pkg of PACKAGES) {
    const name = pkg.archive(ctx.tag, ctx.engine);
    assert.ok(guide.includes(`\n## ${pkg.title}\n`), `guide section for ${pkg.id}`);
    assert.equal(guide.split(`\`${name}\``).length - 1 >= 3, true, `${name} in the decision table, the downloads table and its section`);
  }
  assert.ok(!guide.includes('<tag>') && !guide.includes('<engine>'));

  const changelog = '# Changelog\n\n## v9.9.10 (next)\n\n- later\n\n## v9.9.9 — the one\n\n- first thing\n- second thing\n\n## v9.9.8\n\n- older\n';
  assert.equal(changelogSection(changelog, 'v9.9.9'), '- first thing\n- second thing');
  assert.equal(changelogSection(changelog, 'v9.9.10'), '- later');
  assert.throws(() => changelogSection(changelog, 'v9.9.7'), /no "## v9.9.7" section/);
  assert.throws(() => changelogSection('## v1.0.0\n\n## v0.9.0\n- x\n', 'v1.0.0'), /empty/);

  const template = `## SoftN RELEASE_TAG\n\n### What's new\n\n${CHANGELOG_MARKER}\n\n### Downloads\n\n${NOTES_MARKER}\n\nTail RELEASE_TAG.\n`;
  const notes = releaseNotes(template, ctx, changelog);
  assert.ok(notes.startsWith(`## SoftN ${ctx.tag}\n`));
  assert.ok(notes.includes('- first thing\n- second thing'));
  assert.ok(notes.includes(table));
  assert.ok(!notes.includes('RELEASE_TAG') && !notes.includes(NOTES_MARKER) && !notes.includes(CHANGELOG_MARKER));
  assert.throws(() => releaseNotes('no marker', ctx, changelog), /marker/);
  assert.throws(() => releaseNotes(template, { ...ctx, tag: 'v9.9.7' }, changelog), /CHANGELOG/);
  // The committed template has both markers, and CHANGELOG.md has a section for the version package.json names.
  const committed = fs.readFileSync(path.join(root, '.github/release-notes.md'), 'utf8');
  assert.ok(committed.includes(NOTES_MARKER) && committed.includes(CHANGELOG_MARKER), '.github/release-notes.md carries both markers');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const committedLog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelogSection(committedLog, `v${version}`).length > 0, `CHANGELOG.md has a section for v${version}`);
});

test('every package script ships README.md first and the guide the explainer names', () => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  // The site archive: DEPLOY.md is written by build-site.mjs, README.md by package-site.mjs.
  assert.ok(read('scripts/build-site.mjs').includes("'DEPLOY.md'"));
  assert.ok(read('scripts/package-site.mjs').includes("startHere('site'"));
  assert.equal(packageById('site').guide, 'DEPLOY.md');
  // The static single app and the PHP-served one copy their guide to DEPLOYMENT.md.
  for (const [script, id] of [['scripts/package-single.mjs', 'single'], ['scripts/package-single-private.mjs', 'private']]) {
    const source = read(script);
    assert.ok(source.includes("'DEPLOYMENT.md'"), `${script} ships DEPLOYMENT.md`);
    assert.ok(source.includes(`startHere('${id}'`), `${script} ships the ${id} explainer`);
    assert.ok(source.includes('FRONT_DOOR'), `${script} writes the front door by its one name`);
    assert.equal(packageById(id).guide, 'DEPLOYMENT.md');
  }
  // The two backend archives: packagePhp puts the guide under DEPLOYMENT.md and the explainer under README.md.
  const php = read('apps/softn-host-php/package.mjs');
  assert.ok(php.includes("explainer?'DEPLOYMENT.md':'START-HERE.md'"));
  assert.ok(php.includes("add('README.md',explainer)"));
  assert.ok(read('scripts/package-single-backend.mjs').includes("explainerFile('single-backend'"));
  assert.ok(read('scripts/package-private-single-php.mjs').includes("explainerFile('private-backend'"));
  assert.ok(read('scripts/test-single-backend.py').includes("'README.md','DEPLOYMENT.md'"), 'the backend archive check asserts the front door and the guide');
  // The FormLogic runtime archive: the explainer, the guide and softn-release.json.
  const formlogic = read('scripts/package-formlogic-runtime.mjs');
  assert.ok(formlogic.includes("startHere('formlogic-runtime'") && formlogic.includes('FRONT_DOOR'), 'the FormLogic runtime archive ships the explainer by its one name');
  assert.ok(formlogic.includes("'INTEGRATION.md'") && formlogic.includes("'softn-release.json'"));
  assert.equal(packageById('formlogic-runtime').guide, 'INTEGRATION.md');
  // All five archive writers go through the one shared writer.
  for (const script of ['scripts/package-site.mjs', 'scripts/package-single.mjs', 'scripts/package-single-private.mjs', 'apps/softn-host-php/package.mjs', 'scripts/package-formlogic-runtime.mjs']) {
    assert.ok(read(script).includes('writeArchive('), `${script} uses scripts/lib/archive.mjs`);
    assert.ok(!/(?<!un)zipSync\(/.test(read(script)), `${script} no longer has its own zip writer`);
  }
  // The workflow generates the guide and the notes before building, checks each archive, and attaches the guide.
  const workflow = read('.github/workflows/release.yml');
  assert.ok(workflow.includes('scripts/release-explainers.mjs --tag "$RELEASE_TAG"'));
  assert.ok(workflow.indexOf('release-explainers.mjs --tag') < workflow.indexOf('- name: Build the website'), 'the notes are written before anything is built');
  assert.ok(workflow.includes('release/RELEASE-GUIDE.md --clobber'));
  assert.ok(workflow.includes('--notes-file release/RELEASE-NOTES.md'));
  assert.equal((workflow.match(/grep -qx 'README\.md'/g) ?? []).length, 3, 'each archive kind is checked for its README.md');
  assert.ok(!workflow.includes('START-HERE'));
});

test('archives built locally carry README.md and the guide it names (SOFTN_CHECK_RELEASE_DIR=<dir>)', { skip: !process.env.SOFTN_CHECK_RELEASE_DIR && 'set SOFTN_CHECK_RELEASE_DIR to a directory of freshly built archives' }, () => {
  const releaseDir = path.resolve(process.env.SOFTN_CHECK_RELEASE_DIR);
  // Newest version first, so a stale archive from an older tag beside a fresh one is not the one checked.
  const names = fs.readdirSync(releaseDir).filter((n) => n.endsWith('.zip')).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  let checked = 0;
  for (const pkg of PACKAGES) {
    // The archive whose name matches this package's pattern with the tag (and engine) filled in.
    const re = new RegExp('^' + pkg.pattern.replace(/[.]/g, '\\.').replace('<tag>', 'v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?').replace('<engine>', '[^/]+') + '$');
    const file = names.find((n) => re.test(n));
    if (!file) continue;
    const entries = unzipSync(fs.readFileSync(path.join(releaseDir, file)), { filter: (f) => f.name.endsWith('.md') });
    assert.ok(entries[FRONT_DOOR], `${file}: ${FRONT_DOOR} at the root`);
    assert.ok(entries[pkg.guide], `${file}: ${pkg.guide} beside it`);
    const text = Buffer.from(entries[FRONT_DOOR]).toString('utf8');
    assert.ok(text.startsWith(`# Start here: ${pkg.title}`), `${file}: the ${pkg.id} explainer`);
    checked++;
  }
  assert.ok(checked > 0, 'no archive found');
  console.log(`checked ${checked} local archive(s)`);
});
