import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
import {
  createBundleRuntime,
  SoftNBundleRenderer,
  type BundleRuntime,
} from '../src/bundle/runtime';
import type { SoftNBundle } from '../src/bundle/types';
import { getXDB, setActiveXDBApp } from '../src/runtime/xdb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBundle(): SoftNBundle {
  return {
    manifest: {
      name: 'Disposal probe',
      version: '1.0.0',
      main: 'main.ui',
      files: { ui: ['main.ui'], assets: ['pixel.png'] },
    },
    files: new Map([
      ['main.ui', { path: 'main.ui', type: 'ui' as const, content: '<div>ready</div>', size: 16 }],
      [
        'pixel.png',
        {
          path: 'pixel.png',
          type: 'asset' as const,
          content: new Uint8Array([137, 80, 78, 71]),
          size: 4,
        },
      ],
    ]),
    uiFiles: new Map(),
    logicFiles: new Map(),
    xdbData: new Map(),
  };
}

describe('SoftNBundleRenderer lifecycle', () => {
  it('does not seed records when a runtime is disposed while desktop hydration is pending', async () => {
    const appId = 'DisposedHydrationSeed';
    const xdb = getXDB(appId);
    const originalReady = xdb.isReady;
    let finishHydration!: () => void;
    xdb.isReady = new Promise<void>((resolve) => {
      finishHydration = resolve;
    });
    const bundle = makeBundle();
    bundle.xdbData.set('seed.xdb', {
      collection: 'items',
      records: [
        {
          id: 'seed',
          data: { label: 'late' },
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-04T00:00:00.000Z',
        },
      ],
    });
    const runtime = createBundleRuntime(bundle, { appId });
    try {
      const loading = runtime.initializeXDB();
      runtime.dispose();
      finishHydration();
      await loading;
      expect(xdb.getAll('items')).toEqual([]);
      expect(runtime.getAssetUrl('pixel.png')).toBe('');
      expect(() => runtime.render()).toThrow(/disposed/i);
    } finally {
      xdb.isReady = originalReady;
      runtime.dispose();
      xdb.clear('items');
    }
  });

  it.each(['bundle', 'appId'] as const)(
    'resets local state when its %s changes',
    async (change) => {
      const first = makeBundle();
      first.files.set('main.ui', {
        path: 'main.ui',
        type: 'ui',
        content: '<div>{label}</div>',
        size: 18,
      });
      const second = { ...first, files: new Map(first.files) };
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <SoftNBundleRenderer
              bundle={first}
              appId="bundle-state-a"
              initialState={{ label: 'Private A' }}
            />
          )
        );
        expect(container.textContent).toBe('Private A');
        await act(async () =>
          root.render(
            <SoftNBundleRenderer
              bundle={change === 'bundle' ? second : first}
              appId={change === 'appId' ? 'bundle-state-b' : 'bundle-state-a'}
              initialState={{ label: 'Fresh B' }}
            />
          )
        );
        expect(container.textContent).toBe('Fresh B');
      } finally {
        act(() => root.unmount());
      }
    }
  );

  it('encodes every text asset as UTF-8, including Latin-1 characters', () => {
    const bundle = makeBundle();
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>Café £</text></svg>';
    bundle.files.set('label.svg', {
      path: 'label.svg',
      type: 'asset',
      content: source,
      size: source.length,
    });
    const runtime = createBundleRuntime(bundle);
    try {
      const dataUrl = runtime.getAssetUrl('label.svg');
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (char) => char.charCodeAt(0));
      expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(source);
    } finally {
      runtime.dispose();
    }
  });

  it('restores the previous window asset resolver as runtimes are disposed', () => {
    const hostResolver = vi.fn(() => 'host-asset');
    const assetWindow = window as typeof window & {
      __softnAsset?: (path: string) => string;
    };
    const original = assetWindow.__softnAsset;
    assetWindow.__softnAsset = hostResolver;
    const first = createBundleRuntime(makeBundle());
    const second = createBundleRuntime(makeBundle());

    try {
      first.render();
      const firstResolver = assetWindow.__softnAsset;
      expect(firstResolver).not.toBe(hostResolver);

      second.render();
      const secondResolver = assetWindow.__softnAsset;
      expect(secondResolver).not.toBe(firstResolver);

      first.dispose();
      expect(assetWindow.__softnAsset).toBe(secondResolver);

      second.dispose();
      expect(assetWindow.__softnAsset).toBe(hostResolver);
    } finally {
      first.dispose();
      second.dispose();
      if (original) assetWindow.__softnAsset = original;
      else delete assetWindow.__softnAsset;
    }
  });

  it('initializes bundled XDB records idempotently with their authored IDs', async () => {
    const bundle = makeBundle();
    bundle.xdbData.set('seed.xdb', {
      collection: 'bundle_seed_records',
      records: [
        {
          id: 'authored-id',
          data: { label: 'seed' },
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-04T00:00:00.000Z',
        },
      ],
    });
    setActiveXDBApp('BundleSeedLifecycle');
    const xdb = getXDB('BundleSeedLifecycle');
    xdb.clear('bundle_seed_records');
    const runtime = createBundleRuntime(bundle);

    try {
      await runtime.initializeXDB();
      await runtime.initializeXDB();
      const records = xdb.getAll('bundle_seed_records');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: 'authored-id', data: { label: 'seed' } });
    } finally {
      runtime.dispose();
      setActiveXDBApp(undefined);
    }
  });

  it('does not resurrect a deleted bundled seed when XDB is reinitialized', async () => {
    const collection = 'bundle_seed_tombstones';
    const bundle = makeBundle();
    bundle.xdbData.set('seed.xdb', {
      collection,
      records: [
        {
          id: 'deleted-seed',
          data: { label: 'remove me' },
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-04T00:00:00.000Z',
        },
      ],
    });
    setActiveXDBApp('BundleSeedTombstoneLifecycle');
    const xdb = getXDB('BundleSeedTombstoneLifecycle');
    xdb.clear(collection);
    const runtime = createBundleRuntime(bundle);

    try {
      await runtime.initializeXDB();
      expect(xdb.deleteFromCollection(collection, 'deleted-seed')).toBe(true);
      expect(xdb.get(collection, 'deleted-seed')).toBeNull();

      await runtime.initializeXDB();

      expect(xdb.get(collection, 'deleted-seed')).toBeNull();
      expect(xdb.getAllRaw(collection)).toEqual([
        expect.objectContaining({ id: 'deleted-seed', deleted: true }),
      ]);
    } finally {
      runtime.dispose();
      setActiveXDBApp(undefined);
    }
  });

  it('does not reload a bundle when an inline onLoad callback changes identity', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstLoad = vi.fn();
    const secondLoad = vi.fn();
    const bundle = makeBundle();

    try {
      await act(async () => {
        root.render(<SoftNBundleRenderer bundle={bundle} onLoad={firstLoad} />);
        await Promise.resolve();
      });
      expect(firstLoad).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(<SoftNBundleRenderer bundle={bundle} onLoad={secondLoad} />);
        await Promise.resolve();
      });

      expect(firstLoad).toHaveBeenCalledOnce();
      expect(secondLoad).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('disposes the runtime created by its async load when unmounted', async () => {
    const createObjectURL = vi.fn(() => 'blob:softn-disposal-probe');
    const revokeObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let runtime: BundleRuntime | null = null;

    try {
      await act(async () => {
        root.render(
          <SoftNBundleRenderer
            bundle={makeBundle()}
            onLoad={(loaded) => {
              runtime = loaded;
            }}
          />
        );
        await Promise.resolve();
      });

      expect(runtime).not.toBeNull();
      (runtime as BundleRuntime | null)?.getAssetUrl('pixel.png');
      expect(createObjectURL).toHaveBeenCalledOnce();

      act(() => root.unmount());
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:softn-disposal-probe');
    } finally {
      if (container.isConnected) {
        act(() => root.unmount());
        container.remove();
      }
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });
});
