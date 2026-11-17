/**
 * Builds the framework apps of this folder as a person would: `vite build`, with the
 * framework's own plugin and Vite's defaults, into a dist/ folder that is then run as it is.
 *
 *   node build.mjs <out folder> [react] [vue]      writes <out folder>/<name>/
 *
 * Each app (react/, vue/) is laid out as `npm create vite` lays a project out: index.html at
 * the root naming /src/main, a stylesheet and an image imported from the script, files in
 * public/. What Vite makes of that is what the tests are about: a page that names its script
 * and stylesheet from the root (`/assets/index-<hash>.js`), a lazy chunk fetched through
 * Vite's preload helper, a small image written into the script as a `data:` address.
 *
 * The build runs in a process of its own (`buildFrameworkApps`), for two reasons: a test file
 * under jsdom is no place to run a bundler, and the build must be a production one whatever
 * NODE_ENV the test runner set (under `test`, React's development build would be bundled).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The apps here, by folder. */
export const FRAMEWORKS = ['react', 'vue'];

/**
 * Build `names` into `<outRoot>/<name>/`, in a process of its own. Throws with the build's
 * output when it fails.
 */
export function buildFrameworkApps(outRoot, names = FRAMEWORKS) {
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), outRoot, ...names], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'pipe',
    });
  } catch (error) {
    const said = [error.stdout, error.stderr].map((part) => (part ? String(part) : '')).join('\n').trim();
    throw new Error(`The framework apps did not build.\n${said || error.message}`);
  }
}

/** Every file under `dir`, by its path from there with forward slashes. */
export function readFolder(dir, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, readFolder(path.join(dir, entry.name), name));
    else files[name] = new Uint8Array(fs.readFileSync(path.join(dir, entry.name)));
  }
  return files;
}

async function main(outRoot, names) {
  process.env.NODE_ENV = 'production';
  const { build } = await import('vite');
  for (const name of names.length > 0 ? names : FRAMEWORKS) {
    if (!FRAMEWORKS.includes(name)) throw new Error(`No framework app is called "${name}".`);
    const plugin = name === 'react' ? (await import('@vitejs/plugin-react')).default : (await import('@vitejs/plugin-vue')).default;
    await build({
      root: path.join(HERE, name),
      configFile: false,
      logLevel: 'error',
      clearScreen: false,
      plugins: [plugin()],
      build: { outDir: path.resolve(outRoot, name), emptyOutDir: true },
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [outRoot, ...names] = process.argv.slice(2);
  if (!outRoot) {
    console.error('usage: node build.mjs <out folder> [react] [vue]');
    process.exit(2);
  }
  main(outRoot, names).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
