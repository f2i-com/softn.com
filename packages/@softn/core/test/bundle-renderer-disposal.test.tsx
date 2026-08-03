import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
import { SoftNBundleRenderer, type BundleRuntime } from '../src/bundle/runtime';
import type { SoftNBundle } from '../src/bundle/types';

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
