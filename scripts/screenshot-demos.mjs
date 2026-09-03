#!/usr/bin/env node
/**
 * Photograph every demo bundle, so the directory's cards show the app and
 * not its icon.
 *
 *   node scripts/screenshot-demos.mjs [--base http://localhost:1420] [--only Name,Name]
 *
 * Opens each bundle from apps/softn-web/public/demos/index.json in the web
 * runtime (a dev server or a built site; the default is `npm run dev:web`,
 * but apps that run their script in a worker only start on a built site,
 * so pass --base http://127.0.0.1:5500/web for those),
 * in headless Edge or Chrome, follows a short per-app recipe where a title
 * screen needs a click or a keypress, and writes a 1280×800 WebP to
 * apps/softn-web/public/demos/thumbs/<Name>.webp. The site build copies the
 * folder beside the bundles, and the directory's seed attaches each picture
 * to its app.
 *
 * No dependencies: Node 22's global WebSocket talks the DevTools protocol.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demosDir = path.join(root, 'apps/softn-web/public/demos');
const outDir = path.join(demosDir, 'thumbs');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const base = flag('--base', 'http://localhost:1420').replace(/\/$/, '');
const only = flag('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

/**
 * What to do after the app has loaded, before the picture. `click` finds a
 * button by its text; `key` presses one; `set` assigns window globals the
 * app's logic reads (the games' input latches); `wait` is milliseconds.
 * Anything unlisted gets a plain capture after a settling pause.
 */
const RECIPES = {
  Blockscape: [
    { click: 'New island' },
    { set: { __scene3dLocked: true, __scene3dPitch: -0.18 } },
    { key: 'w', hold: 900 },
    { wait: 700 },
  ],
  DeadHours: [{ click: 'Allow' }, { click: 'Start the night' }, { set: { __scene3dLocked: true } }, { wait: 11000 }, { set: { __dhFire: true } }, { wait: 250 }],
  Twenty48: [{ key: 'ArrowLeft' }, { key: 'ArrowUp' }, { key: 'ArrowRight' }, { key: 'ArrowDown' }, { key: 'ArrowLeft' }, { key: 'ArrowUp' }, { key: 'ArrowRight' }, { wait: 400 }],
  Blockfall: [{ click: 'Start' }, { wait: 500 }, { key: 'ArrowLeft' }, { key: ' ' }, { wait: 500 }, { key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: ' ' }, { wait: 500 }, { key: 'ArrowUp' }, { key: ' ' }, { wait: 1200 }],
  SnakeGame: [{ click: 'Start Game' }, { wait: 1800 }],
  MazeEscape3D: [{ click: 'Start Game' }, { wait: 800 }],
  PromptlyUnemployed: [{ wait: 2500 }],
  Pocket: [{ wait: 2500 }],
  TexasHoldem: [{ wait: 2500 }],
  TheOffice: [{ wait: 3000 }],
};

const KEYS = {
  ' ': ['Space', 32],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40],
  Enter: ['Enter', 13],
};

function findBrowser() {
  const fromEnv = process.env.SOFTN_BROWSER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return BROWSERS.find((p) => fs.existsSync(p)) ?? null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((res, rej) => {
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        on(method, fn) {
          handlers.set(method, fn);
        },
        close() {
          ws.close();
        },
      });
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message ?? e.type}`));
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method && handlers.has(msg.method)) handlers.get(msg.method)(msg.params);
    };
  });
}

async function launch(browser, port, width, height) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-shots-'));
  const proc = spawn(
    browser,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let info = null;
  for (let i = 0; i < 100 && !info; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!info) {
    proc.kill();
    throw new Error('The browser did not start');
  }
  const cdp = await connect(info.webSocketDebuggerUrl);
  return {
    async page() {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.id === targetId);
      const p = await connect(t.webSocketDebuggerUrl);
      await p.send('Page.enable');
      await p.send('Runtime.enable');
      await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      return {
        raw: p,
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        async goto(url) {
          await p.send('Page.navigate', { url });
        },
        async eval(expression) {
          const r = await p.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
        async click(x, y) {
          await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        },
        async key(key, holdMs = 0) {
          const [code, vk] = KEYS[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
          await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
          if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
          await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
        },
        async shot(file) {
          const r = await p.send('Page.captureScreenshot', { format: 'webp', quality: 84 });
          fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        },
        close: () => cdp.send('Target.closeTarget', { targetId }),
      };
    },
    async close() {
      try {
        await cdp.send('Browser.close');
      } catch {
        // Already gone.
      }
      proc.kill();
      // The browser lets go of its profile a beat after it exits.
      await new Promise((r) => setTimeout(r, 800));
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        // A stray temp profile is not worth failing the run over.
      }
    },
  };
}

async function waitForApp(page, timeoutMs) {
  // The runtime marks the shell when the app has painted; failing that, a
  // canvas or the app root appearing is close enough.
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await page.eval(
      `(() => { const t = document.body.innerText || ''; const hasCanvas = !!document.querySelector('canvas'); const loading = /Loading|Starting|Unpacking/i.test(t.slice(0, 200)); return (hasCanvas || t.length > 40) && !loading; })()`
    );
    if (ready) return true;
    await page.wait(250);
  }
  return false;
}

async function runRecipe(page, steps) {
  for (const step of steps) {
    if (step.click) {
      const rect = await page.eval(
        `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(step.click)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
      );
      if (rect) {
        await page.click(rect.x, rect.y);
        await page.wait(500);
      }
    } else if (step.key) {
      await page.key(step.key, step.hold ?? 0);
      await page.wait(step.hold ? 150 : 90);
    } else if (step.set) {
      await page.eval(`(() => { const s = ${JSON.stringify(step.set)}; for (const k of Object.keys(s)) window[k] = s[k]; return true; })()`);
      await page.wait(120);
    } else if (step.wait) {
      await page.wait(step.wait);
    }
  }
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-based browser found; set SOFTN_BROWSER to one.');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(path.join(demosDir, 'index.json'), 'utf8'));
  const list = index.filter((e) => only.length === 0 || only.includes(e.file.replace(/\.softn$/, '')));
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await fetch(`${base}/`);
  } catch {
    console.error(`Nothing answers at ${base}. Start the runtime (npm run dev:web) or pass --base.`);
    process.exit(1);
  }
  const b = await launch(browser, 9400 + Math.floor(Math.random() * 100), 1280, 800);
  let failures = 0;
  for (const entry of list) {
    const name = entry.file.replace(/\.softn$/, '');
    const page = await b.page();
    const t0 = Date.now();
    try {
      await page.goto(`${base}/?open=/demos/${entry.file}&embed=1`);
      const ready = await waitForApp(page, 25000);
      await page.wait(ready ? 900 : 0);
      await runRecipe(page, RECIPES[name] ?? [{ wait: 1500 }]);
      // A frame that shows the runtime's own error card is not a picture of
      // the app. Apps that run in a worker cannot start on the Vite dev
      // server (its worker URL differs); photograph those against a built
      // site: --base http://127.0.0.1:5500/web
      const failed = await page.eval(`/worker_error|Failed to load|could not be loaded/i.test(document.body.innerText.slice(0, 400))`);
      if (failed) throw new Error('the runtime shows an error card instead of the app');
      const file = path.join(outDir, `${name}.webp`);
      await page.shot(file);
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`${name.padEnd(20)} ${kb} KB  (${((Date.now() - t0) / 1000).toFixed(1)}s${ready ? '' : ', app was not confirmed ready'})`);
    } catch (err) {
      failures++;
      console.error(`${name.padEnd(20)} FAILED: ${err instanceof Error ? err.message : err}`);
    } finally {
      await page.close();
    }
  }
  await b.close();
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
