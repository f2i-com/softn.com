// node --test apps/formlogic-host/test/web-archive.test.mjs
//
// The archive the web frame gives the container (web.ts, buildContainerSource): every file FormLogic
// sends under its own path, the apps the page nests among them. FormLogic keeps a hosted app's
// .softn files with its media, under assets/, and sends them as bytes: `<softn-app
// src="assets/widgets/clock.softn">` finds one by exactly that name. Frames of other sites stay off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContainerSource, FRAME_EMBEDS } from '../src/containerBridge.ts';

const page = new Map([
  ['manifest.json', JSON.stringify({ name: 'Board', main: 'index.html', container: true })],
  ['permission.json', '{"permissions":{}}'],
  ['index.html', '<softn-app src="assets/widgets/clock.softn" style="display:block;height:240px"></softn-app>'],
]);
/** A nested app's archive: a ZIP's first bytes, then every byte value once. */
const clock = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 256 }, (_, i) => i)]);

/** Files as FormLogic hands a frame its media pack's: views into the one buffer it fetched (readMediaPackBytes). */
function packed(files) {
  const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
  const buffer = new Uint8Array(12 + total);
  let at = 12;
  const views = {};
  for (const [path, bytes] of Object.entries(files)) {
    buffer.set(bytes, at);
    views[path] = buffer.subarray(at, at + bytes.length);
    at += bytes.length;
  }
  return views;
}

test('puts each app the page nests in the archive under its own path, byte for byte, as bytes or base64', () => {
  const assets = packed({ 'assets/logo.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), 'assets/widgets/clock.softn': clock });
  for (const allowLocalBackend of [true, false]) {
    const source = buildContainerSource(page, assets, { allowLocalBackend, manifest: JSON.parse(page.get('manifest.json')) });
    assert.deepEqual(Object.keys(source).sort(), ['assets/logo.png', 'assets/widgets/clock.softn', 'index.html', 'manifest.json', 'permission.json']);
    assert.deepEqual([...source['assets/widgets/clock.softn']], [...clock], `allowLocalBackend: ${allowLocalBackend}`);
  }
  // From a FormLogic before the frame took bytes: base64 text. And an ArrayBuffer of its own.
  const base64 = buildContainerSource(page, { 'assets/widgets/clock.softn': Buffer.from(clock).toString('base64') }, { allowLocalBackend: true });
  assert.deepEqual([...base64['assets/widgets/clock.softn']], [...clock]);
  const buffer = buildContainerSource(page, { 'assets/widgets/clock.softn': clock.slice().buffer }, { allowLocalBackend: true });
  assert.deepEqual([...buffer['assets/widgets/clock.softn']], [...clock]);
});

test('takes base64 as media.ts takes it: a data: address or other text is no file', () => {
  const source = buildContainerSource(page, {
    'assets/widgets/data.softn': `data:application/zip;base64,${Buffer.from(clock).toString('base64')}`,
    'assets/widgets/text.softn': 'not base64!',
    'assets/widgets/number.softn': 42,
  }, { allowLocalBackend: true });
  assert.equal(source['assets/widgets/data.softn'], undefined);
  assert.equal(source['assets/widgets/text.softn'], undefined);
  assert.equal(source['assets/widgets/number.softn'], undefined);
});

test('keeps the private tree out of the archive whatever its files are called', () => {
  const assets = { 'private/clock.softn': clock, '../clock.softn': clock, 'assets\\clock.softn': clock };
  for (const allowLocalBackend of [true, false]) {
    const source = buildContainerSource(page, assets, { allowLocalBackend });
    assert.deepEqual(Object.keys(source).filter(path => path.endsWith('.softn')), [], `allowLocalBackend: ${allowLocalBackend}`);
  }
  // A backend FormLogic runs on its server keeps its own folder from the page, nested apps and all.
  const manifest = { name: 'Board', main: 'index.html', backend: { runtime: 'php', root: 'api', entry: 'api/index.php' } };
  const hosted = buildContainerSource(page, { 'api/clock.softn': clock, 'assets/widgets/clock.softn': clock }, { allowLocalBackend: false, manifest });
  assert.deepEqual(Object.keys(hosted).filter(path => path.endsWith('.softn')), ['assets/widgets/clock.softn']);
});

test('nests the app\'s own apps and shows no frame of another site, and web.ts gives the container exactly that', () => {
  assert.deepEqual({ ...FRAME_EMBEDS }, { frames: 'deny', nestedApps: 'allow' });
  assert.ok(Object.isFrozen(FRAME_EMBEDS));
  const web = readFileSync(new URL('../src/web.ts', import.meta.url), 'utf8');
  assert.match(web, /\.\.\.FRAME_EMBEDS,/);
  assert.doesNotMatch(web, /frames: 'allow'|nestedApps: 'deny'/);
  // The archive is the one these tests read, not a copy of its rules.
  assert.match(web, /const source = buildContainerSource\(clientEntries, data\.assets, \{/);
});
