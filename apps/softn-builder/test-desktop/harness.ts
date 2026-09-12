import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

export const appRoot = path.resolve(import.meta.dirname, '..');
export const origin = 'https://builder-desktop.test';
const types: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

/** Actual compiled frontend and CSP; only native OS/file calls are mocked. */
export async function openDesktopBuild(page: Page, surface: 'builder' | 'runtime', bundle: Uint8Array, simulatePreviousConfig = false): Promise<string[]> {
  const root = surface === 'builder' ? appRoot : path.resolve(appRoot, '../softn-loader');
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const assetsRoot = path.resolve(root, 'src-tauri', config.build.frontendDist);
  const disabled = config.app.security.dangerousDisableAssetCspModification ?? [];
  const modifyStyles = simulatePreviousConfig || !disabled.includes('style-src');
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('style-src')) violations.push(message.text());
  });
  if (surface === 'runtime') {
    await page.addInitScript((bytes) => {
      const invoke = async (command: string, args?: { record?: unknown }) => {
        if (command === 'get_opened_file') return 'C:\\Examples\\Desktop-example.softn';
        if (command === 'read_softn_bundle') return bytes;
        if (command === 'get_collections' || command === 'get_collection') return [];
        if (command === 'upsert_record') return args?.record;
        if (command === 'plugin:event|listen') return 1;
        return null;
      };
      Object.assign(window, {
        __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } },
        __TAURI_INTERNALS__: {
          invoke, transformCallback: () => 1,
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      });
    }, [...bundle]);
  }
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/example.softn') {
      await route.fulfill({ body: Buffer.from(bundle), contentType: 'application/zip' });
      return;
    }
    const file = path.resolve(assetsRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!file.startsWith(`${assetsRoot}${path.sep}`)) { await route.abort(); return; }
    let bytes: Buffer;
    try { bytes = await readFile(file); } catch { await route.fulfill({ status: 404 }); return; }
    if (path.extname(file) === '.html') {
      let html = bytes.toString('utf8').replace(/<script\b/g, '<script nonce="desktop-script"');
      let csp: string = config.app.security.csp.replace(/(script-src[^;]*)/, "$1 'nonce-desktop-script'");
      if (modifyStyles && /<style\b/.test(html)) {
        html = html.replace(/<style\b/g, '<style nonce="desktop-style"');
        csp = csp.replace(/(style-src[^;]*)/, "$1 'nonce-desktop-style'");
      }
      await route.fulfill({ body: html, contentType: 'text/html', headers: { 'Content-Security-Policy': csp } });
    } else {
      await route.fulfill({ body: bytes, contentType: types[path.extname(file)] ?? 'application/octet-stream' });
    }
  });
  await page.goto(`${origin}/${surface === 'builder' ? '?open=/example.softn' : ''}`);
  return violations;
}
