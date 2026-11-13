/**
 * What the pointer is told about the scene.
 *
 * Real rays against real three.js objects, with no GPU: the renderer is a
 * double, so each test asks the scene for its world matrices as a drawn
 * frame would have (`settle`). The canvas is 300 by 150 at the page's
 * corner; the camera stands at z = 5 looking at the origin, so the middle of
 * the canvas, (150, 75), is a ray down the z axis.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DHit, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { pickTargets, PICKABLE_KEY } from '../src/threed/picking';
import { placeCanvas, pointerEvent, stubFrames, type FrameStub } from './scene3d-doubles';

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

const camera = { position: { x: 0, y: 0, z: 5 }, lookAt: { x: 0, y: 0, z: 0 } };
type Canvas = HTMLCanvasElement & { __softnScene: THREE.Scene };

/** Draw a scene with the camera above, give its canvas a place, and bring its matrices up to date. */
function show(objects: Scene3DObject[], props: Partial<Scene3DProps> = {}): Canvas {
  act(() => root.render(<Scene3D objects={objects} camera={camera} lights={[]} {...props} />));
  const canvas = placeCanvas(container.querySelector('canvas') as Canvas) as Canvas;
  canvas.__softnScene.updateMatrixWorld(true);
  return canvas;
}

function nodeById(canvas: Canvas, id: string): THREE.Object3D {
  let found: THREE.Object3D | undefined;
  canvas.__softnScene.traverse((node) => {
    if (!found && node.userData.__softnId === id) found = node;
  });
  return found as THREE.Object3D;
}

/** A press and release in one place: a click. */
function click(canvas: Canvas, x: number, y: number, pointerId = 1): void {
  act(() => {
    canvas.dispatchEvent(pointerEvent('pointerdown', pointerId, x, y));
    canvas.dispatchEvent(pointerEvent('pointerup', pointerId, x, y));
  });
}

/** Run every frame asked for so far, and no frame those frames ask for. */
function runFrames(): void {
  act(() => {
    for (let pending = frames.frames.length; pending > 0; pending--) frames.runFrame();
  });
}

const door: Scene3DObject = { id: 'door', type: 'box', width: 4, height: 4, depth: 0.2 };

describe('every object is tagged for the pointer, not only a group’s', () => {
  it('a top-level primitive, an instanced batch and particles carry their cursor', () => {
    const canvas = show([
      { id: 'box', type: 'box', cursor: 'grab' },
      { id: 'crowd', type: 'instanced', shape: 'box', instances: [3, 0, 0], interactive: true },
      { id: 'sparks', type: 'particles', particlePositions: [0, 3, 0], cursor: 'help' },
    ]);
    expect(nodeById(canvas, 'box').userData.__softnCursor).toBe('grab');
    expect(nodeById(canvas, 'crowd').userData.__softnInteractive).toBe(true);
    expect(nodeById(canvas, 'sparks').userData.__softnCursor).toBe('help');
  });

  it('the cursor a top-level object asks for is shown over it, and taken away when it stops asking', () => {
    const canvas = show([{ ...door, interactive: true }]);
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, 150, 75)));
    runFrames();
    expect(canvas.style.cursor).toBe('pointer');

    act(() => root.render(<Scene3D objects={[{ ...door, cursor: 'crosshair' }]} camera={camera} lights={[]} />));
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, 151, 75)));
    runFrames();
    expect(canvas.style.cursor).toBe('crosshair');

    act(() => root.render(<Scene3D objects={[door]} camera={camera} lights={[]} />));
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, 152, 75)));
    runFrames();
    expect(canvas.style.cursor).toBe('default');
  });

  it('an instanced batch reports itself and the copy that was hit', () => {
    const clicks: Scene3DHit[] = [];
    const canvas = show(
      [{ id: 'crowd', type: 'instanced', shape: 'box', instances: [-3, 0, 0, 0, 0, 0], interactive: true }],
      { onClick: (hit) => clicks.push(hit) }
    );
    click(canvas, 150, 75);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ objectId: 'crowd', rootObjectId: 'crowd', instanceId: 1, cursor: 'pointer' });
  });
});

describe('what a click can land on', () => {
  it('a decorative cloud of particles does not take the click meant for what is behind it', () => {
    const clicks: Scene3DHit[] = [];
    // One particle 0.8 units off the ray, in front of the door: three tests
    // points with a radius of a whole unit, and this one won.
    const canvas = show(
      [door, { id: 'sparks', type: 'particles', particlePositions: [0.8, 0, 2], particleSize: 0.05 }],
      { onClick: (hit) => clicks.push(hit) }
    );
    click(canvas, 150, 75);
    expect(clicks.map((hit) => hit.objectId)).toEqual(['door']);
  });

  it('particles that ask to be picked are, at the size they are drawn', () => {
    const clicks: Scene3DHit[] = [];
    const sparks = (positions: number[], particleSize: number): Scene3DObject => ({
      id: 'sparks',
      type: 'particles',
      pickable: true,
      particlePositions: positions,
      particleSize,
    });
    // 0.8 off the ray and five hundredths across: not under the pointer.
    let canvas = show([door, sparks([0.8, 0, 2], 0.05)], { onClick: (hit) => clicks.push(hit) });
    click(canvas, 150, 75);
    expect(clicks.at(-1)?.objectId).toBe('door');
    // On the ray: under it.
    canvas = show([door, sparks([0, 0, 2], 0.4)], { onClick: (hit) => clicks.push(hit) });
    click(canvas, 150, 75);
    expect(clicks.at(-1)?.objectId).toBe('sparks');
  });

  it('`pickable: false` lets the pointer through, on a primitive and on a whole group', () => {
    const clicks: Scene3DHit[] = [];
    const glass: Scene3DObject = { id: 'glass', type: 'box', width: 4, height: 4, depth: 0.1, position: { x: 0, y: 0, z: 2 } };
    let canvas = show([door, glass], { onClick: (hit) => clicks.push(hit) });
    click(canvas, 150, 75);
    expect(clicks.at(-1)?.objectId).toBe('glass');

    canvas = show([door, { ...glass, pickable: false }], { onClick: (hit) => clicks.push(hit) });
    expect(nodeById(canvas, 'glass').userData[PICKABLE_KEY]).toBe(false);
    click(canvas, 150, 75);
    expect(clicks.at(-1)?.objectId).toBe('door');

    const screen: Scene3DObject = {
      id: 'screen',
      type: 'group',
      pickable: false,
      position: { x: 0, y: 0, z: 2 },
      children: [{ id: 'pane', type: 'box', width: 4, height: 4, depth: 0.1 }],
    };
    canvas = show([door, screen], { onClick: (hit) => clicks.push(hit) });
    click(canvas, 150, 75);
    expect(clicks.at(-1)?.objectId).toBe('door');

    // And it is picked again once it stops saying so.
    canvas = show([door, { ...screen, pickable: undefined }], { onClick: (hit) => clicks.push(hit) });
    click(canvas, 150, 75);
    expect(clicks.at(-1)).toMatchObject({ objectId: 'pane', rootObjectId: 'screen' });
  });

  it('pickTargets leaves out what is under an unpickable object, and particles that did not ask', () => {
    const tagged = (node: THREE.Object3D, id: string, pickable?: boolean) => {
      node.userData.__softnId = id;
      if (pickable !== undefined) node.userData[PICKABLE_KEY] = pickable;
      return node;
    };
    const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const cloud = () => new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());

    const open = tagged(new THREE.Group(), 'open');
    const child = tagged(mesh(), 'child');
    const shut = tagged(mesh(), 'shut', false);
    const quiet = tagged(cloud(), 'quiet');
    const loud = tagged(cloud(), 'loud', true);
    open.add(child, shut, quiet, loud);

    // A loaded model: its own nodes are not objects of the scene, and answer as it does.
    const model = tagged(new THREE.Group(), 'model', false);
    model.add(mesh());
    const pointModel = tagged(new THREE.Group(), 'points-model', true);
    const inner = cloud();
    pointModel.add(inner);

    const targets = pickTargets([open, model, pointModel]);
    expect(targets.solid).toEqual([open, child, pointModel]);
    expect(targets.clouds).toEqual([loud, inner]);
  });
});

describe('what a hit says about the pointer', () => {
  it('where it is in the scene’s own pixels, whatever the scene’s place on the page', () => {
    const downs: Scene3DHit[] = [];
    const canvas = show([door], { onPointerDown: (hit) => downs.push(hit) });
    placeCanvas(canvas, 300, 150, 40, 20);
    act(() => canvas.dispatchEvent(pointerEvent('pointerdown', 1, 190, 95)));
    expect(downs[0]).toMatchObject({ objectId: 'door', screen: { x: 150, y: 75 }, dragged: false, locked: false });
    act(() => canvas.dispatchEvent(pointerEvent('pointerup', 1, 190, 95)));
  });

  it('whether it moved between going down and coming up', () => {
    const ups: Scene3DHit[] = [];
    const moves: Scene3DHit[] = [];
    const clicks: Scene3DHit[] = [];
    const canvas = show([door], {
      onPointerUp: (hit) => ups.push(hit),
      onPointerMove: (hit) => moves.push(hit),
      onClick: (hit) => clicks.push(hit),
    });
    click(canvas, 150, 75);
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 150, 75));
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 152, 75));
    });
    // A move is reported in the frame after it, not as it happens.
    expect(moves).toEqual([]);
    runFrames();
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 180, 80));
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 180, 80));
    });
    expect(ups.map((hit) => hit.dragged)).toEqual([false, true]);
    expect(ups[1].screen).toEqual({ x: 180, y: 80 });
    // Two pixels is a shaky hand, thirty is a drag.
    expect(moves.map((hit) => hit.dragged)).toEqual([false, true]);
    // The drag is not a click; the press that stayed put is, and says so.
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ objectId: 'door', dragged: false, screen: { x: 150, y: 75 } });
  });
});

describe('a click on nothing', () => {
  it('is a miss, with where it was; a click on something is not', () => {
    const clicks: Scene3DHit[] = [];
    const misses: Scene3DHit[] = [];
    const small: Scene3DObject = { id: 'small', type: 'box', width: 0.5, height: 0.5, depth: 0.5 };
    const canvas = show([small], { onClick: (hit) => clicks.push(hit), onMiss: (hit) => misses.push(hit) });
    click(canvas, 20, 20);
    expect(clicks).toEqual([]);
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({
      objectId: '',
      point: null,
      distance: null,
      instanceId: null,
      screen: { x: 20, y: 20 },
      dragged: false,
      button: 0,
      locked: false,
    });
    click(canvas, 150, 75, 2);
    expect(clicks.map((hit) => hit.objectId)).toEqual(['small']);
    expect(misses).toHaveLength(1);
  });

  it('is not what the end of a drag over nothing is, nor a right click', () => {
    const misses: Scene3DHit[] = [];
    const canvas = show([], { onMiss: (hit) => misses.push(hit) });
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 200, 100));
      canvas.dispatchEvent(pointerEvent('pointerup', 1, 200, 100));
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 10, 10, 2));
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 10, 10, 2));
    });
    expect(misses).toEqual([]);
    click(canvas, 10, 10, 3);
    expect(misses).toHaveLength(1);
  });
});

describe('the pointer with no button held', () => {
  it('is looked at once a frame, at where it is by then', () => {
    const hovers: Scene3DHit[] = [];
    const canvas = show([door], { onHover: (hit) => hovers.push(hit) });
    act(() => {
      for (let i = 0; i < 5; i++) canvas.dispatchEvent(pointerEvent('pointermove', 1, 150 + i, 75));
    });
    // Five moves of the mouse were five rays and five calls into the app.
    expect(hovers).toEqual([]);
    runFrames();
    expect(hovers).toHaveLength(1);
    expect(hovers[0]).toMatchObject({ objectId: 'door', screen: { x: 154, y: 75 }, button: -1, dragged: false });

    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, 150, 76)));
    runFrames();
    expect(hovers).toHaveLength(2);
    // No move, no look.
    runFrames();
    expect(hovers).toHaveLength(2);
  });

  it('reports a change only when what is under it changes, to another object or to nothing', () => {
    const changes: Scene3DHit[] = [];
    const left: Scene3DObject = { id: 'left', type: 'box', position: { x: -1, y: 0, z: 0 } };
    const right: Scene3DObject = { id: 'right', type: 'box', position: { x: 1, y: 0, z: 0 } };
    const canvas = show([left, right], { onHoverChange: (hit) => changes.push(hit) });
    // A unit at the origin is about 39 pixels across: the left box is under
    // x = 85 to 128, the right one under 172 to 215, and both under y = 61 to 89.
    const over = (x: number, y = 75) => {
      act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, x, y)));
      runFrames();
    };
    over(98);
    over(100);
    over(102);
    expect(changes.map((hit) => hit.objectId)).toEqual(['left']);
    over(200);
    expect(changes.map((hit) => hit.objectId)).toEqual(['left', 'right']);
    over(202);
    over(150, 5);
    expect(changes.map((hit) => hit.objectId)).toEqual(['left', 'right', '']);
    expect(changes[2]).toMatchObject({ point: null, screen: { x: 150, y: 5 } });
    // Nothing still: no further word.
    over(150, 8);
    expect(changes).toHaveLength(3);
  });

  it('says so when the pointer leaves the scene, and drops a look it had not yet taken', () => {
    const changes: Scene3DHit[] = [];
    const hovers: Scene3DHit[] = [];
    const canvas = show([door], { onHoverChange: (hit) => changes.push(hit), onHover: (hit) => hovers.push(hit) });
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, 150, 75)));
    runFrames();
    expect(changes.map((hit) => hit.objectId)).toEqual(['door']);

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 151, 75));
      canvas.dispatchEvent(pointerEvent('pointerleave', 1, 400, 75));
    });
    expect(changes.map((hit) => hit.objectId)).toEqual(['door', '']);
    runFrames();
    expect(hovers).toHaveLength(1);
    // Leaving again says nothing: nothing was under the pointer.
    act(() => canvas.dispatchEvent(pointerEvent('pointerleave', 1, 400, 75)));
    expect(changes).toHaveLength(2);
  });

  it('tells one copy of an instanced object from the next', () => {
    const changes: Scene3DHit[] = [];
    const canvas = show(
      [{ id: 'crowd', type: 'instanced', shape: 'box', instances: [-1, 0, 0, 1, 0, 0] }],
      { onHoverChange: (hit) => changes.push(hit) }
    );
    const over = (x: number) => {
      act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, x, 75)));
      runFrames();
    };
    over(100);
    over(101);
    over(200);
    expect(changes.map((hit) => [hit.objectId, hit.instanceId])).toEqual([
      ['crowd', 0],
      ['crowd', 1],
    ]);
  });

  it('asks for no frame once the scene has gone', () => {
    const canvas = show([door], { onHover: () => undefined });
    act(() => canvas.dispatchEvent(pointerEvent('pointermove', 1, 150, 75)));
    const asked = frames.raf.mock.results.at(-1)?.value as number;
    act(() => root.render(<div />));
    expect(frames.caf).toHaveBeenCalledWith(asked);
  });
});
