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

  it('replaces a child whose type changed, and swaps geometry or material for a lesser change', () => {
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

    const recoloured = train(0);
    recoloured.children![0] = { ...next.children![0], color: '#ff0000' };
    act(() => root.render(<Scene3D objects={[recoloured]} />));
    expect(nodeById('cab')).toBe(cab);
    expect(cab.material).not.toBe(cabMaterial);
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
