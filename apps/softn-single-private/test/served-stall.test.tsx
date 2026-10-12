// @vitest-environment jsdom
/**
 * The privately served page waits for its source pack to stop arriving, not
 * to finish, as the shell's own page does (single-shell's stall.test.tsx).
 *
 * It gave the whole load sixty seconds: a pack of a few megabytes on a slow
 * connection failed every time, however steadily it arrived. The minute now
 * starts over with every piece, and a pack that stops arriving for a minute
 * fails, saying so.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@softn/components/theme', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@softn/core', async (original) => ({
  ...(await original<object>()),
  SoftNWithXDB: () => <p data-app="true">The app</p>,
}));
vi.mock('@softn/runtime-shell/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
vi.mock('@softn/brand', () => ({ Mark: () => null }));
import { ServedApp } from '../src/ServedApp';

const pack = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    id: 'sample',
    title: 'Example',
    theme: 'dark',
    loadingText: 'Loading…',
    permissionMode: 'prompt',
    digest: 'a'.repeat(64),
    manifest: { name: 'Example', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } },
    declared: null,
    text: { 'ui/main.ui': '<App><Text>Hello</Text></App>', 'permission.json': '{"permissions":{}}', 'notes.txt': 'x'.repeat(4096) },
    entries: {},
  })
);

/** The pack as a body sending a quarter every `gap` ms, stopping after `pieces`; aborting errors it, as fetch does. */
function trickle(gap: number, pieces: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const size = Math.ceil(pack.length / 4);
  let sent = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        if (finished) return;
        finished = true;
        controller.error(signal.reason);
      }, { once: true });
    },
    pull(controller) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (finished || sent >= pieces) return;
          controller.enqueue(pack.subarray(sent * size, (sent + 1) * size));
          sent++;
          if (sent * size >= pack.length) {
            finished = true;
            controller.close();
          }
          resolve();
        }, gap);
      });
    },
  });
}

const element = document.createElement('div');
document.body.append(element);
let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function serve(gap: number, pieces: number) {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => new Response(trickle(gap, pieces, init?.signal ?? undefined)));
}

async function run(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 5000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  }
}

const boot = { version: 1 as const, endpoint: '/games/index.php', loadingText: 'Loading…' };

it('opens an app whose pack takes three minutes to arrive, a piece every 50 seconds', async () => {
  serve(50_000, 4);
  root = createRoot(element);
  await act(async () => root!.render(<ServedApp boot={boot} />));
  await run(200_000);
  for (let i = 0; i < 200 && !element.querySelector('[data-app], [role="alert"]'); i++) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  expect(element.querySelector('[role="alert"]')).toBeNull();
  expect(element.querySelector('[data-app]')).not.toBeNull();
});

it('fails a pack that stops arriving, after a minute with nothing, and says so', async () => {
  serve(1000, 1);
  root = createRoot(element);
  await act(async () => root!.render(<ServedApp boot={boot} />));
  await run(55_000);
  expect(element.querySelector('[role="alert"]')).toBeNull();
  await run(10_000);
  expect(element.querySelector('h1')?.textContent).toBe('Unable to open this application');
  expect(element.querySelector('details p')?.textContent).toMatch(/stopped/i);
});
