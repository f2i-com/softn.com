/**
 * What a particle is drawn as.
 *
 * A cloud of particles is three's `Points`: each one a square of the cloud's
 * colour, hard at its edges, which is right for a voxel spark and wrong for
 * dust, smoke or a glow. A cloud may now say `particleShape`: 'round', a
 * disc with a clean edge, or 'soft', a disc that fades to nothing at its
 * edge. Either is the same square with a small picture of the disc on it,
 * see-through where the disc is not.
 *
 * One picture for each shape serves every cloud on the page: it is 64 pixels
 * square, worked out here (no canvas, so it is the same on every machine and
 * in a test), and white, so the cloud's own colour and each particle's own
 * colour show through it. A scene takes a hold on a shape the first time one
 * of its clouds uses it, and lets go when the scene itself goes; the picture
 * is freed with the last scene holding it.
 */

import * as THREE from 'three';

/** How a particle is drawn. */
export type ParticleShape = 'square' | 'round' | 'soft';

/** A shape that is drawn with a picture: every one but the square. */
type Sprite = Exclude<ParticleShape, 'square'>;

/** `value` as a shape; anything that is not one is the square particles always were. */
export function particleShapeOf(value: unknown): ParticleShape {
  return value === 'round' || value === 'soft' ? value : 'square';
}

/** Set on a sprite: it is shared between clouds and scenes, and is not a material's to dispose. */
export const SHARED_SPRITE_KEY = '__softnSharedSprite';

const SIZE = 64;

/** How solid a sprite is at `r`, a distance from its middle where 1 is its edge. */
function solidAt(shape: Sprite, r: number): number {
  if (shape === 'round') {
    // Solid to the edge, which is one pixel of the picture wide: clean, not jagged.
    const edge = (1 - r) * (SIZE / 2 - 1) + 0.5;
    return Math.max(0, Math.min(1, edge));
  }
  // Solid at the very middle, and from there a smooth fall to nothing at the edge.
  const u = Math.max(0, Math.min(1, (1 - r) / 0.9));
  return u * u * (3 - 2 * u);
}

function paint(shape: Sprite): THREE.DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  // The disc stops a pixel short of the picture's edge, so its rim is never cut off square.
  const radius = SIZE / 2 - 1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - SIZE / 2;
      const dy = y + 0.5 - SIZE / 2;
      const at = (y * SIZE + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(solidAt(shape, Math.sqrt(dx * dx + dy * dy) / radius) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.name = `softn particle ${shape}`;
  // Smooth when a particle is drawn larger than the picture, and smaller.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.userData[SHARED_SPRITE_KEY] = true;
  texture.needsUpdate = true;
  return texture;
}

/** Each shape's picture, and how many scenes hold it. */
const shared = new Map<Sprite, { texture: THREE.DataTexture; scenes: number }>();

/** How many scenes hold each shape's picture: 0 when there is none. For tests and a development inspector. */
export function particleSpriteHolders(): Record<Sprite, number> {
  return { round: shared.get('round')?.scenes ?? 0, soft: shared.get('soft')?.scenes ?? 0 };
}

/** One scene's hold on the shared pictures. */
export class ParticleSprites {
  private readonly held = new Set<Sprite>();

  /** The picture a cloud of `shape` is drawn with; null for a square, which needs none. */
  texture(shape: ParticleShape): THREE.Texture | null {
    if (shape === 'square') return null;
    let entry = shared.get(shape);
    if (!entry) {
      entry = { texture: paint(shape), scenes: 0 };
      shared.set(shape, entry);
    }
    if (!this.held.has(shape)) {
      this.held.add(shape);
      entry.scenes += 1;
    }
    return entry.texture;
  }

  /** The scene is going: let go of every picture it held. */
  dispose(): void {
    for (const shape of this.held) {
      const entry = shared.get(shape);
      if (!entry) continue;
      entry.scenes -= 1;
      // What renderers uploaded of it is let go even while other scenes hold
      // it, and uploaded afresh by those when they next draw: a renderer
      // leaves a listener on every texture it uploads, and through that a
      // closed scene's renderer and canvas stayed reachable from here for as
      // long as any other scene used the shape.
      entry.texture.dispose();
      if (entry.scenes <= 0) shared.delete(shape);
    }
    this.held.clear();
  }
}
