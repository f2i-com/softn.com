/**
 * TileMap Component
 *
 * Canvas-based tilemap renderer. Draws multiple tile layers from a tileset
 * image onto a single <canvas> element. Efficient — re-renders only when
 * layers or tileset change.
 */

import * as React from 'react';
import { isSafeUrl } from '@softn/core';
import {ViewportTileMap} from './ViewportTileMap';

export interface TileMapProps {
  /** URL of the tileset sprite sheet */
  src?: string;
  /** Size of each tile in pixels (default 32) */
  tileSize?: number;
  /** Number of tile columns in the tileset image */
  tilesetColumns?: number;
  /** Array of tile layers (each is a 2D array of tile indices, -1 = empty) */
  layers?: number[][][];
  /** Map width in tiles; the longest row of the layers when not given */
  mapWidth?: number;
  /** Map height in tiles; the most rows a layer has when not given */
  mapHeight?: number;
  /** Display scale multiplier */
  scale?: number;
  /** Render only the clipped visible region, with a bounded screen-density backing store. */
  viewport?: boolean;
  /** Smooth high-resolution artwork when sampling down to the display density. */
  smooth?: boolean;
  onVisibleRangeChange?: (range:{x:number;y:number;width:number;height:number})=>void;
  /** Additional inline styles for the canvas */
  style?: React.CSSProperties;
  /** CSS class */
  className?: string;
}

/** A map as it is drawn: its size in tiles is known. */
export type SizedTileMapProps = TileMapProps & { mapWidth: number; mapHeight: number };

function LegacyTileMap({
  src,
  tileSize = 32,
  tilesetColumns = 16,
  layers,
  mapWidth,
  mapHeight,
  scale = 1,
  style,
  className,
}: SizedTileMapProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  const loadedSrcRef = React.useRef<string>('');

  const render = React.useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !img.complete) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!Array.isArray(layers)) return;

    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l];
      if (!Array.isArray(layer)) continue;
      for (let y = 0; y < layer.length; y++) {
        const row = layer[y];
        if (!Array.isArray(row)) continue;
        for (let x = 0; x < row.length; x++) {
          const idx = row[x];
          if (idx == null || idx < 0) continue;

          const srcX = (idx % tilesetColumns) * tileSize;
          const srcY = Math.floor(idx / tilesetColumns) * tileSize;

          ctx.drawImage(
            img,
            srcX, srcY, tileSize, tileSize,
            x * tileSize, y * tileSize, tileSize, tileSize
          );
        }
      }
    }
  }, [layers, tileSize, tilesetColumns]);

  // Load tileset image
  React.useEffect(() => {
    // The tileset is named by the bundle, and this assigns it to a real
    // `HTMLImageElement`, so it needs the same scheme check an `<img src>` gets.
    if (!src || !isSafeUrl(src)) {
      // No tileset, or one refused: the map is drawn with none. The last one
      // was kept, and the map went on painting from a tileset the page had
      // taken away.
      imgRef.current = null;
      loadedSrcRef.current = '';
      const canvas = canvasRef.current;
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (src === loadedSrcRef.current) {
      render();
      return;
    }

    // A load that this effect started but a later one has superseded must not
    // install its image: with `src` changed A→B→A, B's onload could land
    // after A's and leave B on the canvas. Nor may it paint after unmount.
    let cancelled = false;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      loadedSrcRef.current = src;
      render();
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, render]);

  // Re-render when layers change, and when the map is resized: setting a
  // canvas's width or height clears it, and nothing else would repaint it.
  React.useEffect(() => {
    render();
  }, [render, mapWidth, mapHeight]);

  const canvasW = mapWidth * tileSize;
  const canvasH = mapHeight * tileSize;

  const computedStyle: React.CSSProperties = {
    imageRendering: 'pixelated',
    width: canvasW * scale,
    height: canvasH * scale,
    ...style,
  };

  return (
    <canvas
      ref={canvasRef}
      width={canvasW}
      height={canvasH}
      className={className}
      style={computedStyle}
    />
  );
}

/** A count or a size that can be drawn with: a finite number above zero, or the default. */
function positive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The map with every measure it is drawn by.
 *
 * `mapWidth` and `mapHeight` were required and nothing said so at run time:
 * a map given only its `layers` multiplied undefined by the tile size, the
 * canvas was sized NaN (which React drops, with a warning), and the tiles
 * were drawn into the 300 by 150 a canvas has by default and cut off there.
 * A side that is not given is what the layers cover. A tile size, a scale or
 * a column count that is null or not above zero is the default, where a
 * default parameter only stood in for undefined.
 */
function sized(props: TileMapProps): SizedTileMapProps {
  let widest = 0;
  let tallest = 0;
  for (const layer of Array.isArray(props.layers) ? props.layers : []) {
    if (!Array.isArray(layer)) continue;
    tallest = Math.max(tallest, layer.length);
    for (const row of layer) if (Array.isArray(row)) widest = Math.max(widest, row.length);
  }
  return {
    ...props,
    tileSize: positive(props.tileSize, 32),
    tilesetColumns: Math.floor(positive(props.tilesetColumns, 16)) || 16,
    scale: positive(props.scale, 1),
    mapWidth: Math.floor(positive(props.mapWidth, widest)),
    mapHeight: Math.floor(positive(props.mapHeight, tallest)),
  };
}

export function TileMap(props: TileMapProps) {
  const map = sized(props);
  return props.viewport ? <ViewportTileMap {...map} /> : <LegacyTileMap {...map} />;
}
export default TileMap;
