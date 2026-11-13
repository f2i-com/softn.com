/**
 * The names a model's parts go by, with three's own glTF loader reading a
 * file written here: what it makes of a name with a space or a dot in it,
 * which of the objects it makes are nodes of the file, and that a part is
 * found by the name its author gave it as well as by the name three gave it.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DModelStateInfo, type Scene3DObject } from '../src/threed/Scene3D';
import { modelTemplateCache } from '../src/threed/model-cache';
import { stubFetch, stubFrames, triangleBytes, waitFor } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

import * as THREE from 'three';

// A quarter turn about z, as a glTF writes a rotation: x, y, z, w.
const QUARTER = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

/** A rover as Blender would export one: names with a dot and a space in them, and a body of two materials. */
const ROVER = JSON.stringify({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ name: 'Scene', nodes: [0] }],
  nodes: [
    { name: 'Rover', children: [1, 3] },
    { name: 'Steer FL', children: [2], translation: [1, 0, 0] },
    { name: 'Wheel.FL', mesh: 0, rotation: QUARTER },
    { name: 'Body', mesh: 1 },
  ],
  meshes: [
    { name: 'Tyre', primitives: [{ attributes: { POSITION: 0 } }] },
    {
      name: 'Shell',
      primitives: [
        { attributes: { POSITION: 0 }, material: 0 },
        { attributes: { POSITION: 0 }, material: 1 },
      ],
    },
  ],
  materials: [{ name: 'Paint' }, { name: 'Glass' }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  buffers: [{ uri: 'rover.bin', byteLength: 36 }],
});

let run = 0;
let container: HTMLDivElement;
let root: Root;
let states: Scene3DModelStateInfo[];
let warned: ReturnType<typeof vi.spyOn>;
const url = () => `https://models.test/names${run}/rover.gltf`;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  run += 1;
  states = [];
  stubFrames();
  stubFetch({
    [url()]: () => ROVER,
    [`https://models.test/names${run}/rover.bin`]: () => triangleBytes(),
  });
  warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
  modelTemplateCache.clearIdle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = (objects: Scene3DObject[]) =>
  act(() => root.render(<Scene3D objects={objects} lights={[]} onModelState={(info) => states.push(info)} />));
const loaded = () => states.find((s) => s.state !== 'pending');
function named(name: string): THREE.Object3D | undefined {
  const scene = (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene }).__softnScene;
  let found: THREE.Object3D | undefined;
  scene.traverse((node) => {
    if (!found && node.name === name) found = node;
  });
  return found;
}

describe('the names of a model’s parts', () => {
  it('`nodes` lists what the author named, as three writes the names, and not the pieces it cuts a mesh into', async () => {
    show([{ id: 'r', type: 'model', modelUrl: url() }]);
    await waitFor(() => loaded() !== undefined, 'the rover');
    expect(loaded()).toMatchObject({ state: 'loaded' });
    // A space is an underscore and a dot is dropped; the scene itself, the top of the model, is not a part.
    expect(loaded()?.nodes).toEqual(['Rover', 'Steer_FL', 'WheelFL', 'Body']);
    // The body's two materials are two meshes under it, named by three after the mesh: seen as meshes, not as nodes.
    expect(loaded()?.meshes).toEqual(expect.arrayContaining(['Shell', 'Shell_1']));
    expect(named('Body')?.children.map((child) => child.name)).toEqual(['Shell', 'Shell_1']);
    // And three's own rule is the one the scene goes by.
    expect(THREE.PropertyBinding.sanitizeNodeName('Steer FL')).toBe('Steer_FL');
    expect(THREE.PropertyBinding.sanitizeNodeName('Wheel.FL')).toBe('WheelFL');
    expect(THREE.PropertyBinding.sanitizeNodeName('a[1]:b/c')).toBe('a1bc');
  });

  it('finds a part by the name it has in the program it was made in, and by the name three gave it', async () => {
    const rest = new THREE.Quaternion().fromArray(QUARTER);
    const rolled = (angle: number) => rest.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(angle, 0, 0)));
    show([
      {
        id: 'r',
        type: 'model',
        modelUrl: url(),
        parts: { 'Wheel.FL': { rotation: { x: 1.2, y: 0, z: 0 } }, 'Steer FL': { rotation: { x: 0, y: 0.3, z: 0 } } },
      },
    ]);
    await waitFor(() => loaded() !== undefined, 'the rover');
    const wheel = named('WheelFL') as THREE.Object3D;
    const steer = named('Steer_FL') as THREE.Object3D;
    wheel.quaternion.toArray().forEach((v, i) => expect(v).toBeCloseTo(rolled(1.2).toArray()[i], 6));
    steer.quaternion.toArray().forEach((v, i) => expect(v).toBeCloseTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.3, 0)).toArray()[i], 9));
    // The steering knuckle keeps its place: only its turn was given.
    expect(steer.position.toArray()).toEqual([1, 0, 0]);

    show([{ id: 'r', type: 'model', modelUrl: url(), parts: { WheelFL: { rotation: { x: 0.4, y: 0, z: 0 } } } }]);
    wheel.quaternion.toArray().forEach((v, i) => expect(v).toBeCloseTo(rolled(0.4).toArray()[i], 6));
    expect(steer.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    // The scene at the top of the file is the object itself, not a part of it.
    show([{ id: 'r', type: 'model', modelUrl: url(), parts: { Scene: { visible: false } } }]);
    expect(warned.mock.calls.filter((call: unknown[]) => String(call[0]).includes('"Scene"'))).toHaveLength(1);
  });
});
