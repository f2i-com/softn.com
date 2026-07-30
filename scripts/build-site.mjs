#!/usr/bin/env node
/**
 * Build everything softn.com serves, into one `dist/` you can upload anywhere.
 *
 *   dist/            the landing page
 *   dist/demos/      the .softn bundles, at the root so `?open=/demos/x.softn`
 *                    resolves the same way from the site and from the runtime
 *   dist/web/        the web runtime
 *   dist/builder/    the visual builder
 *   dist/studio/     the AI studio
 *
 * The three apps are built with a `VITE_BASE` matching where they land, which
 * is what makes their assets, their service worker scope and their own internal
 * routes agree with the directory they are served from.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');

const APPS = [
  { workspace: '@softn/web', dir: 'apps/softn-web', base: '/web/', into: 'web' },
  { workspace: '@softn/builder', dir: 'apps/softn-builder', base: '/builder/', into: 'builder' },
  { workspace: '@softn/studio', dir: 'apps/softn-studio', base: '/studio/', into: 'studio' },
];

function run(args, env) {
  console.log(`\n> npm ${args.join(' ')}`);
  execFileSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

function requireDir(dir, what) {
  if (!fs.existsSync(dir)) throw new Error(`${what} did not produce ${path.relative(root, dir)}`);
}

// The apps import @softn/core and @softn/components from dist/, so those have
// to exist before any app build starts.
run(['run', 'build:core']);
run(['run', 'build:components']);

for (const app of APPS) {
  run(['run', 'build', '-w', app.workspace], { VITE_BASE: app.base });
}

// The site links to the apps by path, not by localhost port.
run(['run', 'build', '-w', '@softn/site'], {
  VITE_WEB_URL: '/web',
  VITE_BUILDER_URL: '/builder',
  VITE_STUDIO_URL: '/studio',
});

fs.rmSync(outDir, { recursive: true, force: true });

const siteDist = path.join(root, 'apps/softn-site/dist');
requireDir(siteDist, 'The site build');
copyDir(siteDist, outDir);

for (const app of APPS) {
  const appDist = path.join(root, app.dir, 'dist');
  requireDir(appDist, `The ${app.workspace} build`);
  copyDir(appDist, path.join(outDir, app.into));
}

// A second copy of the bundles at the root. The runtime serves its own set from
// /web/demos/ for its launcher, but every `?open=` link on the landing page is
// root-relative so that one path works from both places.
const demos = path.join(root, 'apps/softn-web/public/demos');
requireDir(demos, 'The runtime');
copyDir(demos, path.join(outDir, 'demos'));

// Apache-2.0 section 4(a) says a distributed copy must carry the licence, and
// dist/ IS the distributed copy — uploading it is the act of distributing. The
// site additionally redistributes the font binaries it bundles, which are under
// the SIL Open Font License, so their text has to travel too.
function copyLicences() {
  for (const name of ['LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(root, name), path.join(outDir, name));
  }

  // Read the font list off the site's own dependencies rather than repeating it,
  // so adding or dropping a family cannot leave this file lying.
  const sitePkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/softn-site/package.json'), 'utf8'));
  const fonts = Object.keys(sitePkg.dependencies || {}).filter((d) => d.startsWith('@fontsource')).sort();

  const sections = [];
  for (const font of fonts) {
    const licence = path.join(root, 'node_modules', font, 'LICENSE');
    if (!fs.existsSync(licence)) throw new Error(`${font} ships no LICENSE; cannot state its terms`);
    sections.push(`${'='.repeat(72)}\n${font}\n${'='.repeat(72)}\n\n${fs.readFileSync(licence, 'utf8').trim()}\n`);
  }

  fs.writeFileSync(
    path.join(outDir, 'THIRD-PARTY-NOTICES.txt'),
    `This site bundles the font families below. Their licences follow in full.\n` +
      `Everything else here is part of SoftN and is covered by ./LICENSE.\n\n` +
      sections.join('\n'),
  );

  return fonts.length;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

const fontCount = copyLicences();

console.log(`\nBuilt ${countFiles(outDir)} files into dist/`);
console.log('  dist/           landing page');
console.log('  dist/demos/     .softn bundles');
console.log(`  dist/LICENSE, NOTICE, THIRD-PARTY-NOTICES.txt (${fontCount} font licences)`);
for (const app of APPS) console.log(`  dist/${app.into}/`.padEnd(18) + app.workspace);
