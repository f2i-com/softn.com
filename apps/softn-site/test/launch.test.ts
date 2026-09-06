/**
 * Pressing Play must go, whatever the run counter does.
 *
 * Play used to navigate in the run-count request's `.finally()`, so a
 * `/runs` endpoint that hung, failed or was offline was a Play button that
 * did nothing for as long as the request stayed pending. What is pinned
 * here: the launch does not wait on the count, does not fail with it, and
 * still counts when it can.
 */

import { describe, expect, it, vi } from 'vitest';
import { launchApp } from '../src/lib/launch';
import { recordRun } from '../src/lib/api';

describe('launchApp', () => {
  it('navigates at once while the count is still pending', () => {
    const go = vi.fn();
    // A record that never settles: the count endpoint is hanging.
    const record = vi.fn(() => {
      void new Promise(() => {});
    });
    launchApp('notes', { record, go });
    expect(record).toHaveBeenCalledWith('notes');
    expect(go).toHaveBeenCalledTimes(1);
    // The runtime's address for the app, with the way back to its page.
    expect(go.mock.calls[0][0]).toMatch(/\/app\/notes(\?|$)/);
  });

  it('navigates when counting throws', () => {
    const go = vi.fn();
    const record = vi.fn(() => {
      throw new Error('no fetch here');
    });
    launchApp('notes', { record, go });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('records before it goes, so the count is started while the page is still here', () => {
    const order: string[] = [];
    launchApp('notes', { record: () => order.push('record'), go: () => order.push('go') });
    expect(order).toEqual(['record', 'go']);
  });
});

describe('recordRun', () => {
  it('starts a keepalive request and returns without waiting on it', () => {
    let resolveFetch: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const returned = recordRun('notes') as unknown;
      expect(returned).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/apps/notes/runs');
      expect(init.method).toBe('POST');
      expect(init.keepalive).toBe(true);
      resolveFetch?.({ ok: true } as Response);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('swallows a failed request and a fetch that throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    try {
      expect(() => recordRun('notes')).not.toThrow();
      await Promise.resolve();
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('blocked');
      })
    );
    try {
      expect(() => recordRun('notes')).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
