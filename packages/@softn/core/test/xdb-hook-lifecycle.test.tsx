import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDataBlock } from '../src/loader/SoftNRenderer';
import { parse } from '../src/parser';
import { getXDB } from '../src/runtime/xdb';
import type { SoftNDocument } from '../src/parser/ast';
import type { XDBRecord } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const documentWithData = parse(`
  <data><collection name="items" as="items" /></data>
  <div>ready</div>
`);

function DataProbe({
  document,
  appId,
  onRefresh,
}: {
  document: SoftNDocument | null;
  appId: string;
  onRefresh?: (refresh: () => void) => void;
}) {
  const { data, refresh } = useDataBlock(document, appId);
  onRefresh?.(refresh);
  return <span>{String(data.items?.[0]?.data.label ?? '')}</span>;
}

function record(label: string): XDBRecord {
  const timestamp = '2026-08-04T00:00:00.000Z';
  return {
    id: `id-${label}`,
    collection: 'items',
    data: { label },
    created_at: timestamp,
    updated_at: timestamp,
    deleted: false,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDataBlock lifecycle', () => {
  it('ignores an initial fetch that resolves after its app namespace is replaced', async () => {
    const appA = getXDB('HookInitialLifecycleA');
    const appB = getXDB('HookInitialLifecycleB');
    const staleInitialFetch = deferred<XDBRecord[]>();
    vi.spyOn(appA, 'isP2PAvailable').mockReturnValue(true);
    vi.spyOn(appA, 'getAllAsync').mockReturnValue(staleInitialFetch.promise);
    vi.spyOn(appB, 'isP2PAvailable').mockReturnValue(true);
    vi.spyOn(appB, 'getAllAsync').mockResolvedValue([record('App B')]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<DataProbe document={documentWithData} appId="HookInitialLifecycleA" />);
      });

      await act(async () => {
        root.render(<DataProbe document={documentWithData} appId="HookInitialLifecycleB" />);
      });
      await settle();
      expect(container.textContent).toBe('App B');

      await act(async () => {
        staleInitialFetch.resolve([record('Stale App A')]);
        await staleInitialFetch.promise;
        await Promise.resolve();
      });
      expect(container.textContent).toBe('App B');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('cannot retain another app namespace when record signatures happen to match', async () => {
    const timestamp = '2026-08-04T00:00:00.000Z';
    getXDB('HookLifecycleA').writeRecord('items', {
      id: 'same-id',
      collection: 'items',
      data: { label: 'App A' },
      created_at: timestamp,
      updated_at: timestamp,
      deleted: false,
    });
    getXDB('HookLifecycleB').writeRecord('items', {
      id: 'same-id',
      collection: 'items',
      data: { label: 'App B' },
      created_at: timestamp,
      updated_at: timestamp,
      deleted: false,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<DataProbe document={documentWithData} appId="HookLifecycleA" />);
      });
      await settle();
      expect(container.textContent).toBe('App A');

      await act(async () => {
        root.render(<DataProbe document={documentWithData} appId="HookLifecycleB" />);
      });
      await settle();
      expect(container.textContent).toBe('App B');

      await act(async () => {
        root.render(<DataProbe document={null} appId="HookLifecycleB" />);
      });
      await settle();
      expect(container.textContent).toBe('');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('ignores a public refresh that resolves after its app namespace is replaced', async () => {
    const appA = getXDB('HookRefreshLifecycleA');
    const appB = getXDB('HookRefreshLifecycleB');
    const staleRefresh = deferred<XDBRecord[]>();
    const getAllA = vi
      .spyOn(appA, 'getAllAsync')
      .mockResolvedValueOnce([record('App A')])
      .mockReturnValueOnce(staleRefresh.promise);
    vi.spyOn(appA, 'isP2PAvailable').mockReturnValue(true);
    vi.spyOn(appB, 'isP2PAvailable').mockReturnValue(true);
    vi.spyOn(appB, 'getAllAsync').mockResolvedValue([record('App B')]);

    let refresh = () => {};
    const captureRefresh = (next: () => void) => {
      refresh = next;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <DataProbe
            document={documentWithData}
            appId="HookRefreshLifecycleA"
            onRefresh={captureRefresh}
          />
        );
      });
      await settle();
      expect(container.textContent).toBe('App A');

      await act(async () => {
        refresh();
        await Promise.resolve();
      });
      expect(getAllA).toHaveBeenCalledTimes(2);

      await act(async () => {
        root.render(
          <DataProbe
            document={documentWithData}
            appId="HookRefreshLifecycleB"
            onRefresh={captureRefresh}
          />
        );
      });
      await settle();
      expect(container.textContent).toBe('App B');

      await act(async () => {
        staleRefresh.resolve([record('Stale App A')]);
        await staleRefresh.promise;
        await Promise.resolve();
      });
      expect(container.textContent).toBe('App B');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
