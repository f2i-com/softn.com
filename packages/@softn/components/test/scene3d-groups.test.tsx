/**
 * Groups reconciled by child id: a moved child is patched, its siblings are
 * left as the very objects they were, a child whose id is gone is disposed
 * and a new id is built.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DObject } from '../src/threed/Scene3D';
import { stubFrames, type FrameStub } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frames = stubFrames();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function nodeById(id: string): THREE.Object3D | undefined {
  const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene })
    .__softnScene;
  let found: THREE.Object3D | undefined;
  scene.traverse((node) => {
    if (node.userData.__softnId === id) found = node;
  });
  return found;
}

const train = (wheelX: number, extra: Scene3DObject[] = []): Scene3DObject => ({
  id: 'train',
  type: 'group',
  position: { x: 1, y: 0, z: 0 },
  children: [
    { id: 'cab', type: 'box', color: '#224488', position: { x: 0, y: 0.5, z: 0 } },
    { id: 'wheel', type: 'cylinder', radius: 0.2, position: { x: wheelX, y: 0, z: 0 } },
    {
      id: 'tender',
      type: 'group',
      children: [{ id: 'coal', type: 'box', color: '#111111', position: { x: 0, y: 0.2, z: 0 } }],
    },
    ...extra,
  ],
});

describe('Scene3D group reconcile', () => {
  it('patches the child that moved and keeps its siblings', () => {
    act(() => root.render(<Scene3D objects={[train(0)]} />));
    const cab = nodeById('cab') as THREE.Mesh;
    const wheel = nodeById('wheel') as THREE.Mesh;
    const coal = nodeById('coal') as THREE.Mesh;
    const group = nodeById('train') as THREE.Group;
    expect(cab).toBeDefined();
    expect(wheel.position.x).toBe(0);

    act(() => root.render(<Scene3D objects={[train(2)]} />));
    expect(nodeById('train')).toBe(group);
    expect(nodeById('cab')).toBe(cab);
    expect(nodeById('wheel')).toBe(wheel);
    expect(nodeById('coal')).toBe(coal);
    expect(wheel.position.x).toBe(2);
    expect(wheel.geometry).toBeInstanceOf(THREE.CylinderGeometry);
  });

  it('disposes a child whose id is gone and builds one whose id is new', () => {
    act(() => root.render(<Scene3D objects={[train(0)]} />));
    const cab = nodeById('cab') as THREE.Mesh;
    const wheel = nodeById('wheel') as THREE.Mesh;
    const wheelDispose = vi.spyOn(wheel.geometry, 'dispose');

    const without = train(0);
    without.children = without.children!.filter((c) => c.id !== 'wheel');
    act(() =>
      root.render(
        <Scene3D
          objects={[
            { ...without, children: [...without.children!, { id: 'lamp', type: 'sphere', radius: 0.1 }] },
          ]}
        />
      )
    );
    expect(nodeById('wheel')).toBeUndefined();
    expect(wheelDispose).toHaveBeenCalledOnce();
    expect(nodeById('cab')).toBe(cab);
    expect(nodeById('lamp')).toBeInstanceOf(THREE.Mesh);
    expect((nodeById('lamp') as THREE.Mesh).geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect(nodeById('lamp')?.userData.__softnParentId).toBe('train');
  });

  it('replaces a child whose type changed, swaps geometry for a new size, and recolours the material it has', () => {
    act(() => root.render(<Scene3D objects={[train(0)]} />));
    const cab = nodeById('cab') as THREE.Mesh;
    const cabGeometry = cab.geometry;
    const cabMaterial = cab.material as THREE.MeshStandardMaterial;

    const next = train(0);
    next.children![0] = { ...next.children![0], width: 3 };
    act(() => root.render(<Scene3D objects={[next]} />));
    expect(nodeById('cab')).toBe(cab);
    expect(cab.geometry).not.toBe(cabGeometry);
    expect(cab.material).toBe(cabMaterial);

    // A new colour is written into the material: it used to be thrown away
    // and another made.
    const dispose = vi.spyOn(cabMaterial, 'dispose');
    const recoloured = train(0);
    recoloured.children![0] = { ...next.children![0], color: '#ff0000' };
    act(() => root.render(<Scene3D objects={[recoloured]} />));
    expect(nodeById('cab')).toBe(cab);
    expect(cab.material).toBe(cabMaterial);
    expect(dispose).not.toHaveBeenCalled();
    expect((cab.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff0000');

    const retyped = train(0);
    retyped.children![0] = { id: 'cab', type: 'sphere', radius: 0.4 };
    act(() => root.render(<Scene3D objects={[retyped]} />));
    expect(nodeById('cab')).not.toBe(cab);
    expect((nodeById('cab') as THREE.Mesh).geometry).toBeInstanceOf(THREE.SphereGeometry);
  });

  it('reconciles a nested group by the same rule', () => {
    act(() => root.render(<Scene3D objects={[train(0)]} />));
    const tender = nodeById('tender') as THREE.Group;
    const coal = nodeById('coal') as THREE.Mesh;

    const next = train(0);
    next.children![2] = {
      id: 'tender',
      type: 'group',
      position: { x: -2, y: 0, z: 0 },
      children: [
        { id: 'coal', type: 'box', color: '#111111', position: { x: 0, y: 0.4, z: 0 } },
        { id: 'water', type: 'cylinder', radius: 0.3 },
      ],
    };
    act(() => root.render(<Scene3D objects={[next]} />));
    expect(nodeById('tender')).toBe(tender);
    expect(tender.position.x).toBe(-2);
    expect(nodeById('coal')).toBe(coal);
    expect(coal.position.y).toBe(0.4);
    expect(nodeById('water')?.parent).toBe(tender);
  });

  it('leaves a child alone when its spec is the same object', () => {
    const shared = train(0);
    act(() => root.render(<Scene3D objects={[shared]} />));
    const cab = nodeById('cab') as THREE.Mesh;
    cab.position.x = 9;
    // A host that mirrors state hands back the same children array; nothing
    // is touched, not even to reapply an unchanged transform.
    act(() => root.render(<Scene3D objects={[{ ...shared }]} />));
    expect(cab.position.x).toBe(9);
    act(() => root.render(<Scene3D objects={[{ ...shared, children: [...shared.children!] }]} />));
    expect(cab.position.x).toBe(9);
  });
});

// `animate` was read off top-level objects only: a fan's blades, a turret on
// a tank, a propeller, sat still inside their group.
describe('`animate` on a group’s child', () => {
  let now = 0;
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /** A frame, sixteen milliseconds on. */
  const frame = () => {
    now += 16;
    act(() => frames.runFrame(now));
  };

  const fan = (blade: Partial<Scene3DObject> = {}, x = 0): Scene3DObject => ({
    id: 'fan',
    type: 'group',
    position: { x, y: 0, z: 0 },
    children: [
      { id: 'blade', type: 'box', rotation: { x: 0, y: 0, z: 0 }, animate: { rotateY: 0.1 }, ...blade },
      { id: 'post', type: 'cylinder' },
      {
        id: 'cage',
        type: 'group',
        children: [{ id: 'light', type: 'sphere', position: { x: 0, y: 2, z: 0 }, animate: { floatAmplitude: 1 } }],
      },
    ],
  });

  it('turns it and bobs it, at any depth, as it does a top-level object', () => {
    act(() => root.render(<Scene3D objects={[fan(), { id: 'top', type: 'box', animate: { rotateY: 0.1 } }]} />));
    frame();
    const blade = nodeById('blade') as THREE.Object3D;
    // 0.1 a frame at sixty frames a second, for one frame of sixteen milliseconds.
    expect(blade.rotation.y).toBeCloseTo(0.096, 3);
    expect(blade.rotation.y).toBeCloseTo((nodeById('top') as THREE.Object3D).rotation.y, 6);
    expect((nodeById('post') as THREE.Object3D).rotation.y).toBe(0);
    // A bob around where the child stands in its group.
    expect((nodeById('light') as THREE.Object3D).position.y).toBeCloseTo(2 + Math.sin(0.016), 4);
  });

  it('keeps turning through an update of the group, and takes a new speed', () => {
    act(() => root.render(<Scene3D objects={[fan()]} />));
    frame();
    frame();
    const blade = nodeById('blade') as THREE.Object3D;
    const turned = blade.rotation.y;
    expect(turned).toBeGreaterThan(0.15);

    // The group moved, every record new, as a tick of logic hands them over:
    // the blade is not put back to where its spec says it starts.
    act(() => root.render(<Scene3D objects={[fan({}, 3)]} />));
    expect(nodeById('blade')).toBe(blade);
    expect(blade.rotation.y).toBe(turned);
    frame();
    expect(blade.rotation.y).toBeGreaterThan(turned);

    act(() => root.render(<Scene3D objects={[fan({ animate: { rotateY: -0.1 } }, 3)]} />));
    const before = blade.rotation.y;
    frame();
    expect(blade.rotation.y).toBeLessThan(before);
  });

  it('stops when the child no longer asks, and is where its spec says again', () => {
    act(() => root.render(<Scene3D objects={[fan()]} />));
    frame();
    const blade = nodeById('blade') as THREE.Object3D;
    act(() => root.render(<Scene3D objects={[fan({ animate: undefined, rotation: { x: 0, y: 0.5, z: 0 } })]} />));
    expect(blade.rotation.y).toBe(0.5);
    frame();
    expect(blade.rotation.y).toBe(0.5);
  });

  it('is not left turning a child that has gone', () => {
    act(() => root.render(<Scene3D objects={[fan()]} />));
    const blade = nodeById('blade') as THREE.Object3D;
    const emptied = fan();
    emptied.children = emptied.children!.filter((child) => child.id !== 'blade');
    act(() => root.render(<Scene3D objects={[emptied]} />));
    frame();
    expect(blade.rotation.y).toBe(0);
    expect(blade.parent).toBeNull();
  });
});

describe('Scene3D group children with one id', () => {
  const wheels = (xs: number[]): Scene3DObject => ({
    id: 'g',
    type: 'group',
    children: xs.map((x) => ({ id: 'w', type: 'box' as const, position: { x, y: 0, z: 0 } })),
  });

  it('are built first-wins, the rule the reconcile applies, so a later update patches the one node', () => {
    act(() => root.render(<Scene3D objects={[wheels([0, 5])]} />));
    const group = nodeById('g') as THREE.Group;
    expect(group.children).toHaveLength(1);
    expect(group.children[0].position.x).toBe(0);
    const wheel = group.children[0];

    act(() => root.render(<Scene3D objects={[wheels([1])]} />));
    expect(group.children).toHaveLength(1);
    expect(group.children[0]).toBe(wheel);
    expect(wheel.position.x).toBe(1);

    // Handed a duplicate again, the reconcile keeps the first and builds nothing.
    act(() => root.render(<Scene3D objects={[wheels([2, 9])]} />));
    expect(group.children).toHaveLength(1);
    expect(group.children[0]).toBe(wheel);
    expect(wheel.position.x).toBe(2);
  });
});
