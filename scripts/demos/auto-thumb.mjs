#!/usr/bin/env node
/**
 * Automatically boot SoftN apps that are missing a `thumb.*` image inside the
 * SoftN web runtime and save a 1280×800 `thumb.webp` beside their bundle.
 *
 * Works with both flat (`data/apps/<slug>/`) and hierarchical category trees
 * (`data/apps/<category>/[<subcategory>/]<slug>/`).
 *
 * Usage:
 *   node scripts/demos/auto-thumb.mjs --missing
 *   node scripts/demos/auto-thumb.mjs --slug brewdesk-cafe-ops --force
 *   node scripts/demos/auto-thumb.mjs --missing --data apps/softn-api/data --base http://localhost:1420 --limit 10
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { repoRoot as root } from '../lib/paths.mjs';

const DEFAULT_DATA_DIR = path.join(root, 'apps/softn-api/data');
const THUMB_NAMES = ['thumb.webp', 'thumb.png', 'thumb.jpg', 'thumb.jpeg', 'thumb.gif'];
const INTERNAL_DIRS = new Set(['backend-cache', 'backend-data']);

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function parseArgs(argv) {
  const flags = { slugs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--missing') flags.missing = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--slug' && argv[i + 1]) {
      flags.slugs.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      flags[a.slice(2)] = argv[++i];
    }
  }
  return flags;
}

function hasThumb(appDir) {
  return THUMB_NAMES.some((f) => fs.existsSync(path.join(appDir, f)));
}

function hasBundle(appDir) {
  try {
    return fs.readdirSync(appDir).some((f) => !f.startsWith('.') && f.toLowerCase().endsWith('.softn'));
  } catch {
    return false;
  }
}

/** Recursively discover every app folder under data/apps/ (flat, 1-level, or 2-level). */
export function discoverAppDirs(dataDir) {
  const appsRoot = path.join(dataDir, 'apps');
  const found = [];
  if (!fs.existsSync(appsRoot)) return found;

  const visit = (dir, depth) => {
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
        found.push({ slug: ent.name, dir: full });
      } else if (depth < 2) {
        visit(full, depth + 1);
      }
    }
  };
  visit(appsRoot, 0);
  found.sort((a, b) => a.slug.localeCompare(b.slug));
  return found;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = path.join(path.dirname(filePath), `.json-thumb-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

async function findBrowser() {
  const fromEnv = process.env.SOFTN_BROWSER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = BROWSERS.find((p) => fs.existsSync(p));
  if (local) return local;
  try {
    const pw = await import('playwright');
    const exe = pw.chromium.executablePath();
    if (exe && fs.existsSync(exe)) return exe;
  } catch {
    // Playwright not available or no chromium installed.
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((res, rej) => {
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      });
    ws.onerror = (e) => reject(new Error(`CDP WebSocket error: ${e.message ?? e.type}`));
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    };
  });
}

async function launchBrowser(browserPath, width, height) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-autothumb-'));
  const proc = spawn(
    browserPath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let info = null;
  for (let i = 0; i < 80 && !info; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) info = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!info) {
    proc.kill();
    throw new Error('Headless browser did not start');
  }
  const cdp = await connectCdp(info.webSocketDebuggerUrl);

  return {
    async newPage() {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((x) => x.id === targetId);
      const p = await connectCdp(target.webSocketDebuggerUrl);
      await p.send('Page.enable');
      await p.send('Runtime.enable');
      // Capture closed shadow roots (used by Engine 2 Web Containers) so turnkey
      // first-run setup wizards can be auto-completed with demo data before snapping.
      await p.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const orig = Element.prototype.attachShadow;
          const roots = [];
          window.__softnThumbShadows = roots;
          Element.prototype.attachShadow = function (init) {
            const r = orig.call(this, init);
            roots.push(r);
            return r;
          };
        })();`,
      });
      await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      return {
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        async goto(url) {
          await p.send('Page.navigate', { url });
        },
        async eval(expression) {
          const r = await p.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) return null;
          return r.result?.value;
        },
        async click(x, y) {
          await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        },
        async captureWebpBytes() {
          const r = await p.send('Page.captureScreenshot', { format: 'webp', quality: 84 });
          return Buffer.from(r.data, 'base64');
        },
        async screenshotWebp(destFile, existingBytes = null) {
          const bytes = existingBytes ?? (await this.captureWebpBytes());
          const tmp = path.join(path.dirname(destFile), `.thumb-tmp-${process.pid}-${Date.now()}.webp`);
          fs.writeFileSync(tmp, bytes);
          fs.renameSync(tmp, destFile);
        },
        async close() {
          try {
            p.close();
          } catch {
            // ignore
          }
          try {
            await cdp.send('Target.closeTarget', { targetId });
          } catch {
            // ignore
          }
        },
      };
    },
    async close() {
      try {
        await cdp.send('Browser.close');
      } catch {
        // ignore
      }
      proc.kill();
      await new Promise((r) => setTimeout(r, 500));
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/** Wait for a SoftN bundle to finish booting inside /web/?open=...&embed=1 (v1 & v2 closed-shadow containers). */
async function waitForBundlePaint(page, timeoutMs) {
  const started = Date.now();
  let clickedAllow = false;
  let submittedSetup = false;
  let lastBytes = null;
  let stableCount = 0;

  while (Date.now() - started < timeoutMs) {
    const state = await page.eval(`(() => {
      const bodyText = ((document.body && document.body.innerText) || '').trim();
      const lower = bodyText.slice(0, 400).toLowerCase();
      // Check if an embedded permission prompt bar is waiting for "Allow".
      const allowBtn = [...document.querySelectorAll('button')].find((b) => {
        const txt = (b.textContent || '').trim();
        return txt === 'Allow' || txt === 'Allow all' || txt === 'Grant & open';
      });
      const allowRect = allowBtn ? (() => {
        const r = allowBtn.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      })() : null;

      // Detect turnkey business-app first-run setup wizard inside host or closed shadow DOM.
      let hasSetupForm = false;
      let setupReady = false;
      const roots = [document, ...(window.__softnThumbShadows || [])];
      for (const r of roots) {
        if (!r || !r.querySelector) continue;
        const form = r.querySelector('form[data-form="setup"]');
        if (form) {
          hasSetupForm = true;
          const btn = form.querySelector('button[type="submit"]');
          if (btn && !btn.disabled) setupReady = true;
          break;
        }
      }

      const playing = Boolean(document.querySelector('.softn-shell--playing'));
      const runnerEl = document.querySelector('.softn-runner-app');
      const runnerBox = runnerEl ? runnerEl.getBoundingClientRect() : null;
      const hasRunner = Boolean(runnerBox && runnerBox.width >= 200 && runnerBox.height >= 200);

      const hasCanvas = [...document.querySelectorAll('canvas')].some((c) => {
        const r = c.getBoundingClientRect();
        return r.width >= 100 && r.height >= 100;
      });
      const hostLoading = /(loading |starting |unpacking |booting |downloading bundle|installing )/i.test(lower) && bodyText.length < 300;
      const hostError = /(could not open|failed to load|failed to fetch|no app is published|bundle is missing|failed to start)/i.test(lower);
      return {
        allowRect,
        hasSetupForm,
        setupReady,
        playing,
        hasRunner,
        hasCanvas,
        bodyTextLen: bodyText.length,
        loading: hostLoading,
        error: hostError,
      };
    })()`);

    if (state?.allowRect && !clickedAllow) {
      clickedAllow = true;
      await page.click(state.allowRect.x, state.allowRect.y);
      await page.wait(700);
      continue;
    }
    if (state?.hasSetupForm) {
      if (state.setupReady && !submittedSetup) {
        submittedSetup = true;
        await page.eval(`(() => {
          const roots = [document, ...(window.__softnThumbShadows || [])];
          for (const r of roots) {
            if (!r || !r.querySelector) continue;
            const form = r.querySelector('form[data-form="setup"]');
            if (!form) continue;
            const owner = form.querySelector('input[name="owner_name"]');
            if (owner && !owner.value.trim()) {
              owner.value = 'Alex Taylor';
              owner.dispatchEvent(new Event('input', { bubbles: true }));
              owner.dispatchEvent(new Event('change', { bubbles: true }));
            }
            for (const inp of form.querySelectorAll('input[required]')) {
              if (!inp.value.trim() && (inp.type === 'text' || inp.type === '' || inp.type === 'email')) {
                inp.value = inp.type === 'email' ? 'alex@example.com' : 'Demo';
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            const sample = form.querySelector('input[name="load_sample"]');
            if (sample && !sample.checked) {
              sample.checked = true;
              sample.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const btn = form.querySelector('button[type="submit"]');
            if (btn && !btn.disabled) btn.click();
            return true;
          }
          return false;
        })()`);
        lastBytes = null;
        stableCount = 0;
      }
      await page.wait(500);
      continue;
    }
    if (state?.error && Date.now() - started > 3000) {
      return { ok: false, reason: 'App reported a load error' };
    }

    const readyDom =
      state &&
      !state.loading &&
      !state.error &&
      !state.allowRect &&
      !state.hasSetupForm &&
      (state.hasCanvas || state.bodyTextLen > 80 || (state.playing && state.hasRunner));

    if (readyDom) {
      // Hide transient post-setup welcome toasts so thumbnails show the live dashboard cleanly.
      if (submittedSetup) {
        await page.eval(`(() => {
          for (const r of [document, ...(window.__softnThumbShadows || [])]) {
            if (!r || !r.querySelectorAll) continue;
            for (const t of r.querySelectorAll('.k-toast, .k-toasts, .k-toast-wrap, [role="status"]')) {
              if (t && t.style) t.style.display = 'none';
            }
          }
          return true;
        })()`);
      }
      // Probe rendered pixels via CDP so closed-shadow v2 containers are verified as visually painted
      // (a solid blank 1280x800 frame compresses to ~1-2.5 KB in WebP, while painted apps are > 4 KB).
      const bytes = await page.captureWebpBytes();
      const nonBlank = bytes.byteLength > 3800;
      if (nonBlank) {
        if (lastBytes && Math.abs(bytes.byteLength - lastBytes.byteLength) < 1200) {
          stableCount++;
        } else {
          stableCount = 0;
        }
        lastBytes = bytes;
        if (stableCount >= 1 || Date.now() - started > 6000) {
          await page.wait(500);
          return { ok: true, bytes: await page.captureWebpBytes() };
        }
      }
      await page.wait(800);
      continue;
    }
    await page.wait(350);
  }
  if (lastBytes && lastBytes.byteLength > 3800) {
    return { ok: true, bytes: lastBytes };
  }
  return { ok: false, reason: 'Timed out waiting for app to render' };
}

async function captureOne(browser, baseUrl, entry, timeoutMs) {
  const { slug, dir } = entry;
  const appJsonPath = path.join(dir, 'app.json');
  const doc = readJsonSafe(appJsonPath);
  const latestSha = doc?.versions?.[0]?.sha256 || '';
  const openParam = `/api/apps/${encodeURIComponent(slug)}/bundle.softn`;
  const targetUrl = `${baseUrl.replace(/\/$/, '')}/web/?open=${encodeURIComponent(openParam)}&embed=1`;

  const page = await browser.newPage();
  try {
    await page.goto(targetUrl);
    const outcome = await waitForBundlePaint(page, timeoutMs);
    if (!outcome.ok) {
      writeJsonAtomic(path.join(dir, '.auto-thumb.json'), {
        sha256: latestSha,
        status: 'error',
        reason: outcome.reason,
        at: new Date().toISOString(),
      });
      return { slug, ok: false, reason: outcome.reason };
    }

    const thumbPath = path.join(dir, 'thumb.webp');
    await page.screenshotWebp(thumbPath, outcome.bytes ?? null);

    // Update app.json atomically if present so thumbnailKind becomes 'image' immediately.
    const freshDoc = readJsonSafe(appJsonPath);
    if (freshDoc?.app) {
      freshDoc.app.thumb = 'thumb.webp';
      freshDoc.app.updated_at = Math.floor(Date.now() / 1000);
      writeJsonAtomic(appJsonPath, freshDoc);
    }
    writeJsonAtomic(path.join(dir, '.auto-thumb.json'), {
      sha256: latestSha,
      status: 'ok',
      file: 'thumb.webp',
      at: new Date().toISOString(),
    });
    return { slug, ok: true, file: thumbPath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      writeJsonAtomic(path.join(dir, '.auto-thumb.json'), {
        sha256: latestSha,
        status: 'error',
        reason,
        at: new Date().toISOString(),
      });
    } catch {
      // ignore
    }
    return { slug, ok: false, reason };
  } finally {
    await page.close();
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(flags.data || DEFAULT_DATA_DIR);
  const baseUrl = (flags.base || process.env.SOFTN_SITE_URL || 'http://localhost:1420').replace(/\/$/, '');
  const limit = flags.limit ? Math.max(1, Number(flags.limit)) : Infinity;
  const timeoutMs = flags.timeout ? Math.max(4000, Number(flags.timeout)) : 20000;
  const log = (...m) => {
    if (!flags.quiet) console.log('[auto-thumb]', ...m);
  };

  // Verify the site/runtime is reachable before launching a headless browser.
  try {
    const probe = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!probe.ok) {
      log(`API at ${baseUrl}/api/health answered ${probe.status}; skipping.`);
      return;
    }
  } catch (err) {
    log(`Server at ${baseUrl} is not reachable (${err instanceof Error ? err.message : String(err)}); skipping.`);
    return;
  }

  const allApps = discoverAppDirs(dataDir);
  const wanted = new Set(flags.slugs);
  const queue = [];

  for (const entry of allApps) {
    if (wanted.size > 0 && !wanted.has(entry.slug)) continue;
    if (!hasBundle(entry.dir)) continue;
    if (!flags.force && hasThumb(entry.dir)) continue;

    // Skip already-attempted identical bundles unless --force.
    if (!flags.force) {
      const doc = readJsonSafe(path.join(entry.dir, 'app.json'));
      const latestSha = doc?.versions?.[0]?.sha256 || '';
      const marker = readJsonSafe(path.join(entry.dir, '.auto-thumb.json'));
      if (marker && latestSha && marker.sha256 === latestSha) continue;
    }
    queue.push(entry);
    if (queue.length >= limit) break;
  }

  if (queue.length === 0) {
    log('All apps already have thumbnails (nothing to capture).');
    return;
  }

  const browserPath = await findBrowser();
  if (!browserPath) {
    console.error('[auto-thumb] No Chromium/Edge/Chrome executable found. Set SOFTN_BROWSER or install Playwright Chromium.');
    process.exitCode = 1;
    return;
  }

  log(`Capturing ${queue.length} missing thumbnail(s) against ${baseUrl} using ${path.basename(browserPath)}...`);
  const browser = await launchBrowser(browserPath, 1280, 800);
  let captured = 0;
  let failed = 0;
  try {
    for (const entry of queue) {
      const res = await captureOne(browser, baseUrl, entry, timeoutMs);
      if (res.ok) {
        captured++;
        log(`OK   ${res.slug} -> thumb.webp`);
      } else {
        failed++;
        log(`SKIP ${res.slug} (${res.reason})`);
      }
    }
  } finally {
    await browser.close();
    const lockFile = path.join(dataDir, '.auto-thumb.lock');
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // ignore
      }
    }
  }
  log(`Done: ${captured} captured, ${failed} skipped.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  main().catch((err) => {
    console.error('[auto-thumb]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
