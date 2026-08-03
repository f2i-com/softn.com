import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBundleFromFiles, readBundleFromUrl } from '../src/bundle/bundle';
import { useSoftNBundle } from '../src/bundle/runtime';
import { MAX_ZIP_INPUT_BYTES } from '../src/bundle/zip';
import type { SoftNManifest } from '../src/bundle/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DeferredResponse = {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

function responseFor(bytes: Uint8Array): Response {
  return {
    ok: true,
    statusText: 'OK',
    headers: { get: () => String(bytes.byteLength) },
    body: null,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

async function makeBundle(name: string): Promise<Uint8Array> {
  const manifest: SoftNManifest = {
    name,
    version: '1.0.0',
    main: 'main.ui',
    files: { ui: ['main.ui'] },
  };
  return createBundleFromFiles(manifest, new Map([['main.ui', `<div>${name}</div>`]]));
}

function BundleName({ url }: { url: string }) {
  const { runtime, loading, error } = useSoftNBundle({ url });
  if (loading) return <span>loading</span>;
  if (error) return <span>{error.message}</span>;
  return <span>{runtime?.bundle.manifest.name}</span>;
}

type BundleSource = Parameters<typeof useSoftNBundle>[0];

function BundleStatus({
  source,
  observe,
}: {
  source: BundleSource;
  observe: (runtime: ReturnType<typeof useSoftNBundle>['runtime']) => void;
}) {
  const { runtime, loading, error } = useSoftNBundle(source);
  observe(runtime);
  return (
    <span>
      {runtime?.bundle.manifest.name ?? 'none'}|{loading ? 'loading' : (error?.message ?? 'ready')}
    </span>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remote bundle lifecycle', () => {
  it('cancels an HTTP error body instead of downloading it in the background', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('stream already disturbed');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        statusText: 'Not Found',
        headers: { get: () => null },
        body: { cancel },
      }))
    );

    await expect(readBundleFromUrl('https://bundles.test/missing.softn')).rejects.toThrow(
      'Failed to fetch bundle: Not Found'
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('clears the previous runtime when its source becomes empty', async () => {
    const bytes = await makeBundle('Loaded bundle');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responseFor(bytes))
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let observedRuntime: ReturnType<typeof useSoftNBundle>['runtime'] = null;
    const observe = (runtime: ReturnType<typeof useSoftNBundle>['runtime']) => {
      observedRuntime = runtime;
    };
    const readObservedRuntime = (): ReturnType<typeof useSoftNBundle>['runtime'] => observedRuntime;

    try {
      await act(async () => {
        root.render(
          <BundleStatus source={{ url: 'https://bundles.test/loaded.softn' }} observe={observe} />
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(readObservedRuntime()?.bundle.manifest.name).toBe('Loaded bundle');

      await act(async () => {
        root.render(<BundleStatus source={{}} observe={observe} />);
        await Promise.resolve();
      });
      expect(readObservedRuntime()).toBeNull();
      expect(container.textContent).toBe('none|No bundle source provided');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('does not let an older request overwrite a newer bundle', async () => {
    const pending = new Map<string, DeferredResponse>();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          new Promise<Response>((resolve, reject) => {
            // Deliberately ignore AbortSignal to verify the generation guard too.
            pending.set(url, { resolve, reject });
          })
      )
    );

    const oldBytes = await makeBundle('Old bundle');
    const newBytes = await makeBundle('New bundle');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<BundleName url="https://bundles.test/old.softn" />);
      });
      await act(async () => {
        root.render(<BundleName url="https://bundles.test/new.softn" />);
      });

      await act(async () => {
        pending.get('https://bundles.test/new.softn')?.resolve(responseFor(newBytes));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent).toBe('New bundle');

      await act(async () => {
        pending.get('https://bundles.test/old.softn')?.resolve(responseFor(oldBytes));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent).toBe('New bundle');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('stops a streaming response before it allocates an oversized archive', async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const chunks = [
      { byteLength: MAX_ZIP_INPUT_BYTES - 1 },
      { byteLength: 2 },
    ] as unknown as Uint8Array[];
    let index = 0;
    const response = {
      ok: true,
      statusText: 'OK',
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true, value: undefined },
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );

    await expect(readBundleFromUrl('https://bundles.test/huge.softn')).rejects.toThrow(
      'Bundle archive is too large'
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
