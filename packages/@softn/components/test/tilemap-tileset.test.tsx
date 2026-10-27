/**
 * A TileMap whose tileset is taken away (an empty `src`, or one refused)
 * draws with none: the last one was kept, and every repaint after drew the
 * map from a tileset the page no longer named.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from './dom';
import { TileMap } from '../src/animation/TileMap';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TileMap', () => {
  it('stops drawing from a tileset once src is taken away', async () => {
    const ctx = { imageSmoothingEnabled: true, clearRect: vi.fn(), drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    class LoadingImage {
      onload: (() => void) | null = null;
      crossOrigin = '';
      complete = false;
      set src(_value: string) {
        queueMicrotask(() => {
          this.complete = true;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal('Image', LoadingImage);
    const layers = [[[0, 1]]];
    const m = mount(<TileMap src="tiles.png" layers={layers} tileSize={8} />);
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(ctx.drawImage).toHaveBeenCalled();
      m.rerender(<TileMap src="" layers={layers} tileSize={8} />);
      ctx.drawImage.mockClear();
      m.rerender(<TileMap src="" layers={[[[1, 0]]]} tileSize={8} />);
      expect(ctx.drawImage).not.toHaveBeenCalled();
    } finally {
      m.unmount();
    }
  });
});
