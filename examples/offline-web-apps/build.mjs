import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import { zipSync } from 'fflate';
import { build, createServer } from 'vite';
import { starterVendorsPlugin } from '../../scripts/build/starter-vendors.mjs';
import examples from './catalog.json' with { type: 'json' };

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const published = path.join(here, '../../apps/softn-site/public/examples');
const plugins = { react, vue };

const compiler = await createServer({
  root: path.resolve(here, '../..'), configFile: false, plugins: [starterVendorsPlugin()],
  server: { middlewareMode: true, hmr: false, watch: null },
  ssr: { noExternal: ['@softn/bundle-format'] },
});

try {
  const { webArchiveEntries } = await compiler.ssrLoadModule('/packages/@softn/editor-shared/src/prepareWebSource.ts');
  for (const example of examples) await packageExample(example, webArchiveEntries);
} finally {
  await compiler.close();
}

async function packageExample({ id: folder, file, name, description }, webArchiveEntries) {
  const plugin = plugins[folder];
  const root = path.join(here, folder);
  const outDir = path.join(dist, folder);
  if (plugin) {
    await build({
      root, configFile: false, plugins: [plugin()],
      build: { outDir, emptyOutDir: true, license: { fileName: 'THIRD-PARTY-LICENSES.md' } },
    });
  } else {
    const vanillaOutput = path.join(here, 'dist/vanilla');
    await rm(vanillaOutput, { recursive: true, force: true });
    await cp(root, vanillaOutput, { recursive: true });
  }

  // The folders are ordinary production builds. The archives carry original
  // component source alongside the offline-ready modules both editors export.
  const contents = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    contents[file] = /\.(?:html?|css|jsx?|mjs|json|md|txt|vue)$/i.test(file)
      ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))
      : bytes;
  }
  contents['manifest.json'] = Buffer.from(JSON.stringify({
    engine: 2, name, description, version: '1.0.0', main: 'index.html', icon: 'icon.svg',
    files: {
      ui: ['index.html'],
      logic: files.filter(file => /\.(?:js|jsx|vue)$/.test(file)),
      assets: files.filter(file => /\.(?:css|svg)$/.test(file)),
    },
  }, null, 2) + '\n');
  contents['permission.json'] = Buffer.from('{"permissions":{}}\n');
  for (const file of ['LICENSE', 'NOTICE']) {
    const name = file + '.txt';
    const text = (await readFile(path.join(here, '../..', file), 'utf8')).replace(/\r\n/g, '\n');
    contents[name] = Buffer.from(text);
    await writeFile(path.join(outDir, name), text);
  }
  const archive = zipSync(await webArchiveEntries(contents), { level: 9, mtime: new Date(2000, 0, 1) });
  await writeFile(path.join(dist, file + '.softn'), archive);
  if (process.argv.includes('--publish')) await writeFile(path.join(published, file + '.softn'), archive);
  process.stdout.write(file + '.softn (' + archive.byteLength + ' bytes)\n');
}
