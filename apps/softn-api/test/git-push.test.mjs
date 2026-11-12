/**
 * Publishing with `git push`, with the real git client against the real API.
 *
 * Git is run with nothing of this machine's: an empty home, no system or global configuration, no prompt, and the key
 * from a one-line credential helper. The packs git sends are what the reader meets in use; the hand-made ones below are
 * what someone holding a key could send instead.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { startServer, HAVE_PHP, NO_PHP_REASON } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const { unzipSync, zipSync } = require('fflate');
const HAVE_GIT = spawnSync('git', ['--version']).status === 0;
const skip = { skip: !HAVE_PHP ? NO_PHP_REASON : !HAVE_GIT ? 'git is not on PATH, so pushing was not tested' : false };

let s = null;
const scratch = HAVE_GIT ? fs.mkdtempSync(path.join(os.tmpdir(), 'softn-git-')) : '';
let made = 0;

before(async () => {
  if (skip.skip) return;
  s = await startServer({ config: { limits: { version: [500, 3600], publish: [500, 3600], gitKey: [500, 3600] } }, prefix: 'softn-git-' });
});

after(() => {
  s?.stop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

const gitEnv = () => ({
  ...process.env,
  HOME: scratch,
  USERPROFILE: scratch,
  XDG_CONFIG_HOME: scratch,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'no-config'),
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
});

function git(dir, args, key) {
  const helper = key === undefined ? [] : ['-c', 'credential.helper=', '-c', `credential.helper=!f() { echo "password=${key}"; }; f`];
  const r = spawnSync('git', [...helper, ...args], { cwd: dir, env: gitEnv(), encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const MANIFEST = { name: 'Pushed', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } };

function project(files = {}) {
  const dir = path.join(scratch, `repo-${++made}`);
  fs.mkdirSync(dir);
  assert.equal(git(dir, ['init', '-q', '-b', 'main', '.']).status, 0);
  write(dir, { 'manifest.json': JSON.stringify(MANIFEST), 'ui/main.ui': '<App><Text>hello</Text></App>\n', ...files });
  commit(dir, 'First');
  return dir;
}

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

function commit(dir, message) {
  assert.equal(git(dir, ['add', '-A']).status, 0);
  const r = git(dir, ['commit', '-q', '-m', message]);
  assert.equal(r.status, 0, r.out);
}

const remote = (slug) => `${s.base}/api/git/${slug}.git`.replace('://', `://${slug}@`);
const push = (dir, slug, key, ref = 'HEAD:main', extra = []) => git(dir, ['push', ...extra, remote(slug), ref], key);

/**
 * The lines the site gives a publisher, all but the last (`git push softn`), each as git's arguments: read from the
 * site's own source, so what is run here is what a person is given, and not a copy of it that can fall behind.
 */
function siteCommands(slug) {
  const source = fs.readFileSync(new URL('../../softn-site/src/components/publish/keys.tsx', import.meta.url), 'utf8');
  const body = source.match(/export function gitCommands\([^)]*\): string \{[\s\S]*?return \[([\s\S]*?)\]\.join\('\\n'\);/);
  assert.ok(body, 'the site’s gitCommands was not found');
  const origin = new URL(s.base);
  const lines = [...body[1].matchAll(/^\s*(?:`([^`]*)`|'([^']*)'),?\s*$/gm)].map((m) => (m[1] ?? m[2]).replaceAll('${site.protocol}', origin.protocol).replaceAll('${site.host}', origin.host).replaceAll('${slug}', slug));
  assert.ok(lines.length >= 5 && lines.every((line) => line.startsWith('git ') && !/[`$"'\\^%!]/.test(line)), `plain lines, the same in any shell: ${lines.join(' | ')}`);
  assert.equal(lines.at(-1), 'git push softn');
  return lines.slice(0, -1).map((line) => line.split(' ').slice(1));
}
const versions = async (slug) => (await s.api('GET', `/api/apps/${slug}`)).json.app.versions;
const published = async (slug) => (await s.publish(`Pushed ${slug}`, {}, { category: 'tools' }));

async function bundleFiles(slug) {
  const response = await fetch(`${s.base}/api/apps/${slug}/bundle.softn`);
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}

test('the way the guide gives: a project in git, its first bundle by git archive, then its commands, from any branch', skip, async () => {
  const dir = project();
  const archive = git(dir, ['archive', '--format=zip', '-o', 'app.softn', 'HEAD']);
  assert.equal(archive.status, 0, archive.out);
  const form = new FormData();
  form.append('bundle', new Blob([fs.readFileSync(path.join(dir, 'app.softn'))]), 'app.softn');
  form.append('category', 'tools');
  const first = await s.api('POST', '/api/apps', { body: form });
  assert.equal(first.status, 201, first.text);
  fs.rmSync(path.join(dir, 'app.softn'));
  const slug = first.json.app.slug;
  // A project that lives somewhere else too, on a branch that is not main.
  const elsewhere = path.join(scratch, `elsewhere-${++made}.git`);
  assert.equal(git(scratch, ['init', '-q', '--bare', elsewhere]).status, 0);
  git(dir, ['branch', '-m', 'master']);
  git(dir, ['remote', 'add', 'origin', elsewhere]);
  assert.equal(git(dir, ['push', '-q', '-u', 'origin', 'master']).status, 0);
  // The site's gitCommands, against this server.
  for (const command of siteCommands(slug)) assert.equal(git(dir, command).status, 0, command.join(' '));
  // Its last line, run straight after the page published these files, as "Copy the commands" has it: the page's
  // bundle is another zip of the same files, and no second version is made of them.
  const again = git(dir, ['push', 'softn'], first.json.editKey);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /remote: Already published as version 1/);
  assert.equal((await versions(slug)).length, 1);
  write(dir, { 'ui/main.ui': '<App><Text>the next version</Text></App>\n', 'assets/big.bin': crypto.randomBytes(2 * 1024 * 1024) });
  commit(dir, 'The next version');
  const r = git(dir, ['push', 'softn'], first.json.editKey);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Published version 2/);
  assert.equal(Buffer.from((await bundleFiles(slug))['ui/main.ui']).toString(), '<App><Text>the next version</Text></App>\n');
  assert.ok(!fs.readFileSync(path.join(dir, '.git/config'), 'utf8').includes(first.json.editKey), 'the key is not in the repository');
  // The branch still follows its own remote, and what editors run in the background does not ask the directory.
  assert.equal(git(dir, ['push', '-q']).status, 0);
  assert.match(git(dir, ['status', '-sb']).out, /^## master\.\.\.origin\/master$/m);
  for (const quiet of [['fetch', '--all'], ['remote', 'update'], ['pull']]) {
    const done = git(dir, quiet);
    assert.equal(done.status, 0, `${quiet.join(' ')}: ${done.out}`);
  }
});

test('an app that plays on its own site has no bundle here for a push to replace', skip, async () => {
  const app = await published('linked');
  const slug = app.app.slug;
  const file = path.join(s.dataDir, 'apps', slug, 'app.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.app.play_url = 'https://elsewhere.test/';
  fs.writeFileSync(file, JSON.stringify(doc));
  const r = push(project(), slug, app.editKey);
  assert.notEqual(r.status, 0);
  // Git shows a 404 on its first request as "not found", without the words, so the reason comes where the refs would.
  assert.match(r.out, /fatal: remote error: This app plays on its own site, so the directory holds no bundle of it for a push to replace\./, r.out);
  assert.doesNotMatch(r.out, /not found/);
  const authorization = `Basic ${Buffer.from(`${slug}:${app.editKey}`).toString('base64')}`;
  const refs = await fetch(`${s.base}/api/git/${slug}.git/info/refs?service=git-receive-pack`, { headers: { authorization } });
  assert.equal(refs.status, 200);
  assert.match(await refs.text(), /ERR This app plays on its own site/);
  // Only to the key that opens it: without one it asks for the key, as any app does.
  assert.equal((await fetch(`${s.base}/api/git/${slug}.git/info/refs?service=git-receive-pack`)).status, 401);
  // A push sent without asking first is told the same, as a push that was not read.
  const { tip, objects } = aProject();
  const sent = await raw(app, pack(objects), tip);
  assert.equal(sent.status, 200, sent.text);
  assert.match(sent.text, /This app plays on its own site.*unpack not read/s, sent.text);
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'apps', slug, 'v2.softn')), 'nothing was added to it');
});

test('a push is a new version: the files of the commit, with its subject as the notes, and the page in the terminal', skip, async () => {
  const app = await published('one');
  const slug = app.app.slug;
  // Git's own files in the top folder and below it: an ignore list beside the files it is about, the file that keeps
  // an empty folder in git, attributes for one folder.
  const dir = project({ '.gitignore': 'node_modules\n', '.github/workflows/ci.yml': 'on: push\n', 'logic/main.logic': 'let x = 1\n', 'ui/.DS_Store': 'x', 'ui/.gitignore': '*.tmp\n', 'assets/.gitkeep': '', 'logic/deep/.gitattributes': '* text\n' });
  git(dir, ['commit', '-q', '--amend', '-m', 'Make the app say hello']);

  const r = push(dir, slug, app.editKey);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`remote: Published version 2: http://[^ ]+/app/${slug}`));

  const list = await versions(slug);
  assert.equal(list.length, 2);
  assert.equal(list[0].notes, 'Make the app say hello');
  const files = await bundleFiles(slug);
  assert.deepEqual(Object.keys(files).sort(), ['logic/main.logic', 'manifest.json', 'ui/main.ui'], 'what is git’s and not the app’s stays out, in every folder');
  assert.equal(Buffer.from(files['ui/main.ui']).toString(), '<App><Text>hello</Text></App>\n');

  // Git commits no `.git` folder below the top, and a hand-made tree can name one: it is left out like the rest.
  const other = await published('one-crafted');
  const config = Buffer.from('[core]\n');
  const inner = tree([['100644', 'config', oid('blob', config)]]);
  const sub = tree([['40000', '.git', oid('tree', inner)], ['100644', 'kept.txt', oid('blob', config)]]);
  const crafted = aProject([['40000', 'sub', oid('tree', sub)]]);
  const sent = await raw(other, pack([...crafted.objects, entry(TYPES.tree, sub), entry(TYPES.tree, inner), entry(TYPES.blob, config)]), crafted.tip);
  assert.match(sent.text, /Published version 2/, sent.text);
  assert.deepEqual(Object.keys(await bundleFiles(other.app.slug)).sort(), ['manifest.json', 'sub/kept.txt', 'ui.ui']);
});

test('a shallow clone, as CI checks a project out, publishes its latest commit', skip, async () => {
  const app = await published('shallow');
  const slug = app.app.slug;
  const dir = project();
  for (const text of ['two', 'three']) {
    write(dir, { 'ui/main.ui': `<App><Text>${text}</Text></App>\n` });
    commit(dir, text);
  }
  const copy = path.join(scratch, `shallow-${++made}`);
  const cloned = git(scratch, ['clone', '-q', '--depth', '1', '--no-local', `file://${dir.replace(/\\/g, '/')}`, copy]);
  assert.equal(cloned.status, 0, cloned.out);
  assert.equal(git(copy, ['rev-parse', '--is-shallow-repository']).out.trim(), 'true');
  const r = push(copy, slug, app.editKey);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Published version 2/);
  assert.equal((await versions(slug))[0].notes, 'three');
  assert.equal(Buffer.from((await bundleFiles(slug))['ui/main.ui']).toString(), '<App><Text>three</Text></App>\n');
});

test('the guide’s way to publish from CI: the key from the environment, in no argument, address or config', skip, async () => {
  const docs = fs.readFileSync(new URL('../../../docs/content/softn-docs.json', import.meta.url), 'utf8');
  const item = JSON.parse(docs).pages.flatMap((p) => p.sections ?? []).find((section) => section.id === 'push-with-git').blocks.flatMap((b) => b.items ?? []).find((text) => text.includes('SOFTN_EDIT_KEY'));
  const command = item.match(/`(git -c credential\.helper='([^']+)' -c (http\.postBuffer=64M) push (https:\/\/my-app@softn\.com\/api\/git\/my-app\.git) (HEAD:refs\/heads\/main))`/);
  assert.ok(command, item);
  const app = await published('ci');
  const dir = project();
  // CI checks out a commit, not a branch (a tag, a pull request, GitLab always): `HEAD:main` cannot be read there.
  git(dir, ['checkout', '-q', '--detach']);
  // As a shell hands it to git: the helper as one argument, with the variable's name in it and not its value.
  const args = ['-c', `credential.helper=${command[2]}`, '-c', command[3], 'push', command[4].replace('https://my-app@softn.com/api/git/my-app.git', remote(app.app.slug)), command[5]];
  assert.ok(!args.some((arg) => arg.includes(app.editKey)));
  const r = spawnSync('git', args, { cwd: dir, env: { ...gitEnv(), SOFTN_EDIT_KEY: app.editKey }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /Published version 2/);
  assert.ok(!fs.readFileSync(path.join(dir, '.git/config'), 'utf8').includes(app.editKey));
  // And without the variable, nothing is published and nothing waits for a terminal.
  write(dir, { 'ui/main.ui': '<App><Text>no key</Text></App>\n' });
  commit(dir, 'No key');
  const bare = spawnSync('git', args, { cwd: dir, env: gitEnv(), encoding: 'utf8', timeout: 60000 });
  assert.notEqual(bare.status, 0);
  assert.equal((await versions(app.app.slug)).length, 2);
});

test('the same files again are no new version, whatever the commit', skip, async () => {
  const app = await published('same');
  const slug = app.app.slug;
  const dir = project();
  assert.equal(push(dir, slug, app.editKey).status, 0);
  assert.equal((await versions(slug)).length, 2);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'Nothing changed']);
  const r = push(dir, slug, app.editKey);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Already published as version 2/);
  assert.equal((await versions(slug)).length, 2);
  write(dir, { 'ui/main.ui': '<App><Text>changed</Text></App>\n' });
  commit(dir, 'A change');
  assert.match(push(dir, slug, app.editKey).out, /Published version 3/);
});

test('without the key nothing is published, and git is told so', skip, async () => {
  const app = await published('keyed');
  const dir = project();
  const wrong = push(dir, app.app.slug, 'a'.repeat(40));
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.out, /Authentication failed/);
  const none = push(dir, app.app.slug, undefined);
  assert.notEqual(none.status, 0);
  const other = await published('other');
  assert.notEqual(push(dir, app.app.slug, other.editKey).status, 0, 'another app’s key opens nothing here');
  assert.equal((await versions(app.app.slug)).length, 1);
});

test('a key that has been replaced stops working, and the new one works', skip, async () => {
  const app = await published('rotated');
  const slug = app.app.slug;
  const dir = project();
  const replaced = await s.api('POST', `/api/apps/${slug}/key`, { headers: { 'X-Edit-Key': app.editKey } });
  assert.notEqual(push(dir, slug, app.editKey).status, 0);
  assert.equal(push(dir, slug, replaced.json.editKey).status, 0);
});

test('only main is published: another branch and a delete are refused, with what to do, and a tag alone publishes nothing', skip, async () => {
  const app = await published('refs');
  const slug = app.app.slug;
  const dir = project();
  const branch = push(dir, slug, app.editKey, 'HEAD:refs/heads/work');
  assert.notEqual(branch.status, 0);
  assert.match(branch.out, /remote: Only main is published\. Push your branch to it: git push softn HEAD:refs\/heads\/main/);
  git(dir, ['tag', 'v1']);
  // A tag is never a failure, as git sends tags along by itself; pushed alone, it is told that nothing was published.
  const tag = push(dir, slug, app.editKey, 'refs/tags/v1');
  assert.equal(tag.status, 0, tag.out);
  assert.match(tag.out, /remote: Nothing was published: tags are not kept, and only a push to main makes a version\. To publish the commit you are on: git push softn HEAD:refs\/heads\/main/);
  // A delete: git does not send one for a ref it was not offered, and one sent all the same is told what to do.
  assert.notEqual(push(dir, slug, app.editKey, ':main').status, 0, 'a delete');
  const zero = '0'.repeat(40);
  const gone = await s.api('POST', `/api/git/${slug}.git/git-receive-pack`, { raw: Buffer.concat([pkt(`${zero} ${zero} refs/heads/main\0report-status side-band-64k\n`), Buffer.from('0000')]), headers: pushHeaders(app) });
  assert.match(gone.text, /A push does not delete an app\. Unpublish it from its page\./, gone.text);
  assert.match(gone.text, /ng refs\/heads\/main not published/, gone.text);
  const notes = push(dir, slug, app.editKey, 'HEAD:refs/notes/commits');
  assert.notEqual(notes.status, 0);
  assert.match(notes.out, /remote: Only main is published\. Other refs are not kept\./);
  assert.equal((await versions(slug)).length, 1);
});

test('tags that git sends along never stop a push or fail it: main is published, and a line says tags are not kept', skip, async () => {
  const app = await published('follow-tags');
  const slug = app.app.slug;
  const dir = project();
  // Annotated tags, as `npm version` makes them, and more of them than the sixteen refs a push could once name.
  for (let i = 1; i <= 20; i++) {
    write(dir, { 'ui/main.ui': `<App><Text>release ${i}</Text></App>\n` });
    commit(dir, `Release ${i}`);
    assert.equal(git(dir, ['tag', '-a', `v1.0.${i}`, '-m', `v1.0.${i}`]).status, 0);
  }
  const r = git(dir, ['-c', 'push.followTags=true', 'push', remote(slug), 'HEAD:refs/heads/main'], app.editKey);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /remote: Published version 2/);
  assert.equal(r.out.match(/remote: Tags are not kept: the directory keeps an app's versions, and nothing else of its project\./g)?.length, 1, r.out);
  assert.doesNotMatch(r.out, /rejected|too many refs|failed to report/, r.out);
  assert.equal(Buffer.from((await bundleFiles(slug))['ui/main.ui']).toString(), '<App><Text>release 20</Text></App>\n');
  // The next push sends them all again, as the directory offers no refs, and is as quiet.
  write(dir, { 'ui/main.ui': '<App><Text>after the releases</Text></App>\n' });
  commit(dir, 'After the releases');
  const next = git(dir, ['-c', 'push.followTags=true', 'push', remote(slug), 'HEAD:refs/heads/main'], app.editKey);
  assert.equal(next.status, 0, next.out);
  assert.match(next.out, /remote: Published version 3/);
  // And `git push --tags` after a push, which a release script runs: no failure, nothing published.
  const tags = git(dir, ['push', '--tags', remote(slug)], app.editKey);
  assert.equal(tags.status, 0, tags.out);
  assert.match(tags.out, /remote: Nothing was published: tags are not kept/);
  assert.equal((await versions(slug)).length, 3);
  assert.ok(!fs.readdirSync(path.join(s.dataDir, 'apps', slug)).some((name) => /tag|ref/.test(name)), 'nothing of a tag is kept');
});

test('more refs than are answered for: main is published all the same, and the rest are said to be unanswered', skip, async () => {
  const app = await published('many-refs');
  const { tip, objects } = aProject();
  const zero = '0'.repeat(40);
  // 1 MB of answers is some twelve thousand refs of this length; twenty thousand of them, with main in the middle.
  const lines = Array.from({ length: 20000 }, (_, i) => pkt(`${zero} ${tip} refs/tags/${String(i).padStart(60, 'v')}\n`));
  lines.splice(10000, 0, pkt(`${zero} ${tip} refs/heads/main\n`));
  lines[0] = pkt(`${zero} ${tip} refs/tags/first\0report-status side-band-64k\n`);
  const r = await s.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, { raw: Buffer.concat([...lines, Buffer.from('0000'), pack(objects)]), headers: pushHeaders(app) });
  assert.equal(r.status, 200);
  assert.match(r.text, /Published version 2/);
  assert.match(r.text, /ok refs\/heads\/main/);
  assert.match(r.text, /This push names more refs than the directory answers for, so git will say that \d+ of them were not reported\. None of those is kept either\./);
  assert.ok(r.text.length < 1200 * 1024, `the answer is held to its limit: ${r.text.length}`);
  assert.equal((await versions(app.app.slug)).length, 2);
});

test('the refusal a bundle gets on the publish page reaches the terminal', skip, async () => {
  const app = await published('refused');
  const dir = project();
  write(dir, { 'manifest.json': JSON.stringify({ name: 'No main', version: '1.0.0' }) });
  commit(dir, 'Lose the entry file');
  const r = push(dir, app.app.slug, app.editKey);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /remote: The manifest names no entry file/);
  assert.match(r.out, /remote rejected/);
  assert.equal((await versions(app.app.slug)).length, 1);
});

test('a storage policy stays fixed, by push as by upload', skip, async () => {
  const declared = (policy) => JSON.stringify({ permissions: { storage: { enabled: true, collections: { notes: policy, '*': 'public' } } } });
  const app = await s.publish('Policy', { permissions: { storage: { enabled: true, collections: { notes: 'private', '*': 'public' } } } }, { category: 'tools' });
  const dir = project({ 'permission.json': declared('public') });
  const r = push(dir, app.app.slug, app.editKey);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /storage policy of notes/);
});

test('a link and a submodule are refused, as a published app holds its files', skip, async () => {
  const app = await published('links');
  const slug = app.app.slug;
  const dir = project();
  const blob = git(dir, ['rev-parse', 'HEAD:manifest.json']).out.trim();
  git(dir, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  git(dir, ['commit', '-q', '-m', 'A link']);
  const link = push(dir, slug, app.editKey);
  assert.notEqual(link.status, 0);
  assert.match(link.out, /link is a symbolic link/);
  git(dir, ['rm', '-q', '--cached', 'link']);
  const head = git(dir, ['rev-parse', 'HEAD']).out.trim();
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${head},vendor`]);
  git(dir, ['commit', '-q', '-m', 'A submodule']);
  const sub = push(dir, slug, app.editKey);
  assert.notEqual(sub.status, 0);
  assert.match(sub.out, /vendor is a submodule/);
  assert.equal((await versions(slug)).length, 1);
});

test('a file that holds secrets is refused; one removed before the commit pushed is never kept', skip, async () => {
  const app = await published('secrets');
  const slug = app.app.slug;
  for (const name of ['.env', 'config/.env.production', 'server.pem', 'id_ed25519', 'server.key', 'deploy/.htpasswd', 'putty/me.ppk', '.envrc', '.env-local', 'keys/id_ecdsa_sk', 'android/release.keystore', '.aws/credentials', '.pypirc', 'Certs/Site.PFX']) {
    const dir = project({ [name]: 'TOKEN=sk-live-must-not-be-public\n' });
    const r = push(dir, slug, app.editKey);
    assert.notEqual(r.status, 0, name);
    assert.match(r.out, new RegExp(`remote: ${name.replaceAll('.', '\\.')} looks like it holds secrets, and everything published is public\\. Take it out of the commit, with git rm --cached if you need to keep the file\\.`), `${name}: ${r.out}`);
  }
  assert.equal((await versions(slug)).length, 1);
  // A private key under a name that says nothing, by how it begins. And the words alone, further in, are a file.
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\n-----END OPENSSH PRIVATE KEY-----\n';
  for (const [name, text] of [['deploy', pem], ['notes/key.txt', `${String.fromCharCode(0xfeff)}\r\n${pem.replace('OPENSSH', 'RSA')}`], ['backup.txt', 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n']]) {
    const r = push(project({ [name]: text }), slug, app.editKey);
    assert.notEqual(r.status, 0, name);
    assert.match(r.out, new RegExp(`remote: ${name.replaceAll('.', '\\.')} looks like it holds secrets`), `${name}: ${r.out}`);
  }
  assert.equal((await versions(slug)).length, 1);
  // Ordinary files of an app, some of them near what is refused, all go through.
  const ordinary = {
    '.env.example': 'TOKEN=\n', 'config/.env.production.sample': 'TOKEN=\n', 'id_rsa.pub': 'ssh-rsa AAAA me@example\n', 'keys.json': '{"up":"ArrowUp"}\n', 'logic/hotkey.js': 'export const key = 1\n',
    'docs/pem.md': 'A key file begins with\n-----BEGIN PRIVATE KEY-----\nand this is only a page about that.\n', 'logic/reader.js': 'const HEAD = "-----BEGIN RSA PRIVATE KEY-----";\n',
    'environment.json': '{}\n', 'data/format.json': '{"format":"softn-edit-keys-are-not-this"}\n', 'assets/keyboard.keys': 'qwerty\n', '.envoy.yaml': 'static: {}\n',
  };
  const fine = push(project(ordinary), slug, app.editKey);
  assert.equal(fine.status, 0, fine.out);
  assert.deepEqual(Object.keys(await bundleFiles(slug)).sort(), [...Object.keys(ordinary), 'manifest.json', 'ui/main.ui'].sort());

  const dir = project({ '.env.example': 'TOKEN=\n', '.env': 'TOKEN=sk-live-must-not-be-public\n' });
  git(dir, ['rm', '-q', '.env']);
  commit(dir, 'Take the secret out');
  const r = push(dir, slug, app.editKey);
  assert.equal(r.status, 0, r.out);
  const files = await bundleFiles(slug);
  assert.deepEqual(Object.keys(files).sort(), ['.env.example', 'manifest.json', 'ui/main.ui']);
  const kept = fs.readdirSync(path.join(s.root, 'data/apps', slug));
  assert.ok(!kept.some((name) => /git|objects|pack/.test(name)), `no store of objects: ${kept.join(' ')}`);
});

/** What the site's "Download backup" writes: lib/keyStore.ts exportKeys, and lib/keyBackup.ts for one with a passphrase. */
const keyBackup = (keys) => JSON.stringify({ format: 'softn-edit-keys', version: 1, keys }, null, 2);
const sealedBackup = () => JSON.stringify({ format: 'softn-edit-keys', version: 2, encrypted: true, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000 }, cipher: 'AES-GCM', salt: 'c2FsdA==', iv: 'aXY=', ciphertext: 'c2VhbGVk' }, null, 2);

/** Everything about an app that a refused push must leave as it was: its record, and each file of its folder. */
function appState(slug) {
  const folder = path.join(s.dataDir, 'apps', slug);
  return Object.fromEntries(fs.readdirSync(folder).sort().map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, name))).digest('hex')]));
}

test('a backup of edit keys is never published: by its name, by what it holds under any name, with or without a passphrase', skip, async () => {
  const app = await published('backup');
  const other = await published('backup-other');
  const slug = app.app.slug;
  const before = appState(slug);
  // As the reviewer did it: "Download backup" saved into the project, then git add -A, commit, push.
  const cases = [
    ['softn-edit-keys-2026-11-12.json', keyBackup({ [slug]: app.editKey, [other.app.slug]: other.editKey })],
    ['docs/softn-edit-keys-2026-11-12 (1).json', keyBackup({ [other.app.slug]: other.editKey })],
    ['Softn-Edit-Keys.JSON', '{}'],
    // Renamed, and holding only another app's key, which this push did not present.
    ['notes/my-keys.json', keyBackup({ [other.app.slug]: other.editKey })],
    // Renamed, and holding this app's key among others: it is said to be the backup it is, as every key in it is to
    // be replaced, and not only this app's.
    ['all-my-keys.json', keyBackup({ [other.app.slug]: other.editKey, [slug]: app.editKey })],
    ['config.txt', sealedBackup()],
    // As PowerShell's `>` writes a file: UTF-16, with a byte order mark.
    ['copy.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(keyBackup({ [other.app.slug]: other.editKey }), 'utf16le')])],
  ];
  for (const [name, content] of cases) {
    const r = push(project({ [name]: content }), slug, app.editKey);
    assert.notEqual(r.status, 0, name);
    assert.ok(r.out.includes(`remote: ${name} is a backup of edit keys, and everything published is public: whoever reads it could change or unpublish every app it names. Take it out of the commit, with git rm --cached if you need to keep the file. If it was ever published, here or anywhere else, replace those keys on the Publish page.`), `${name}: ${r.out}`);
    assert.match(r.out, /remote rejected/);
    assert.ok(!r.out.includes(app.editKey) && !r.out.includes(other.editKey), 'and no key is repeated in the terminal');
  }
  assert.deepEqual(appState(slug), before, 'the app is as it was');
  assert.ok(await s.tempEmpty(), 'nothing left on the temp disk');
  const source = await s.api('GET', `/api/apps/${slug}/source`);
  assert.ok(!source.text.includes(app.editKey) && !source.text.includes(other.editKey));
  // Both keys still open their apps, and nobody else's does.
  assert.equal((await s.api('PATCH', `/api/apps/${slug}`, { body: { description: 'still mine' }, headers: { 'X-Edit-Key': app.editKey } })).status, 200);
});

test('a file that holds the key a push came with is never published, wherever in it the key is and however it is written', skip, async () => {
  const app = await published('own-key');
  const slug = app.app.slug;
  const refusal = (name) => `remote: ${name} holds this app's edit key, and everything published is public: whoever reads it could change or unpublish the app. Take the key out of the file, or the file out of the commit with git rm --cached. If it was ever published, here or anywhere else, replace the key on the Publish page.`;
  const big = crypto.randomBytes(3 * 1024 * 1024);
  const cases = [
    ['notes.txt', `the key is ${app.editKey}\n`],
    ['deploy.sh', `curl -H "X-Edit-Key: ${app.editKey.toUpperCase()}" https://softn.example/api/apps/x/versions\n`],
    // Written by PowerShell's `>`: UTF-16, a zero byte beside each character.
    ['key.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${app.editKey}\r\n`, 'utf16le')])],
    // Deep in a file that does not compress, so it lies across the pieces the bundle is read in.
    ['assets/noise.bin', Buffer.concat([big, Buffer.from(app.editKey), big])],
    ['logic/config.logic', `let key = "${app.editKey}"\n`],
  ];
  for (const [name, content] of cases) {
    const r = push(project({ [name]: content }), slug, app.editKey);
    assert.notEqual(r.status, 0, name);
    assert.ok(r.out.includes(refusal(name)), `${name}: ${r.out}`);
    assert.ok(!r.out.includes(app.editKey), 'and the key is not repeated in the terminal');
  }
  assert.equal((await versions(slug)).length, 1);
  assert.ok(await s.tempEmpty(), 'nothing left on the temp disk');
  // By a hand-made pack as well, at the very start of a file and at its very end.
  for (const at of [0, 70000 - 40]) {
    const data = crypto.randomBytes(70000);
    data.write(app.editKey, at, 'latin1');
    const { tip, objects } = aProject([['100644', 'padded.bin', oid('blob', data)]]);
    await refused(app, pack([...objects, entry(TYPES.blob, data)]), tip, /padded\.bin holds this app's edit key/);
  }
  // Forty characters that are no app's key are a file, and so is the key cut short.
  const fine = push(project({ 'notes.txt': `not a key: ${crypto.randomBytes(20).toString('hex')}\n${'a'.repeat(40)}\n${app.editKey.slice(0, 39)}\n` }), slug, app.editKey);
  assert.equal(fine.status, 0, fine.out);
  assert.match(fine.out, /Published version 2/);
  // A key replaced since is the one looked for.
  const replaced = await s.api('POST', `/api/apps/${slug}/key`, { headers: { 'X-Edit-Key': app.editKey } });
  const stale = push(project({ 'notes.txt': `the new key is ${replaced.json.editKey}\n` }), slug, replaced.json.editKey);
  assert.notEqual(stale.status, 0);
  assert.ok(stale.out.includes(refusal('notes.txt')), stale.out);
});

test('a file that holds the edit key of any app in the directory is never published, and a lock file full of commit ids is', skip, async () => {
  const app = await published('any-key');
  const other = await published('any-key-other');
  const third = await published('any-key-third');
  const slug = app.app.slug;
  const before = appState(slug);
  const refusal = (name) => `remote: ${name} holds an edit key of a published app, and everything published is public: whoever reads it could change or unpublish that app. Take the key out of the file, or the file out of the commit with git rm --cached. If it was ever published, here or anywhere else, replace that key on the Publish page.`;
  // A list of one's keys pasted into a note: no backup's marker, and not the key this push came with.
  const cases = [
    ['notes.txt', `my other app: ${other.editKey}\n`],
    ['config/apps.json', JSON.stringify({ apps: [{ slug: third.app.slug, key: third.editKey }] })],
    ['deploy.cmd', `set KEY=${other.editKey.toUpperCase()}\r\n`],
    // As PowerShell's `>` writes it.
    ['keys.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${other.editKey}\r\n`, 'utf16le')])],
    // Among commit ids, which are the same forty characters, and at the very end of a file with no line break.
    ['CHANGELOG.md', `${Array.from({ length: 300 }, () => `- ${crypto.randomBytes(20).toString('hex')} a change`).join('\n')}\nkey ${third.editKey}`],
  ];
  for (const [name, content] of cases) {
    const r = push(project({ [name]: content }), slug, app.editKey);
    assert.notEqual(r.status, 0, name);
    assert.ok(r.out.includes(refusal(name)), `${name}: ${r.out}`);
    assert.match(r.out, /remote rejected/);
    assert.ok(!r.out.toLowerCase().includes(other.editKey) && !r.out.toLowerCase().includes(third.editKey), 'the key is not repeated in the terminal');
    assert.ok(!r.out.includes(other.app.slug) && !r.out.includes(third.app.slug), 'nor is the app it opens named');
  }
  assert.deepEqual(appState(slug), before, 'the app is as it was');
  assert.ok(await s.tempEmpty(), 'nothing left on the temp disk');
  assert.ok(!s.log.some((line) => line.includes(other.editKey) || line.includes(third.editKey)), 'and no key is in the server\'s log');

  // An ordinary project: lock files with thousands of commit ids, its own among them, and a list of checksums.
  const dir = project();
  const ids = Array.from({ length: 6000 }, () => crypto.randomBytes(20).toString('hex'));
  write(dir, {
    'composer.lock': JSON.stringify({ packages: ids.slice(0, 3000).map((reference, i) => ({ name: `vendor/package-${i}`, source: { type: 'git', reference }, dist: { reference } })) }, null, 2),
    'Podfile.lock': `SPEC CHECKSUMS:\n${ids.slice(3000).map((id, i) => `  Pod${i}: ${id}`).join('\n')}\n`,
    'docs/history.txt': `${git(dir, ['rev-parse', 'HEAD']).out.trim()} First\n`,
  });
  commit(dir, 'Lock files');
  const started = Date.now();
  const ordinary = push(dir, slug, app.editKey);
  assert.equal(ordinary.status, 0, ordinary.out);
  assert.match(ordinary.out, /remote: Published version 2/);
  assert.ok(Date.now() - started < 10000, 'and promptly');
  assert.equal(Buffer.from((await bundleFiles(slug))['Podfile.lock']).toString().split('\n').length, 3002);

  // A key that was replaced opens nothing, and is a file like any other; an unpublished app's key still opens it.
  const replaced = await s.api('POST', `/api/apps/${other.app.slug}/key`, { headers: { 'X-Edit-Key': other.editKey } });
  assert.equal(replaced.status, 200);
  assert.match(push(project({ 'notes.txt': `an old key: ${other.editKey}\n` }), slug, app.editKey).out, /Published version 3/);
  assert.ok(push(project({ 'notes.txt': `the new key: ${replaced.json.editKey}\n` }), slug, app.editKey).out.includes(refusal('notes.txt')));
  assert.equal((await s.api('DELETE', `/api/apps/${third.app.slug}`, { headers: { 'X-Edit-Key': third.editKey } })).status, 204);
  assert.ok(push(project({ 'notes.txt': `${third.editKey}\n` }), slug, app.editKey).out.includes(refusal('notes.txt')));
  assert.equal((await versions(slug)).length, 3);
});

test('a push from a clone that never got the live version is published, and told what is not in it', skip, async () => {
  const app = await published('stale');
  const slug = app.app.slug;
  const one = project();
  // Two people, or one person's two computers: the second cloned before the first went on.
  const two = path.join(scratch, `second-${++made}`);
  assert.equal(git(scratch, ['clone', '-q', '--no-local', `file://${one.replace(/\\/g, '/')}`, two]).status, 0);
  const first = push(one, slug, app.editKey);
  assert.match(first.out, /Published version 2/);
  assert.doesNotMatch(first.out, /does not contain/, 'the first version was uploaded: nothing is known of where its files came from');
  write(one, { 'ui/feature.ui': '<Text>a feature</Text>\n' });
  commit(one, 'A feature');
  const feature = push(one, slug, app.editKey);
  assert.match(feature.out, /Published version 3/);
  assert.doesNotMatch(feature.out, /does not contain/, 'built on what was live');
  const published3 = (await versions(slug))[0].createdAt;

  write(two, { 'ui/main.ui': '<App><Text>something else</Text></App>\n' });
  commit(two, 'Something else');
  const stale = push(two, slug, app.editKey);
  assert.equal(stale.status, 0, stale.out);
  assert.match(stale.out, /remote: Published version 4/);
  const when = new Date(published3);
  const said = `${when.getUTCDate()} ${when.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${when.getUTCFullYear()} at ${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')} UTC`;
  assert.ok(stale.out.includes(`remote: Version 4 does not contain version 3, which was live until now (published ${said}): that version's commit is not in the history this push sent. If it was pushed from another computer, or by someone else, its changes are not in version 4. To keep them, bring them into this project and push again.`), stale.out);
  assert.ok(!('ui/feature.ui' in (await bundleFiles(slug))), 'published as it was pushed, as always');

  // What it says to do: the first clone brings the second's work in, and its push holds both.
  assert.equal(git(one, ['pull', '-q', '--no-rebase', '--no-edit', `file://${two.replace(/\\/g, '/')}`, 'main']).status, 0);
  const merged = push(one, slug, app.editKey);
  assert.match(merged.out, /Published version 5/);
  assert.doesNotMatch(merged.out, /does not contain/, merged.out);
  assert.ok('ui/feature.ui' in (await bundleFiles(slug)));

  // Where it cannot be told, nothing is said: no history at all (the latest files alone, a tree, a shallow clone).
  write(two, { 'ui/main.ui': '<App><Text>no history</Text></App>\n' });
  commit(two, 'No history');
  const tree = git(two, ['push', remote(slug), 'HEAD^{tree}:refs/heads/main'], app.editKey);
  assert.match(tree.out, /Published version 6/);
  assert.doesNotMatch(tree.out, /does not contain/, tree.out);
  write(one, { 'ui/main.ui': '<App><Text>back on the first</Text></App>\n' });
  commit(one, 'Back on the first');
  assert.match(push(one, slug, app.editKey).out, /Published version 7/);
  write(two, { 'ui/main.ui': '<App><Text>one commit</Text></App>\n' });
  commit(two, 'One commit');
  const lone = git(two, ['commit-tree', 'HEAD^{tree}', '-m', 'Publish']);
  const single = git(two, ['push', remote(slug), `${lone.out.trim()}:refs/heads/main`], app.editKey);
  assert.match(single.out, /Published version 8/);
  assert.doesNotMatch(single.out, /does not contain/, single.out);
  write(one, { 'ui/main.ui': '<App><Text>the first again</Text></App>\n' });
  commit(one, 'The first again');
  assert.match(push(one, slug, app.editKey).out, /Published version 9/);
  const shallow = path.join(scratch, `shallow-${++made}`);
  assert.equal(git(scratch, ['clone', '-q', '--depth', '1', '--no-local', `file://${two.replace(/\\/g, '/')}`, shallow]).status, 0);
  write(shallow, { 'ui/main.ui': '<App><Text>from a shallow clone</Text></App>\n' });
  commit(shallow, 'From a shallow clone');
  const cut = push(shallow, slug, app.editKey);
  assert.match(cut.out, /Published version 10/);
  assert.doesNotMatch(cut.out, /does not contain/, cut.out);

  // The commit is the app's to know and nobody else's to read.
  const record = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'apps', slug, 'app.json'), 'utf8')).app.pushed;
  assert.deepEqual(Object.keys(record).sort(), ['commit', 'sha256', 'tree', 'version']);
  assert.equal(record.version, 10);
  assert.equal(record.commit, git(shallow, ['rev-parse', 'HEAD']).out.trim());
  assert.ok(!(await s.api('GET', `/api/apps/${slug}`)).text.includes(record.commit));
});

test('a history rewritten over the same files is built on them still, and an upload in between ends what is known', skip, async () => {
  const app = await published('rewritten');
  const slug = app.app.slug;
  const dir = project();
  write(dir, { 'ui/main.ui': '<App><Text>two</Text></App>\n' });
  commit(dir, 'Two');
  assert.match(push(dir, slug, app.editKey).out, /Published version 2/);
  // The message reworded, so the commit that was pushed is no longer in the history; its files are.
  git(dir, ['commit', '-q', '--amend', '-m', 'Two, said better']);
  write(dir, { 'ui/main.ui': '<App><Text>three</Text></App>\n' });
  commit(dir, 'Three');
  const reworded = push(dir, slug, app.editKey);
  assert.match(reworded.out, /Published version 3/);
  assert.doesNotMatch(reworded.out, /does not contain/, reworded.out);
  // The latest files pushed alone, then the branch they came from: the files are in its history.
  write(dir, { 'ui/main.ui': '<App><Text>four</Text></App>\n' });
  commit(dir, 'Four');
  assert.match(git(dir, ['push', remote(slug), 'HEAD^{tree}:refs/heads/main'], app.editKey).out, /Published version 4/);
  write(dir, { 'ui/main.ui': '<App><Text>five</Text></App>\n' });
  commit(dir, 'Five');
  const after = push(dir, slug, app.editKey);
  assert.match(after.out, /Published version 5/);
  assert.doesNotMatch(after.out, /does not contain/, after.out);
  // A commit changed and pushed again is not built on the one it replaces, and is told so: it cannot be told apart
  // from another clone's.
  write(dir, { 'ui/main.ui': '<App><Text>five, changed</Text></App>\n' });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--amend', '-m', 'Five, changed']);
  const amended = push(dir, slug, app.editKey);
  assert.match(amended.out, /Published version 6/);
  assert.match(amended.out, /remote: Version 6 does not contain version 5, which was live until now/);

  // A version from the update page: the next push is not held against a commit the page never had.
  const form = new FormData();
  form.append('bundle', new Blob([zipSync({ 'manifest.json': Buffer.from(JSON.stringify(MANIFEST)), 'ui/main.ui': Buffer.from('<App><Text>uploaded</Text></App>\n') })]), 'app.softn');
  assert.equal((await s.api('POST', `/api/apps/${slug}/versions`, { body: form, headers: { 'X-Edit-Key': app.editKey } })).status, 201);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'apps', slug, 'app.json'), 'utf8')).app.pushed, undefined);
  const other = project();
  write(other, { 'ui/main.ui': '<App><Text>from elsewhere</Text></App>\n' });
  commit(other, 'From elsewhere');
  const unrelated = push(other, slug, app.editKey);
  assert.match(unrelated.out, /Published version 8/);
  assert.doesNotMatch(unrelated.out, /does not contain/, unrelated.out);
});

test('git push --force-with-lease publishes, with the commands the site gives; the line that makes it so is the second', skip, async () => {
  const app = await published('lease');
  const slug = app.app.slug;
  const dir = project();
  for (const command of siteCommands(slug)) assert.equal(git(dir, command).status, 0, command.join(' '));
  assert.match(git(dir, ['push', 'softn'], app.editKey).out, /Published version 2/);
  assert.equal(git(dir, ['for-each-ref', 'refs/remotes']).out.trim(), '', 'a push leaves no ref behind for a lease to be held against');
  write(dir, { 'ui/main.ui': '<App><Text>leased</Text></App>\n' });
  commit(dir, 'Leased');
  const leased = git(dir, ['push', '--force-with-lease', 'softn'], app.editKey);
  assert.equal(leased.status, 0, leased.out);
  assert.match(leased.out, /Published version 3/);
  for (const quiet of [['fetch', '--all'], ['remote', 'update']]) assert.equal(git(dir, quiet).status, 0, quiet.join(' '));

  // A project set up before that line was given: git itself refuses, and the line the guide gives puts it right.
  const old = project();
  for (const command of siteCommands(slug).filter((command) => !command.includes('--unset'))) assert.equal(git(old, command).status, 0);
  write(old, { 'ui/main.ui': '<App><Text>set up earlier</Text></App>\n' });
  commit(old, 'Set up earlier');
  assert.match(git(old, ['push', 'softn'], app.editKey).out, /Published version 4/);
  write(old, { 'ui/main.ui': '<App><Text>set up earlier, again</Text></App>\n' });
  commit(old, 'Again');
  const refusedByGit = git(old, ['push', '--force-with-lease', 'softn'], app.editKey);
  assert.notEqual(refusedByGit.status, 0);
  assert.match(refusedByGit.out, /stale info/);
  assert.equal(git(old, ['config', '--unset', 'remote.softn.fetch']).status, 0);
  const put = git(old, ['push', '--force-with-lease', 'softn'], app.editKey);
  assert.equal(put.status, 0, put.out);
  assert.match(put.out, /Published version 5/);
});

test('a push larger than git’s buffer: its probe, then a chunked body', skip, async () => {
  const app = await published('large');
  const dir = project({ 'assets/big.bin': crypto.randomBytes(3 * 1024 * 1024) });
  const r = push(dir, app.app.slug, app.editKey);
  assert.equal(r.status, 0, r.out);
  const files = await bundleFiles(app.app.slug);
  assert.equal(files['assets/big.bin'].length, 3 * 1024 * 1024);
});

test('a history of similar files arrives as deltas, and comes out byte for byte', skip, async () => {
  const app = await published('deltas');
  const dir = project();
  const line = (i) => `line ${i} of a file that changes a little at a time\n`;
  let text = Array.from({ length: 4000 }, (_, i) => line(i)).join('');
  for (let round = 0; round < 12; round++) {
    text = text.replace(line(round * 37), `changed in round ${round}\n`);
    write(dir, { 'data/long.txt': text, [`data/copy-${round % 3}.txt`]: text });
    commit(dir, `Round ${round}`);
  }
  git(dir, ['gc', '-q', '--aggressive']);
  const r = push(dir, app.app.slug, app.editKey);
  assert.equal(r.status, 0, r.out);
  const files = await bundleFiles(app.app.slug);
  assert.equal(Buffer.from(files['data/long.txt']).toString(), text);
  assert.equal((await versions(app.app.slug))[0].notes, 'Round 11');
});

test('names in other scripts, an empty file and an executable bit all arrive', skip, async () => {
  const app = await published('names');
  const dir = project({ 'docs/日本語.txt': 'こんにちは\n', 'assets/empty.txt': '' });
  assert.equal(git(dir, ['update-index', '--chmod=+x', 'manifest.json']).status, 0);
  git(dir, ['commit', '-q', '-m', 'Executable']);
  const r = push(dir, app.app.slug, app.editKey);
  assert.equal(r.status, 0, r.out);
  const files = await bundleFiles(app.app.slug);
  assert.equal(Buffer.from(files['docs/日本語.txt']).toString(), 'こんにちは\n');
  assert.equal(files['assets/empty.txt'].length, 0);
});

test('a clone is told what to do instead', skip, async () => {
  const app = await published('clone');
  const r = git(scratch, ['clone', '-q', `${s.base}/api/git/${app.app.slug}.git`, path.join(scratch, `clone-${++made}`)]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /takes pushes, and does not serve clones, fetches or pulls\. An app's source can be downloaded from its page\./);
});

test('a branch set to pull from the directory, as git suggests for a bare push, is told how to stop that', skip, async () => {
  const app = await published('upstream');
  const dir = project();
  git(dir, ['remote', 'add', 'softn', remote(app.app.slug)]);
  // Without the guide's push refspec, git answers a bare push with --set-upstream.
  const bare = git(dir, ['push', 'softn'], app.editKey);
  assert.notEqual(bare.status, 0);
  assert.match(bare.out, /git push --set-upstream softn main/);
  const followed = git(dir, ['push', '--set-upstream', 'softn', 'main'], app.editKey);
  assert.equal(followed.status, 0, followed.out);
  const pull = git(dir, ['pull'], app.editKey);
  assert.notEqual(pull.status, 0);
  assert.match(pull.out, /If git pull brought you here and the project has another remote, your branch is set to pull from the directory, and git branch --unset-upstream stops that\./);
  // What it says to do is all it takes, in a project that has another remote to pull from.
  const elsewhere = path.join(scratch, `elsewhere-${++made}.git`);
  assert.equal(git(scratch, ['init', '-q', '--bare', '-b', 'main', elsewhere]).status, 0);
  git(dir, ['remote', 'add', 'origin', elsewhere]);
  assert.equal(git(dir, ['push', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(dir, ['branch', '--unset-upstream']).status, 0);
  assert.match(git(dir, ['status', '-sb']).out, /^## main$/m);
  assert.doesNotMatch(git(dir, ['pull'], app.editKey).out, /takes pushes/, 'the directory is no longer asked');
  const quiet = git(dir, ['pull', 'origin', 'main'], app.editKey);
  assert.equal(quiet.status, 0, quiet.out);
});

test('in a project whose only remote is the directory, a pull is told there is nothing to pull, and not to run what changes nothing', skip, async () => {
  const app = await published('only-remote');
  const dir = project();
  for (const command of siteCommands(app.app.slug)) assert.equal(git(dir, command).status, 0);
  assert.equal(git(dir, ['push', 'softn'], app.editKey).status, 0);
  // No branch is set to pull from it, and git asks it all the same, as it is the only remote there is.
  assert.match(git(dir, ['status', '-sb']).out, /^## main$/m);
  const pull = git(dir, ['pull'], app.editKey);
  assert.notEqual(pull.status, 0);
  assert.match(pull.out, /remote error: This directory takes pushes, and does not serve clones, fetches or pulls\./, pull.out);
  assert.match(pull.out, /If the directory is the project's only remote, git pull asks it whatever the branch is set to, and there is nothing here to pull\./, pull.out);
});

test('an address that names no app is told so in words git shows, before any key is asked for', skip, async () => {
  const dir = project();
  const r = push(dir, 'no-such-app', 'x'.repeat(40));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /fatal: remote error: No app is published under that name\. Check the name in the remote's address, or publish the app's first version on the Publish page, which gives the commands with its name in them\./, r.out);
  assert.doesNotMatch(r.out, /not found|Authentication failed/, r.out);
  const refs = await s.api('GET', '/api/git/no-such-app.git/info/refs?service=git-receive-pack');
  assert.equal(refs.status, 200);
  assert.equal(refs.headers.get('content-type'), 'application/x-git-receive-pack-advertisement');
  assert.equal(refs.headers.get('www-authenticate'), null, 'no key is asked for, so git has none to keep under a wrong name');
  assert.equal(refs.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(refs.text, /no-such-app/, 'and nothing of the address is repeated to a terminal');
  // The same whatever came with it, and for a push sent without asking first.
  const keyed = await s.api('GET', '/api/git/no-such-app.git/info/refs?service=git-receive-pack', { headers: { Authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` } });
  assert.equal(keyed.status, 200);
  assert.match(keyed.text, /ERR No app is published under that name/);
  const sent = await s.api('POST', '/api/git/no-such-app.git/git-receive-pack', { raw: Buffer.from('0000'), headers: { 'Content-Type': 'application/x-git-receive-pack-request' } });
  assert.equal(sent.status, 200);
  assert.match(sent.text, /No app is published under that name.*unpack not read/s);
  // An unpublished app is no app to anyone but its owner's key, which is asked for as for any app.
  const app = await published('taken-down');
  assert.equal((await s.api('DELETE', `/api/apps/${app.app.slug}`, { headers: { 'X-Edit-Key': app.editKey } })).status, 204);
  const hidden = push(dir, app.app.slug, app.editKey);
  assert.notEqual(hidden.status, 0);
  assert.match(hidden.out, /remote error: No app is published under that name/, hidden.out);
});

test('every reply says not to keep it', skip, async () => {
  const app = await published('cache');
  const auth = { Authorization: `Basic ${Buffer.from(`x:${app.editKey}`).toString('base64')}` };
  const asked = await s.api('GET', `/api/git/${app.app.slug}.git/info/refs?service=git-receive-pack`);
  assert.equal(asked.status, 401);
  assert.match(asked.headers.get('www-authenticate'), /^Basic /);
  assert.equal(asked.headers.get('cache-control'), 'no-store');
  const refs = await s.api('GET', `/api/git/${app.app.slug}.git/info/refs?service=git-receive-pack`, { headers: auth });
  assert.equal(refs.status, 200);
  assert.equal(refs.headers.get('content-type'), 'application/x-git-receive-pack-advertisement');
  assert.equal(refs.headers.get('cache-control'), 'no-store');
  assert.ok(!refs.text.includes(app.editKey));
});

// ── What someone holding a key could send instead of what git sends ─────────────────────────────────────────────────

const TYPES = { commit: 1, tree: 2, blob: 3, tag: 4 };

function oid(type, data) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data])).digest('hex');
}

function varHeader(type, size) {
  const out = [];
  let byte = (type << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size > 0) {
    out.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(byte);
  return Buffer.from(out);
}

function entry(type, data, declared = data.length) {
  return Buffer.concat([varHeader(type, declared), zlib.deflateSync(data)]);
}

function pack(entries, count = entries.length) {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(count, 8);
  const body = Buffer.concat([head, ...entries]);
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}

function pkt(text) {
  const bytes = Buffer.from(text);
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}

/** A tree's bytes. A name can be bytes, for one that is not UTF-8. */
function tree(entries) {
  return Buffer.concat(entries.map(([mode, name, id]) => Buffer.concat([Buffer.from(`${mode} `), Buffer.isBuffer(name) ? name : Buffer.from(name), Buffer.from('\0'), Buffer.from(id, 'hex')])));
}

function pushRequest(app, packBytes, tip) {
  return {
    raw: Buffer.concat([pkt(`${'0'.repeat(40)} ${tip} refs/heads/main\0report-status side-band-64k\n`), Buffer.from('0000'), packBytes]),
    headers: { 'Content-Type': 'application/x-git-receive-pack-request', Authorization: `Basic ${Buffer.from(`x:${app.editKey}`).toString('base64')}` },
  };
}

/** A push of `objects` ({type, data}) with `tip` as the commit, sent as git would send it. */
async function raw(app, packBytes, tip, server = s) {
  return server.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, pushRequest(app, packBytes, tip));
}

/** A project of one commit; with `history`, of two, the first with the same files, sent along as a history is. */
function aProject(treeEntries = [], { history = false } = {}) {
  const manifest = Buffer.from(JSON.stringify({ name: 'Crafted', version: '1.0.0', main: 'ui.ui' }));
  const page = Buffer.from('<App><Text>hi</Text></App>');
  const entries = [['100644', 'manifest.json', oid('blob', manifest)], ['100644', 'ui.ui', oid('blob', page)], ...treeEntries].sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const treeData = tree(entries);
  const earlier = Buffer.from(`tree ${oid('tree', treeData)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nEarlier\n`);
  const commitData = Buffer.from(`tree ${oid('tree', treeData)}\n${history ? `parent ${oid('commit', earlier)}\n` : ''}author T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nCrafted\n`);
  return {
    tip: oid('commit', commitData),
    objects: [entry(TYPES.commit, commitData), ...(history ? [entry(TYPES.commit, earlier)] : []), entry(TYPES.tree, treeData), entry(TYPES.blob, manifest), entry(TYPES.blob, page)],
  };
}

async function refused(app, packBytes, tip, words, server = s) {
  const started = Date.now();
  const r = await raw(app, packBytes, tip, server);
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /not published/, r.text);
  assert.match(r.text, words, r.text);
  assert.ok(Date.now() - started < 20000, 'and refused quickly');
  assert.equal((await server.api('GET', `/api/apps/${app.app.slug}`)).json.app.versions.length, 1, 'nothing published');
  assert.ok(await server.tempEmpty(), 'nothing left on the temp disk');
}

test('a hand-made pack that is whole is read as git’s is', skip, async () => {
  const app = await published('crafted');
  const { tip, objects } = aProject();
  const r = await raw(app, pack(objects), tip);
  assert.match(r.text, /Published version 2/, r.text);
});

test('a delta is applied, whether its base comes before it or after, and the file it makes is what is published', skip, async () => {
  const number = (n) => {
    const out = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Buffer.from(out);
  };
  const base = Buffer.from('the first half|the second half');
  const made = Buffer.from('the second half and something new');
  // Copy "the second half" (15 bytes from 15), then insert the rest.
  const added = Buffer.from(' and something new');
  const delta = Buffer.concat([number(base.length), number(made.length), Buffer.from([0x80 | 0x01 | 0x10, 15, 16 - 1]), Buffer.from([added.length]), added]);
  const refDelta = Buffer.concat([varHeader(7, delta.length), Buffer.from(oid('blob', base), 'hex'), zlib.deflateSync(delta)]);
  for (const order of ['base first', 'delta first']) {
    const app = await published(`delta-${order.split(' ')[0]}`);
    const { tip, objects } = aProject([['100644', 'made.txt', oid('blob', made)]]);
    const entries = order === 'base first' ? [...objects, entry(TYPES.blob, base), refDelta] : [...objects, refDelta, entry(TYPES.blob, base)];
    const r = await raw(app, pack(entries), tip);
    assert.match(r.text, /Published version 2/, `${order}: ${r.text}`);
    const files = await bundleFiles(app.app.slug);
    assert.equal(Buffer.from(files['made.txt']).toString(), made.toString(), order);
  }
});

test('a damaged pack is refused: cut short, a wrong checksum, a wrong count, not a pack', skip, async () => {
  const app = await published('damaged');
  const { tip, objects } = aProject();
  const whole = pack(objects);
  await refused(app, whole.subarray(0, whole.length - 40), tip, /damaged|ends early/);
  const bent = Buffer.from(whole);
  bent[bent.length - 1] ^= 0xff;
  await refused(app, bent, tip, /damaged/);
  const flipped = Buffer.from(whole);
  flipped[40] ^= 0xff;
  await refused(app, flipped, tip, /damaged|smaller|larger/);
  await refused(app, pack(objects, objects.length + 1), tip, /damaged|ends early/);
  await refused(app, Buffer.from('this is not a pack at all'), tip, /did not carry a pack/);
});

test('a stream that expands past what it declares stops where it says, not where it ends', skip, async () => {
  const app = await published('bomb');
  const { tip, objects } = aProject();
  const bomb = entry(TYPES.blob, Buffer.alloc(40 * 1024 * 1024), 10);
  await refused(app, pack([...objects, bomb]), tip, /larger than its pack says/);
});

test('an object or a push past the limits is refused from what it declares', skip, async () => {
  const app = await published('limits');
  // Every object counts, history included, so the way to leave an old one behind is said with it: to a push that
  // came with a history, in a line that runs the same in Command Prompt, PowerShell and a POSIX shell.
  const long = aProject([], { history: true });
  await refused(app, pack([...long.objects, varHeader(TYPES.blob, 51 * 1024 * 1024)]), long.tip, /larger than 50 MB, the most a file of an app can be\. It may be in an earlier commit and not in the latest\. To send only its latest files: git push softn "HEAD\^\{tree\}:refs\/heads\/main"\n/);
  // A push that is its last commit alone has no earlier commit for the file to be in, and is not sent round again.
  const { tip, objects } = aProject();
  const alone = await raw(app, pack([...objects, varHeader(TYPES.blob, 51 * 1024 * 1024)]), tip);
  assert.match(alone.text, /larger than 50 MB, the most a file of an app can be\.\n/, alone.text);
  assert.doesNotMatch(alone.text, /latest files|earlier commit/, alone.text);
  // Before its commit is read, a push is taken to have a history, as most do.
  await refused(app, pack(objects, 60000), tip, /60000 objects, and the most taken is 50000\. To send only its latest files: git push softn "HEAD\^\{tree\}:refs\/heads\/main"\n/);
  // A shallow clone's push names a parent it did not send: that is the latest files alone too.
  const manifest = Buffer.from(JSON.stringify({ name: 'Crafted', version: '1.0.0', main: 'ui.ui' }));
  const page = Buffer.from('<App><Text>hi</Text></App>');
  const top = tree([['100644', 'manifest.json', oid('blob', manifest)], ['100644', 'ui.ui', oid('blob', page)]]);
  const cut = Buffer.from(`tree ${oid('tree', top)}\nparent ${'a'.repeat(40)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nShallow\n`);
  const shallow = await raw(app, pack([entry(TYPES.commit, cut), entry(TYPES.tree, top), entry(TYPES.blob, manifest), entry(TYPES.blob, page), varHeader(TYPES.blob, 51 * 1024 * 1024)]), oid('commit', cut));
  assert.match(shallow.text, /larger than 50 MB, the most a file of an app can be\.\n/, shallow.text);
  assert.equal((await versions(app.app.slug)).length, 1);
});

test('a delta is held to what it declares, before anything is made', skip, async () => {
  const app = await published('delta-bomb');
  const { tip, objects } = aProject();
  const blob = Buffer.from('a base to build on');
  const baseId = oid('blob', blob);
  const number = (n) => {
    const out = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Buffer.from(out);
  };
  const refDelta = (data) => Buffer.concat([varHeader(7, data.length), Buffer.from(baseId, 'hex'), zlib.deflateSync(data)]);
  // Declares a gigabyte.
  await refused(app, pack([...objects, entry(TYPES.blob, blob), refDelta(Buffer.concat([number(blob.length), number(1024 * 1024 * 1024)]))]), tip, /larger than/);
  // Copies from past the end of its base.
  await refused(app, pack([...objects, entry(TYPES.blob, blob), refDelta(Buffer.concat([number(blob.length), number(100), Buffer.from([0x90 | 1, 200, 100])]))]), tip, /damaged/);
  // Built on nothing that is there.
  const missing = Buffer.concat([varHeader(7, 2), Buffer.from('f'.repeat(40), 'hex'), zlib.deflateSync(Buffer.from([1, 1]))]);
  await refused(app, pack([...objects, missing]), tip, /missing an object/);
});

test('a tree cannot name its way out of the bundle, or be missing what it names', skip, async () => {
  const app = await published('trees');
  const blob = Buffer.from('x');
  for (const name of ['..', '.', 'a\\b', '..\\..\\x']) {
    const { tip, objects } = aProject([['100644', name, oid('blob', blob)]]);
    await refused(app, pack([...objects, entry(TYPES.blob, blob)]), tip, /name a bundle cannot hold/);
  }
  const { tip, objects } = aProject([['100644', 'gone.txt', 'e'.repeat(40)]]);
  await refused(app, pack(objects), tip, /missing gone\.txt/);
  const notCommit = entry(TYPES.blob, blob);
  await refused(app, pack([notCommit]), oid('blob', blob), /Only a commit, or the folder of one, is published\./);
});

test('a bundle that would be too large is refused', skip, async () => {
  const { tip, objects } = aProject([['100644', 'big.bin', oid('blob', Buffer.alloc(1))]]);
  void tip;
  void objects;
  const small = await startServer({ config: { maxBundleBytes: 4096 }, prefix: 'softn-git-small-' });
  try {
    const app = await small.publish('Small', {}, { category: 'tools' });
    const dir = project({ 'assets/noise.bin': crypto.randomBytes(20000) });
    const url = `${small.base}/api/git/${app.app.slug}.git`.replace('://', `://${app.app.slug}@`);
    const r = git(dir, ['push', url, 'HEAD:main'], app.editKey);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /remote: .*(larger than this route accepts|the most the directory takes)/, r.out);
    // A body past the route's limit, before any of it is read, is told the way to send less.
    const past = await small.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, { raw: Buffer.alloc(8 * 1024 * 1024), headers: pushHeaders(app) });
    assert.equal(past.status, 200, past.text);
    // Nothing of it was read, so it is not known whether its history is what makes it large: both cases are said, and
    // a person whose latest files are the trouble is not sent to push them again.
    assert.match(past.text, /larger than this route accepts \([^)]+\)\. If the project's history is what makes it that large, this sends its latest files alone: git push softn "HEAD\^\{tree\}:refs\/heads\/main"\. If the latest files alone are that large, the app is more than the directory takes, which is 4 KB as a bundle\.\n/, past.text);
    assert.match(past.text, /unpack not read/);
  } finally {
    small.stop();
  }
});

test('a wrong key is counted, and git’s asking without one is not', skip, async () => {
  const limited = await startServer({ config: { limits: { gitKey: [2, 3600] } }, prefix: 'softn-git-limit-' });
  try {
    const app = await limited.publish('Limited', {}, { category: 'tools' });
    const route = `/api/git/${app.app.slug}.git/info/refs?service=git-receive-pack`;
    const asking = { Authorization: `Basic ${Buffer.from(`${app.app.slug}:`).toString('base64')}` };
    for (let i = 0; i < 6; i++) assert.equal((await limited.api('GET', route, { headers: i % 2 ? asking : {} })).status, 401);
    const wrong = { Authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` };
    assert.equal((await limited.api('GET', route, { headers: wrong })).status, 401);
    assert.equal((await limited.api('GET', route, { headers: wrong })).status, 401);
    assert.equal((await limited.api('GET', route, { headers: wrong })).status, 429);
  } finally {
    limited.stop();
  }
});

test('a chunked push a host hands PHP nothing of says what to do', skip, async () => {
  const app = await published('chunked');
  const url = new URL(`${s.base}/api/git/${app.app.slug}.git/git-receive-pack`);
  const text = await new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-receive-pack-request', 'Transfer-Encoding': 'chunked', Authorization: `Basic ${Buffer.from(`x:${app.editKey}`).toString('base64')}` },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
  assert.match(text, /git config http\.postBuffer 64M/);
  // Git with that set sends pieces only past 64 MB, too large anyway: it is told what does fit, not to set it again.
  assert.match(text, /If http\.postBuffer is set already, this push is past 64 MB, more than the directory takes\. If the project's history is what makes it that large, this sends its latest files alone: git push softn "HEAD\^\{tree\}:refs\/heads\/main"\. If the latest files alone are that large/);
  // With no report at all, dulwich said the push had succeeded.
  assert.match(text, /unpack not read/);
});

test('an empty push says the same with no sign of chunks, as over HTTP/2 there is none', skip, async () => {
  const app = await published('no-header');
  const r = await s.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, { raw: Buffer.alloc(0), headers: pushHeaders(app) });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /git config http\.postBuffer 64M/);
  assert.match(r.text, /unpack not read/);
});

test('an app keeps its first version and its latest: the oldest after the first goes to make room, by any route', skip, async () => {
  const small = await startServer({ config: { maxVersionsPerApp: 3, siteOrigin: 'https://softn.example' }, prefix: 'softn-git-rolling-' });
  try {
    const app = await small.publish('Rolling', {}, { category: 'tools' });
    const slug = app.app.slug;
    const folder = path.join(small.dataDir, 'apps', slug);
    const dir = project();
    const url = `${small.base}/api/git/${slug}.git`.replace('://', `://${slug}@`);
    const push = (text) => {
      write(dir, { 'ui/main.ui': `<App><Text>${text}</Text></App>\n` });
      commit(dir, text);
      return git(dir, ['push', url, 'HEAD:main'], app.editKey);
    };
    const held = async () => (await small.api('GET', `/api/apps/${slug}`)).json.app.versions.map((v) => v.version);
    // The address comes from the site's own setting, not from what the request called it.
    assert.match(push('two').out, /Published version 2: https:\/\/softn\.example\/app\//);
    assert.doesNotMatch(push('three').out, /removed/);
    assert.deepEqual(await held(), [3, 2, 1]);

    const four = push('four');
    assert.equal(four.status, 0, four.out);
    assert.match(four.out, /Published version 4/);
    assert.match(four.out, /To make room, version 2 was removed: an app keeps its first version and its latest ones\./);
    assert.deepEqual(await held(), [4, 3, 1]);
    assert.ok(!fs.existsSync(path.join(folder, 'v2.softn')), 'its file goes with it');
    assert.ok(fs.existsSync(path.join(folder, 'v1.softn')), 'the first stays');
    assert.equal((await small.api('GET', `/api/apps/${slug}/bundle.softn?v=2`)).status, 404);
    assert.equal((await small.api('GET', `/api/apps/${slug}/bundle.softn?v=1`)).status, 200);

    const form = new FormData();
    form.append('bundle', new Blob([zipSync({ 'manifest.json': Buffer.from(JSON.stringify(MANIFEST)), 'ui/main.ui': Buffer.from('<App><Text>five</Text></App>\n') })]), 'app.softn');
    const five = await small.api('POST', `/api/apps/${slug}/versions`, { body: form, headers: { 'X-Edit-Key': app.editKey } });
    assert.equal(five.status, 201, five.text);
    assert.deepEqual(five.json.app.droppedVersions, [3]);
    assert.deepEqual(await held(), [5, 4, 1]);
    assert.equal(five.json.app.version, 5, 'the numbers carry on');
    assert.equal(Buffer.from(unzipSync(new Uint8Array(await (await fetch(`${small.base}/api/apps/${slug}/bundle.softn`)).arrayBuffer()))['ui/main.ui']).toString(), '<App><Text>five</Text></App>\n');

    // Lowered later, one goes for each new version and no more: a setting is not a way to delete dozens at a stroke.
    const file = path.join(small.dataDir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), maxVersionsPerApp: 2 }));
    const six = push('six').out;
    assert.match(six, /Published version 6.*To make room, version 4 was removed: an app keeps its first version and its latest ones\./);
    assert.doesNotMatch(six, /keeps \d+ versions/, 'it does not claim a number the app is still over');
    assert.deepEqual(await held(), [6, 5, 1]);

    // A site that would rather refuse.
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), dropOldVersions: false }));
    const refused7 = push('seven');
    assert.notEqual(refused7.status, 0);
    assert.match(refused7.out, /reached its version limit/);
    assert.deepEqual(await held(), [6, 5, 1]);
    assert.ok(fs.existsSync(path.join(folder, 'v6.softn')));

    // And with only the first to keep, there is nothing that can go.
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), maxVersionsPerApp: 1, dropOldVersions: true }));
    const other = await small.publish('Only one', {}, { category: 'tools' });
    const otherUrl = `${small.base}/api/git/${other.app.slug}.git`.replace('://', `://${other.app.slug}@`);
    const alone = git(dir, ['push', otherUrl, 'HEAD:main'], other.editKey);
    assert.notEqual(alone.status, 0);
    assert.match(alone.out, /reached its version limit/);
  } finally {
    small.stop();
  }
});

test('a bundle the operator put in an app\'s folder by hand is never what goes to make room', skip, async () => {
  const small = await startServer({ config: { maxVersionsPerApp: 3 }, prefix: 'softn-git-handmade-' });
  try {
    const app = await small.publish('Hand made', {}, { category: 'tools' });
    const slug = app.app.slug;
    const folder = path.join(small.dataDir, 'apps', slug);
    // Discovery numbers a file it does not know after the latest, whatever its name.
    fs.writeFileSync(path.join(folder, 'by-hand.softn'), zipSync({ 'manifest.json': Buffer.from(JSON.stringify(MANIFEST)), 'ui/main.ui': Buffer.from('<App><Text>by hand</Text></App>\n') }));
    const versions = async () => (await small.api('GET', `/api/apps/${slug}`)).json.app.versions;
    assert.deepEqual((await versions()).map((v) => v.version), [2, 1]);

    const dir = project();
    const url = `${small.base}/api/git/${slug}.git`.replace('://', `://${slug}@`);
    const push = (text) => {
      write(dir, { 'ui/main.ui': `<App><Text>${text}</Text></App>\n` });
      commit(dir, text);
      return git(dir, ['push', url, 'HEAD:main'], app.editKey);
    };
    assert.match(push('three').out, /Published version 3/);
    const four = push('four');
    assert.match(four.out, /Published version 4.*To make room, version 3 was removed/);
    assert.deepEqual((await versions()).map((v) => v.version), [4, 2, 1]);
    assert.ok(fs.existsSync(path.join(folder, 'by-hand.softn')), 'the operator\'s file stays');
    assert.ok(!fs.existsSync(path.join(folder, 'v3.softn')));
    assert.match(push('five').out, /To make room, version 4 was removed/);
    assert.deepEqual((await versions()).map((v) => v.version), [5, 2, 1]);
  } finally {
    small.stop();
  }
});

const pushHeaders = (app) => ({ 'Content-Type': 'application/x-git-receive-pack-request', Authorization: `Basic ${Buffer.from(`x:${app.editKey}`).toString('base64')}` });

test('a ref is named once, so the work of a push is not done again under the catalogue lock', skip, async () => {
  const app = await published('twice');
  const { tip, objects } = aProject();
  const zero = '0'.repeat(40);
  const r = await s.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, {
    raw: Buffer.concat([pkt(`${zero} ${tip} refs/heads/main\0report-status side-band-64k\n`), pkt(`${zero} ${tip} refs/heads/main\n`), Buffer.from('0000'), pack(objects)]),
    headers: pushHeaders(app),
  });
  assert.match(r.text, /not a push git would send/, r.text);
  assert.match(r.text, /unpack not read/, r.text);
  assert.equal((await versions(app.app.slug)).length, 1);
});

test('a push of every branch publishes main, however many the others are, and says once that they are not kept', skip, async () => {
  const app = await published('all-branches');
  const dir = project();
  for (let i = 0; i < 20; i++) assert.equal(git(dir, ['branch', `b${i}`]).status, 0);
  const r = git(dir, ['push', '--all', remote(app.app.slug)], app.editKey);
  // Git ends in failure, as twenty branches a person named were not taken; main was, and is published.
  assert.notEqual(r.status, 0);
  assert.match(r.out, /remote: Published version 2/, r.out);
  assert.equal(r.out.match(/remote: Only main is published: the other branches in this push are not kept\./g)?.length, 1, r.out);
  assert.equal(r.out.match(/\[remote rejected\]/g)?.length, 20, r.out);
  assert.doesNotMatch(r.out, /Everything up-to-date|too many refs|failed to report/, r.out);
  assert.equal((await versions(app.app.slug)).length, 2);
  // Without main among them, nothing is published, and the line says what to run.
  git(dir, ['checkout', '-q', 'b0']);
  git(dir, ['branch', '-D', 'main']);
  write(dir, { 'ui/main.ui': '<App><Text>no main</Text></App>\n' });
  commit(dir, 'No main');
  const none = git(dir, ['push', '--all', remote(app.app.slug)], app.editKey);
  assert.notEqual(none.status, 0);
  assert.match(none.out, /remote: Only main is published\. Push your branch to it: git push softn HEAD:refs\/heads\/main/, none.out);
  assert.equal((await versions(app.app.slug)).length, 2);
});

test('a pkt-line of nothing is refused as a bad request, not a failure of the server', skip, async () => {
  const app = await published('empty-line');
  const r = await s.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, { raw: Buffer.from('00040000'), headers: pushHeaders(app) });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /not a push git would send/, r.text);
});

test('a walk is counted by every name it meets, not by the files it finds', skip, async () => {
  const app = await published('laughs');
  // 63 folders, each naming the next twice, with nothing at the bottom: 2^63 names, from 3 KB, and no file among them.
  const empty = Buffer.alloc(0);
  const made = [entry(TYPES.tree, empty)];
  let id = oid('tree', empty);
  for (let i = 0; i < 63; i++) {
    const data = tree([['40000', 'a', id], ['40000', 'b', id]]);
    made.push(entry(TYPES.tree, data));
    id = oid('tree', data);
  }
  const doubled = aProject([['40000', 'bomb', id]]);
  await refused(app, pack([...doubled.objects, ...made]), doubled.tip, /more than 8000 files and folders/);
  // Names that are left out are met all the same.
  const blob = Buffer.from('x');
  const skipped = tree(Array.from({ length: 9000 }, () => ['100644', '.DS_Store', oid('blob', blob)]));
  const leftOut = aProject([['40000', 'left-out', oid('tree', skipped)]]);
  await refused(app, pack([...leftOut.objects, entry(TYPES.tree, skipped), entry(TYPES.blob, blob)]), leftOut.tip, /more than 8000 files and folders/);
});

test('a folder and a path are held to what a bundle could hold', skip, async () => {
  const app = await published('long');
  const blob = Buffer.from('x');
  // Past zip's 16-bit length the name stored would be a piece of the name checked.
  const long = aProject([['100644', 'n'.repeat(70000), oid('blob', blob)]]);
  await refused(app, pack([...long.objects, entry(TYPES.blob, blob)]), long.tip, /path of more than 4096 bytes/);
  const wide = tree(Array.from({ length: 12000 }, (_, i) => ['100644', `${String(i).padStart(120, '0')}`, oid('blob', blob)]));
  const big = aProject([['40000', 'wide', oid('tree', wide)]]);
  await refused(app, pack([...big.objects, entry(TYPES.tree, wide), entry(TYPES.blob, blob)]), big.tip, /wide\/ has more files than a bundle can hold/);
});

test('an object sent again and again is counted as read, though it is kept once', skip, async () => {
  const app = await published('again');
  const size = 50 * 1024 * 1024;
  const blob = Buffer.alloc(size);
  const copy = entry(TYPES.blob, blob);
  const { tip, objects } = aProject();
  await refused(app, pack([...objects, ...Array(21).fill(copy)]), tip, /too much to read/);

  // And rebuilt by a few bytes of delta, which is the base read and the object made, each time.
  const number = (n) => {
    const out = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Buffer.from(out);
  };
  const chunk = 0xffffff;
  const ops = [];
  for (let at = 0; at < size; at += chunk) {
    const length = Math.min(chunk, size - at);
    ops.push(Buffer.from([0x80 | 0x0f | 0x70, at & 255, (at >> 8) & 255, (at >> 16) & 255, (at >> 24) & 255, length & 255, (length >> 8) & 255, (length >> 16) & 255]));
  }
  const data = Buffer.concat([number(size), number(size), ...ops]);
  const rebuild = Buffer.concat([varHeader(7, data.length), Buffer.from(oid('blob', blob), 'hex'), zlib.deflateSync(data)]);
  await refused(app, pack([...objects, copy, ...Array(11).fill(rebuild)]), tip, /too much to read/);
});

test('a delta of nothing but tiny steps is counted by its steps, which are what take the time', skip, async () => {
  const app = await published('steps');
  const number = (n) => {
    const out = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Buffer.from(out);
  };
  const blob = Buffer.from('x');
  const steps = 8 * 1024 * 1024;
  // Copy one byte from the start, over and over. As bytes this is 25 MB, and the 950 MB sent ahead of it, which is the
  // cheap way to use up most of the allowance, still leaves room for that: only the steps can take it over.
  const ops = Buffer.alloc(steps * 2);
  for (let at = 0; at < ops.length; at += 2) { ops[at] = 0x90; ops[at + 1] = 1; }
  const data = Buffer.concat([number(1), number(steps), ops]);
  const delta = Buffer.concat([varHeader(7, data.length), Buffer.from(oid('blob', blob), 'hex'), zlib.deflateSync(data)]);
  const filler = entry(TYPES.blob, Buffer.alloc(50 * 1024 * 1024));
  const { tip, objects } = aProject();
  await refused(app, pack([...objects, entry(TYPES.blob, blob), ...Array(19).fill(filler), delta]), tip, /too much to read/);
});

test('what waits for a base waits in memory, and is held to a limit', skip, async () => {
  const app = await published('waiting');
  const { tip, objects } = aProject();
  const far = Buffer.alloc(17 * 1024 * 1024);
  const waiting = Buffer.concat([varHeader(7, far.length), Buffer.from('f'.repeat(40), 'hex'), zlib.deflateSync(far)]);
  await refused(app, pack([...objects, waiting]), tip, /too much ahead/);
});

test('a long chain sent backwards is read in one pass', skip, async () => {
  const app = await published('backwards');
  const number = (n) => {
    const out = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Buffer.from(out);
  };
  // Each object is the one before with a byte added, and the pack holds them last first, then the first.
  const versionsOf = [Buffer.from('a')];
  const deltas = [];
  for (let i = 1; i < 3000; i++) {
    const from = versionsOf[i - 1];
    const next = Buffer.concat([from.subarray(0, 8), Buffer.from([65 + (i % 26), i & 255, (i >> 8) & 255])]);
    versionsOf.push(next);
    const data = Buffer.concat([number(from.length), number(next.length), Buffer.from([0x80 | 0x10, Math.min(from.length, 8)]), Buffer.from([3]), next.subarray(-3)]);
    deltas.push(Buffer.concat([varHeader(7, data.length), Buffer.from(oid('blob', from), 'hex'), zlib.deflateSync(data)]));
  }
  const last = versionsOf[versionsOf.length - 1];
  const { tip, objects } = aProject([['100644', 'chain.txt', oid('blob', last)]]);
  const started = Date.now();
  const r = await raw(app, pack([...objects, ...deltas.reverse(), entry(TYPES.blob, versionsOf[0])]), tip);
  assert.match(r.text, /Published version 2/, r.text);
  assert.ok(Date.now() - started < 10000);
  assert.deepEqual(Buffer.from((await bundleFiles(app.app.slug))['chain.txt']), last);
});

test('a push is counted before its body is read, whatever it asks for, and git’s probe is not', skip, async () => {
  const limited = await startServer({ config: { limits: { version: [1, 3600] } }, prefix: 'softn-git-window-' });
  try {
    const app = await limited.publish('Window', {}, { category: 'tools' });
    const slug = app.app.slug;
    for (let i = 0; i < 3; i++) {
      assert.equal((await limited.api('POST', `/api/git/${slug}.git/git-receive-pack`, { raw: Buffer.from('0000'), headers: pushHeaders(app) })).status, 200);
    }
    const dir = project();
    const url = `${limited.base}/api/git/${slug}.git`.replace('://', `://${slug}@`);
    assert.match(git(dir, ['push', url, 'HEAD:other'], app.editKey).out, /Only main is published/);
    const next = git(dir, ['push', url, 'HEAD:main'], app.editKey);
    assert.notEqual(next.status, 0);
    assert.match(next.out, /remote: Too many requests/, next.out);
    assert.equal(limited.tempFiles().filter((f) => f.startsWith('softn-')).length, 0);
  } finally {
    limited.stop();
  }
});

test('the temp disk is looked at while a pack is read, as a small pack can expand a long way', skip, async () => {
  const tight = await startServer({ prefix: 'softn-git-room-' });
  try {
    const app = await tight.publish('Room', {}, { category: 'tools' });
    const file = path.join(tight.dataDir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), minFreeBytes: 2 ** 60 }));
    const { tip, objects } = aProject();
    // With a checksum that fails, so this is not the check on the finished bundle, which comes after it.
    const send = async (extra) => {
      const damaged = pack([...objects, ...extra]);
      damaged[damaged.length - 1] ^= 1;
      return tight.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, {
        raw: Buffer.concat([pkt(`${'0'.repeat(40)} ${tip} refs/heads/main\0report-status side-band-64k\n`), Buffer.from('0000'), damaged]),
        headers: pushHeaders(app),
      });
    };
    assert.match((await send([])).text, /pack is damaged/, 'a small push does not ask for room it will not use');
    assert.match((await send([entry(TYPES.blob, Buffer.alloc(33 * 1024 * 1024))])).text, /no room for this/);
  } finally {
    tight.stop();
  }
});

test('a large file with a history fits in the memory a small host gives', skip, async () => {
  const small = await startServer({ ini: { memory_limit: '128M' }, prefix: 'softn-git-memory-' });
  try {
    const app = await small.publish('Memory', {}, { category: 'tools' });
    const slug = app.app.slug;
    const piece = crypto.randomBytes(4096);
    const large = Buffer.alloc(48 * 1024 * 1024);
    for (let at = 0; at < large.length; at += piece.length) piece.copy(large, at);
    const dir = project({ 'assets/large.bin': large });
    large[1000] ^= 1;
    write(dir, { 'assets/large.bin': large });
    commit(dir, 'Changed a byte');
    const url = `${small.base}/api/git/${slug}.git`.replace('://', `://${slug}@`);
    const r = git(dir, ['-c', 'http.postBuffer=67108864', 'push', url, 'HEAD:main'], app.editKey);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Published version 2/);
    const got = await fetch(`${small.base}/api/apps/${slug}/bundle.softn`);
    const files = unzipSync(new Uint8Array(await got.arrayBuffer()));
    assert.ok(Buffer.from(files['assets/large.bin']).equals(large));
  } finally {
    small.stop();
  }
});

/**
 * A line a person is given, run as their shell runs it: Command Prompt on Windows, sh elsewhere. The key comes from
 * git's own environment, as a line that is run as it is can name no helper.
 */
function inShell(dir, line, key) {
  const env = { ...gitEnv(), GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: `!f() { echo "password=${key}"; }; f` };
  const r = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: dir, env, encoding: 'utf8', timeout: 60000, windowsVerbatimArguments: true })
    : spawnSync('sh', ['-c', line], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('what the refusal says to do about a large history works, as a shell runs it: only the latest files, on the same branch', skip, async () => {
  const app = await published('latest');
  const dir = project({ 'old-secret.txt': 'was here once\n' });
  fs.rmSync(path.join(dir, 'old-secret.txt'));
  write(dir, { 'ui/main.ui': '<App><Text>latest</Text></App>\n' });
  commit(dir, 'Second');
  // The line as a refusal gives it, taken from one.
  const long = aProject([], { history: true });
  const told = await raw(app, pack(long.objects, 60000), long.tip);
  const line = told.text.match(/To send only its latest files: (git push softn "HEAD\^\{tree\}:refs\/heads\/main")\n/);
  assert.ok(line, told.text);
  assert.equal(git(dir, ['remote', 'add', 'softn', remote(app.app.slug)]).status, 0);
  const before = git(dir, ['rev-parse', 'HEAD']).out;
  const r = inShell(dir, line[1], app.editKey);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /remote: Published version 2/);
  const files = await bundleFiles(app.app.slug);
  assert.deepEqual(Object.keys(files).sort(), ['manifest.json', 'ui/main.ui']);
  assert.equal(Buffer.from(files['ui/main.ui']).toString(), '<App><Text>latest</Text></App>\n');
  assert.equal((await versions(app.app.slug))[0].notes, '', 'files pushed with no commit have no subject');
  assert.equal(git(dir, ['rev-parse', 'HEAD']).out, before, 'and the branch is where it was');
  assert.equal(git(dir, ['status', '--porcelain']).out, '');
  // What that line replaced, a commit made of the tree, is published as it was, where a shell can run it.
  write(dir, { 'ui/main.ui': '<App><Text>later</Text></App>\n' });
  commit(dir, 'Third');
  const made = git(dir, ['commit-tree', 'HEAD^{tree}', '-m', 'Publish']);
  assert.equal(made.status, 0, made.out);
  const old = git(dir, ['push', remote(app.app.slug), `${made.out.trim()}:refs/heads/main`], app.editKey);
  assert.equal(old.status, 0, old.out);
  assert.match(old.out, /Published version 3/);
  assert.equal((await versions(app.app.slug))[0].notes, 'Publish');
});

test('an app in a folder of a larger repository: the refusal names the folder, and the command it gives publishes it alone', skip, async () => {
  const app = await published('folder');
  const dir = path.join(scratch, `repo-${++made}`);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main', '.']);
  // What would be refused elsewhere in the repository is no business of the app's, and is not what it is told.
  write(dir, { 'README.md': '# The project\n', 'server/.env': 'TOKEN=x\n', 'app/manifest.json': JSON.stringify(MANIFEST), 'app/ui/main.ui': '<App><Text>in a folder</Text></App>\n' });
  commit(dir, 'An app in a folder');
  const r = push(dir, app.app.slug, app.editKey);
  assert.notEqual(r.status, 0);
  const command = r.out.match(/To publish app\/ alone: (git push softn "HEAD:app:refs\/heads\/main")/);
  assert.ok(command, r.out);
  // The command, as a shell runs it: the folder's tree, pushed as it is.
  assert.equal(git(dir, ['remote', 'add', 'softn', remote(app.app.slug)]).status, 0);
  const ok = inShell(dir, command[1], app.editKey);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /Published version 2/);
  assert.deepEqual(Object.keys(await bundleFiles(app.app.slug)).sort(), ['manifest.json', 'ui/main.ui']);
  // A folder with a space in its name, which is why the command is in quotes.
  write(dir, { 'My App/manifest.json': JSON.stringify({ ...MANIFEST, name: 'Spaced' }), 'My App/ui/main.ui': '<App><Text>in a folder with a space</Text></App>\n' });
  fs.rmSync(path.join(dir, 'app'), { recursive: true });
  commit(dir, 'A folder with a space');
  const spaced = push(dir, app.app.slug, app.editKey).out.match(/To publish My App\/ alone: (git push softn "HEAD:My App:refs\/heads\/main")/);
  assert.ok(spaced);
  const second = inShell(dir, spaced[1], app.editKey);
  assert.equal(second.status, 0, second.out);
  assert.match(second.out, /Published version 3/);
  assert.equal(Buffer.from((await bundleFiles(app.app.slug))['ui/main.ui']).toString(), '<App><Text>in a folder with a space</Text></App>\n');
  // What these lines replaced, a commit made of the folder's tree, is published as it was.
  write(dir, { 'My App/ui/main.ui': '<App><Text>as before</Text></App>\n' });
  commit(dir, 'As before');
  const folder = git(dir, ['commit-tree', 'HEAD:My App', '-m', 'Publish']);
  assert.match(git(dir, ['push', remote(app.app.slug), `${folder.out.trim()}:refs/heads/main`], app.editKey).out, /Published version 4/);

  // More than one, the nearest the top: each its own app. And none at all.
  write(dir, { 'apps/two/manifest.json': JSON.stringify({ ...MANIFEST, name: 'Two' }), 'apps/two/ui/main.ui': '<App><Text>two</Text></App>\n', 'apps/one/manifest.json': JSON.stringify({ ...MANIFEST, name: 'One' }), 'apps/one/ui/main.ui': '<App><Text>one</Text></App>\n' });
  fs.rmSync(path.join(dir, 'My App'), { recursive: true });
  commit(dir, 'Two apps');
  assert.match(push(dir, app.app.slug, app.editKey).out, /apps\/one\/, apps\/two\/ have one\. Each app is its own remote, with its own key\. To publish apps\/one\/ alone: git push softn "HEAD:apps\/one:refs\/heads\/main"/);
  fs.rmSync(path.join(dir, 'apps'), { recursive: true });
  write(dir, { 'notes.txt': 'no app here\n' });
  commit(dir, 'No app');
  assert.match(push(dir, app.app.slug, app.editKey).out, /This commit has no manifest\.json in its top folder, which is where an app has it\./);
  assert.equal((await versions(app.app.slug)).length, 4);
});

test('a folder name that is not plain is named, and never put in a command to paste', skip, async () => {
  const app = await published('folder-name');
  const blob = Buffer.from(JSON.stringify(MANIFEST));
  const ui = Buffer.from('<App />\n');
  const uiTree = tree([['100644', 'main.ui', oid('blob', ui)]]);
  const inner = tree([['100644', 'manifest.json', oid('blob', blob)], ['40000', 'ui', oid('tree', uiTree)]]);
  const root = tree([['40000', '$(touch x)', oid('tree', inner)]]);
  const commitData = Buffer.from(`tree ${oid('tree', root)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nCrafted\n`);
  const objects = [commitData, root, inner, uiTree].map((data, i) => entry(i === 0 ? TYPES.commit : TYPES.tree, data));
  await refused(app, pack([...objects, entry(TYPES.blob, blob), entry(TYPES.blob, ui)]), oid('commit', commitData), /\$\(touch x\)\/ has one\. Publish that folder on its own\.(?![^\n]*git push)/);
  // Nor one that Command Prompt acts on inside quotes, or that ends the quotes.
  for (const name of ['%PATH%', 'a^b', 'a"b', 'a!b', 'a`b', 'a&b', "a'b"]) {
    const top = tree([['40000', name, oid('tree', inner)]]);
    const data = Buffer.from(`tree ${oid('tree', top)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nCrafted\n`);
    const sent = [data, top, inner, uiTree].map((bytes, i) => entry(i === 0 ? TYPES.commit : TYPES.tree, bytes));
    await refused(app, pack([...sent, entry(TYPES.blob, blob), entry(TYPES.blob, ui)]), oid('commit', data), /has one\. Publish that folder on its own\.(?![^\n]*git push)/);
  }
  // A space is safe inside the quotes, and a common name for a folder.
  const spaced = tree([['40000', 'My App', oid('tree', inner)]]);
  const spacedCommit = Buffer.from(`tree ${oid('tree', spaced)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nCrafted\n`);
  const more = [spacedCommit, spaced, inner, uiTree].map((data, i) => entry(i === 0 ? TYPES.commit : TYPES.tree, data));
  await refused(app, pack([...more, entry(TYPES.blob, blob), entry(TYPES.blob, ui)]), oid('commit', spacedCommit), /To publish My App\/ alone: git push softn "HEAD:My App:refs\/heads\/main"\n/);
});

test('a command too long for a line in the terminal is not given cut short', skip, async () => {
  const app = await published('folder-long');
  const blob = Buffer.from(JSON.stringify(MANIFEST));
  const ui = Buffer.from('<App />\n');
  const uiTree = tree([['100644', 'main.ui', oid('blob', ui)]]);
  const inner = tree([['100644', 'manifest.json', oid('blob', blob)], ['40000', 'ui', oid('tree', uiTree)]]);
  const withFolder = (name) => {
    const root = tree([['40000', name, oid('tree', inner)]]);
    const commitData = Buffer.from(`tree ${oid('tree', root)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nCrafted\n`);
    const objects = [commitData, root, inner, uiTree].map((data, i) => entry(i === 0 ? TYPES.commit : TYPES.tree, data));
    return [pack([...objects, entry(TYPES.blob, blob), entry(TYPES.blob, ui)]), oid('commit', commitData)];
  };
  // The name is in the line three times, so a plain one of 300 bytes is a line past what the terminal is given.
  const long = 'a'.repeat(300);
  await refused(app, ...withFolder(long), new RegExp(`${long}/ has one\\. Publish that folder on its own\\.(?![^\\n]*git push)`));
  const fits = 'b'.repeat(200);
  await refused(app, ...withFolder(fits), new RegExp(`git push softn "HEAD:${fits}:refs/heads/main"\\n`));
});

test('a committed node_modules beside the app’s folder, more folders than are looked in, does not hide it', skip, async () => {
  const app = await published('beside');
  const x = Buffer.from('x');
  const manifest = Buffer.from(JSON.stringify({ name: 'Beside', version: '1.0.0', main: 'x' }));
  const appTree = tree([['100644', 'manifest.json', oid('blob', manifest)], ['100644', 'x', oid('blob', x)]]);
  const packages = Array.from({ length: 1100 }, (_, i) => tree([['100644', `index${i}.js`, oid('blob', x)]]));
  const modules = tree(packages.map((one, i) => ['40000', `package-${String(i).padStart(4, '0')}`, oid('tree', one)]));
  const root = tree([['40000', 'app', oid('tree', appTree)], ['40000', 'node_modules', oid('tree', modules)]]);
  const commitData = Buffer.from(`tree ${oid('tree', root)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nCrafted\n`);
  const objects = [entry(TYPES.commit, commitData), entry(TYPES.tree, root), entry(TYPES.tree, appTree), entry(TYPES.tree, modules), ...packages.map((one) => entry(TYPES.tree, one)), entry(TYPES.blob, x), entry(TYPES.blob, manifest)];
  await refused(app, pack(objects), oid('commit', commitData), /no manifest\.json in its top folder, and app\/ has one\. To publish app\/ alone/);
});

test('the notes are the subject as git shows it: the first paragraph, in UTF-8 from the encoding the commit names', skip, async () => {
  const app = await published('subject');
  const dir = project();
  fs.writeFileSync(path.join(scratch, 'message.txt'), Buffer.from('Caf\xe9 au lait,\nmade twice\n\nThe rest of the message.\n', 'latin1'));
  const r = git(dir, ['-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '-q', '--allow-empty', '-F', path.join(scratch, 'message.txt')]);
  assert.equal(r.status, 0, r.out);
  assert.equal(push(dir, app.app.slug, app.editKey).status, 0);
  assert.equal((await versions(app.app.slug))[0].notes, 'Café au lait, made twice');
});

test('a name with what a terminal acts on reaches it as harmless marks', skip, async () => {
  const app = await published('escape');
  const blob = Buffer.from('x');
  const { tip, objects } = aProject([['120000', '\u001b[31mlink', oid('blob', blob)]]);
  const r = await raw(app, pack([...objects, entry(TYPES.blob, blob)]), tip);
  assert.match(r.text, /symbolic link/, r.text);
  assert.ok(!r.text.includes('\u001b'), 'the escape is gone');
});

test('the controls of C1 are masked too, as a character and as a byte that is not UTF-8', skip, async () => {
  const app = await published('escape-c1');
  const blob = Buffer.from('x');
  // U+009B is CSI on its own, and some terminals act on it as on ESC [.
  const one = aProject([['120000', '\u009b31mlink', oid('blob', blob)]]);
  const r = await raw(app, pack([...one.objects, entry(TYPES.blob, blob)]), one.tip);
  assert.match(r.text, /symbolic link/, r.text);
  assert.ok(!r.text.includes('\u009b'), r.text);
  // The same as a lone byte, in a name refused for not being UTF-8, which the refusal repeats.
  const name = Buffer.from([0x9b, 0x33, 0x31, 0x6d, 0x78]);
  const two = aProject([['100644', name, oid('blob', blob)]]);
  const request = pushRequest(app, pack([...two.objects, entry(TYPES.blob, blob)]), two.tip);
  const answer = await fetch(`${s.base}/api/git/${app.app.slug}.git/git-receive-pack`, { method: 'POST', body: request.raw, headers: request.headers });
  const bytes = Buffer.from(await answer.arrayBuffer());
  assert.match(bytes.toString('latin1'), /a name a bundle cannot hold/);
  assert.equal(bytes.indexOf(0x9b), -1, 'no byte of C1 reaches the terminal');
});

test('a folder whose mode has a leading zero is a folder; an empty name in a folder is refused', skip, async () => {
  const app = await published('modes');
  const inner = Buffer.from('inside\n');
  const sub = tree([['100644', 'inner.txt', oid('blob', inner)]]);
  const padded = aProject([['040000', 'more', oid('tree', sub)]]);
  const r = await raw(app, pack([...padded.objects, entry(TYPES.tree, sub), entry(TYPES.blob, inner)]), padded.tip);
  assert.match(r.text, /Published version 2/, r.text);
  assert.equal(Buffer.from((await bundleFiles(app.app.slug))['more/inner.txt']).toString(), 'inside\n');

  // "more/" and nothing: unsafeName takes a path that ends in "/" for a folder of a zip.
  const other = await published('empty-name');
  const empty = tree([['100644', '', oid('blob', inner)]]);
  const bad = aProject([['40000', 'more', oid('tree', empty)]]);
  await refused(other, pack([...bad.objects, entry(TYPES.tree, empty), entry(TYPES.blob, inner)]), bad.tip, /a name a bundle cannot hold: more\//);
});

test('a file kept in Git LFS is refused: what git holds of it is a pointer, which would be published in its place', skip, async () => {
  const app = await published('lfs');
  for (const version of ['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1']) {
    const pointer = Buffer.from(`version ${version}\noid sha256:${'a'.repeat(64)}\nsize 12345\n`);
    const { tip, objects } = aProject([['100644', 'logo.png', oid('blob', pointer)]]);
    await refused(app, pack([...objects, entry(TYPES.blob, pointer)]), tip, /logo\.png is kept in Git LFS.*update page/);
  }
  // A file that only begins with the words is a file.
  const notes = Buffer.from(`version https://git-lfs.github.com/spec/v1 is how a pointer begins, and oid sha256:${'b'.repeat(64)} follows\n`);
  const { tip, objects } = aProject([['100644', 'notes.txt', oid('blob', notes)]]);
  assert.match((await raw(app, pack([...objects, entry(TYPES.blob, notes)]), tip)).text, /Published version 2/);

  // git-lfs asks this before the push, and shows the message of the answer.
  const batch = await s.api('POST', `/api/git/${app.app.slug}.git/info/lfs/objects/batch`, { raw: JSON.stringify({ operation: 'upload', objects: [{ oid: 'a'.repeat(64), size: 12345 }] }), headers: { 'Content-Type': 'application/vnd.git-lfs+json', Accept: 'application/vnd.git-lfs+json' } });
  assert.equal(batch.status, 404, batch.text);
  assert.match(batch.headers.get('content-type'), /^application\/json/);
  assert.match(batch.json.message, /does not take files kept in Git LFS/);
});

const HAVE_LFS = HAVE_GIT && spawnSync('git', ['lfs', 'version']).status === 0;
test('with git-lfs, a push stops at its hook with what is wrong; past the hook the pointer is refused; out of LFS it goes through', { skip: skip.skip || (HAVE_LFS ? false : 'git-lfs is not installed') }, async () => {
  const app = await published('lfs-real');
  const dir = project();
  assert.equal(git(dir, ['lfs', 'install', '--local']).status, 0);
  assert.equal(git(dir, ['lfs', 'track', '*.png']).status, 0);
  const picture = crypto.randomBytes(300);
  write(dir, { 'logo.png': picture });
  commit(dir, 'A picture kept in LFS');

  const hooked = push(dir, app.app.slug, app.editKey);
  assert.notEqual(hooked.status, 0);
  assert.match(hooked.out, /batch response: This directory does not take files kept in Git LFS/, hooked.out);
  assert.doesNotMatch(hooked.out, /not found/i);

  const past = push(dir, app.app.slug, app.editKey, 'HEAD:main', ['--no-verify']);
  assert.notEqual(past.status, 0);
  assert.match(past.out, /remote: logo\.png is kept in Git LFS/, past.out);
  assert.equal((await versions(app.app.slug)).length, 1, 'nothing published');

  // What the guide says to do, as it says it: git has no terminal here, so a question would fail this.
  const out = git(dir, ['lfs', 'migrate', 'export', '--include=*.png', '--everything']);
  assert.equal(out.status, 0, out.out);
  const after = push(dir, app.app.slug, app.editKey);
  assert.equal(after.status, 0, after.out);
  assert.match(after.out, /Published version 2/);
  assert.ok(Buffer.from((await bundleFiles(app.app.slug))['logo.png']).equals(picture), 'the picture itself');
});

function varint(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

test('a delta too large for the memory a host gives is refused in the terminal, before PHP would end the request', skip, async () => {
  // Each push here ends PHP's request with a fatal error, without the look at memory, on a host that gives 48 MB.
  const tight = await startServer({ ini: { memory_limit: '48M' }, prefix: 'softn-git-tight-' });
  try {
    const app = await tight.publish('Tight', {}, { category: 'tools' });
    // The base of a delta is held whole beside it: 46 MB, copied by a few steps. Made of a piece over and over, so
    // that the push is small, as only what it expands to matters here.
    const base = Buffer.alloc(46 * 1024 * 1024);
    const piece = crypto.randomBytes(4096);
    for (let at = 0; at < base.length; at += piece.length) piece.copy(base, at);
    const copies = [];
    for (let at = 0; at < base.length; at += 0xffff) {
      const length = Math.min(0xffff, base.length - at);
      copies.push(Buffer.from([0x80 | 0x0f | 0x30, at & 255, (at >> 8) & 255, (at >> 16) & 255, (at >> 24) & 255, length & 255, (length >> 8) & 255]));
    }
    const copied = Buffer.concat([varint(base.length), varint(base.length), ...copies]);
    const copying = Buffer.concat([varHeader(7, copied.length), Buffer.from(oid('blob', base), 'hex'), zlib.deflateSync(copied)]);
    // With a history, the way out is the latest files alone, which sends no earlier copy for a change to be made to.
    const one = aProject([], { history: true });
    await refused(app, pack([...one.objects, entry(TYPES.blob, base), copying]), one.tip, /more memory than this server gives a request\. To send only its latest files: git push softn "HEAD\^\{tree\}:refs\/heads\/main"\n/, tight);
    // A push that is those already can still hold two files alike, and is sent to the page that takes them whole.
    const alone = aProject();
    await refused(app, pack([...alone.objects, entry(TYPES.blob, base), copying]), alone.tip, /more memory than this server gives a request\. The app's update page takes the same files as a bundle\.\n/, tight);

    // A delta is held whole while it inflates, and can be copied as it grows: 30 MB of one, on a byte.
    const x = Buffer.from('x');
    const insert = Buffer.concat([Buffer.from([127]), Buffer.alloc(127, 0x41)]);
    const count = Math.floor((30 * 1024 * 1024) / insert.length);
    const grown = Buffer.concat([varint(1), varint(count * 127), ...Array(count).fill(insert)]);
    const growing = Buffer.concat([varHeader(7, grown.length), Buffer.from(oid('blob', x), 'hex'), zlib.deflateSync(grown, { level: 1 })]);
    const two = aProject();
    await refused(app, pack([...two.objects, entry(TYPES.blob, x), growing]), two.tip, /more memory than this server gives a request/, tight);
    assert.deepEqual(tight.log.filter((line) => /Fatal/.test(line)), [], 'and PHP did not end a request');
  } finally {
    tight.stop();
  }
});

/** A commit of `root`, with every other object it names, as a pack. */
function packOf(root, objects) {
  const commitData = Buffer.from(`tree ${oid('tree', root)}\nauthor T <t@e> 0 +0000\ncommitter T <t@e> 0 +0000\n\nCrafted\n`);
  return { tip: oid('commit', commitData), bytes: pack([entry(TYPES.commit, commitData), entry(TYPES.tree, root), ...objects]) };
}

test('the folders of a push are read within the memory a host gives, however long their names', skip, async () => {
  // Each push here ends PHP's request with a fatal error, without what it tests, on a host that gives 48 MB.
  const tight = await startServer({ ini: { memory_limit: '48M' }, prefix: 'softn-git-folders-' });
  try {
    const app = await tight.publish('Folders', {}, { category: 'tools' });
    const x = Buffer.from('x');
    const long = 'A'.repeat(600 * 1024);

    // No manifest.json at the top, so its folders are looked through for one. A name of most of a megabyte, over a
    // folder of 120 others, was a path of that length held for each of them: 70 MB from a push of a few kilobytes.
    const children = Array.from({ length: 120 }, (_, i) => tree([['100644', `f${i}`, oid('blob', x)]]));
    const middle = tree(children.map((child, i) => ['40000', `d${i}`, oid('tree', child)]));
    const one = packOf(tree([['40000', long, oid('tree', middle)]]), [entry(TYPES.tree, middle), ...children.map((child) => entry(TYPES.tree, child)), entry(TYPES.blob, x)]);
    await refused(app, one.bytes, one.tip, /This commit has no manifest\.json in its top folder/, tight);

    // A walk holds each folder open on its way down, and each can be a megabyte of which only the first entry has been
    // read: 46 of them are more than the host gives.
    const manifest = Buffer.from(JSON.stringify({ name: 'Deep', version: '1.0.0', main: 'x' }));
    const padding = ['100644', 'B'.repeat(1000 * 1000), oid('blob', x)];
    let below = tree([['100644', 'x', oid('blob', x)]]);
    const levels = [below];
    for (let depth = 0; depth < 45; depth++) {
      below = tree([['40000', 'a', oid('tree', below)], padding]);
      levels.push(below);
    }
    const top = tree([['40000', 'a', oid('tree', below)], ['100644', 'manifest.json', oid('blob', manifest)], padding]);
    const two = packOf(top, [...levels.map((level) => entry(TYPES.tree, level)), entry(TYPES.blob, x), entry(TYPES.blob, manifest)]);
    await refused(app, two.bytes, two.tip, /Reading this push needs more memory than this server gives a request\./, tight);
    assert.deepEqual(tight.log.filter((line) => /Fatal/.test(line)), [], 'and PHP did not end a request');
  } finally {
    tight.stop();
  }
});

test('trouble on the server is said in the terminal, without its paths, and not as a bare 500', { skip: skip.skip || (process.platform === 'win32' ? 'a read-only folder does not stop a write on Windows' : false) }, async () => {
  const app = await published('stuck');
  const folder = path.join(s.dataDir, 'apps', app.app.slug);
  const dir = project();
  fs.chmodSync(folder, 0o555);
  let r;
  try {
    r = push(dir, app.app.slug, app.editKey);
  } finally {
    fs.chmodSync(folder, 0o755);
  }
  assert.notEqual(r.status, 0);
  assert.match(r.out, /remote: The directory could not take this push just now, and nothing was published/, r.out);
  assert.ok(!r.out.includes(s.dataDir), 'no path of the server');
  assert.equal((await versions(app.app.slug)).length, 1);
  // Logged as index.php logs a failure, without a trace: the arguments in one can hold the key. The server's log is
  // read as it arrives, which it could not while git ran.
  let logged;
  for (let i = 0; i < 40 && !logged; i++) {
    logged = s.log.findLast((line) => line.includes('a push failed'));
    if (!logged) await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(logged ?? '', /a push failed: [\w\\]+: .+ at .+:\d+\s*$/);
  assert.match(push(dir, app.app.slug, app.editKey).out, /Published version 2/, 'and it goes through once that is put right');
});

test('a page on another site cannot post a push', skip, async () => {
  const app = await published('cors');
  const { tip, objects } = aProject();
  const r = await s.api('POST', `/api/git/${app.app.slug}.git/git-receive-pack`, {
    raw: Buffer.concat([pkt(`${'0'.repeat(40)} ${tip} refs/heads/main\0report-status\n`), Buffer.from('0000'), pack(objects)]),
    headers: { 'Content-Type': 'application/x-git-receive-pack-request', Origin: 'https://elsewhere.example', Authorization: `Basic ${Buffer.from(`x:${app.editKey}`).toString('base64')}` },
  });
  assert.equal(r.status, 403, r.text);
});
