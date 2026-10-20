/**
 * Parts of an app's public/ that only its dev server reads. Vite copies all
 * of public/ into a build; this removes the named folders again once the
 * build is written, so a production build does not carry them.
 *
 * SoftN Web's demos/ is one: the runtime reads its catalogue only under the
 * dev server (src/App.tsx), and the site build ships the bundles once, at
 * /demos/, for the landing page's `?open=` links and the directory API. It
 * used to ride along in every web build as well, 21 MB that nothing read.
 */
import fs from 'node:fs';
import path from 'node:path';

export function devOnlyPublicPlugin(folders) {
  let outDir = '';
  return {
    name: 'softn-dev-only-public',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const folder of folders) fs.rmSync(path.join(outDir, folder), { recursive: true, force: true });
    },
  };
}
