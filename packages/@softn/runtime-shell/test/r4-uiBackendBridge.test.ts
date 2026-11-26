/**
 * A classic app's embedded backend, started by its first request: one that
 * failed to start is stopped, and a start the bridge was disposed during
 * cannot make the bridge forget the start after it.
 *
 * - A backend whose worker failed to start was never disposed, and the next
 *   request started another: a worker kept for every request after a failure.
 * - The failed start of a disposed bridge cleared the bridge's note of the
 *   start made after it was activated again, so the request after that started
 *   a third backend: two ran, and the one forgotten was never stopped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Started {
  ready: Promise<void>;
  fail(error: Error): void;
  succeed(): void;
  disposed: boolean;
}

const started: Started[] = [];
let failNext = false;

vi.mock('@softn/container', () => {
  class LocalBackendTransport {
    readonly ready: Promise<void>;
    private resolveReady!: () => void;
    private rejectReady!: (error: Error) => void;
    readonly record: Started;
    constructor() {
      this.ready = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.ready.catch(() => {});
      const record: Started = {
        ready: this.ready,
        fail: (error) => this.rejectReady(error),
        succeed: () => this.resolveReady(),
        disposed: false,
      };
      this.record = record;
      started.push(record);
      if (failNext) {
        failNext = false;
        queueMicrotask(() => record.fail(new Error('the backend did not start')));
      }
    }
    dispose(): void {
      this.record.disposed = true;
      this.rejectReady(new Error('LocalBackendTransport disposed'));
    }
    async fetch() {
      return { status: 200, statusText: 'OK', headers: [] as Array<[string, string]>, body: new TextEncoder().encode('{"ok":true}') };
    }
  }
  return {
    LocalBackendTransport,
    buildBackendRoutingConfig: () => ({}),
    matchBackendTarget: (url: string) => ({ path: url, query: '' }),
    statusTextFor: () => 'OK',
  };
});

const { createUiBackendBridge } = await import('../src/uiBackendBridge');

const manifest = {
  name: 'UI + PHP',
  main: 'ui/main.ui',
  backend: { runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/'] },
};

function bridge() {
  const made = createUiBackendBridge({ appId: 'r4-ui-backend', manifest, textFiles: {}, runtimeUrl: 'https://example.test/runtime/', isolation: 'inline' });
  if (!made) throw new Error('no bridge');
  return made;
}

/** Let the bridge's own steps (the container's import, the transport's construction) run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  started.length = 0;
  failNext = false;
});

describe('an embedded backend', () => {
  it('that failed to start is stopped, and the next request starts one in its place', async () => {
    const b = bridge();
    try {
      failNext = true;
      await expect(b.netFetchHandler('/api/notes', { method: 'GET' })).rejects.toThrow(/did not start/);
      expect(started).toHaveLength(1);
      expect(started[0].disposed).toBe(true);

      const second = b.netFetchHandler('/api/notes', { method: 'GET' });
      await settle();
      expect(started).toHaveLength(2);
      started[1].succeed();
      await expect(second).resolves.toMatchObject({ ok: true, status: 200 });
      expect(started[1].disposed).toBe(false);
    } finally {
      b.dispose();
    }
  });

  it('started after a disposal is the one kept, and the one stopped with the bridge', async () => {
    const b = bridge();
    const first = b.netFetchHandler('/api/notes', { method: 'GET' });
    first.catch(() => {});
    await settle();
    expect(started).toHaveLength(1);

    // Put away and back while the first start waits (React's StrictMode does this).
    b.dispose();
    b.activate();
    const second = b.netFetchHandler('/api/notes', { method: 'GET' });
    await settle();
    expect(started).toHaveLength(2);
    started[1].succeed();
    await expect(second).resolves.toMatchObject({ ok: true });
    await expect(first).rejects.toThrow();

    // A later request is answered by the backend that is running.
    await expect(b.netFetchHandler('/api/notes', { method: 'GET' })).resolves.toMatchObject({ ok: true });
    expect(started).toHaveLength(2);

    b.dispose();
    expect(started.every((transport) => transport.disposed)).toBe(true);
  });
});
