#!/usr/bin/env node
/**
 * Generate current native icons from the same vector mark as the web apps.
 *
 * node scripts/generate-native-icons.mjs [appDir]
 * With no argument, uses the current native app, or both apps from repo root.
 * Tauri's local CLI writes the platform formats; no old bitmap is a source.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { markSvg } from './brand-mark.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js');
const ground = '#101317';
const currentIsNative = fs.existsSync(path.join(process.cwd(), 'src-tauri/tauri.conf.json'));
const appDirs = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : currentIsNative ? [process.cwd()] : ['softn-loader', 'softn-builder'].map(name => path.join(repoRoot, 'apps', name));

for (const appDir of appDirs) {
  if (!fs.existsSync(path.join(appDir, 'src-tauri/tauri.conf.json'))) {
    throw new Error(`No native app configuration at ${appDir}`);
  }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-native-icons-'));
try {
  fs.writeFileSync(path.join(temporary, 'icon.svg'), markSvg(ground));
  fs.writeFileSync(path.join(temporary, 'foreground.svg'), markSvg(ground, { foreground: true }));
  fs.writeFileSync(path.join(temporary, 'monochrome.svg'), markSvg(ground, { foreground: true, monochrome: true }));
  const manifest = path.join(temporary, 'icons.json');
  fs.writeFileSync(manifest, JSON.stringify({
    default: 'icon.svg', bg_color: ground,
    android_fg: 'foreground.svg', android_fg_scale: 85,
    android_monochrome: 'monochrome.svg',
  }));
  for (const appDir of appDirs) {
    const output = path.join(appDir, 'src-tauri/icons');
    const result = spawnSync(process.execPath, [cli, 'icon', manifest, '--output', output], { cwd: appDir, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Tauri icon generation failed for ${appDir} (${result.status})`);
    for (const file of ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns', 'Square310x310Logo.png']) {
      const written = fs.readFileSync(path.join(output, file));
      if (written.length === 0) throw new Error(`Native icon is empty: ${file}`);
    }
    console.log(`Current SoftN native icons written to ${path.relative(repoRoot, output)}`);
  }
} finally {
  // This mkdtemp directory has no input path components and only these files.
  // Never delete app output directories.
  for (const name of ['icon.svg', 'foreground.svg', 'monochrome.svg', 'icons.json']) {
    fs.rmSync(path.join(temporary, name), { force: true });
  }
  fs.rmdirSync(temporary);
}
