import { afterEach, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
vi.mock('../../softn-web/src/lib/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
import { loadApplication } from '../src/load';
const base = 'https://example.test/nested/runtime.config.json';
function bundle(permission = '{"permissions":{}}') {
  return zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        name: 'Example',
        main: 'main.ui',
        files: { ui: ['main.ui'], logic: [], xdb: [] },
      })
    ),
    'main.ui': strToU8('<App><Text>Hello</Text></App>'),
    'permission.json': strToU8(permission),
  });
}
afterEach(() => vi.unstubAllGlobals());
it.each(['assets/icon.svg', 'assets/icon.png', 'assets/icon.ico'])(
  'extracts a bundled favicon from %s',
  async (icon) => {
    const image = strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const bytes = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          name: 'Icon example',
          main: 'main.ui',
          icon,
          files: { ui: ['main.ui'], logic: [], xdb: [] },
        })
      ),
      'main.ui': strToU8('<App><Text>Example</Text></App>'),
      [icon]: image,
    });
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
    expect(app.icon).toMatch(/^data:image\/(svg\+xml|png|x-icon);base64,/);
    app.assets.dispose();
  }
);
it.each(['https://example.test/icon.svg', '../icon.svg', 'missing.png', 'assets/icon.html', 7])(
  'ignores an unavailable or unsupported icon: %s',
  async (icon) => {
    const bytes = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          name: 'Icon example',
          main: 'main.ui',
          icon,
          files: { ui: ['main.ui'], logic: [], xdb: [] },
        })
      ),
      'main.ui': strToU8('<App><Text>Example</Text></App>'),
      'assets/icon.html': strToU8('<script>alert(1)</script>'),
    });
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
    expect(app.icon).toBeUndefined();
    app.assets.dispose();
  }
);
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
it('loads exactly the configured app and composes the source', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    return new Response(
      url === base
        ? JSON.stringify({ version: 1, id: 'sample', title: 'Example', bundle: 'app.softn' })
        : bundle()
    );
  });
  const app = await loadApplication(base, new AbortController().signal);
  expect(calls).toEqual([base, 'https://example.test/nested/app.softn']);
  expect(app.source).toContain('Hello');
  expect(app.appId).toBe('single:/nested/runtime.config.json:sample');
  app.assets.dispose();
});
it('rejects invalid permission JSON instead of launching with broad access', async () => {
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(
        url === base
          ? JSON.stringify({ version: 1, id: 'sample', title: 'Example', bundle: 'app.softn' })
          : bundle('{bad')
      )
  );
  await expect(loadApplication(base, new AbortController().signal)).rejects.toThrow();
});
it('rejects an app that does not match the configured hash', async () => {
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(
        url === base
          ? JSON.stringify({
              version: 1,
              id: 'sample',
              title: 'Example',
              bundle: 'app.softn',
              sha256: '0'.repeat(64),
            })
          : bundle()
      )
  );
  await expect(loadApplication(base, new AbortController().signal)).rejects.toThrow('integrity');
});
