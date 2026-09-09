import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../softn-web/src/lib/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
import { loadServedApplication, parsePack } from '../src/load';

const base = 'https://example.test/games/';
const digest = 'a'.repeat(64);

function pack(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: 'sample',
    title: 'Example',
    theme: 'dark',
    loadingText: 'Loading…',
    permissionMode: 'prompt',
    digest,
    manifest: {
      name: 'Example',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets: ['images/a.png'] },
      config: { execution: 'worker' },
    },
    declared: null,
    text: {
      'ui/main.ui':
        '<logic src="../logic/main.logic" />\n<App><Image src={asset("images/a.png")} /></App>',
      'logic/main.logic':
        'let sampleClicks = 0\nfunction increment() { sampleClicks = sampleClicks + 1 }',
      'permission.json': '{"permissions":{"net":{"enabled":true}}}',
    },
    entries: { 'images/a.png': 300 },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

function serve(body: unknown, calls: string[] = []) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect(init?.credentials).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    return new Response(JSON.stringify(body));
  });
  return calls;
}

it('fetches exactly the source pack and composes the app from it', async () => {
  const calls = serve(pack());
  const app = await loadServedApplication('/games/index.php', base, new AbortController().signal);
  expect(calls).toEqual(['https://example.test/games/index.php?source']);
  expect(app.source).toContain('let sampleClicks = 0');
  expect(app.source).toContain('function increment()');
  expect(app.appId).toBe('served:/games/index.php:sample');
  expect(app.execution).toBe('worker');
  expect(app.config).toEqual({
    title: 'Example',
    theme: 'dark',
    loadingText: 'Loading…',
    permissionMode: 'prompt',
  });
  expect(app.declared).toEqual({ permissions: { net: { enabled: true } } });
  expect(app.grantKey).toMatch(/^single-grant:[a-f0-9]{64}$/);
  expect(app.textFiles.has('ui/main.ui')).toBe(true);
  expect(app.assets('images/a.png')).toBe('/games/index.php?entry=images/a.png');
  expect(app.assets('images/b.png')).toBe('');
  app.assets.dispose();
});

it('prefers the operator sidecar over the bundle declaration', async () => {
  serve(pack({ declared: { permissions: { camera: { enabled: true } } } }));
  const app = await loadServedApplication('/games/index.php', base, new AbortController().signal);
  expect(app.declared).toEqual({ permissions: { camera: { enabled: true } } });
  app.assets.dispose();
});

it('falls back to the legacy manifest declaration without a permission.json', async () => {
  const p = pack();
  delete (p.text as Record<string, string>)['permission.json'];
  (p.manifest as Record<string, unknown>).permissions = { network: true, filesystem: false };
  serve(p);
  const app = await loadServedApplication('/games/index.php', base, new AbortController().signal);
  expect(app.declared).toEqual({ permissions: { net: { enabled: true }, files: undefined } });
  app.assets.dispose();
});

it('scopes the consent key to the endpoint, the bundle digest and the declaration', async () => {
  serve(pack());
  const first = await loadServedApplication('/games/index.php', base, new AbortController().signal);
  serve(pack({ digest: 'b'.repeat(64) }));
  const second = await loadServedApplication(
    '/games/index.php',
    base,
    new AbortController().signal
  );
  serve(pack());
  const third = await loadServedApplication('/other/index.php', base, new AbortController().signal);
  expect(first.grantKey).not.toBe(second.grantKey);
  expect(first.grantKey).not.toBe(third.grantKey);
  for (const app of [first, second, third]) app.assets.dispose();
});

it('stops on a malformed bundle declaration instead of treating it as absent', async () => {
  serve(pack({ text: { ...pack().text, 'permission.json': '{"permissions":{"teleport":{}}}' } }));
  await expect(
    loadServedApplication('/games/index.php', base, new AbortController().signal)
  ).rejects.toThrow('Invalid permission declaration');
});

it.each([
  ['https://other.test/index.php', 'another origin'],
  ['/games/index.php?x=1', 'a query'],
])('refuses %s (%s) as an endpoint', async (endpoint) => {
  serve(pack());
  await expect(
    loadServedApplication(endpoint, base, new AbortController().signal)
  ).rejects.toThrow();
});

it.each<[Record<string, unknown>, string]>([
  [{ version: 2 }, 'version'],
  [{ id: 'Not Valid' }, 'id'],
  [{ theme: 'blue' }, 'theme'],
  [{ digest: 'xyz' }, 'digest'],
  [{ manifest: { name: 'x' } }, 'manifest'],
  [{ text: { '../escape.ui': '' } }, 'text name'],
  [{ entries: { 'images/a.png': -1 } }, 'entry size'],
  [{ entries: { 'ui/main.ui': 3 } }, 'entry that is also text'],
  [{ extra: 1 }, 'unknown key'],
])('refuses a pack with a bad %j (%s)', (override) => {
  expect(() => parsePack(pack(override))).toThrow();
});

it('refuses a pack whose main file is not in the text', async () => {
  serve(pack({ manifest: { ...pack().manifest, main: 'ui/missing.ui' } }));
  await expect(
    loadServedApplication('/games/index.php', base, new AbortController().signal)
  ).rejects.toThrow('Invalid application manifest');
});
