#!/usr/bin/env node
/**
 * Manage apps in `apps/softn-api/data/apps/` (the folder-based SoftN directory catalogue).
 *
 * Supports both hierarchical category/subcategory folder trees
 * (`data/apps/<category>/[<subcategory>/]<slug>/` with `category.json` in every folder)
 * and legacy flat folders (`data/apps/<slug>/`).
 *
 * Examples:
 *   node scripts/demos/manage-data.mjs list
 *   node scripts/demos/manage-data.mjs list --category games --subcategory 3d
 *   node scripts/demos/manage-data.mjs organize
 *   node scripts/demos/manage-data.mjs sync --thumbs
 *   node scripts/demos/manage-data.mjs watch
 *   node scripts/demos/manage-data.mjs set brewdesk-cafe-ops --hosting hybrid --subcategory hospitality
 *   node scripts/demos/manage-data.mjs add ./MyApp.softn --slug my-app --category games --subcategory arcade
 *   node scripts/demos/manage-data.mjs remove old-slug
 *   node scripts/demos/manage-data.mjs import-business-demos --hosting browser
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const DEFAULT_DATA_DIR = path.join(repoRoot, 'apps/softn-api/data');
const DEFAULT_BUSINESS_DIR = path.join(repoRoot, 'apps/softn-web/public/business-demos');
const EXCLUDED_BUSINESS_SLUGS = new Set(['vcdi', 'servalet']);
const INTERNAL_DIRS = new Set(['backend-cache', 'backend-data']);
const VALID_HOSTING = new Set(['browser', 'server', 'hybrid']);

const CATEGORY_META = {
  business: { name: 'Business Apps', description: 'Full-stack business operations apps with sandboxed backends and SQLite', emoji: '🏢', sort: 5 },
  games: { name: 'Games', description: 'Things to play across 3D, arcade, strategy, story and retro', emoji: '🎮', sort: 10 },
  simulations: { name: 'Simulations', description: 'Interactive worlds, ecosystems and models', emoji: '🌐', sort: 15 },
  tools: { name: 'Tools', description: 'Utilities that do one job well', emoji: '🧰', sort: 20 },
  creative: { name: 'Creative', description: 'Drawing, music, generators', emoji: '🎨', sort: 30 },
  productivity: { name: 'Productivity', description: 'Notes, planners, trackers', emoji: '📝', sort: 40 },
  education: { name: 'Learning', description: 'Teach, quiz, explain', emoji: '📚', sort: 50 },
  ai: { name: 'AI', description: 'Apps that run a model', emoji: '🤖', sort: 60 },
  experiments: { name: 'Experiments', description: 'Trying something out', emoji: '🧪', sort: 70 },
  demos: { name: 'Examples', description: 'Interactive apps showing what SoftN Web Containers can do', emoji: '🧩', sort: 80 },
  other: { name: 'Other', description: 'Everything else', emoji: '📦', sort: 90 },
  // Games subcategories
  'games/3d': { name: '3D & First-Person', description: '3D worlds, voxel sandboxes, survival and mazes', emoji: '🧊', sort: 10 },
  'games/arcade': { name: 'Arcade & Comedy', description: 'Fast-paced reflexes, satire and pick-up-and-play games', emoji: '🕹️', sort: 20 },
  'games/strategy': { name: 'Strategy & Management', description: 'Cities, colonies, tactics and resource management', emoji: '🏗️', sort: 30 },
  'games/story': { name: 'Story & Narrative', description: 'Interactive dramas, mysteries and atmospheric fiction', emoji: '📖', sort: 40 },
  'games/retro': { name: 'Retro & Tabletop', description: 'Card games, tabletop classics and pocket-sized throwbacks', emoji: '🃏', sort: 50 },
  'games/puzzle': { name: 'Puzzle & Brain', description: 'Logic puzzles, riddles and brain teasers', emoji: '🧠', sort: 60 },
  // Business Apps subcategories
  'business/hospitality': { name: 'Hospitality & Events', description: 'Cafes, restaurants, catering, venues and short-stay ops', emoji: '☕', sort: 10 },
  'business/field-trades': { name: 'Field & Trades', description: 'Workshops, farms, plumbing, cleaning, pet care and site diaries', emoji: '🔧', sort: 20 },
  'business/healthcare-wellness': { name: 'Health, Beauty & Coaching', description: 'Clinics, salons, coaching studios and tutoring', emoji: '🩺', sort: 30 },
  'business/operations': { name: 'Operations & Fleet', description: 'Fleet tracking, job invoicing and device repair benches', emoji: '🚚', sort: 40 },
  'business/retail-inventory': { name: 'Retail & Inventory', description: 'POS workflows, stock control and purchase orders', emoji: '🛒', sort: 50 },
  'business/people-support': { name: 'People & Support', description: 'Reception desks, customer service and HR operations', emoji: '👥', sort: 60 },
  'business/finance-compliance': { name: 'Finance & Compliance', description: 'Accounting, bookkeeping, OHS and quality management', emoji: '📊', sort: 70 },
};

const GAME_SUBCATEGORIES = {
  blockscape: '3d',
  'dead-hours': '3d',
  'maze-escape-3d': '3d',
  'do-not-press-the-duck': 'arcade',
  'express-delivery-snail': 'arcade',
  'frog-employee-of-the-month': 'arcade',
  'pigeon-municipal-employee': 'arcade',
  'potato-peeler': 'arcade',
  'very-normal-post-office': 'arcade',
  'snake-game': 'arcade',
  blockfall: 'arcade',
  'mine-management': 'strategy',
  outermate: 'strategy',
  outerstead: 'strategy',
  scorchline: 'strategy',
  urbanward: 'strategy',
  'convenience-store-at-the-end-of-the-universe': 'story',
  lastsound3d: 'story',
  'please-do-not-feed-the-moon': 'story',
  'promptly-unemployed': 'story',
  'the-night-window': 'story',
  pocket: 'retro',
  'texas-holdem': 'retro',
  'the-office': 'retro',
  twenty48: 'puzzle',
};

const BUSINESS_SUBCATEGORIES = {
  'brewdesk-cafe-ops': 'hospitality',
  'catercraft-catering': 'hospitality',
  'event-management': 'hospitality',
  'grillstack-burger-ops': 'hospitality',
  'passmaster-restaurant': 'hospitality',
  'stayready-short-stay': 'hospitality',
  'venueops-venue-hire': 'hospitality',
  'agrilog-farm': 'field-trades',
  'cleanshift-cleaning': 'field-trades',
  'mechanic-workshop': 'field-trades',
  'pawroute-pet-care': 'field-trades',
  'plumbing-field-service': 'field-trades',
  'property-maintenance': 'field-trades',
  'sitepulse-site-diary': 'field-trades',
  'clinic-appointment-intake': 'healthcare-wellness',
  'fitstudio-coaching': 'healthcare-wellness',
  'salon-beauty-studio': 'healthcare-wellness',
  'tutortrack-tutoring': 'healthcare-wellness',
  'fleetflow-fleet': 'operations',
  'job-invoice-management': 'operations',
  'repairbench-device-repair': 'operations',
  'counterflow-retail-ops': 'retail-inventory',
  'inventory-purchase-orders': 'retail-inventory',
  'aokie-receptionist': 'people-support',
  'customer-service': 'people-support',
  'hr-people': 'people-support',
  'finance-os-au': 'finance-compliance',
  'finance-os-us': 'finance-compliance',
  'ohs-qms': 'finance-compliance',
};

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(arg);
    }
  }
  return { cmd: pos[0] || 'help', args: pos.slice(1), flags };
}

function slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}

function titleize(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((p) => (p.length <= 2 && /^[a-z0-9]+$/i.test(p) ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join(' ');
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.json-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

function hasBundle(dir) {
  try {
    return fs.readdirSync(dir).some((f) => !f.startsWith('.') && f.toLowerCase().endsWith('.softn'));
  } catch {
    return false;
  }
}

/** Recursively discover every app folder under data/apps/ (flat, <cat>/<slug>, or <cat>/<sub>/<slug>). */
function discoverApps(dataDir) {
  const appsRoot = path.join(dataDir, 'apps');
  const found = [];
  if (!fs.existsSync(appsRoot)) return found;

  const visit = (dir, depth, parts) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.isSymbolicLink() || ent.name.startsWith('.') || INTERNAL_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const isApp = fs.existsSync(path.join(full, 'app.json')) || (hasBundle(full) && !fs.existsSync(path.join(full, 'category.json')));
      if (isApp) {
        found.push({
          slug: ent.name,
          dir: full,
          rel: [...parts, ent.name].join('/'),
          folderCategory: parts[0] || null,
          folderSubcategory: parts[1] || null,
        });
      } else if (depth < 2) {
        visit(full, depth + 1, [...parts, ent.name]);
      }
    }
  };
  visit(appsRoot, 0, []);
  found.sort((a, b) => a.slug.localeCompare(b.slug));
  return found;
}

function findApp(dataDir, slug) {
  return discoverApps(dataDir).find((a) => a.slug === slug) || null;
}

function isCategorizedDataDir(dataDir) {
  const cfg = readJsonSafe(path.join(dataDir, 'config.json'));
  if (cfg?.folderLayout === 'categorized') return true;
  if (cfg?.folderLayout === 'flat') return false;
  const appsRoot = path.join(dataDir, 'apps');
  if (!fs.existsSync(appsRoot)) return false;
  for (const ent of fs.readdirSync(appsRoot, { withFileTypes: true })) {
    if (ent.isDirectory() && fs.existsSync(path.join(appsRoot, ent.name, 'category.json'))) return true;
  }
  return false;
}

function targetDirFor(dataDir, slug, category, subcategory) {
  const appsRoot = path.join(dataDir, 'apps');
  if (!isCategorizedDataDir(dataDir) && !subcategory) {
    return path.join(appsRoot, slug);
  }
  if (subcategory) return path.join(appsRoot, category, subcategory, slug);
  return path.join(appsRoot, category, slug);
}

function inspectBundleZip(filePath) {
  const bytes = fs.readFileSync(filePath);
  const files = unzipSync(new Uint8Array(bytes));
  const rawManifest = files['manifest.json'];
  let manifest = {};
  if (rawManifest) {
    manifest = JSON.parse(new TextDecoder().decode(rawManifest).replace(/^\uFEFF/, ''));
  }
  const backendRuntime =
    manifest?.backend && typeof manifest.backend.runtime === 'string' && manifest.backend.runtime.trim()
      ? manifest.backend.runtime.trim().toLowerCase()
      : null;
  const isV2 = manifest?.engine === 2 || manifest?.container === true || Boolean(backendRuntime) || !rawManifest;
  let iconBytes = null;
  let iconExt = null;
  const iconCandidates = [];
  if (typeof manifest?.icon === 'string' && manifest.icon.trim()) iconCandidates.push(manifest.icon.trim());
  for (const fb of ['icon.svg', 'icon.png', 'icon.webp', 'assets/icon.svg', 'assets/icon.png', 'assets/icon.webp', 'favicon.svg', 'favicon.png']) {
    iconCandidates.push(fb);
  }
  for (const cand of iconCandidates) {
    if (files[cand]) {
      iconBytes = files[cand];
      iconExt = path.extname(cand).replace(/^\./, '').toLowerCase() || 'svg';
      break;
    }
  }
  const capabilities = [];
  let storagePolicies = {};
  if (files['permission.json']) {
    try {
      const perm = JSON.parse(new TextDecoder().decode(files['permission.json']).replace(/^\uFEFF/, ''));
      if (perm?.permissions && typeof perm.permissions === 'object') {
        for (const [k, v] of Object.entries(perm.permissions)) {
          if (v && typeof v === 'object' && v.enabled === true) capabilities.push(k);
        }
        if (perm.permissions.storage?.collections && typeof perm.permissions.storage.collections === 'object') {
          storagePolicies = perm.permissions.storage.collections;
        }
      }
    } catch {
      /* ignore malformed */
    }
  }
  return {
    manifest,
    size: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    engine: isV2 ? 2 : 1,
    execution: isV2 || manifest?.config?.execution === 'worker' ? 'worker' : 'main',
    backendRuntime,
    capabilities,
    storagePolicies,
    iconBytes,
    iconExt,
  };
}

/** Write/update category.json in every category & subcategory folder under data/apps/, preserving custom display fields. */
function writeAllCategoryJsons(dataDir) {
  const appsRoot = path.join(dataDir, 'apps');
  if (!fs.existsSync(appsRoot)) return;
  const apps = discoverApps(dataDir);
  const byMain = new Map();
  const bySub = new Map();
  const subsOf = new Map();

  for (const a of apps) {
    const doc = readJsonSafe(path.join(a.dir, 'app.json'));
    if (doc?.app?.hidden) continue;
    const cat = a.folderCategory || doc?.app?.category || 'other';
    const sub = a.folderSubcategory || doc?.app?.subcategory || null;
    if (sub) {
      const key = `${cat}/${sub}`;
      if (!bySub.has(key)) bySub.set(key, []);
      bySub.get(key).push(a.slug);
      if (!subsOf.has(cat)) subsOf.set(cat, new Set());
      subsOf.get(cat).add(sub);
    } else {
      if (!byMain.has(cat)) byMain.set(cat, []);
      byMain.get(cat).push(a.slug);
    }
  }

  for (const ent of fs.readdirSync(appsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || INTERNAL_DIRS.has(ent.name)) continue;
    const cat = ent.name;
    const catDir = path.join(appsRoot, cat);
    if (fs.existsSync(path.join(catDir, 'app.json'))) continue;

    // Inspect child subcategory directories
    for (const subEnt of fs.readdirSync(catDir, { withFileTypes: true })) {
      if (!subEnt.isDirectory() || subEnt.name.startsWith('.') || INTERNAL_DIRS.has(subEnt.name)) continue;
      const subDir = path.join(catDir, subEnt.name);
      if (fs.existsSync(path.join(subDir, 'app.json'))) continue;
      const sub = subEnt.name;
      if (!subsOf.has(cat)) subsOf.set(cat, new Set());
      subsOf.get(cat).add(sub);

      const id = `${cat}/${sub}`;
      const existing = readJsonSafe(path.join(subDir, 'category.json')) || {};
      const def = CATEGORY_META[id] || { name: titleize(sub), description: `Apps in ${titleize(sub)}`, emoji: '📂', sort: 100 };
      const list = (bySub.get(id) || []).slice().sort();
      writeJsonAtomic(path.join(subDir, 'category.json'), {
        schemaVersion: 1,
        id,
        slug: sub,
        parent: cat,
        name: existing.name || def.name,
        description: existing.description ?? def.description,
        emoji: existing.emoji || def.emoji,
        sort: typeof existing.sort === 'number' ? existing.sort : def.sort,
        status: existing.status || (CATEGORY_META[id] ? 'core' : 'approved'),
        updatedAt: new Date().toISOString(),
        cache: {
          appCount: list.length,
          directAppCount: list.length,
          subcategories: [],
          apps: list,
        },
      });
    }

    const existing = readJsonSafe(path.join(catDir, 'category.json')) || {};
    const def = CATEGORY_META[cat] || { name: titleize(cat), description: `Apps in ${titleize(cat)}`, emoji: '📁', sort: 100 };
    const direct = (byMain.get(cat) || []).slice().sort();
    const subSlugs = Array.from(subsOf.get(cat) || []).sort();
    let total = direct.length;
    for (const ss of subSlugs) total += (bySub.get(`${cat}/${ss}`) || []).length;

    writeJsonAtomic(path.join(catDir, 'category.json'), {
      schemaVersion: 1,
      id: cat,
      slug: cat,
      parent: null,
      name: existing.name || def.name,
      description: existing.description ?? def.description,
      emoji: existing.emoji || def.emoji,
      sort: typeof existing.sort === 'number' ? existing.sort : def.sort,
      status: existing.status || (CATEGORY_META[cat] ? 'core' : 'approved'),
      updatedAt: new Date().toISOString(),
      cache: {
        appCount: total,
        directAppCount: direct.length,
        subcategories: subSlugs,
        apps: direct,
      },
    });
  }
}

function addApp({ bundlePath, dataDir, flags }) {
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    throw new Error(`Bundle file not found: ${bundlePath}`);
  }
  const info = inspectBundleZip(bundlePath);
  const slug = slugify(flags.slug || info.manifest.name || path.basename(bundlePath, '.softn'));
  const hosting = String(flags.hosting || 'browser').toLowerCase();
  if (!VALID_HOSTING.has(hosting)) throw new Error(`Invalid hosting mode: ${hosting} (use browser, server, or hybrid)`);
  const backendUrl = typeof flags['backend-url'] === 'string' && flags['backend-url'] !== '' && flags['backend-url'] !== 'none'
    ? flags['backend-url']
    : null;
  if ((hosting === 'server' || hosting === 'hybrid') && !info.backendRuntime && !backendUrl) {
    throw new Error(`App "${slug}" has no embedded backend; server/hybrid hosting requires a backend or --backend-url.`);
  }
  const withholdBackend = hosting === 'server' && parseBool(flags['withhold-backend']);

  const existingEntry = findApp(dataDir, slug);
  const existing = existingEntry ? readJsonSafe(path.join(existingEntry.dir, 'app.json')) : null;
  let category = String(flags.category || existing?.app?.category || 'other');
  let subcategory = typeof flags.subcategory === 'string'
    ? (flags.subcategory === '' || flags.subcategory === 'none' ? null : slugify(flags.subcategory))
    : (existing?.app?.subcategory ?? null);
  if (category.includes('/')) {
    const [c, s] = category.split('/', 2);
    category = slugify(c);
    subcategory = slugify(s);
  }

  const appDir = existingEntry ? existingEntry.dir : targetDirFor(dataDir, slug, category, subcategory);
  fs.mkdirSync(appDir, { recursive: true });
  const targetBundle = path.join(appDir, 'v1.softn');
  fs.copyFileSync(bundlePath, targetBundle);

  let iconFile = null;
  if (typeof flags.icon === 'string' && fs.existsSync(flags.icon)) {
    const ext = path.extname(flags.icon).replace(/^\./, '').toLowerCase() || 'svg';
    iconFile = `icon.${ext}`;
    fs.copyFileSync(flags.icon, path.join(appDir, iconFile));
  } else if (info.iconBytes) {
    iconFile = `icon.${info.iconExt}`;
    fs.writeFileSync(path.join(appDir, iconFile), info.iconBytes);
  }

  let thumbFile = null;
  if (typeof flags.thumb === 'string' && fs.existsSync(flags.thumb)) {
    const ext = path.extname(flags.thumb).replace(/^\./, '').toLowerCase() || 'png';
    thumbFile = `thumb.${ext}`;
    fs.copyFileSync(flags.thumb, path.join(appDir, thumbFile));
  }

  const appJsonPath = path.join(appDir, 'app.json');
  const now = Math.floor(Date.now() / 1000);
  const tags = typeof flags.tags === 'string'
    ? flags.tags.split(',').map((t) => slugify(t)).filter(Boolean).slice(0, 8)
    : Array.isArray(existing?.app?.tags)
      ? existing.app.tags
      : [];

  const doc = {
    schemaVersion: 1,
    app: {
      slug,
      name: String(flags.name || info.manifest.name || slug),
      description: String(flags.description ?? info.manifest.description ?? ''),
      author: String(flags.author || (typeof info.manifest.author === 'string' ? info.manifest.author : info.manifest.author?.name) || 'SoftN'),
      category,
      subcategory,
      tags,
      parent_slug: existing?.app?.parent_slug ?? null,
      root_slug: existing?.app?.root_slug ?? null,
      latest_version: 1,
      capabilities: info.capabilities,
      execution: info.execution,
      engine: info.engine,
      backend_runtime: info.backendRuntime,
      hosting,
      backend_url: backendUrl,
      withhold_backend: withholdBackend ? 1 : 0,
      storage_policies: info.storagePolicies,
      hidden_remixes: existing?.app?.hidden_remixes ?? '[]',
      thumb: thumbFile ?? existing?.app?.thumb ?? null,
      icon: iconFile ?? existing?.app?.icon ?? null,
      primary_color: typeof flags.primary === 'string' ? flags.primary : (existing?.app?.primary_color ?? null),
      edit_key_hash: existing?.app?.edit_key_hash ?? null,
      play_url: null,
      source: 'folder',
      runs: existing?.app?.runs ?? 0,
      launches: existing?.app?.launches ?? 0,
      remixes: existing?.app?.remixes ?? 0,
      rating_sum: existing?.app?.rating_sum ?? 0,
      rating_count: existing?.app?.rating_count ?? 0,
      comments: existing?.app?.comments ?? 0,
      size: info.size,
      hidden: 0,
      created_at: existing?.app?.created_at ?? now,
      updated_at: now,
    },
    versions: [
      {
        slug,
        version: 1,
        file: 'v1.softn',
        size: info.size,
        sha256: info.sha256,
        manifest_version: String(info.manifest.version || '1.0.0'),
        notes: existing?.versions?.[0]?.notes ?? '',
        created_at: existing?.versions?.[0]?.created_at ?? now,
      },
    ],
    comments: existing?.comments ?? [],
    ratings: existing?.ratings ?? [],
    runsDaily: existing?.runsDaily ?? [],
  };

  writeJsonAtomic(appJsonPath, doc);
  if (isCategorizedDataDir(dataDir)) writeAllCategoryJsons(dataDir);
  return doc;
}

function cmdList(dataDir, flags) {
  const entries = discoverApps(dataDir);
  const rows = [];
  for (const ent of entries) {
    const doc = readJsonSafe(path.join(ent.dir, 'app.json'));
    const app = doc?.app || {};
    const cat = app.category || ent.folderCategory || 'other';
    const sub = app.subcategory || ent.folderSubcategory || null;
    if (flags.category && cat !== flags.category) continue;
    if (flags.subcategory && sub !== flags.subcategory) continue;
    if (flags.hosting && (app.hosting || 'browser') !== flags.hosting) continue;
    rows.push({
      slug: ent.slug,
      catPath: sub ? `${cat}/${sub}` : cat,
      hosting: app.hosting || 'browser',
      backend: app.backend_runtime || '-',
      thumb: app.thumb || '-',
      rel: ent.rel,
    });
  }
  console.log(`Directory apps (${rows.length}) in ${dataDir}:`);
  for (const r of rows) {
    console.log(
      `  ${r.slug.padEnd(42)} cat=${r.catPath.padEnd(28)} hosting=${r.hosting.padEnd(8)} backend=${r.backend.padEnd(6)} thumb=${r.thumb}`
    );
  }
}

function cmdSet(slug, dataDir, flags) {
  if (!slug) throw new Error('Usage: manage-data.mjs set <slug> [--category ...] [--subcategory <sub|none>] [--hosting browser|server|hybrid] [--backend-url <url|none>] [--withhold-backend true|false]');
  const entry = findApp(dataDir, slug);
  if (!entry) throw new Error(`App not found: ${slug}`);
  const p = path.join(entry.dir, 'app.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const app = doc.app;
  let moved = false;
  if (typeof flags.category === 'string') {
    if (flags.category.includes('/')) {
      const [c, s] = flags.category.split('/', 2);
      app.category = slugify(c);
      app.subcategory = slugify(s);
    } else {
      app.category = slugify(flags.category);
      if (flags.subcategory === undefined) app.subcategory = null;
    }
    moved = true;
  }
  if (typeof flags.subcategory === 'string') {
    app.subcategory = flags.subcategory === '' || flags.subcategory === 'none' ? null : slugify(flags.subcategory);
    moved = true;
  }
  if (typeof flags.hosting === 'string') {
    const h = flags.hosting.toLowerCase();
    if (!VALID_HOSTING.has(h)) throw new Error(`Invalid hosting mode: ${h}`);
    app.hosting = h;
    if (h !== 'server') app.withhold_backend = 0;
  }
  if (typeof flags['backend-url'] === 'string') {
    app.backend_url = flags['backend-url'] === 'none' || flags['backend-url'] === '' ? null : flags['backend-url'];
  }
  if (flags['withhold-backend'] !== undefined) {
    app.withhold_backend = app.hosting === 'server' && parseBool(flags['withhold-backend']) ? 1 : 0;
  }
  if (typeof flags.tags === 'string') {
    app.tags = flags.tags.split(',').map((t) => slugify(t)).filter(Boolean).slice(0, 8);
  }
  app.updated_at = Math.floor(Date.now() / 1000);
  writeJsonAtomic(p, doc);

  if (moved && isCategorizedDataDir(dataDir)) {
    const dest = targetDirFor(dataDir, slug, app.category || 'other', app.subcategory || null);
    if (path.resolve(dest) !== path.resolve(entry.dir)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(entry.dir, dest);
    }
    writeAllCategoryJsons(dataDir);
  }
  console.log(`Updated ${slug}: category=${app.category}${app.subcategory ? '/' + app.subcategory : ''} hosting=${app.hosting} backend_url=${app.backend_url ?? 'default'} withhold_backend=${app.withhold_backend}`);
}

function cmdRemove(slug, dataDir) {
  if (!slug) throw new Error('Usage: manage-data.mjs remove <slug>');
  const entry = findApp(dataDir, slug);
  if (!entry) {
    console.log(`Not found: ${slug}`);
    return;
  }
  fs.rmSync(entry.dir, { recursive: true, force: true });
  if (isCategorizedDataDir(dataDir)) writeAllCategoryJsons(dataDir);
  console.log(`Removed ${slug} (${entry.rel}) from ${dataDir}`);
}

/**
 * Organize every app folder under data/apps/ into `data/apps/<category>/[<subcategory>/]<slug>/`,
 * write `category.json` in every category & subcategory folder, and enable `folderLayout: "categorized"`.
 */
function cmdOrganize(dataDir) {
  const appsRoot = path.join(dataDir, 'apps');
  if (!fs.existsSync(appsRoot)) throw new Error(`No apps directory at ${appsRoot}`);

  // Set folderLayout: "categorized" in config.json
  const cfgPath = path.join(dataDir, 'config.json');
  const cfg = readJsonSafe(cfgPath) || {};
  cfg.folderLayout = 'categorized';
  writeJsonAtomic(cfgPath, cfg);

  const entries = discoverApps(dataDir);
  let moved = 0;
  let updated = 0;

  for (const ent of entries) {
    const appJsonPath = path.join(ent.dir, 'app.json');
    const doc = readJsonSafe(appJsonPath);
    if (!doc?.app) continue;

    let cat = String(doc.app.category || 'other');
    let sub = typeof doc.app.subcategory === 'string' && doc.app.subcategory ? doc.app.subcategory : null;

    // Remap legacy top-level story / strategy into games/story and games/strategy
    if (cat === 'story') {
      cat = 'games';
      sub = 'story';
    } else if (cat === 'strategy') {
      cat = 'games';
      sub = 'strategy';
    }
    // Apply curated subcategories for Games & Business Apps when none is set yet
    if ((cat === 'games' || cat === 'other') && !sub && GAME_SUBCATEGORIES[ent.slug]) {
      cat = 'games';
      sub = GAME_SUBCATEGORIES[ent.slug];
    } else if (cat === 'business' && !sub && BUSINESS_SUBCATEGORIES[ent.slug]) {
      sub = BUSINESS_SUBCATEGORIES[ent.slug];
    }

    if (doc.app.category !== cat || (doc.app.subcategory ?? null) !== sub) {
      doc.app.category = cat;
      doc.app.subcategory = sub;
      if (doc.app.source === 'seed') {
        doc.app.seed_category = cat;
        doc.app.seed_subcategory = sub;
      }
      writeJsonAtomic(appJsonPath, doc);
      updated++;
    }

    const dest = sub ? path.join(appsRoot, cat, sub, ent.slug) : path.join(appsRoot, cat, ent.slug);
    if (path.resolve(dest) !== path.resolve(ent.dir)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(ent.dir, dest);
      moved++;
    }
  }

  // Clean up legacy top-level categories.json entries for story/strategy if present
  const catsPath = path.join(dataDir, 'categories.json');
  const cats = readJsonSafe(catsPath);
  if (cats && typeof cats === 'object') {
    let changed = false;
    for (const legacy of ['story', 'strategy']) {
      if (cats[legacy] && cats[legacy].status === 'core' && !cats[legacy].parent) {
        delete cats[legacy];
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(catsPath, cats);
  }

  // Clear bundle cache so next request re-keys cleanly to nested paths
  const bundleCache = path.join(dataDir, 'cache', 'bundles.json');
  if (fs.existsSync(bundleCache)) {
    try {
      fs.unlinkSync(bundleCache);
    } catch {
      // ignore
    }
  }

  writeAllCategoryJsons(dataDir);
  console.log(`Organized ${entries.length} app(s) into categorized folders (${moved} moved, ${updated} metadata updated) and generated category.json caches.`);
}

async function cmdSync(dataDir, flags) {
  const baseUrl = (typeof flags.base === 'string' ? flags.base : (process.env.SOFTN_SITE_URL || 'http://localhost:1420')).replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    console.log(`Triggered catalogue scan via ${baseUrl}/api/health -> HTTP ${res.status}`);
  } catch {
    console.log(`API at ${baseUrl} not reachable; updating local category.json caches only.`);
    writeAllCategoryJsons(dataDir);
  }
  if (flags.thumbs) {
    const args = [path.join(here, 'auto-thumb.mjs'), '--missing', '--data', dataDir, '--base', baseUrl];
    if (flags.force) args.push('--force');
    const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (r.status !== 0) process.exitCode = r.status ?? 1;
  }
}

function cmdWatch(dataDir, flags) {
  const baseUrl = (typeof flags.base === 'string' ? flags.base : (process.env.SOFTN_SITE_URL || 'http://localhost:1420')).replace(/\/$/, '');
  const appsRoot = path.join(dataDir, 'apps');
  fs.mkdirSync(appsRoot, { recursive: true });
  console.log(`Watching ${appsRoot} for dropped .softn bundles and folder changes (target: ${baseUrl})...`);

  let timer = null;
  let running = false;
  const trigger = () => {
    if (running) return;
    running = true;
    fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(8000) })
      .then((r) => console.log(`[watch] synced catalogue -> HTTP ${r.status}`))
      .catch((err) => console.warn(`[watch] sync failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = false;
      });
  };

  fs.watch(appsRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const norm = filename.replace(/\\/g, '/');
    if (
      norm.includes('/.json-') ||
      norm.includes('/.upload-') ||
      norm.includes('/.thumb-tmp-') ||
      norm.includes('/.auto-thumb') ||
      norm.includes('/backend-cache/') ||
      norm.includes('/backend-data/') ||
      norm.endsWith('category.json') ||
      norm.endsWith('.tmp')
    ) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(trigger, 600);
  });
}

function cmdImportBusiness(dataDir, flags) {
  const fromDir = path.resolve(typeof flags.from === 'string' ? flags.from : DEFAULT_BUSINESS_DIR);
  const indexPath = path.join(fromDir, 'index.json');
  if (!fs.existsSync(indexPath)) throw new Error(`Missing index.json at ${indexPath}`);
  const manifest = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const apps = Array.isArray(manifest.demos) ? manifest.demos : (Array.isArray(manifest.apps) ? manifest.apps : []);
  const hosting = String(flags.hosting || 'browser').toLowerCase();
  if (!VALID_HOSTING.has(hosting)) throw new Error(`Invalid hosting mode: ${hosting}`);

  let imported = 0;
  for (const entry of apps) {
    const slug = slugify(entry.slug || entry.id || entry.name);
    if (EXCLUDED_BUSINESS_SLUGS.has(slug)) {
      console.log(`Skipping excluded app: ${slug}`);
      continue;
    }
    const bundleFile = entry.file || entry.bundle;
    const bundlePath = path.join(fromDir, bundleFile);
    if (!bundleFile || !fs.existsSync(bundlePath)) {
      console.warn(`Missing bundle for ${slug}: ${bundlePath}`);
      continue;
    }
    const iconCandidate = entry.icon ? path.join(fromDir, entry.icon) : null;
    const industryTag = slugify(entry.category || '');
    const tags = Array.from(
      new Set([industryTag, 'php', 'sqlite', 'full-stack'].filter(Boolean))
    ).join(',');

    addApp({
      bundlePath,
      dataDir,
      flags: {
        slug,
        name: entry.name,
        description: entry.description || '',
        author: 'SoftN',
        category: 'business',
        subcategory: BUSINESS_SUBCATEGORIES[slug] || undefined,
        hosting,
        tags,
        icon: iconCandidate && fs.existsSync(iconCandidate) ? iconCandidate : undefined,
        primary: entry.accent || undefined,
      },
    });
    imported++;
  }

  // Ensure excluded apps (VCDI / Servalet) are not lingering anywhere in data/apps/
  for (const excluded of EXCLUDED_BUSINESS_SLUGS) {
    const found = findApp(dataDir, excluded);
    if (found) {
      fs.rmSync(found.dir, { recursive: true, force: true });
      console.log(`Removed excluded app folder: ${found.rel}`);
    }
  }
  if (isCategorizedDataDir(dataDir)) writeAllCategoryJsons(dataDir);
  console.log(`Imported ${imported} business apps into ${dataDir}/apps/ (category=business, hosting=${hosting}).`);
}

function cmdInstallDemos(dataDir, flags) {
  const demosDir = path.resolve(
    typeof flags.from === 'string' ? flags.from : path.join(repoRoot, 'apps/softn-web/public/demos')
  );
  if (!flags.from && !flags['no-fetch']) {
    const fetchArgs = [path.join(here, 'fetch-demos.mjs')];
    if (typeof flags.tag === 'string' && flags.tag) fetchArgs.push('--pin', flags.tag);
    const fetched = spawnSync(process.execPath, fetchArgs, { cwd: repoRoot, stdio: 'inherit' });
    if (fetched.status !== 0) {
      throw new Error(`fetch-demos failed with status ${fetched.status ?? 1}`);
    }
  }
  const indexPath = path.join(demosDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Missing demos index at ${indexPath}`);
  }
  const entries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`Invalid index.json at ${indexPath}`);

  // Default to categorized folder layout when installing demos into data/
  const cfgPath = path.join(dataDir, 'config.json');
  const cfg = readJsonSafe(cfgPath) || {};
  if (!cfg.folderLayout || cfg.folderLayout === 'auto') {
    cfg.folderLayout = 'categorized';
    writeJsonAtomic(cfgPath, cfg);
  }

  let installed = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string') continue;
    const bundlePath = path.join(demosDir, path.basename(entry.file));
    if (!fs.existsSync(bundlePath)) {
      console.warn(`Skipping missing demo bundle: ${bundlePath}`);
      continue;
    }
    const slug = slugify(entry.id || entry.name || path.basename(entry.file, '.softn'));
    const base = path.basename(entry.file, '.softn');
    let cat = String(entry.category || 'demos');
    let sub = typeof entry.subcategory === 'string' && entry.subcategory ? entry.subcategory : undefined;
    if (cat === 'story') { cat = 'games'; sub = 'story'; }
    else if (cat === 'strategy') { cat = 'games'; sub = 'strategy'; }
    if (cat === 'games' && !sub && GAME_SUBCATEGORIES[slug]) sub = GAME_SUBCATEGORIES[slug];

    let iconPath;
    for (const ext of ['svg', 'png', 'webp']) {
      const cand = path.join(demosDir, 'icons', `${base}.${ext}`);
      if (fs.existsSync(cand)) { iconPath = cand; break; }
    }
    let thumbPath;
    for (const ext of ['webp', 'png', 'jpg']) {
      const cand = path.join(demosDir, 'thumbs', `${base}.${ext}`);
      if (fs.existsSync(cand)) { thumbPath = cand; break; }
    }

    addApp({
      bundlePath,
      dataDir,
      flags: {
        slug,
        name: entry.name || base,
        description: entry.description || '',
        author: entry.author || 'SoftN',
        category: cat,
        subcategory: sub,
        hosting: 'browser',
        tags: typeof entry.tags === 'string' ? entry.tags : '',
        icon: iconPath,
        thumb: thumbPath,
        primary: typeof entry.primary === 'string' ? entry.primary : undefined,
      },
    });
    installed++;
  }
  writeAllCategoryJsons(dataDir);
  console.log(`Installed ${installed} optional SoftN example demos into ${dataDir}/apps/ (categorized).`);
}

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(typeof flags.data === 'string' ? flags.data : DEFAULT_DATA_DIR);

  switch (cmd) {
    case 'list':
      cmdList(dataDir, flags);
      break;
    case 'add': {
      const doc = addApp({ bundlePath: path.resolve(args[0] || ''), dataDir, flags });
      console.log(`Added ${doc.app.slug} (category=${doc.app.category}${doc.app.subcategory ? '/' + doc.app.subcategory : ''}, hosting=${doc.app.hosting}, backend=${doc.app.backend_runtime || 'none'})`);
      break;
    }
    case 'set':
      cmdSet(args[0], dataDir, flags);
      break;
    case 'remove':
      cmdRemove(args[0], dataDir);
      break;
    case 'organize':
      cmdOrganize(dataDir);
      break;
    case 'sync':
      await cmdSync(dataDir, flags);
      break;
    case 'watch':
      cmdWatch(dataDir, flags);
      break;
    case 'install-demos':
      cmdInstallDemos(dataDir, flags);
      break;
    case 'import-business-demos':
      cmdImportBusiness(dataDir, flags);
      break;
    default:
      console.log(`Usage:
  node scripts/demos/manage-data.mjs list [--category <cat>] [--subcategory <sub>] [--hosting <mode>] [--data <dir>]
  node scripts/demos/manage-data.mjs install-demos [--tag <vX.Y.Z>] [--from <dir>] [--no-fetch] [--data <dir>]
  node scripts/demos/manage-data.mjs organize [--data <dir>]
  node scripts/demos/manage-data.mjs sync [--thumbs] [--force] [--base <url>] [--data <dir>]
  node scripts/demos/manage-data.mjs watch [--base <url>] [--data <dir>]
  node scripts/demos/manage-data.mjs add <bundle.softn> --slug <slug> --category <cat> [--subcategory <sub>] [--hosting browser|server|hybrid] [--withhold-backend]
  node scripts/demos/manage-data.mjs set <slug> [--category <cat>] [--subcategory <sub|none>] [--hosting browser|server|hybrid] [--backend-url <url|none>] [--withhold-backend true|false]
  node scripts/demos/manage-data.mjs remove <slug> [--data <dir>]
  node scripts/demos/manage-data.mjs import-business-demos [--from <dir>] [--hosting browser|server|hybrid] [--data <dir>]`);
  }
}

main();
