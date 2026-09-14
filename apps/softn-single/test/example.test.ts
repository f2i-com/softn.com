/**
 * The repository sample this app ships (scripts/example.mjs writes it into
 * public/ when no bundle is there) opens through the shared shell with its
 * handler and state in the composed source.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
vi.mock('@softn/web/src/lib/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
import { loadApplication } from '@softn/single-shell';
const base = 'https://example.test/nested/runtime.config.json';
afterEach(() => vi.unstubAllGlobals());
it('ships a sample whose event handler and state are included in the composed source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'single-example-'));
  try {
    mkdirSync(join(dir, 'public'));
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../scripts/example.mjs', import.meta.url))],
      { cwd: dir }
    );
    const bytes = new Uint8Array(readFileSync(join(dir, 'public/app.softn')));
    vi.stubGlobal(
      'fetch',
      async (url: string) =>
        new Response(
          url === base
            ? JSON.stringify({ version: 1, id: 'sample', title: 'Example', bundle: 'app.softn' })
            : bytes
        )
    );
    const app = await loadApplication(base, new AbortController().signal);
    expect(app.source).toContain('let sampleClicks = 0');
    expect(app.source).toContain('function increment()');
    app.assets.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
