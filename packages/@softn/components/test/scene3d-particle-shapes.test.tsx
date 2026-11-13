/**
 * Particles that are not squares: `particleShape` on a cloud.
 *
 * The cloud, its material and the picture it is drawn with are three's own;
 * the renderer draws nothing. What the picture holds is read pixel by pixel
 * here; that a particle is drawn round, and soft at its edge, is checked in
 * a browser.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { particleShapeOf, particleSpriteHolders } from '../src/threed/particle-sprites';
import { stubFrames, type FrameStub } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

import * as THREE from 'three';

let container: HTMLDivElement;
let second: HTMLDivElement;
let root: Root;
let other: Root;
let frames: FrameStub;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  second = document.createElement('div');
  document.body.append(container, second);
  root = createRoot(container);
  other = createRoot(second);
  frames = stubFrames();
});

afterEach(() => {
  act(() => {
    root.unmount();
    other.unmount();
  });
  container.remove();
  second.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cloud = (id: string, extra: Partial<Scene3DObject> = {}): Scene3DObject => ({ id, type: 'particles', particlePositions: [0, 0, 0, 1, 0, 0], ...extra });
const show = (objects: Scene3DObject[], props: Partial<Scene3DProps> = {}, into: Root = root) =>
  act(() => into.render(<Scene3D objects={objects} lights={[]} {...props} />));
function materialOf(id: string, within: HTMLElement = container): THREE.PointsMaterial {
  const scene = (within.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene }).__softnScene;
  let found: THREE.Points | undefined;
  scene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node as THREE.Points;
  });
  return (found as THREE.Points).material as THREE.PointsMaterial;
}
/** How solid a sprite is at a pixel of its picture, from 0 to 255. */
function solidAt(texture: THREE.Texture, x: number, y: number): number {
  const image = texture.image as { data: Uint8Array; width: number };
  return image.data[(y * image.width + x) * 4 + 3];
}

describe('`particleShape`', () => {
  it('leaves a cloud that names none, or names the square, drawn exactly as it was', () => {
    show([cloud('plain'), cloud('square', { particleShape: 'square' }), cloud('faint', { opacity: 0.5 })]);
    for (const id of ['plain', 'square']) {
      const material = materialOf(id);
      expect(material.map).toBeNull();
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(0.8);
      expect(material.depthWrite).toBe(false);
      expect(material.alphaTest).toBe(0);
    }
    expect(materialOf('faint').transparent).toBe(true);
    expect(materialOf('faint').opacity).toBe(0.5);
    // No picture was made for anyone.
    expect(particleSpriteHolders()).toEqual({ round: 0, soft: 0 });
    expect(particleShapeOf(undefined)).toBe('square');
    expect(particleShapeOf('star')).toBe('square');
  });

  it('draws a round or a soft cloud see-through, with a picture of a disc: solid at its middle, with no depth written', () => {
    show([cloud('dust', { particleShape: 'soft' }), cloud('beads', { particleShape: 'round', color: '#ff8800' })]);
    const soft = materialOf('dust');
    const round = materialOf('beads');
    for (const material of [soft, round]) {
      // Drawn after everything solid, and writing no depth for what is drawn after it.
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.opacity).toBe(1);
      expect(material.map).toBeInstanceOf(THREE.DataTexture);
      // White, so the cloud's colour and each particle's own show through it.
      const image = (material.map as THREE.DataTexture).image;
      expect([image.width, image.height]).toEqual([64, 64]);
      expect(Array.from((image.data as Uint8Array).slice(0, 3))).toEqual([255, 255, 255]);
    }
    expect(round.color.getHexString()).toBe('ff8800');
    expect(soft.map).not.toBe(round.map);

    const softDisc = soft.map as THREE.Texture;
    const roundDisc = round.map as THREE.Texture;
    // Soft: solid at its middle, half way out about half as solid, faint at its rim, nothing at its corners.
    expect(solidAt(softDisc, 32, 32)).toBe(255);
    expect(solidAt(softDisc, 47, 32)).toBeGreaterThan(110);
    expect(solidAt(softDisc, 47, 32)).toBeLessThan(170);
    expect(solidAt(softDisc, 60, 32)).toBeGreaterThan(0);
    expect(solidAt(softDisc, 60, 32)).toBeLessThan(20);
    expect(solidAt(softDisc, 0, 0)).toBe(0);
    // It falls steadily from the middle to the rim.
    const along = Array.from({ length: 32 }, (_, i) => solidAt(softDisc, 32 + i, 32));
    expect(along.every((value, i) => i === 0 || value <= along[i - 1])).toBe(true);
    // Round: solid right up to its rim, and nothing outside it.
    expect(solidAt(roundDisc, 32, 32)).toBe(255);
    expect(solidAt(roundDisc, 61, 32)).toBe(255);
    expect(solidAt(roundDisc, 63, 32)).toBeLessThan(128);
    expect(solidAt(roundDisc, 0, 0)).toBe(0);
    expect(solidAt(roundDisc, 4, 4)).toBe(0);
  });

  it('follows a change of shape and of opacity on the cloud it has', () => {
    show([cloud('c')]);
    const material = materialOf('c');
    const compiled = material.version;
    show([cloud('c', { particleShape: 'soft', opacity: 0.6 })]);
    expect(materialOf('c')).toBe(material);
    expect(material.map).not.toBeNull();
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.6);
    // A material with a picture is another program.
    expect(material.version).toBeGreaterThan(compiled);
    show([cloud('c')]);
    expect(material.map).toBeNull();
    expect(material.transparent).toBe(false);
    expect(material.opacity).toBe(0.8);
  });

  it('shares one picture a shape between every cloud and every scene, in a group or not', () => {
    show([cloud('a', { particleShape: 'soft' }), { id: 'g', type: 'group', children: [cloud('b', { particleShape: 'soft' })] }]);
    show([cloud('c', { particleShape: 'soft' }), cloud('d', { particleShape: 'round' })], {}, other);
    const picture = materialOf('a').map;
    expect(materialOf('b').map).toBe(picture);
    expect(materialOf('c', second).map).toBe(picture);
    expect(particleSpriteHolders()).toEqual({ round: 1, soft: 2 });
  });

  it('does not free the picture with a cloud, and frees it with the last scene that used it', () => {
    show([cloud('a', { particleShape: 'soft' }), cloud('b', { particleShape: 'soft' })]);
    show([cloud('c', { particleShape: 'soft' })], {}, other);
    const picture = materialOf('a').map as THREE.Texture;
    const freed = vi.spyOn(picture, 'dispose');

    // A cloud goes, and then every cloud of the scene: the scene still holds the picture.
    show([cloud('b', { particleShape: 'soft' })]);
    show([]);
    expect(freed).not.toHaveBeenCalled();
    expect(particleSpriteHolders().soft).toBe(2);
    // The same picture when a cloud comes back.
    show([cloud('e', { particleShape: 'soft' })]);
    expect(materialOf('e').map).toBe(picture);

    // A scene goes: what it had uploaded of the picture is let go, and the other scene goes on with it.
    act(() => root.unmount());
    root = createRoot(container);
    expect(particleSpriteHolders().soft).toBe(1);
    expect(materialOf('c', second).map).toBe(picture);

    act(() => other.unmount());
    other = createRoot(second);
    expect(particleSpriteHolders()).toEqual({ round: 0, soft: 0 });
    expect(freed).toHaveBeenCalledTimes(2);
    // A scene made after that makes the picture afresh.
    show([cloud('f', { particleShape: 'soft' })]);
    expect(materialOf('f').map).not.toBe(picture);
  });
});

describe('a square cloud under `transition`', () => {
  it('stays drawn solid while its colour is eased: only an ease of its opacity makes it see-through, and only while that lasts', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const frame = (ms = 16) => {
      now += ms;
      act(() => frames.runFrame(now));
    };
    const eased = { transition: 300 };
    show([cloud('c', { color: '#ff0000' })], eased);
    frame();
    const material = materialOf('c');
    // A square cloud is drawn solid at four fifths of its colour, on purpose.
    expect([material.transparent, material.opacity]).toEqual([false, 0.8]);

    show([cloud('c', { color: '#0000ff' })], eased);
    frame(100);
    // On its way from red to blue: still solid, and still sorted with solid things.
    expect(['ff0000', '0000ff']).not.toContain(material.color.getHexString());
    expect([material.transparent, material.opacity]).toEqual([false, 0.8]);
    frame(400);
    expect(material.color.getHexString()).toBe('0000ff');
    expect([material.transparent, material.opacity]).toEqual([false, 0.8]);

    // An opacity of its own makes it see-through, and it is while it is on its way there.
    show([cloud('c', { color: '#0000ff', opacity: 0.3 })], eased);
    frame(100);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBeLessThan(0.8);
    expect(material.opacity).toBeGreaterThan(0.3);
    frame(400);
    expect([material.transparent, material.opacity]).toEqual([true, 0.3]);
    // And back: see-through for as long as the ease lasts, and then as the object has it, which is solid.
    show([cloud('c', { color: '#0000ff' })], eased);
    frame(100);
    expect(material.transparent).toBe(true);
    frame(400);
    expect([material.transparent, material.opacity]).toEqual([false, 0.8]);
  });
});
