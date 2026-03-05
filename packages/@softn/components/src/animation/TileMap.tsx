/**
 * TileMap Component
 *
 * Canvas-based tilemap renderer. Draws multiple tile layers from a tileset
 * image onto a single <canvas> element. Efficient — re-renders only when
 * layers or tileset change.
 */

import * as React from 'react';

export interface TileMapProps {
  /** URL of the tileset sprite sheet */
  src: string;
  /** Size of each tile in pixels (default 32) */
  tileSize?: number;
  /** Number of tile columns in the tileset image */
  tilesetColumns?: number;
  /** Array of tile layers (each is a 2D array of tile indices, -1 = empty) */
  layers: number[][][];
  /** Map width in tiles */
  mapWidth: number;
  /** Map height in tiles */
  mapHeight: number;
  /** Display scale multiplier */
  scale?: number;
  /** Additional inline styles for the canvas */
  style?: React.CSSProperties;
  /** CSS class */
  className?: string;
}

export function TileMap({
  src,
  tileSize = 32,
  tilesetColumns = 16,
  layers,
  mapWidth,
  mapHeight,
  scale = 1,
  style,
  className,
}: TileMapProps) {
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
    if (!src || src === loadedSrcRef.current) {
      render();
      return;
    }

    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      loadedSrcRef.current = src;
      render();
    };
    img.src = src;
  }, [src, render]);

  // Re-render when layers change
  React.useEffect(() => {
    render();
  }, [render]);

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

export default TileMap;
