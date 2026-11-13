/**
 * An object's surface, changed after the object exists.
 *
 * Two things were wrong. `doubleSided`, `alphaTest`, `fog` and `bumpScale`
 * were read when the material was made and never again, so a leaf turned
 * double-sided stayed one-sided. And a change of nothing but a colour or an
 * opacity threw the material away and made another: a decal fading out, or
 * every part of a figure flashing when it is hit, made a material a tick.
 * A change is now written into the material the object has, and only a
 * different texture makes a new one.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { proceduralTextureCacheStats, Scene3D, type Scene3DObject } from '../src/threed/Scene3D';
import { stubFrames } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubFrames();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = (objects: Scene3DObject[]) => act(() => root.render(<Scene3D objects={objects} lights={[]} />));

function nodeById<T extends THREE.Object3D = THREE.Mesh>(id: string): T {
  const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene }).__softnScene;
  let found: THREE.Object3D | undefined;
  scene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found as T;
}
const materialOf = (id: string) => nodeById(id).material as THREE.MeshStandardMaterial;

/** A 2D context that keeps count of what was drawn on it: enough for the painters, which jsdom has none for. */
function stubCanvas2D() {
  const drawn = { fillRect: 0, arc: 0, stroke: 0, fill: 0 };
  const gradient = { addColorStop: () => undefined };
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: () => void drawn.fillRect++,
    strokeRect: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    bezierCurveTo: () => undefined,
    arc: () => void drawn.arc++,
    fill: () => void drawn.fill++,
    stroke: () => void drawn.stroke++,
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
    kind === '2d' ? context : null) as unknown as HTMLCanvasElement['getContext']);
  return drawn;
}

describe('what was only read when the material was made', () => {
  it('`doubleSided`, `fog` and `alphaTest` are honoured when they change, in the material the object has', () => {
    show([{ id: 'leaf', type: 'plane', doubleSided: false, fog: true }]);
    const material = materialOf('leaf');
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.fog).toBe(true);
    expect(material.alphaTest).toBe(0);
    const compiled = material.version;

    show([{ id: 'leaf', type: 'plane', doubleSided: true, fog: false, alphaTest: 0.5 }]);
    expect(materialOf('leaf')).toBe(material);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.fog).toBe(false);
    expect(material.alphaTest).toBe(0.5);
    // A cut-out is drawn a hair in front of what it sits on.
    expect(material.depthWrite).toBe(false);
    expect(material.polygonOffset).toBe(true);
    // Each of these is compiled into the shader: it is asked for again.
    expect(material.version).toBeGreaterThan(compiled);

    show([{ id: 'leaf', type: 'plane' }]);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.fog).toBe(true);
    expect(material.alphaTest).toBe(0);
    expect(material.depthWrite).toBe(true);
    expect(material.polygonOffset).toBe(false);
  });

  it('`bumpScale` is honoured when it changes', () => {
    stubCanvas2D();
    show([{ id: 'wall', type: 'box', texture: 'brick', color: '#a04030' }]);
    const material = materialOf('wall');
    expect(material.bumpMap).not.toBeNull();
    expect(material.bumpScale).toBe(0.03);
    show([{ id: 'wall', type: 'box', texture: 'brick', color: '#a04030', bumpScale: 0.2 }]);
    expect(materialOf('wall')).toBe(material);
    expect(material.bumpScale).toBe(0.2);
  });
});

describe('a change of colour or finish', () => {
  it('is written into the material the object has, which is not disposed', () => {
    const crate = (extra: Partial<Scene3DObject>): Scene3DObject => ({ id: 'crate', type: 'box', color: '#ff0000', ...extra });
    show([crate({})]);
    const material = materialOf('crate');
    const dispose = vi.spyOn(material, 'dispose');
    const compiled = material.version;

    show([crate({ opacity: 0.4 })]);
    expect(material.opacity).toBe(0.4);
    expect(material.transparent).toBe(true);

    show([crate({ opacity: 0.4, color: '#00ff00', emissive: '#0000ff', emissiveIntensity: 2 })]);
    expect(material.color.getHexString()).toBe('00ff00');
    expect(material.emissive.getHexString()).toBe('0000ff');
    expect(material.emissiveIntensity).toBe(2);

    show([crate({ color: '#00ff00', metalness: 0.9, roughness: 0.2, wireframe: true })]);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
    // What is no longer said goes back to what it is by default.
    expect(material.emissive.getHexString()).toBe('000000');
    expect(material.emissiveIntensity).toBe(1);
    expect(material.metalness).toBe(0.9);
    expect(material.roughness).toBe(0.2);
    expect(material.wireframe).toBe(true);

    expect(materialOf('crate')).toBe(material);
    expect(dispose).not.toHaveBeenCalled();
    // Opaque to see-through and back is compiled in; a colour is not.
    const afterOpacity = material.version;
    expect(afterOpacity).toBeGreaterThan(compiled);
    show([crate({ color: '#123456', metalness: 0.9, roughness: 0.2, wireframe: true })]);
    expect(material.version).toBe(afterOpacity);
  });

  it('leaves a material alone when nothing about it changed', () => {
    show([{ id: 'crate', type: 'box', color: '#ff0000', position: { x: 0, y: 0, z: 0 } }]);
    const material = materialOf('crate');
    const set = vi.spyOn(material.color, 'set');
    show([{ id: 'crate', type: 'box', color: '#ff0000', position: { x: 1, y: 0, z: 0 } }]);
    expect(set).not.toHaveBeenCalled();
    expect(nodeById('crate').position.x).toBe(1);
  });

  it('a different texture is a different material, and the old one gives its shared texture back', () => {
    stubCanvas2D();
    const wall = (texture: string, color = '#806040'): Scene3DObject => ({ id: 'wall', type: 'box', texture, color });
    const before = proceduralTextureCacheStats();
    show([wall('stone')]);
    const stone = materialOf('wall');
    const dispose = vi.spyOn(stone, 'dispose');
    expect(stone.map).not.toBeNull();
    expect(proceduralTextureCacheStats().referenced).toBe(before.referenced + 1);

    show([wall('wood')]);
    const wood = materialOf('wall');
    expect(wood).not.toBe(stone);
    expect(dispose).toHaveBeenCalledOnce();
    expect(wood.map).not.toBe(stone.map);
    // One texture in use, as before: the stone was handed back, not leaked.
    expect(proceduralTextureCacheStats().referenced).toBe(before.referenced + 1);

    // A painted texture is painted in the object's colour, so a new colour is a new painting.
    show([wall('wood', '#402010')]);
    expect(materialOf('wall')).not.toBe(wood);
    expect(proceduralTextureCacheStats().referenced).toBe(before.referenced + 1);
  });

  it('keeps an instanced mesh and its material, and places its copies again when their colours change', () => {
    const crowd = (extra: Partial<Scene3DObject>): Scene3DObject => ({
      id: 'crowd',
      type: 'instanced',
      shape: 'box',
      instances: [0, 0, 0, 0, 2, 0, 0, 1],
      palette: ['#ff0000', '#00ff00'],
      ...extra,
    });
    show([crowd({})]);
    const mesh = nodeById<THREE.InstancedMesh>('crowd');
    const material = mesh.material as THREE.MeshStandardMaterial;
    // A palette is multiplied by the material, which is white for it.
    expect(material.color.getHexString()).toBe('ffffff');

    show([crowd({ roughness: 0.1, opacity: 0.5 })]);
    expect(nodeById('crowd')).toBe(mesh);
    expect(mesh.material).toBe(material);
    expect(material.roughness).toBe(0.1);
    expect(material.opacity).toBe(0.5);

    const colour = new THREE.Color();
    mesh.getColorAt(1, colour);
    expect(colour.getHexString()).toBe('00ff00');
    show([crowd({ roughness: 0.1, opacity: 0.5, palette: ['#ff0000', '#0000ff'] })]);
    expect(nodeById('crowd')).toBe(mesh);
    mesh.getColorAt(1, colour);
    expect(colour.getHexString()).toBe('0000ff');

    // Another count of copies is another mesh, as it was.
    show([crowd({ instances: [0, 0, 0, 0] })]);
    expect(nodeById('crowd')).not.toBe(mesh);
  });

  it('writes a cloud of particles’ colour, size, opacity and fog into the material it has', () => {
    const smoke = (extra: Partial<Scene3DObject>): Scene3DObject => ({
      id: 'smoke',
      type: 'particles',
      particlePositions: [0, 1, 0, 0, 2, 0],
      ...extra,
    });
    show([smoke({ color: '#cccccc', particleSize: 0.4 })]);
    const points = nodeById<THREE.Points>('smoke');
    const material = points.material as THREE.PointsMaterial;
    expect(material.fog).toBe(true);

    show([smoke({ color: '#ff8800', particleSize: 0.1, opacity: 0.25, fog: false })]);
    expect(nodeById('smoke')).toBe(points);
    expect(points.material).toBe(material);
    expect(material.color.getHexString()).toBe('ff8800');
    expect(material.size).toBe(0.1);
    expect(material.opacity).toBe(0.25);
    expect(material.transparent).toBe(true);
    expect(material.fog).toBe(false);
  });
});

describe('the textures the type names', () => {
  // "stripes" and "dots" had no painter: both came out as the speckle of
  // "noise", which is what any unknown name is painted as.
  it('paints stripes as bands and dots as dots, and neither as the speckle', () => {
    const drawn = stubCanvas2D();
    const painted = (texture: string) => {
      const before = { ...drawn };
      // A colour of its own for each, so none is another's cached texture.
      show([{ id: `t-${texture}`, type: 'box', texture, color: `#0000${texture.length}${texture.length}` }]);
      expect(materialOf(`t-${texture}`).map).not.toBeNull();
      return { fillRect: drawn.fillRect - before.fillRect, arc: drawn.arc - before.arc };
    };
    // The base colour is one rectangle; the speckle is two hundred more.
    expect(painted('noise')).toEqual({ fillRect: 201, arc: 0 });
    expect(painted('stripes')).toEqual({ fillRect: 9, arc: 0 });
    // Thirty-two dots, each filled and then ringed.
    expect(painted('dots')).toEqual({ fillRect: 1, arc: 64 });
  });
});
