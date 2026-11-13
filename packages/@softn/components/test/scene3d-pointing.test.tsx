/**
 * Which way an object faces, and how each copy of an instanced object is
 * turned and sized.
 *
 * `lookAt`, `align` and `rotationOrder` on an object, and the flat arrays
 * `instanceRotations` and `instanceScales` beside `instances`. Each is held
 * here to three.js's own arithmetic: what the scene makes of an object must
 * be what `Object3D.lookAt`, `Quaternion.setFromUnitVectors`, an `Euler` in
 * the order named and `Matrix4.compose` would have made.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DHit, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { orientationOf, pointsSomewhere, rotationOrderOf } from '../src/threed/pointing';
import { numbersPerCopy } from '../src/threed/instances';
import { placeCanvas, pointerEvent, stubFrames, type FrameStub } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;
let now = 0;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frames = stubFrames();
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Canvas = HTMLCanvasElement & { __softnScene: THREE.Scene };
const canvasOf = () => container.querySelector('canvas') as Canvas;
const show = (objects: Scene3DObject[], props: Partial<Scene3DProps> = {}) =>
  act(() => root.render(<Scene3D objects={objects} lights={[]} {...props} />));
function nodeById<T extends THREE.Object3D = THREE.Mesh>(id: string): T {
  let found: THREE.Object3D | undefined;
  canvasOf().__softnScene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found as T;
}
function frame(ms: number): void {
  now += ms;
  act(() => frames.runFrame(now));
}
/** Whether two quaternions are the same turn: a quaternion and its negative are. */
const sameTurn = (a: THREE.Quaternion, b: THREE.Quaternion) => Math.abs(a.dot(b)) > 1 - 1e-9;
const v = (x: number, y: number, z: number) => ({ x, y, z });

describe('lookAt', () => {
  it.each([
    ['ahead and to one side', v(1, 2, 3), v(7, 2, -4)],
    ['above', v(0, 0, 0), v(2, 5, 1)],
    ['below and behind', v(-3, 4, 2), v(-3.5, -1, 9)],
    ['straight up, where up itself is no guide', v(1, 1, 1), v(1, 6, 1)],
  ])('turns the object to face a point %s, as Object3D.lookAt does', (_where, position, target) => {
    show([{ id: 'turret', type: 'box', position, lookAt: target }]);
    const expected = new THREE.Object3D();
    expected.position.set(position.x, position.y, position.z);
    expected.lookAt(target.x, target.y, target.z);
    expect(sameTurn(nodeById('turret').quaternion, expected.quaternion)).toBe(true);
  });

  it('points the object’s +z at the point', () => {
    show([{ id: 'turret', type: 'box', position: v(1, 0, 1), lookAt: v(4, 0, 5) }]);
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(nodeById('turret').quaternion);
    expect(front.distanceTo(new THREE.Vector3(3, 0, 4).normalize())).toBeLessThan(1e-9);
  });

  it('follows the point when it moves, and the object when it moves', () => {
    show([{ id: 'turret', type: 'box', position: v(0, 0, 0), lookAt: v(0, 0, 5) }]);
    const node = nodeById('turret');
    show([{ id: 'turret', type: 'box', position: v(0, 0, 0), lookAt: v(5, 0, 0) }]);
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(node.quaternion).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    show([{ id: 'turret', type: 'box', position: v(10, 0, 0), lookAt: v(5, 0, 0) }]);
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(node.quaternion).distanceTo(new THREE.Vector3(-1, 0, 0))).toBeLessThan(1e-9);
  });

  it('for a group’s child, is a point in the group’s own space, as the child’s position is', () => {
    show([
      {
        id: 'tank',
        type: 'group',
        position: v(100, 0, 0),
        rotation: v(0, 1, 0),
        children: [{ id: 'gun', type: 'box', position: v(0, 1, 0), lookAt: v(3, 1, 0) }],
      },
    ]);
    const expected = new THREE.Object3D();
    expected.position.set(0, 1, 0);
    expected.lookAt(3, 1, 0);
    expect(sameTurn(nodeById('gun').quaternion, expected.quaternion)).toBe(true);
  });

  it('with a rotation too, the rotation is the object’s own turn, applied first', () => {
    // A model whose front is its +x needs a quarter turn to face where it is pointed.
    show([{ id: 'car', type: 'box', position: v(0, 0, 0), lookAt: v(0, 0, 9), rotation: v(0, -Math.PI / 2, 0) }]);
    const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(nodeById('car').quaternion);
    expect(nose.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9);
  });

  it('a point the object stands on points nowhere, and the rotation is all there is', () => {
    show([{ id: 'a', type: 'box', position: v(2, 2, 2), lookAt: v(2, 2, 2), rotation: v(0, 0.5, 0) }]);
    expect(nodeById('a').rotation.y).toBe(0.5);
  });

  it('is turned to over the transition, by the shortest way', () => {
    show([{ id: 'turret', type: 'box', position: v(0, 0, 0), lookAt: v(0, 0, 5) }], { transition: 200 });
    const node = nodeById('turret');
    const from = node.quaternion.clone();
    show([{ id: 'turret', type: 'box', position: v(0, 0, 0), lookAt: v(5, 0, 0) }], { transition: 200 });
    const to = orientationOf({ position: v(0, 0, 0), lookAt: v(5, 0, 0) }, new THREE.Quaternion());
    frame(100);
    expect(sameTurn(node.quaternion, new THREE.Quaternion().slerpQuaternions(from, to, 0.5))).toBe(true);
    frame(100);
    expect(sameTurn(node.quaternion, to)).toBe(true);
  });
});

describe('align', () => {
  it.each([
    ['along x', v(1, 0, 0)],
    ['along a slope, at any length', v(3, 4, -12)],
    ['straight down', v(0, -2, 0)],
  ])('lays the object’s long axis %s, as Quaternion.setFromUnitVectors does', (_how, direction) => {
    show([{ id: 'arm', type: 'capsule', align: direction }]);
    const unit = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    const expected = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), unit);
    expect(sameTurn(nodeById('arm').quaternion, expected)).toBe(true);
    // The axis a capsule stands along is its +y.
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(nodeById('arm').quaternion).distanceTo(unit)).toBeLessThan(1e-9);
  });

  it('a rotation given with it rolls the object about the axis that was aligned', () => {
    show([{ id: 'beam', type: 'box', align: v(1, 0, 0), rotation: v(0, Math.PI / 2, 0) }]);
    const node = nodeById('beam');
    // Still along x.
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(node.quaternion).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    const expected = new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)));
    expect(sameTurn(node.quaternion, expected)).toBe(true);
  });

  it('a direction of no length points nowhere; lookAt is used when both are given', () => {
    show([
      { id: 'still', type: 'capsule', align: v(0, 0, 0) },
      { id: 'both', type: 'capsule', align: v(1, 0, 0), lookAt: v(0, 0, 5) },
    ]);
    expect(sameTurn(nodeById('still').quaternion, new THREE.Quaternion())).toBe(true);
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(nodeById('both').quaternion).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9);
    expect(pointsSomewhere({ align: v(0, 0, 0) })).toBe(false);
    expect(pointsSomewhere({ align: v(0, 0, 1) })).toBe(true);
    expect(pointsSomewhere({ position: v(1, 1, 1), lookAt: v(1, 1, 1) })).toBe(false);
  });

  it('leaves the turn to `animate` once the object is there', () => {
    const spinner = (align: { x: number; y: number; z: number }): Scene3DObject => ({ id: 's', type: 'capsule', align, animate: { rotateY: 0.1 } });
    show([spinner(v(1, 0, 0))]);
    const node = nodeById('s');
    frame(16);
    const turned = node.quaternion.clone();
    show([spinner(v(0, 0, 1))]);
    expect(sameTurn(node.quaternion, turned)).toBe(true);
  });
});

describe('rotationOrder', () => {
  it.each(['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'] as const)('applies the three angles in the order %s, as an Euler of that order does', (order) => {
    show([{ id: 'a', type: 'box', rotation: v(0.3, 1.1, -0.7), rotationOrder: order }]);
    const node = nodeById('a');
    expect(node.rotation.order).toBe(order);
    expect(sameTurn(node.quaternion, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, -0.7, order)))).toBe(true);
    // The angles read back as written.
    expect([node.rotation.x, node.rotation.y, node.rotation.z]).toEqual([0.3, 1.1, -0.7]);
  });

  it('is XYZ when not given, as it always was, and for an order that is not one', () => {
    show([
      { id: 'plain', type: 'box', rotation: v(0.3, 1.1, -0.7) },
      { id: 'odd', type: 'box', rotation: v(0.3, 1.1, -0.7), rotationOrder: 'yaw-first' as never },
    ]);
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, -0.7, 'XYZ'));
    expect(sameTurn(nodeById('plain').quaternion, expected)).toBe(true);
    expect(sameTurn(nodeById('odd').quaternion, expected)).toBe(true);
    expect(rotationOrderOf(undefined)).toBe('XYZ');
    expect(rotationOrderOf('YXZ')).toBe('YXZ');
  });

  it('a heading and then a lean, in YXZ, leans the figure along its own heading', () => {
    // Turned a quarter turn to face +x, then leaning forward: its top tips toward +x.
    show([{ id: 'runner', type: 'capsule', rotation: v(0.4, Math.PI / 2, 0), rotationOrder: 'YXZ' }]);
    const top = new THREE.Vector3(0, 1, 0).applyQuaternion(nodeById('runner').quaternion);
    expect(top.x).toBeCloseTo(Math.sin(0.4), 9);
    expect(top.z).toBeCloseTo(0, 9);
  });

  it('may change while the object stays', () => {
    show([{ id: 'a', type: 'box', rotation: v(0.3, 1.1, -0.7) }]);
    const node = nodeById('a');
    show([{ id: 'a', type: 'box', rotation: v(0.3, 1.1, -0.7), rotationOrder: 'ZYX' }]);
    expect(nodeById('a')).toBe(node);
    expect(sameTurn(node.quaternion, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, -0.7, 'ZYX')))).toBe(true);
  });
});

describe('instances that turn and scale', () => {
  const places = [0, 0, 0, 4, 0, 0, 0, 0, 4];
  const batch = (extra: Partial<Scene3DObject>): Scene3DObject => ({ id: 'rails', type: 'instanced', shape: 'box', instances: places, ...extra });
  const matrixOf = (mesh: THREE.InstancedMesh, index: number) => {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(index, m);
    return m;
  };
  const composed = (position: number[], quaternion: THREE.Quaternion, scale: number[]) =>
    new THREE.Matrix4().compose(new THREE.Vector3(...position), quaternion, new THREE.Vector3(...scale));
  const close = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((value, i) => Math.abs(value - b.elements[i]) < 1e-6);
  const aboutY = (angle: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);

  it('with neither array, each copy is only its position, as before', () => {
    show([batch({})]);
    const mesh = nodeById<THREE.InstancedMesh>('rails');
    expect(close(matrixOf(mesh, 1), new THREE.Matrix4().makeTranslation(4, 0, 0))).toBe(true);
  });

  it('one number a copy is a turn about the upright axis', () => {
    show([batch({ instanceRotations: [0, Math.PI / 2, 1.2] })]);
    const mesh = nodeById<THREE.InstancedMesh>('rails');
    expect(close(matrixOf(mesh, 0), composed([0, 0, 0], aboutY(0), [1, 1, 1]))).toBe(true);
    expect(close(matrixOf(mesh, 1), composed([4, 0, 0], aboutY(Math.PI / 2), [1, 1, 1]))).toBe(true);
    expect(close(matrixOf(mesh, 2), composed([0, 0, 4], aboutY(1.2), [1, 1, 1]))).toBe(true);
  });

  it('three numbers a copy are its turns about x, y and z', () => {
    show([batch({ instanceRotations: [0, 0, 0, 0.2, 0.4, 0.6, -1, 2, 0.5] })]);
    const mesh = nodeById<THREE.InstancedMesh>('rails');
    const turned = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
    expect(close(matrixOf(mesh, 1), composed([4, 0, 0], turned(0.2, 0.4, 0.6), [1, 1, 1]))).toBe(true);
    expect(close(matrixOf(mesh, 2), composed([0, 0, 4], turned(-1, 2, 0.5), [1, 1, 1]))).toBe(true);
  });

  it('one number a copy is its size, and three are its sizes along x, y and z', () => {
    show([batch({ instanceScales: [1, 0.5, 2] })]);
    let mesh = nodeById<THREE.InstancedMesh>('rails');
    expect(close(matrixOf(mesh, 1), composed([4, 0, 0], aboutY(0), [0.5, 0.5, 0.5]))).toBe(true);
    expect(close(matrixOf(mesh, 2), composed([0, 0, 4], aboutY(0), [2, 2, 2]))).toBe(true);

    show([batch({ instanceScales: [1, 1, 1, 1, 3, 1, 2, 0.1, 2] })]);
    mesh = nodeById<THREE.InstancedMesh>('rails');
    expect(close(matrixOf(mesh, 1), composed([4, 0, 0], aboutY(0), [1, 3, 1]))).toBe(true);
    expect(close(matrixOf(mesh, 2), composed([0, 0, 4], aboutY(0), [2, 0.1, 2]))).toBe(true);
  });

  it('both together, with a palette, turn and size each copy and still colour it', () => {
    show([
      batch({
        instances: [0, 0, 0, 0, 4, 0, 0, 1],
        palette: ['#ff0000', '#00ff00'],
        instanceRotations: [0, Math.PI],
        instanceScales: [1, 2, 1, 3, 1, 1],
      }),
    ]);
    const mesh = nodeById<THREE.InstancedMesh>('rails');
    expect(mesh.count).toBe(2);
    expect(close(matrixOf(mesh, 0), composed([0, 0, 0], aboutY(0), [1, 2, 1]))).toBe(true);
    expect(close(matrixOf(mesh, 1), composed([4, 0, 0], aboutY(Math.PI), [3, 1, 1]))).toBe(true);
    const colour = new THREE.Color();
    mesh.getColorAt(1, colour);
    expect(colour.getHexString()).toBe('00ff00');
  });

  it('goes by the length: three times the copies or more is three each, anything shorter is one each', () => {
    expect(numbersPerCopy(undefined, 3)).toBe(0);
    expect(numbersPerCopy([], 3)).toBe(0);
    expect(numbersPerCopy([1, 2, 3], 3)).toBe(1);
    expect(numbersPerCopy([1, 2], 3)).toBe(1);
    expect(numbersPerCopy([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toBe(3);
    // One copy: three numbers are its three angles.
    expect(numbersPerCopy([1, 2, 3], 1)).toBe(3);
    expect(numbersPerCopy([1], 1)).toBe(1);

    // A copy the array does not reach is not turned, and is its full size.
    show([batch({ instanceRotations: [0.5], instanceScales: [2] })]);
    const mesh = nodeById<THREE.InstancedMesh>('rails');
    expect(close(matrixOf(mesh, 0), composed([0, 0, 0], aboutY(0.5), [2, 2, 2]))).toBe(true);
    expect(close(matrixOf(mesh, 2), composed([0, 0, 4], aboutY(0), [1, 1, 1]))).toBe(true);
  });

  it('a new turn or size for the same copies is written into the mesh there is', () => {
    show([batch({ instanceRotations: [0, 0, 0] })]);
    const mesh = nodeById<THREE.InstancedMesh>('rails');
    show([batch({ instanceRotations: [0, 1, 0], instanceScales: [1, 1, 4] })]);
    expect(nodeById('rails')).toBe(mesh);
    expect(close(matrixOf(mesh, 1), composed([4, 0, 0], aboutY(1), [1, 1, 1]))).toBe(true);
    expect(close(matrixOf(mesh, 2), composed([0, 0, 4], aboutY(0), [4, 4, 4]))).toBe(true);
    // And taken away again, each copy is only its position.
    show([batch({})]);
    expect(close(matrixOf(mesh, 2), new THREE.Matrix4().makeTranslation(0, 0, 4))).toBe(true);
  });

  it('a click lands on a copy where it now lies', () => {
    // A rail four long and thin, turned a quarter turn: it lies along z, not x.
    const clicks: Scene3DHit[] = [];
    act(() =>
      root.render(
        <Scene3D
          lights={[]}
          camera={{ position: v(0, 10, 0.001), lookAt: v(0, 0, 0) }}
          objects={[
            { id: 'rail', type: 'instanced', shape: 'box', width: 4, height: 0.2, depth: 0.2, instances: [0, 0, 0], instanceRotations: [Math.PI / 2] },
          ]}
          onClick={(hit) => clicks.push(hit)}
          onMiss={(hit) => clicks.push(hit)}
        />
      )
    );
    const canvas = placeCanvas(canvasOf(), 300, 300) as Canvas;
    // As a drawn frame would have left them: the renderer here is a double.
    canvas.__softnScene.updateMatrixWorld(true);
    (canvas as Canvas & { __softnCamera: THREE.Camera }).__softnCamera.updateMatrixWorld();
    const click = (x: number, y: number, id: number) =>
      act(() => {
        canvas.dispatchEvent(pointerEvent('pointerdown', id, x, y));
        canvas.dispatchEvent(pointerEvent('pointerup', id, x, y));
      });
    // Seen from above, z runs down the screen: a point well along z is on the rail, one along x is not.
    click(150, 190, 1);
    click(190, 150, 2);
    expect(clicks.map((hit) => hit.objectId)).toEqual(['rail', '']);
  });
});
