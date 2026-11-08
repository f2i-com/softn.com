/**
 * ZIPP's release installer as one file, for FormLogic: packages/@softn/core/
 * scripts/fetch-zipp-release.mjs with what it imports (the WebAssembly section
 * reader in scripts/lib/zipp-engine-copy.mjs, fflate for the embed kit) bundled
 * in, so it runs on Node alone, beside the curated ZIPP notices it falls back
 * to for a release that ships none. Laid out as core is (scripts/ beside
 * zipp-notices/), so the paths the script finds from its own place still hold.
 *
 * FormLogic runs it from the archive it installed (zipp-tools/) to install a
 * ZIPP release of its own choosing into its own folders: ZIPP_OUT names the
 * install, ZIPP_CACHE_DIR the downloads, ZIPP_RELEASE and ZIPP_SUMS_SHA256 the
 * release and the digest of its SHA256SUMS. Every check this repository makes
 * of a ZIPP release is the bundled script's own: one verifier, not two.
 */
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { build } from 'vite';
import { root } from './release-packages.mjs';

export const INSTALLER_SOURCE = path.join(root, 'packages/@softn/core/scripts/fetch-zipp-release.mjs');
export const CURATED_NOTICES = path.join(root, 'packages/@softn/core/zipp-notices/THIRD_PARTY_LICENSES.txt');

/** Writes `out`/scripts/fetch-zipp-release.mjs and `out`/zipp-notices/THIRD_PARTY_LICENSES.txt; returns their paths. */
export async function bundleZippInstaller(out) {
  fs.rmSync(out, { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'warn',
    root,
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: INSTALLER_SOURCE,
      outDir: path.join(out, 'scripts'),
      emptyOutDir: true,
      minify: false,
      target: 'node24',
      copyPublicDir: false,
      rolldownOptions: { output: { entryFileNames: 'fetch-zipp-release.mjs', format: 'es', codeSplitting: false } },
    },
  });
  const script = path.join(out, 'scripts/fetch-zipp-release.mjs');
  const leftovers = fs.readdirSync(path.join(out, 'scripts')).filter((name) => name !== 'fetch-zipp-release.mjs');
  if (leftovers.length) throw new Error(`the ZIPP installer did not bundle to one file: ${leftovers.join(', ')}`);
  // Node built-ins only: anything else would have to be installed beside it.
  const imports = [...fs.readFileSync(script, 'utf8').matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const foreign = imports.filter((name) => !name.startsWith('node:') && !builtinModules.includes(name));
  if (foreign.length) throw new Error(`the bundled ZIPP installer imports ${foreign.join(', ')}; it must run on Node alone`);
  const notices = path.join(out, 'zipp-notices/THIRD_PARTY_LICENSES.txt');
  fs.mkdirSync(path.dirname(notices), { recursive: true });
  fs.copyFileSync(CURATED_NOTICES, notices);
  return { script, notices };
}
