#!/usr/bin/env node
/**
 * Capture live rendered HTML snapshots (`ssr.html`) for hosted SoftN apps so
 * View Page Source and search crawlers receive the real rendered application
 * markup (from Container v2 Shadow DOM or Classic .ui live DOM), strictly
 * sanitized to safe semantic HTML5.
 *
 * Usage:
 *   node scripts/demos/prerender-demos.mjs [--origin http://127.0.0.1:1420] [--data-dir dist/data] [--slug stayready-short-stay]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { repoRoot } from '../lib/paths.mjs';

function parseArgs(argv) {
  const opts = {
    origin: process.env.SOFTN_SITE_URL || 'http://127.0.0.1:1420',
    dataDir: null,
    slugs: [],
    concurrency: 3,
    timeoutMs: 25000,
    settleMs: 1800,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--origin' && argv[i + 1]) opts.origin = argv[++i].replace(/\/+$/, '');
    else if (a === '--data-dir' && argv[i + 1]) opts.dataDir = path.resolve(argv[++i]);
    else if (a === '--slug' && argv[i + 1]) opts.slugs.push(argv[++i]);
    else if (a === '--concurrency' && argv[i + 1]) opts.concurrency = Math.max(1, Math.min(8, Number(argv[++i]) || 3));
    else if (a === '--timeout' && argv[i + 1]) opts.timeoutMs = Math.max(5000, Number(argv[++i]) || 25000);
    else if (a === '--settle' && argv[i + 1]) opts.settleMs = Math.max(200, Number(argv[++i]) || 1800);
  }
  if (!opts.dataDir) {
    const distData = path.join(repoRoot, 'dist/data');
    const apiData = path.join(repoRoot, 'apps/softn-api/data');
    opts.dataDir = fs.existsSync(path.join(distData, 'apps')) ? distData : apiData;
  }
  return opts;
}

function findApps(dataDir, requestedSlugs) {
  const appsRoot = path.join(dataDir, 'apps');
  if (!fs.existsSync(appsRoot)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const metaPath = path.join(full, 'app.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.hidden || meta.playUrl) continue;
          const slug = String(meta.slug || entry.name);
          if (requestedSlugs.length > 0 && !requestedSlugs.includes(slug)) continue;
          const versions = Array.isArray(meta.versions) ? meta.versions : [];
          const latest = versions[versions.length - 1] || null;
          const sha256 = String(latest?.sha256 || '');
          found.push({ slug, dir: full, name: String(meta.name || slug), sha256 });
        } catch {
          // Skip unreadable metadata
        }
      } else {
        walk(full);
      }
    }
  };
  walk(appsRoot);
  found.sort((a, b) => a.slug.localeCompare(b.slug));
  return found;
}

/** Browser-side DOM serializer that pierces open shadow roots and extracts clean semantic HTML5. */
function serializeRenderedAppInPage() {
  const ALLOWED = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'ul', 'ol', 'li',
    'section', 'article', 'header', 'main', 'footer', 'nav', 'aside',
    'div', 'span', 'a', 'strong', 'b', 'em', 'i',
    'code', 'pre', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'dl', 'dt', 'dd', 'figure', 'figcaption',
    'hr', 'br', 'label', 'button',
  ]);
  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
    'svg', 'math', 'canvas', 'audio', 'video', 'link', 'meta', 'base', 'head',
  ]);
  const VOID = new Set(['br', 'hr']);

  const esc = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const isVisible = (el) => {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch {
      /* ignore */
    }
    return true;
  };

  const getShadow = (el) => el.shadowRoot || (window.__softnPrerenderRoots ? window.__softnPrerenderRoots.get(el) : null);

  // Target ONLY `.application-content` (never the outer FrameBar or PermissionBar).
  // Prefer the mounted Container v2 shadow root (`[data-softn-viewport]` inside the
  // container's shadow root) so we capture the exact live app DOM shown in DevTools.
  const findAppRoot = () => {
    const stage = document.querySelector('.application-content');
    if (!stage) return null;
    if (stage.querySelector('.loading')) return { loading: true };
    const queue = [stage];
    let fallbackShadow = null;
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) continue;
      const sr = getShadow(cur);
      if (sr) {
        const vp = sr.querySelector('[data-softn-viewport]');
        if (vp) return { node: vp, isShadow: true, loading: false };
        if (!fallbackShadow) fallbackShadow = sr;
      }
      if (cur.children) {
        for (const child of cur.children) queue.push(child);
      }
    }
    if (fallbackShadow) return { node: fallbackShadow, isShadow: true, loading: false };
    return { node: stage, isShadow: false, loading: false };
  };

  let nodes = 0;
  let bytes = 0;
  const MAX_NODES = 380;
  const MAX_BYTES = 48000;

  const walk = (node, depth) => {
    if (!node || depth > 28 || nodes >= MAX_NODES || bytes >= MAX_BYTES) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!txt) return '';
      const out = esc(txt);
      bytes += out.length;
      return out;
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      const parts = [];
      for (const c of node.childNodes) {
        const s = walk(c, depth);
        if (s) parts.push(s);
      }
      return parts.join('\n');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    const tag = el.localName.toLowerCase();
    if (SKIP.has(tag) || !isVisible(el)) return '';
    // Skip host shell permission bars or boot overlays.
    if (el.id === 'boot' || el.classList?.contains('softn-ssr') || el.classList?.contains('loading')) return '';

    // Pierce shadow roots transparently (including closed container shadow roots captured by initScript).
    const sr = getShadow(el);
    if (sr) {
      const vp = sr.querySelector('[data-softn-viewport]') || sr;
      return walk(vp, depth);
    }

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const hint = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
      if (!hint) return '';
      nodes++;
      const out = `<span>${esc(hint)}</span>`;
      bytes += out.length;
      return out;
    }

    if (VOID.has(tag)) {
      nodes++;
      bytes += 6;
      return `<${tag} />`;
    }

    const childParts = [];
    for (const c of el.childNodes) {
      const s = walk(c, depth + 1);
      if (s) childParts.push(s);
    }
    const inner = childParts.join('\n');
    if (!inner.trim()) return '';

    if (!ALLOWED.has(tag)) return inner;

    let outTag = tag === 'h1' ? 'h2' : tag;
    let attrs = '';
    if (outTag === 'a') {
      const rawHref = (el.getAttribute('href') || '').trim();
      if (/^https?:\/\//i.test(rawHref)) {
        attrs = ` href="${esc(rawHref)}" rel="noopener noreferrer"`;
      } else {
        outTag = 'span';
      }
    } else if (outTag === 'button') {
      attrs = ' type="button"';
    }

    nodes++;
    bytes += outTag.length * 2 + attrs.length + 5;
    return `<${outTag}${attrs}>${inner}</${outTag}>`;
  };

  const target = findAppRoot();
  if (!target || target.loading || !target.node) {
    return { html: '', textLen: 0, isShadow: false, nodes: 0, loading: true };
  }
  const html = walk(target.node, 0);
  const textLen = (target.node.textContent || '').replace(/\s+/g, ' ').trim().length;
  return { html, textLen, isShadow: target.isShadow, nodes, loading: false };
}

async function prerenderApp(context, app, opts) {
  const page = await context.newPage();
  const url = `${opts.origin}/play/${encodeURIComponent(app.slug)}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });

    // Wait until #boot and .loading disappear and real rendered app DOM appears.
    const deadline = Date.now() + opts.timeoutMs;
    let best = { html: '', textLen: 0, isShadow: false, nodes: 0 };
    while (Date.now() < deadline) {
      const snap = await page.evaluate(serializeRenderedAppInPage).catch(() => null);
      if (snap && !snap.loading && snap.html) {
        const plain = snap.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const looksLoading = /^(?:Opening|Loading)\b/i.test(plain) && snap.nodes < 10;
        if (!looksLoading && snap.textLen > best.textLen) {
          best = snap;
        }
        if (!looksLoading && snap.textLen >= 140 && snap.nodes >= 8) {
          // Let async embedded PHP/SQLite API calls finish painting live tables/cards.
          await page.waitForTimeout(opts.settleMs);
          const finalSnap = await page.evaluate(serializeRenderedAppInPage).catch(() => null);
          if (finalSnap && !finalSnap.loading && finalSnap.html && finalSnap.textLen >= best.textLen) {
            best = finalSnap;
          }
          break;
        }
      }
      await page.waitForTimeout(350);
    }

    if (!best.html || best.textLen < 20) {
      return { slug: app.slug, ok: false, reason: 'no visible rendered DOM before timeout' };
    }

    const header = app.sha256 ? `<!-- softn-ssr-sha256: ${app.sha256} -->\n` : '';
    const outPath = path.join(app.dir, 'ssr.html');
    const tmpPath = `${outPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(tmpPath, `${header}${best.html}\n`, 'utf8');
    fs.renameSync(tmpPath, outPath);
    return { slug: app.slug, ok: true, bytes: best.html.length, nodes: best.nodes, isShadow: best.isShadow };
  } catch (err) {
    return { slug: app.slug, ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Record closed shadow roots inside this ephemeral headless prerender context
  // so Container v2's rendered DOM can be serialized without altering production encapsulation.
  await context.addInitScript(() => {
    const map = new WeakMap();
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = orig.call(this, init);
      map.set(this, root);
      return root;
    };
    Object.defineProperty(window, '__softnPrerenderRoots', { value: map, configurable: false, enumerable: false });
  });

  let apps = findApps(opts.dataDir, opts.slugs);
  if (apps.length === 0) {
    // Trigger first-run demo seeding on a fresh dist/data directory via /apps.
    const seedPage = await context.newPage();
    await seedPage.goto(`${opts.origin}/apps`, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs }).catch(() => {});
    await seedPage.close().catch(() => {});
    apps = findApps(opts.dataDir, opts.slugs);
  }
  if (apps.length === 0) {
    await browser.close();
    console.error(`No apps found under ${path.join(opts.dataDir, 'apps')}`);
    process.exit(1);
  }
  console.log(`Pre-rendering ${apps.length} app(s) from ${opts.origin} -> ${opts.dataDir}/apps/*/ssr.html (concurrency=${opts.concurrency})`);

  const results = [];
  let idx = 0;

  const workers = Array.from({ length: Math.min(opts.concurrency, apps.length) }, async () => {
    while (idx < apps.length) {
      const app = apps[idx++];
      const res = await prerenderApp(context, app, opts);
      results.push(res);
      const tag = res.ok ? `OK (${res.bytes}B, ${res.nodes} nodes${res.isShadow ? ', shadow' : ''})` : `SKIP (${res.reason})`;
      console.log(`  [${results.length}/${apps.length}] ${app.slug}: ${tag}`);
    }
  });
  await Promise.all(workers);
  await browser.close();

  // Clear cached page-meta files so PHP picks up fresh ssr.html snapshots immediately.
  const cacheDir = path.join(opts.dataDir, 'page-cache');
  if (fs.existsSync(cacheDir)) {
    for (const f of fs.readdirSync(cacheDir)) {
      if (f.endsWith('.json')) fs.rmSync(path.join(cacheDir, f), { force: true });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nCaptured live SSR snapshots: ${okCount}/${apps.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
