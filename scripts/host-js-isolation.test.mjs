/**
 * The host-JavaScript engine ships in one place and nowhere else.
 *
 * `@softn/core/host-js` runs an app author's `.logic` as the host document's
 * own JavaScript. That is a deliberate transfer of trust, made by a host that
 * has verified the author and framed their code in an opaque origin. Every
 * other build — the two editors, the web app, and the ZIPP entry document of
 * the app runtime itself — makes no such transfer and must not contain the
 * adapter at all, so that "this build cannot run host JavaScript" is a fact
 * about the bytes rather than a promise about the code paths.
 *
 * Three things hold that, and all three are checked here:
 *   1. No module outside `src/runtime/host-js/` imports it, so the default
 *      entry's graph cannot reach it.
 *   2. The built package carries it only under `dist/runtime/host-js/` — in
 *      particular not in `dist/core-runtime/`, which every consumer copies into
 *      its own assets.
 *   3. A built editor or web app does not contain its mark at all.
 *
 * (1) and (2) need only `npm run build:packages`. (3) needs the app builds, so
 * each is checked when its `dist/` is there and reported as unchecked when it
 * is not — the archive that actually ships is checked unconditionally, in
 * `package-formlogic-runtime.test.mjs`, which also checks the app runtime's own
 * two documents and the one chunk that carries the engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './release-packages.mjs';

const CORE = path.join(root, 'packages/@softn/core');
const ENGINE_DIR = 'runtime/host-js';
/** The mark the adapter puts in any build that contains it. */
const MARK = fs
  .readFileSync(path.join(CORE, 'src/runtime/host-js/host-js-adapter.ts'), 'utf8')
  .match(/export const HOST_JS_ENGINE_MARK = '([^']+)'/)?.[1];
/** Every file under `dir`, relative to it. */
function walk(dir, rel = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), at, out);
    else if (entry.isFile()) out.push(at);
  }
  return out;
}

/** The files under `dir` whose bytes contain `needle`. */
function carrying(dir, needle) {
  return walk(dir).filter((rel) => fs.readFileSync(path.join(dir, rel)).includes(needle));
}

test('the adapter declares a mark a build can be searched for', () => {
  assert.match(MARK ?? '', /^softn\.host-js\./, 'host-js-adapter.ts still exports HOST_JS_ENGINE_MARK');
});

test('nothing outside the engine’s own directory imports it', () => {
  const src = path.join(CORE, 'src');
  const offenders = walk(src)
    .filter((rel) => /\.tsx?$/.test(rel) && !rel.startsWith(`${ENGINE_DIR}/`))
    .filter((rel) => /from '[^']*host-js/.test(fs.readFileSync(path.join(src, rel), 'utf8')));
  assert.deepEqual(offenders, [], 'the default entry’s graph must not be able to reach the host engine');
  // And it is a real entry of its own, not a file that only happens to exist.
  const pkg = JSON.parse(fs.readFileSync(path.join(CORE, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./host-js'].default, `./dist/${ENGINE_DIR}/index.js`);
  assert.ok(fs.readFileSync(path.join(CORE, 'tsup.config.ts'), 'utf8').includes(`src/${ENGINE_DIR}/index.ts`));
});

test('the built package carries it only under its own entry', (t) => {
  const dist = path.join(CORE, 'dist');
  if (!fs.existsSync(dist)) return t.skip('packages/@softn/core is not built (npm run build:packages)');
  const carriers = carrying(dist, MARK).filter((rel) => !rel.endsWith('.map'));
  assert.deepEqual(
    carriers.sort(),
    [`${ENGINE_DIR}/index.d.ts`, `${ENGINE_DIR}/index.js`],
    'only the host-js entry itself'
  );
  // core-runtime/ is the mirror every consumer copies into assets/core-runtime.
  // The engine is main-thread-only, no worker can reach it, and a copy there
  // would put it in the editors and the ZIPP document by the back door.
  assert.equal(carrying(path.join(dist, 'core-runtime'), MARK).length, 0);
});

for (const [name, dir] of [
  ['the builder', 'apps/softn-builder/dist'],
  ['the studio', 'apps/softn-studio/dist'],
  ['the web app', 'apps/softn-web/dist'],
]) {
  test(`${name} is built without the host engine`, (t) => {
    const dist = path.join(root, dir);
    if (!fs.existsSync(dist)) return t.skip(`${dir} is not built`);
    assert.deepEqual(carrying(dist, MARK), [], `${dir} stays on ZIPP`);
  });
}

// The app runtime's own build is checked in `package-formlogic-runtime.test.mjs`,
// against the bytes of the archive that ships rather than a directory on disk:
// which chunk carries the engine, that `index.html`'s static graph does not,
// and that nothing else in the archive compiles code at runtime. It is checked
// there and not here because the packager rebuilds `apps/formlogic-host/dist`
// while it runs, and `node --test` runs these files side by side.
