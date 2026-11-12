/**
 * What must not be published because everything published is public, on the routes that take a bundle from a person:
 * `POST /api/apps`, `POST /api/apps/{slug}/versions` and a remix. A push is held to the same in git-push.test.mjs; the
 * two share `Secrets` in lib/bundle.php, which is also tested here piece by piece.
 *
 * Found by publishing for real: the site's "Download backup" file, saved into a project and sent with it, was
 * published, and `GET /api/apps/{slug}/source` then gave anyone the edit key of every app it named.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, makeBundle, runPhp, skip } from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const { strToU8, unzipSync } = require('fflate');

let s = null;

before(async () => {
  if (skip.skip) return;
  s = await startServer({ config: { limits: { version: [500, 3600], publish: [500, 3600] } }, prefix: 'softn-secrets-' });
});

after(() => s?.stop());

/** What the site's "Download backup" writes: lib/keyStore.ts exportKeys, and lib/keyBackup.ts for one with a passphrase. */
const keyBackup = (keys) => JSON.stringify({ format: 'softn-edit-keys', version: 1, keys }, null, 2);
const sealedBackup = () => JSON.stringify({ format: 'softn-edit-keys', version: 2, encrypted: true, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000 }, cipher: 'AES-GCM', salt: 'c2FsdA==', iv: 'aXY=', ciphertext: 'c2VhbGVk' }, null, 2);

function form(name, extra, fields = {}) {
  const fd = new FormData();
  fd.append('bundle', new Blob([makeBundle(name, { extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])) })]), 'app.softn');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** A visitor's publish, as the Publish page sends it. */
const publish = (name, extra = {}) => s.api('POST', '/api/apps', { body: form(name, extra, { category: 'tools' }) });
const update = (app, extra, headers = { 'X-Edit-Key': app.editKey }) => s.api('POST', `/api/apps/${app.app.slug}/versions`, { body: form('Next', extra), headers });
const versions = async (slug) => (await s.api('GET', `/api/apps/${slug}`)).json.app.versions;

test('a new app with a backup of edit keys in it is refused, by the file’s name and by what it holds under any name', skip, async () => {
  const mine = (await publish('Mine')).json;
  const count = async () => (await s.api('GET', '/api/apps?perPage=48')).json.total;
  const listed = await count();
  const cases = [
    ['softn-edit-keys-2026-11-12.json', keyBackup({ [mine.app.slug]: mine.editKey })],
    ['docs/Softn-Edit-Keys (2).JSON', '{}'],
    ['notes/my-keys.json', keyBackup({ [mine.app.slug]: mine.editKey })],
    ['config.txt', sealedBackup()],
    ['copy.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(keyBackup({ [mine.app.slug]: mine.editKey }), 'utf16le')])],
  ];
  for (const [name, content] of cases) {
    const r = await publish('With a backup', { [name]: content });
    assert.equal(r.status, 400, `${name}: ${r.text}`);
    assert.equal(r.json.error, `The bundle has a backup of edit keys in it, ${name}, and everything published is public: whoever reads it could change or unpublish every app it names. Take it out of the app's files and publish again. If it was ever published, here or anywhere else, replace those keys on the Publish page.`);
    assert.ok(!r.text.includes(mine.editKey), 'the key is not repeated in the answer');
  }
  assert.equal(await count(), listed, 'nothing was published');
  assert.ok(await s.tempEmpty(), 'nothing left on the temp disk');
});

test('a new version that holds the edit key it was sent with is refused, wherever in a file the key is', skip, async () => {
  const app = (await publish('Keyed')).json;
  const slug = app.app.slug;
  const refusal = (name) => `The bundle has a file that holds the edit key sent with it, ${name}, and everything published is public: whoever reads it could change or unpublish the app. Take the key out of the file, or the file out of the app's files. If it was ever published, here or anywhere else, replace the key on the Publish page.`;
  const noise = crypto.randomBytes(300 * 1024);
  const cases = [
    ['notes.txt', `the key is ${app.editKey}\n`],
    ['deploy.sh', `curl -H "X-Edit-Key: ${app.editKey.toUpperCase()}" https://softn.example/\n`],
    ['key.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${app.editKey}\r\n`, 'utf16le')])],
    ['assets/noise.bin', Buffer.concat([noise, Buffer.from(app.editKey), noise])],
  ];
  for (const [name, content] of cases) {
    const r = await update(app, { [name]: content });
    assert.equal(r.status, 400, `${name}: ${r.text}`);
    assert.equal(r.json.error, refusal(name));
    assert.ok(!r.text.includes(app.editKey));
  }
  // However the bundle and the key are sent: a raw body with the key in a header, JSON with both in the body.
  const bundle = makeBundle('Next', { extra: { 'notes.txt': strToU8(`the key is ${app.editKey}\n`) } });
  const rawBody = await s.api('POST', `/api/apps/${slug}/versions`, { raw: bundle, headers: { 'Content-Type': 'application/octet-stream', 'X-Edit-Key': app.editKey } });
  assert.equal(rawBody.status, 400, rawBody.text);
  assert.equal(rawBody.json.error, refusal('notes.txt'));
  const json = await s.api('POST', `/api/apps/${slug}/versions`, { body: { bundleBase64: Buffer.from(bundle).toString('base64'), editKey: app.editKey } });
  assert.equal(json.status, 400, json.text);
  assert.equal(json.json.error, refusal('notes.txt'));
  assert.equal((await versions(slug)).length, 1, 'no version was made');
  assert.ok(await s.tempEmpty(), 'nothing left on the temp disk');

  // The operator's key is as public once published: an upload that holds the admin key it came with.
  const admin = await update(app, { 'notes.txt': `admin ${s.adminKey}\n` }, { 'X-Admin-Key': s.adminKey });
  assert.equal(admin.status, 400, admin.text);
  assert.equal(admin.json.error, 'The bundle has a file that holds the admin key sent with it, notes.txt, and everything published is public. Take the key out of the file. If it was ever published, here or anywhere else, change adminKey in data/config.json.');
  assert.ok(!admin.text.includes(s.adminKey));

  // Forty characters that are no app's key are a file, and so is the key cut short.
  const fine = await update(app, { 'notes.txt': `${crypto.randomBytes(20).toString('hex')}\n${'a'.repeat(40)}\n${app.editKey.slice(1)}\n` });
  assert.equal(fine.status, 201, fine.text);
  assert.equal((await versions(slug)).length, 2);
});

test('a bundle that holds the edit key of any app in the directory is refused, whoever sends it and whichever app it is', skip, async () => {
  const app = (await publish('Holder')).json;
  const other = (await publish('Held')).json;
  const slug = app.app.slug;
  const refusal = (name) => `The bundle has a file that holds an edit key of a published app, ${name}, and everything published is public: whoever reads it could change or unpublish that app. Take the key out of the file, or the file out of the app's files. If it was ever published, here or anywhere else, replace that key on the Publish page.`;
  const ids = (n) => Array.from({ length: n }, () => crypto.randomBytes(20).toString('hex'));
  const cases = [
    ['notes.txt', `my other app: ${other.editKey}\n`],
    ['config/apps.json', JSON.stringify({ [other.app.slug]: other.editKey })],
    ['KEY.TXT', other.editKey.toUpperCase()],
    ['keys.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${other.editKey}\r\n`, 'utf16le')])],
    // The last run that is looked at in a file: 1,999 commit ids before it.
    ['history.txt', `${ids(1999).join('\n')}\n${other.editKey}\n`],
  ];
  for (const [name, content] of cases) {
    const r = await update(app, { [name]: content });
    assert.equal(r.status, 400, `${name}: ${r.text}`);
    assert.equal(r.json.error, refusal(name));
    assert.ok(!r.text.toLowerCase().includes(other.editKey) && !r.text.includes(other.app.slug), 'neither the key nor its app is in the answer');
  }
  assert.equal((await versions(slug)).length, 1, 'no version was made');
  // By the admin, who sends no edit key at all: the app's own key is a key like any other.
  const byAdmin = await update(app, { 'notes.txt': `key ${app.editKey}\n` }, { 'X-Admin-Key': s.adminKey });
  assert.equal(byAdmin.status, 400, byAdmin.text);
  assert.equal(byAdmin.json.error, refusal('notes.txt'));
  // In a new app, and in a remix that brings its own bundle.
  const fresh = await publish('Fresh', { 'notes.txt': `${other.editKey}\n` });
  assert.equal(fresh.status, 400, fresh.text);
  assert.equal(fresh.json.error, refusal('notes.txt'));
  const remix = await s.api('POST', `/api/apps/${slug}/remix`, { body: form('Remixed', { 'notes.txt': `${other.editKey}\n` }) });
  assert.equal(remix.status, 400, remix.text);
  assert.equal(remix.json.error, refusal('notes.txt'));
  assert.ok(await s.tempEmpty(), 'nothing left on the temp disk');
  assert.ok(!s.log.some((line) => line.toLowerCase().includes(other.editKey)), 'and the key is in no log');

  // A lock file's commit ids are the same forty characters, in their thousands, and are no app's key.
  const lock = await update(app, { 'composer.lock': JSON.stringify({ packages: ids(6000).map((reference) => ({ source: { reference } })) }, null, 1), 'checksums.txt': ids(3000).join('\n') });
  assert.equal(lock.status, 201, lock.text);
  // Past the most runs looked at in one file, the rest of that file's are not: said in the README, and held here so
  // that it is changed knowingly. The same key in a second file is looked at there.
  const past = await update(app, { 'history.txt': `${ids(2000).join('\n')}\n${other.editKey}\n` });
  assert.equal(past.status, 201, past.text);
  const second = await update(app, { 'history.txt': `${ids(2000).join('\n')}\n${other.editKey}\n`, 'notes.txt': `${other.editKey}\n` });
  assert.equal(second.status, 400, second.text);
  assert.equal(second.json.error, refusal('notes.txt'));
  // A key that was replaced opens nothing and is no longer looked for; an unpublished app's key still opens it.
  const replaced = await s.api('POST', `/api/apps/${other.app.slug}/key`, { headers: { 'X-Edit-Key': other.editKey } });
  assert.equal((await update(app, { 'notes.txt': `${other.editKey}\n` })).status, 201);
  assert.equal((await update(app, { 'notes.txt': `${replaced.json.editKey}\n` })).status, 400);
  assert.equal((await s.api('DELETE', `/api/apps/${other.app.slug}`, { headers: { 'X-Edit-Key': replaced.json.editKey } })).status, 204);
  assert.equal((await update(app, { 'notes.txt': `${replaced.json.editKey}\n` })).json.error, refusal('notes.txt'));
});

test('a site can decline to say that a string is some app’s key: "refuseAppKeys": false', skip, async () => {
  const quiet = await startServer({ config: { refuseAppKeys: false, limits: { version: [500, 3600], publish: [500, 3600] } }, prefix: 'softn-secrets-quiet-' });
  try {
    const send = (name, extra, route = '/api/apps', headers = {}) => quiet.api('POST', route, { body: form(name, extra, { category: 'tools' }), headers });
    const app = (await send('Holder', {})).json;
    const other = (await send('Held', {})).json;
    const versionsOf = `/api/apps/${app.app.slug}/versions`;
    // Another app's key is then published, as it was before the look; the key a request came with never is.
    assert.equal((await send('Next', { 'notes.txt': `${other.editKey}\n` }, versionsOf, { 'X-Edit-Key': app.editKey })).status, 201);
    const own = await send('Next', { 'notes.txt': `${app.editKey}\n` }, versionsOf, { 'X-Edit-Key': app.editKey });
    assert.equal(own.status, 400, own.text);
    assert.match(own.json.error, /holds the edit key sent with it, notes\.txt/);
  } finally {
    quiet.stop();
  }
});

test('every run of forty hex characters is found, however a file is cut into pieces, and no other', skip, () => {
  const r = runPhp({
    dataDir: s.dataDir,
    script: `
      // What is looked for, said as a pattern: forty hex characters with none before or after, all in one case.
      $reference = static function (string $text): array {
          preg_match_all('/(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/', $text, $m);
          $out = [];
          foreach ($m[0] as $run) if ($run === strtolower($run) || $run === strtoupper($run)) $out[hash('sha256', strtolower($run), true)] = true;
          return $out;
      };
      $found = static function (array $pieces): array {
          $secrets = new Secrets([]);
          $secrets->open('f');
          foreach ($pieces as $piece) $secrets->feed($piece);
          $secrets->close();
          $out = [];
          foreach (str_split($secrets->keyLike()['f'] ?? '', 32) as $digest) if ($digest !== '') $out[$digest] = true;
          return $out;
      };
      mt_srand(20261112);
      $alphabet = ['0', '7', 'a', 'f', 'A', 'F', 'g', ' ', "\\n", '"'];
      $problems = [];
      $checked = 0;
      for ($round = 0; $round < 250 && count($problems) < 5; $round++) {
          // Runs of hex around forty long, in one case or mixed, with a character between that is not hex.
          $text = '';
          for ($i = mt_rand(1, 12); $i > 0; $i--) {
              $length = [38, 39, 40, 40, 40, 41, 42, 80, 3, 0][mt_rand(0, 9)];
              $case = mt_rand(0, 4);
              for ($j = 0; $j < $length; $j++) $text .= $case === 0 ? ['0', '7', 'A', 'F'][mt_rand(0, 3)] : ($case === 1 ? $alphabet[mt_rand(0, 5)] : ['0', '7', 'a', 'f'][mt_rand(0, 3)]);
              if (mt_rand(0, 9) > 0) $text .= $alphabet[mt_rand(6, 9)];
              if (mt_rand(0, 3) === 0) $text .= str_repeat('x', mt_rand(1, 90));
          }
          $want = $reference($text);
          $cuts = [[$text], str_split($text . ' ', 1), str_split($text . ' ', 7), str_split($text . ' ', 40), str_split($text . ' ', 41)];
          for ($k = 0; $k < 6; $k++) {
              $pieces = [];
              for ($at = 0; $at < strlen($text);) { $n = mt_rand(1, 97); $pieces[] = substr($text, $at, $n); $at += $n; }
              $cuts[] = $pieces;
          }
          foreach ($cuts as $pieces) {
              $checked++;
              $got = $found($pieces);
              foreach ($want as $digest => $_) if (!isset($got[$digest])) $problems[] = 'missed a run in ' . json_encode($pieces);
              // More than the pattern finds only where a piece ended in the middle of a longer run.
              $ends = [];
              $at = 0;
              foreach ($pieces as $piece) { $at += strlen($piece); if ($at >= 40) $ends[hash('sha256', strtolower(substr(implode('', $pieces), $at - 40, 40)), true)] = true; }
              foreach ($got as $digest => $_) if (!isset($want[$digest]) && !isset($ends[$digest])) $problems[] = 'took what is no run in ' . json_encode($pieces);
          }
      }
      // The caps: in one file, and in all of a bundle's files.
      $run = static fn(): string => bin2hex(random_bytes(20)) . "\\n";
      $secrets = new Secrets([]);
      $secrets->open('big');
      $secrets->feed(implode('', array_map($run, range(1, 2500))));
      $secrets->close();
      $inOne = intdiv(strlen($secrets->keyLike()['big']), 32);
      for ($file = 0; $file < 30; $file++) { $secrets->open("f$file"); for ($i = 0; $i < 10; $i++) $secrets->feed(implode('', array_map($run, range(1, 100)))); $secrets->close(); }
      $inAll = array_sum(array_map(static fn(string $d): int => intdiv(strlen($d), 32), $secrets->keyLike()));
      echo json_encode(['checked' => $checked, 'problems' => $problems, 'inOne' => $inOne, 'inAll' => $inAll, 'caps' => [Secrets::MAX_KEY_LIKE_IN_FILE, Secrets::MAX_KEY_LIKE]]);
    `,
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.problems, []);
  assert.ok(got.checked >= 2500, `cuts tried: ${got.checked}`);
  assert.deepEqual(got.caps, [2000, 20000]);
  assert.equal(got.inOne, 2000, 'the most runs looked at in one file');
  assert.equal(got.inAll, 20000, 'the most in all the files of a bundle');
});

test('a file that is credentials by its name, or a private key by how it begins, is refused; ordinary files are not', skip, async () => {
  const app = (await publish('Named')).json;
  for (const name of ['.env', 'config/.env.production', 'server.pem', 'server.key', 'id_ed25519', 'deploy/.htpasswd', 'me.ppk', '.npmrc', '.aws/credentials']) {
    const r = await update(app, { [name]: 'TOKEN=sk-live-must-not-be-public\n' });
    assert.equal(r.status, 400, `${name}: ${r.text}`);
    assert.equal(r.json.error, `The bundle has a file that looks like it holds secrets, ${name}, and everything published is public. Take it out of the app's files and publish again.`);
  }
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n';
  const byContent = await update(app, { deploy: pem });
  assert.equal(byContent.status, 400, byContent.text);
  assert.match(byContent.json.error, /^The bundle has a file that looks like it holds secrets, deploy,/);
  // A new app and a remix are held to the same.
  assert.equal((await publish('New with a key', { 'server.key': pem })).status, 400);
  const remix = await s.api('POST', `/api/apps/${app.app.slug}/remix`, { body: form('Remixed', { '.env': 'TOKEN=x\n' }) });
  assert.equal(remix.status, 400, remix.text);
  assert.match(remix.json.error, /looks like it holds secrets, \.env,/);
  assert.equal((await versions(app.app.slug)).length, 1);

  const ordinary = {
    '.env.example': 'TOKEN=\n', 'id_rsa.pub': 'ssh-rsa AAAA me@example\n', 'keys.json': '{"up":"ArrowUp"}\n', 'logic/hotkey.js': 'export const key = 1\n',
    'docs/pem.md': 'A key file begins with\n-----BEGIN PRIVATE KEY-----\nand this is only a page about that.\n', 'logic/reader.js': 'const HEAD = "-----BEGIN RSA PRIVATE KEY-----";\n',
    'data/format.json': '{"format":"softn-edit-keys-are-not-this"}\n', 'assets/keyboard.keys': 'qwerty\n', '.gitignore': 'node_modules\n',
  };
  const fine = await update(app, ordinary);
  assert.equal(fine.status, 201, fine.text);
  const kept = unzipSync(new Uint8Array(await (await fetch(`${s.base}/api/apps/${app.app.slug}/bundle.softn`)).arrayBuffer()));
  for (const name of Object.keys(ordinary)) assert.ok(name in kept, name);
});

test('a bundle already in the directory is not looked at again: an app is not taken off the list for a file it has always had', skip, async () => {
  const app = (await publish('Old')).json;
  const folder = path.join(s.dataDir, 'apps', app.app.slug);
  // As a bundle published before these checks, or one the operator put in the folder: discovery reads it as ever.
  fs.writeFileSync(path.join(folder, 'v2.softn'), makeBundle('Old', { extra: { '.env': strToU8('TOKEN=x\n'), 'softn-edit-keys-2026-01-01.json': strToU8(keyBackup({})) } }));
  const listed = await versions(app.app.slug);
  assert.deepEqual(listed.map((v) => v.version), [2, 1]);
  assert.equal((await s.api('GET', `/api/apps/${app.app.slug}/bundle.softn`)).status, 200);
  // And a remix that copies it is a copy of what is public already.
  const copy = await s.api('POST', `/api/apps/${app.app.slug}/remix`, { body: { name: 'A copy' } });
  assert.equal(copy.status, 201, copy.text);
});

test('a key is found wherever a file is cut into pieces, and in either case or as UTF-16', skip, () => {
  const key = crypto.randomBytes(20).toString('hex');
  const r = runPhp({
    dataDir: s.dataDir,
    args: [key],
    script: `
      $key = $argv[2];
      $missed = [];
      $found = static function (array $pieces, array $presented) use ($key): ?string {
          $secrets = new Secrets($presented);
          $secrets->open('file.txt');
          try {
              foreach ($pieces as $piece) $secrets->feed($piece);
              $secrets->close();
          } catch (SecretFound $e) {
              return $e->kind;
          }
          return null;
      };
      $forms = ['plain' => $key, 'upper' => strtoupper($key), 'utf16le' => mb_convert_encoding($key, 'UTF-16LE', 'UTF-8'), 'utf16be' => mb_convert_encoding($key, 'UTF-16BE', 'UTF-8')];
      foreach ($forms as $form => $written) {
          $text = str_repeat('.', 37) . $written . str_repeat('.', 41);
          // Cut once at every place, cut into single bytes, and whole.
          for ($at = 0; $at <= strlen($text); $at++) if ($found([substr($text, 0, $at), substr($text, $at)], ['edit' => $key]) !== 'key') $missed[] = "$form cut at $at";
          if ($found(str_split($text), ['edit' => $key]) !== 'key') $missed[] = "$form byte by byte";
          if ($found([$text], ['edit' => $key]) !== 'key') $missed[] = "$form whole";
          if ($found([$text], ['admin' => $key]) !== 'admin-key') $missed[] = "$form as the admin key";
      }
      // What is not the key: one character short, another key, no key sent, a key too short to look for.
      $none = [
          'short' => $found([substr($key, 1)], ['edit' => $key]),
          'other' => $found([bin2hex(random_bytes(20))], ['edit' => $key]),
          'no key sent' => $found([$key], ['edit' => null, 'admin' => '']),
          'a short admin key' => $found(['the admin of this page'], ['admin' => 'admin']),
          'pieces of two files' => (static function () use ($key) { $s = new Secrets(['edit' => $key]); $s->open('a'); $s->feed(substr($key, 0, 20)); $s->close(); $s->open('b'); try { $s->feed(substr($key, 20)); $s->close(); } catch (SecretFound $e) { return $e->kind; } return null; })(),
      ];
      // What a file is by its name, and by how it begins.
      $names = [];
      foreach (['softn-edit-keys-2026-11-12.json', 'a/b/SOFTN-EDIT-KEYS.JSON', '.env', '.env.local', '.envrc', '.env-prod', 'id_rsa', 'x/id_ed25519_sk', 'a.pem', 'A.KEY', 'b.ppk', 'c.p12', 'd.pfx', 'e.jks', 'f.keystore', 'g.kdbx', '.npmrc', '.netrc', '_netrc', '.pgpass', '.pypirc', '.htpasswd', '.git-credentials', '.aws/credentials', 'x/.aws/credentials',
          '.env.example', 'x/.env.production.sample', '.env-template', 'id_rsa.pub', 'keys.json', 'softn-edit-keys.txt', 'my-softn-edit-keys.json', 'environment.ts', '.envoy.yaml', 'hotkey.js', 'monkey.txt', 'key', 'pem', 'aws/credentials', 'credentials', 'app.keys', 'manifest.json'] as $name) $names[$name] = Secrets::named($name);
      $begins = [];
      foreach ([
          'backup' => "{\\n  \\"format\\": \\"softn-edit-keys\\",\\n  \\"version\\": 1",
          'compact backup' => '{"version":1,"format":"softn-edit-keys","keys":{}}',
          'pem' => "-----BEGIN PRIVATE KEY-----\\nMIIE",
          'rsa pem' => "\\r\\n  -----BEGIN RSA PRIVATE KEY-----\\n",
          'encrypted pem' => "-----BEGIN ENCRYPTED PRIVATE KEY-----\\n",
          'openssh' => "\\xEF\\xBB\\xBF-----BEGIN OPENSSH PRIVATE KEY-----\\n",
          'pgp' => "-----BEGIN PGP PRIVATE KEY BLOCK-----\\n",
          'putty' => 'PuTTY-User-Key-File-2: ssh-rsa',
          'public key' => "-----BEGIN PUBLIC KEY-----\\n",
          'certificate' => "-----BEGIN CERTIFICATE-----\\n",
          'words further in' => "const HEAD = '-----BEGIN PRIVATE KEY-----';",
          'another format' => '{"format": "softn-app"}',
          'empty' => '',
      ] as $what => $head) $begins[$what] = Secrets::begins($head);
      echo json_encode(['missed' => $missed, 'none' => $none, 'names' => $names, 'begins' => $begins]);
    `,
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.missed, []);
  assert.deepEqual(got.none, { short: null, other: null, 'no key sent': null, 'a short admin key': null, 'pieces of two files': null });
  const secret = ['.env', '.env.local', '.envrc', '.env-prod', 'id_rsa', 'x/id_ed25519_sk', 'a.pem', 'A.KEY', 'b.ppk', 'c.p12', 'd.pfx', 'e.jks', 'f.keystore', 'g.kdbx', '.npmrc', '.netrc', '_netrc', '.pgpass', '.pypirc', '.htpasswd', '.git-credentials', '.aws/credentials', 'x/.aws/credentials'];
  const backup = ['softn-edit-keys-2026-11-12.json', 'a/b/SOFTN-EDIT-KEYS.JSON'];
  for (const [name, kind] of Object.entries(got.names)) assert.equal(kind, backup.includes(name) ? 'backup' : secret.includes(name) ? 'secret' : null, name);
  assert.deepEqual(got.begins, {
    backup: 'backup', 'compact backup': 'backup', pem: 'secret', 'rsa pem': 'secret', 'encrypted pem': 'secret', openssh: 'secret', pgp: 'secret', putty: 'secret',
    'public key': null, certificate: null, 'words further in': null, 'another format': null, empty: null,
  });
});

test('two bundles are the same files or not, whatever zipped them, by their names and their bytes', skip, () => {
  const { zipSync } = require('fflate');
  const dir = fs.mkdtempSync(path.join(s.root, 'same-'));
  try {
    const files = { 'manifest.json': strToU8('{"name":"x"}'), 'ui/main.ui': strToU8('<App />\n'), 'assets/noise.bin': new Uint8Array(crypto.randomBytes(200 * 1024)), 'assets/empty.txt': new Uint8Array(0) };
    const write = (name, entries, options = {}) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, zipSync(entries, options));
      return file.replace(/\\/g, '/');
    };
    const one = write('one.zip', files, { level: 9 });
    const cases = {
      'stored, in another order, with folder entries and other dates': write('two.zip', { 'ui/': new Uint8Array(0), 'assets/': new Uint8Array(0), 'assets/empty.txt': files['assets/empty.txt'], 'ui/main.ui': files['ui/main.ui'], 'assets/noise.bin': files['assets/noise.bin'], 'manifest.json': files['manifest.json'] }, { level: 0, mtime: new Date('2001-02-03T04:05:06') }),
      'a file changed': write('three.zip', { ...files, 'ui/main.ui': strToU8('<App/>\n\n') }),
      'a file more': write('four.zip', { ...files, 'extra.txt': strToU8('x') }),
      'a file fewer': write('five.zip', Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'assets/empty.txt'))),
      'a file renamed': write('six.zip', Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name === 'ui/main.ui' ? 'ui/Main.ui' : name, bytes]))),
      'not a zip': (() => { const file = path.join(dir, 'seven.zip'); fs.writeFileSync(file, 'not a zip'); return file.replace(/\\/g, '/'); })(),
      missing: path.join(dir, 'gone.zip').replace(/\\/g, '/'),
    };
    const r = runPhp({ dataDir: s.dataDir, args: [one, JSON.stringify(cases)], script: `
      $out = [];
      foreach (json_decode($argv[3], true) as $what => $file) $out[$what] = [Bundle::sameFiles($argv[2], $file), Bundle::sameFiles($file, $argv[2])];
      $out['itself'] = [Bundle::sameFiles($argv[2], $argv[2]), true];
      echo json_encode($out);
    ` });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.deepEqual(got, {
      'stored, in another order, with folder entries and other dates': [true, true],
      'a file changed': [false, false], 'a file more': [false, false], 'a file fewer': [false, false], 'a file renamed': [false, false], 'not a zip': [false, false], missing: [false, false],
      itself: [true, true],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two files with the same size and the same CRC-32 are told apart by their bytes', skip, () => {
  const { zipSync } = require('fflate');
  // Four bytes appended to any data can make its CRC-32 anything: here, the CRC of another text of the same length.
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes, start = 0xffffffff) => { let c = start; for (const b of bytes) c = (table[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0; return c; };
  const first = Buffer.from('the first text!!abcd');
  const wanted = (crc(first) ^ 0xffffffff) >>> 0;
  const prefix = Buffer.from('another text....');
  // Work back from the wanted final register to the four bytes that take the prefix's register there.
  let register = (wanted ^ 0xffffffff) >>> 0;
  const picks = [];
  for (let i = 0; i < 4; i++) {
    const index = table.findIndex((value) => (value >>> 24) === (register >>> 24));
    picks.unshift(index);
    register = ((register ^ table[index]) << 8) >>> 0;
  }
  let state = crc(prefix);
  const patch = [];
  for (const index of picks) {
    const byte = (state ^ index) & 0xff;
    patch.push(byte);
    state = (table[index] ^ (state >>> 8)) >>> 0;
  }
  const second = Buffer.concat([prefix, Buffer.from(patch)]);
  assert.equal(second.length, first.length);
  assert.equal((crc(second) ^ 0xffffffff) >>> 0, wanted, 'the test made its collision');
  assert.notDeepEqual(second, first);
  const dir = fs.mkdtempSync(path.join(s.root, 'crc-'));
  try {
    const a = path.join(dir, 'a.zip').replace(/\\/g, '/');
    const b = path.join(dir, 'b.zip').replace(/\\/g, '/');
    fs.writeFileSync(a, zipSync({ 'manifest.json': strToU8('{}'), 'data.bin': new Uint8Array(first) }));
    fs.writeFileSync(b, zipSync({ 'manifest.json': strToU8('{}'), 'data.bin': new Uint8Array(second) }));
    const r = runPhp({ dataDir: s.dataDir, args: [a, b], script: 'echo json_encode([Bundle::sameFiles($argv[2], $argv[3]), Bundle::sameFiles($argv[2], $argv[2])]);' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [false, true]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
