#!/usr/bin/env node
/**
 * Sync local SoftN example bundles from `E:\repos\softn_projects3\softn-Examples`
 * (built from `bundles/` into `dist/*.softn` + `screenshots/*.webp`) into
 * `apps/softn-web/public/demos/`.
 *
 * Usage:
 *   node scripts/demos/sync-local-demos.mjs [--from <dir>] [--build] [--check]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { repoRoot as root } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const shouldBuild = args.includes('--build');
const fromIdx = args.indexOf('--from');
const sourceDir = path.resolve(
  (fromIdx >= 0 && args[fromIdx + 1]) ||
    process.env.SOFTN_EXAMPLES_DIR ||
    path.resolve(root, '../softn_projects3/softn-Examples')
);

const demosDir = path.join(root, 'apps/softn-web/public/demos');
const thumbsDir = path.join(demosDir, 'thumbs');
const iconsDir = path.join(demosDir, 'icons');
const indexPath = path.join(demosDir, 'index.json');

const CATEGORY_MAP = {
  'ai-chat': 'ai',
  'device-kit': 'demos',
  'gpu-demo': 'demos',
  showcase: 'demos',
  'three-demo': 'demos',
  notes: 'tools',
  'warble-wire': 'tools',
  'soft-dos': 'tools',
  'glamour-studio': 'creative',
  'house-builder': 'creative',
  'photo-studio': 'creative',
  'first-drive': 'simulations',
  'train-yard': 'simulations',
  'predator-prey': 'simulations',
  racelab: 'simulations',
  'sim-lives': 'simulations',
  'solar-simulator': 'simulations',
  'voice-simulator': 'simulations',
  'convenience-store-at-the-end-of-the-universe': 'story',
  'please-do-not-feed-the-moon': 'story',
  'the-night-window': 'story',
  lastsound3d: 'story',
  'promptly-unemployed': 'story',
  scorchline: 'strategy',
  urbanward: 'strategy',
  outermate: 'strategy',
  outerstead: 'strategy',
  'do-not-press-the-duck': 'games',
  'very-normal-post-office': 'games',
  'express-delivery-snail': 'games',
  'frog-employee-of-the-month': 'games',
  'pigeon-municipal-employee': 'games',
  'texas-holdem': 'games',
  'the-office': 'games',
  pocket: 'games',
  blockscape: 'games',
  'maze-escape-3d': 'games',
  'dead-hours': 'games',
  'potato-peeler': 'games',
  'mine-management': 'games',
};

const TAGS_MAP = {
  'ai-chat': 'llm,chat,local-ai',
  'device-kit': 'camera,qr,network',
  'gpu-demo': 'webgpu,compute',
  showcase: 'components,ui,3d',
  'three-demo': '3d,webgl,pbr',
  notes: 'notes,markdown,local-first',
  'warble-wire': 'audio,modem,dsp',
  'soft-dos': 'emulator,dos,x86,doom',
  'glamour-studio': 'salon,portrait,lighting',
  'house-builder': '3d,floor-plan,architecture',
  'photo-studio': 'image-editor,layers,psd',
  'first-drive': '3d,lunar,cinema',
  'train-yard': '3d,railway,diorama',
  'predator-prey': '3d,ecosystem,biology',
  racelab: '3d,racing,monte-carlo',
  'sim-lives': '3d,life-sim,sandbox',
  'solar-simulator': '3d,space,astrophysics',
  'voice-simulator': '3d,speech,synth',
  'convenience-store-at-the-end-of-the-universe': 'story,narrative,sci-fi',
  'please-do-not-feed-the-moon': 'story,narrative,surreal',
  'the-night-window': 'story,mystery,terminal',
  lastsound3d: '3d,horror,submarine,voiced',
  'promptly-unemployed': '3d,story,comedy,voiced',
  scorchline: 'rts,strategy,skirmish',
  urbanward: '3d,city-builder,strategy',
  outermate: 'strategy,stealth,prison',
  outerstead: 'strategy,colony,survival',
  'do-not-press-the-duck': 'comedy,interactive,arcade',
  'very-normal-post-office': 'inspection,arcade,comedy',
  'express-delivery-snail': 'delivery,puzzle,arcade',
  'frog-employee-of-the-month': 'platformer,physics,comedy',
  'pigeon-municipal-employee': 'exploration,sandbox,comedy',
  'texas-holdem': 'cards,poker,multiplayer',
  'the-office': 'simulation,ai,comedy',
  pocket: 'emulator,handheld,retro',
  blockscape: '3d,voxel,sandbox',
  'maze-escape-3d': '3d,maze,first-person',
  'dead-hours': '3d,shooter,zombies',
  'potato-peeler': '3d,arcade,kitchen',
  'mine-management': '3d,vehicles,automation',
};

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function findBundleSourceDir(bundlesRoot, baseName) {
  if (!fs.existsSync(bundlesRoot)) return null;
  for (const group of fs.readdirSync(bundlesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const candidate = path.join(bundlesRoot, group.name, baseName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

function main() {
  const distDir = path.join(sourceDir, 'dist');
  const bundlesRoot = path.join(sourceDir, 'bundles');
  const shotsDir = path.join(sourceDir, 'screenshots');

  if (shouldBuild) {
    console.log(`Building SoftN examples in ${sourceDir}...`);
    execFileSync(process.execPath, [path.join(sourceDir, 'scripts/build/build-release.cjs')], {
      cwd: sourceDir,
      stdio: 'inherit',
    });
  }

  const distCataloguePath = path.join(distDir, 'catalogue.json');
  const rootCataloguePath = path.join(sourceDir, 'catalogue.json');
  let rawItems;
  if (fs.existsSync(distCataloguePath)) {
    const doc = JSON.parse(fs.readFileSync(distCataloguePath, 'utf8'));
    rawItems = Array.isArray(doc) ? doc : doc.bundles || [];
  } else if (fs.existsSync(rootCataloguePath)) {
    rawItems = JSON.parse(fs.readFileSync(rootCataloguePath, 'utf8'));
  } else {
    throw new Error(`No catalogue.json found in ${sourceDir}`);
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error(`Catalogue in ${sourceDir} lists no bundles`);
  }

  const entries = [];
  const plannedBundles = new Map();
  const plannedThumbs = new Map();
  const plannedIcons = new Map();

  for (const item of rawItems) {
    const fileName = path.basename(String(item.file || ''));
    if (!fileName.endsWith('.softn')) continue;
    const baseName = fileName.replace(/\.softn$/i, '');
    const srcBundle = path.join(distDir, fileName);
    if (!fs.existsSync(srcBundle)) {
      throw new Error(`Missing built bundle ${srcBundle} — run with --build first`);
    }
    const bytes = fs.readFileSync(srcBundle);
    plannedBundles.set(fileName, bytes);

    // Copy screenshot matching <baseName>.(webp|png|jpg)
    for (const ext of ['.webp', '.png', '.jpg']) {
      const shot = path.join(shotsDir, `${baseName}${ext}`);
      if (fs.existsSync(shot)) {
        plannedThumbs.set(`${baseName}${ext}`, fs.readFileSync(shot));
        break;
      }
    }

    // Copy icon.svg from bundles/<group>/<baseName>/assets/icon.svg (or icon.svg)
    const srcDir = findBundleSourceDir(bundlesRoot, baseName);
    if (srcDir) {
      for (const rel of ['assets/icon.svg', 'icon.svg']) {
        const iconPath = path.join(srcDir, rel);
        if (fs.existsSync(iconPath)) {
          plannedIcons.set(`${baseName}.svg`, fs.readFileSync(iconPath));
          break;
        }
      }
    }

    const id = String(item.id || baseName.toLowerCase());
    entries.push({
      id,
      file: fileName,
      name: String(item.name || baseName),
      description: String(item.description || ''),
      category: CATEGORY_MAP[id] || 'demos',
      tags: TAGS_MAP[id] || '',
      primary: typeof item.primary === 'string' ? item.primary : '#6366f1',
      size: bytes.length,
      source: 'local',
      sha256: sha256(bytes),
    });
  }

  const indexJson = `${JSON.stringify(entries, null, 2)}\n`;

  if (checkOnly) {
    const problems = [];
    if (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, 'utf8') !== indexJson) {
      problems.push('apps/softn-web/public/demos/index.json is out of sync');
    }
    for (const [fileName, bytes] of plannedBundles) {
      const dst = path.join(demosDir, fileName);
      if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(bytes)) {
        problems.push(`bundle ${fileName} is missing or out of sync`);
      }
    }
    if (problems.length) {
      for (const p of problems) console.error(`ERROR: ${p}`);
      process.exit(1);
    }
    console.log(`Verified ${entries.length} local SoftN example bundles in ${path.relative(root, demosDir)}`);
    return;
  }

  fs.mkdirSync(demosDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const name of fs.readdirSync(demosDir)) {
    if ((name.endsWith('.softn') || name.endsWith('.softn.download')) && !plannedBundles.has(name)) {
      fs.rmSync(path.join(demosDir, name), { force: true });
    }
  }
  for (const name of fs.readdirSync(thumbsDir)) {
    if (!plannedThumbs.has(name)) fs.rmSync(path.join(thumbsDir, name), { force: true });
  }
  for (const name of fs.readdirSync(iconsDir)) {
    if (!plannedIcons.has(name)) fs.rmSync(path.join(iconsDir, name), { force: true });
  }

  let written = 0;
  for (const [fileName, bytes] of plannedBundles) {
    const dst = path.join(demosDir, fileName);
    if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(bytes)) {
      fs.writeFileSync(dst, bytes);
      written++;
    }
  }
  for (const [fileName, bytes] of plannedThumbs) {
    const dst = path.join(thumbsDir, fileName);
    if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(bytes)) {
      fs.writeFileSync(dst, bytes);
    }
  }
  for (const [fileName, bytes] of plannedIcons) {
    const dst = path.join(iconsDir, fileName);
    if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(bytes)) {
      fs.writeFileSync(dst, bytes);
    }
  }

  fs.writeFileSync(indexPath, indexJson, 'utf8');
  console.log(
    `Synced ${entries.length} SoftN example bundles (${written} written, ${plannedThumbs.size} thumbs, ${plannedIcons.size} icons) into ${path.relative(root, demosDir)}`
  );
}

main();
