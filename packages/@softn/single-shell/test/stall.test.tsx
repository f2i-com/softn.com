// @vitest-environment jsdom
/**
 * A slow download is not a stalled one.
 *
 * The page gave the whole load sixty seconds, so a bundle of a few megabytes
 * on a slow connection failed every time, however steadily it was arriving,
 * and "Try again" repeated it; its details read "signal is aborted without
 * reason". The deadline is now for the download to stop: it starts again
 * with every piece that arrives, and a download that stops for a minute
 * fails, saying so.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

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
import { SingleApp } from '../src/SingleApp';
import { fetchBytes } from '../src/config';

const base = 'https://example.test/nested/runtime.config.json';
const bundle = zipSync({
  'manifest.json': strToU8(JSON.stringify({ name: 'Example', main: 'main.ui', files: { ui: ['main.ui'] } })),
  'main.ui': strToU8('<div>Hello</div>'),
  'permission.json': strToU8('{"permissions":{}}'),
  // Something to send in pieces.
  'padding.bin': new Uint8Array(4096).map((_, i) => (i * 31) % 251),
}, { level: 0 });

/**
 * The bundle as a body that sends a piece every `gap` milliseconds, stopping
 * after `pieces` of them. Aborting the request errors the body, as fetch does.
 */
function trickle(gap: number, pieces: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const size = Math.ceil(bundle.length / 4);
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
          if (finished || sent >= pieces) return; // stalls: never answers again
          const piece = bundle.subarray(sent * size, (sent + 1) * size);
          sent++;
          if (piece.length > 0) controller.enqueue(piece);
          if (sent * size >= bundle.length) {
            finished = true;
            controller.close();
          }
          resolve();
        }, gap);
      });
    },
  });
}

function serve(body: (signal?: AbortSignal) => ReadableStream<Uint8Array>) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
    url === base
      ? new Response(JSON.stringify({ version: 1, id: 'sample', title: 'Example', bundle: 'app.softn' }))
      : new Response(body(init?.signal ?? undefined))
  );
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

async function run(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 5000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  }
}

it('opens an app whose bundle takes three minutes to arrive, a piece every 50 seconds', async () => {
  serve((signal) => trickle(50_000, 4, signal));
  root = createRoot(element);
  await act(async () => root!.render(<SingleApp source={{ configUrl: base }} />));
  await run(200_000);
  // Let the steps after the download (hashing, unpacking) finish on the real event loop.
  for (let i = 0; i < 200 && !element.querySelector('[data-app], [role="alert"]'); i++) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  expect(element.querySelector('[role="alert"]')).toBeNull();
  expect(element.querySelector('[data-app]')).not.toBeNull();
});

it('fails a download that stops, after a minute with nothing arriving, and says so', async () => {
  serve((signal) => trickle(1000, 1, signal));
  root = createRoot(element);
  await act(async () => root!.render(<SingleApp source={{ configUrl: base }} />));
  await run(55_000);
  expect(element.querySelector('[role="alert"]')).toBeNull();
  await run(10_000);
  expect(element.querySelector('h1')?.textContent).toBe('Unable to open this application');
  expect(element.querySelector('details p')?.textContent).toMatch(/stopped/i);
});

it('reports each piece of a download as it arrives', async () => {
  vi.stubGlobal('fetch', async () => new Response(trickle(10, 4)));
  const arrived: number[] = [];
  const reading = fetchBytes('https://example.test/app.softn', new AbortController().signal, 1 << 20, 'no-store', () => arrived.push(arrived.length));
  await vi.advanceTimersByTimeAsync(100);
  expect((await reading).length).toBe(bundle.length);
  expect(arrived.length).toBeGreaterThanOrEqual(4);
});

/**
 * A body that sends one byte every `gap` milliseconds for as long as it is
 * read: never stalled for a minute, and never done.
 */
function drip(gap: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
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
          if (finished) return;
          controller.enqueue(bundle.subarray(sent, sent + 1));
          sent++;
          resolve();
        }, gap);
      });
    },
  });
}

// One byte every 59 seconds kept the minute from ever running out, and the
// page said "loading" for as long as the 32 MB cap allowed: years. The whole
// download now has a ceiling as well, long enough for a real slow connection.
it('stops a download that never stalls and never finishes, at the ceiling, and says so', async () => {
  serve((signal) => drip(59_000, signal));
  root = createRoot(element);
  await act(async () => root!.render(<SingleApp source={{ configUrl: base }} />));
  await run(29 * 60_000);
  expect(element.querySelector('[role="alert"]')).toBeNull();
  await run(2 * 60_000);
  expect(element.querySelector('h1')?.textContent).toBe('Unable to open this application');
  expect(element.querySelector('details p')?.textContent).toMatch(/30 minutes/);
});
