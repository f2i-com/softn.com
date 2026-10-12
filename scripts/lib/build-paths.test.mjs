import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMachinePaths, dropMachineMaps, machinePathIn, pathSpellings } from './build-paths.mjs';
import { buildInfoProblem } from './build-info.mjs';

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'softn-build-paths-')));
  t.after(() => {
    assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const BACKSLASH = String.fromCharCode(92);

test('a source map names a path on the machine by a drive, a root, a share or a file: URL', () => {
  for (const source of ['C:/Users/someone/AppData/Local/Temp/0a1b/sw.js', `C:${BACKSLASH}work${BACKSLASH}sw.js`, '/tmp/0a1b/sw.js', `${BACKSLASH}${BACKSLASH}host${BACKSLASH}share${BACKSLASH}a.js`, 'file:///home/runner/a.ts']) {
    assert.equal(machinePathIn({ version: 3, sources: ['../src/a.ts', source] }), source, source);
  }
  assert.equal(machinePathIn({ version: 3, sourceRoot: '/home/runner/work/', sources: ['a.ts'] }), '/home/runner/work/');
  // Where the build put them, relative, and the bundlers' own names.
  for (const source of ['../../../../node_modules/react/index.js', 'src/app.ts', 'webpack:///./src/a.js', '\u0000commonjsHelpers.js']) {
    assert.equal(machinePathIn({ version: 3, sources: [source] }), null, source);
  }
  assert.equal(machinePathIn(null), null);
  assert.equal(machinePathIn({ version: 3 }), null);
});

test('the checkout is looked for as forward slashes, backslashes and JSON-escaped backslashes', () => {
  const windows = ['E:', 'repos', 'softn.com'].join(BACKSLASH);
  assert.deepEqual(pathSpellings(windows), ['e:/repos/softn.com', windows.toLowerCase(), ['e:', 'repos', 'softn.com'].join(BACKSLASH + BACKSLASH)]);
  assert.deepEqual(pathSpellings('/home/runner/work/softn.com/softn.com')[0], '/home/runner/work/softn.com/softn.com');
});

test('the maps that name the machine are left out, with their twins and the comment that names them', (t) => {
  const dir = scratch(t);
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  write('web/sw.js', 'self.skipWaiting();\n//# sourceMappingURL=sw.js.map\n//# sourceMappingURL=sw.js.map\n');
  write('web/sw.js.map', JSON.stringify({ version: 3, sources: ['C:/Users/someone/AppData/Local/Temp/0a1b/sw.js'], mappings: 'AAAA' }));
  write('web/sw.js.map.gz', 'twin');
  write('web/assets/index.js', 'a();\n//# sourceMappingURL=index.js.map\n');
  write('web/assets/index.js.map', JSON.stringify({ version: 3, sources: ['../../src/index.ts'], mappings: 'AAAA' }));
  write('web/assets/broken.js.map', '{not json');
  assert.deepEqual(dropMachineMaps(dir), ['web/sw.js.map']);
  assert.ok(!fs.existsSync(path.join(dir, 'web/sw.js.map')) && !fs.existsSync(path.join(dir, 'web/sw.js.map.gz')));
  assert.equal(fs.readFileSync(path.join(dir, 'web/sw.js'), 'utf8'), 'self.skipWaiting();\n');
  // The app's own map, and what it maps, are as they were.
  assert.equal(fs.readFileSync(path.join(dir, 'web/assets/index.js'), 'utf8'), 'a();\n//# sourceMappingURL=index.js.map\n');
  assert.ok(fs.existsSync(path.join(dir, 'web/assets/index.js.map')));
  assert.deepEqual(buildMachinePaths(dir, ['web/sw.js', 'web/assets/index.js', 'web/assets/index.js.map'], path.join(dir, 'checkout')), []);
});

// What a Linux build writes: workbox names the worker's temporary file relatively, and the
// sources the map carries import from the checkout by its full path. The packager refused
// the v0.0.20 tag's site for two such maps (studio/sw.js.map, web/sw.js.map).
test('a map that names the checkout is left out too, as the packager would refuse it', (t) => {
  const dir = scratch(t);
  const checkout = '/home/runner/work/softn.com/softn.com';
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  const linuxWorker = {
    version: 3,
    sources: ['../../../../../../tmp/0a1b2c3d/sw.js'],
    sourcesContent: [`import { precacheAndRoute } from '${checkout}/node_modules/workbox-precaching/index.mjs';`],
    mappings: 'AAAA',
  };
  write('studio/sw.js', 'self.skipWaiting();\n//# sourceMappingURL=sw.js.map\n');
  write('studio/sw.js.map', JSON.stringify(linuxWorker));
  write('studio/assets/index.js.map', JSON.stringify({ version: 3, sources: ['../../src/index.ts'], sourcesContent: ['a()'], mappings: 'AAAA' }));
  assert.equal(machinePathIn(linuxWorker), null, 'its sources alone do not give it away');
  assert.deepEqual(buildMachinePaths(dir, ['studio/sw.js.map'], checkout), ['studio/sw.js.map names the checkout this was built in']);
  // Without the checkout it stays, as it did; with it, it goes, and its comment with it.
  assert.deepEqual(dropMachineMaps(dir), []);
  assert.deepEqual(dropMachineMaps(dir, checkout), ['studio/sw.js.map']);
  assert.equal(fs.readFileSync(path.join(dir, 'studio/sw.js'), 'utf8'), 'self.skipWaiting();\n');
  assert.ok(fs.existsSync(path.join(dir, 'studio/assets/index.js.map')), "the app's own map stays");
  assert.deepEqual(buildMachinePaths(dir, ['studio/sw.js', 'studio/assets/index.js.map'], checkout), []);
  // A checkout too short to tell from ordinary text is not looked for here either.
  write('studio/other.js.map', JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: ['// from /src'], mappings: 'AAAA' }));
  assert.deepEqual(dropMachineMaps(dir, '/src'), []);
});

test('a checkout too short to tell from ordinary text is not looked for', (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'guide.md'), 'Copy it to /src and run it.\n');
  assert.deepEqual(buildMachinePaths(dir, ['guide.md'], '/src'), []);
  assert.deepEqual(buildMachinePaths(dir, ['guide.md'], '/srv/build/softn'), []);
  fs.writeFileSync(path.join(dir, 'guide.md'), 'Built in /srv/build/softn/apps.\n');
  assert.deepEqual(buildMachinePaths(dir, ['guide.md'], '/srv/build/softn'), ['guide.md names the checkout this was built in']);
});

test('build-site leaves the machine maps out before the twins are made', () => {
  const source = fs.readFileSync(new URL('../build-site.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const dropped = source.indexOf('dropMachineMaps(outDir, root)');
  assert.ok(dropped > 0, 'build-site calls dropMachineMaps(outDir, root): the checkout is looked for as well');
  assert.ok(dropped < source.lastIndexOf('precompressAssets();'), 'and before precompressAssets()');
});

test('a build is packaged only from the commit it was built from', () => {
  const head = 'a'.repeat(40);
  assert.equal(buildInfoProblem({ softn: { revision: head, dirty: false } }, head), null);
  assert.match(buildInfoProblem({ softn: { revision: 'b'.repeat(40), dirty: false } }, head), /^dist\/ was built from bbbbbbbbbb, not from HEAD \(aaaaaaaaaa\)/);
  assert.match(buildInfoProblem({ softn: { revision: head, dirty: true } }, head), /dirty/);
  assert.equal(buildInfoProblem({ softn: { revision: head, dirty: true } }, head, { allowDirty: true }), null);
  for (const info of [{}, null, { softn: { revision: 'HEAD' } }]) assert.match(buildInfoProblem(info, head), /names no SoftN revision/);
});
