/**
 * The page's side of a 3D scene (SplitRealmSceneHost): how many scenes it keeps at once.
 * This test's page has no WebGL: a stand-in Three.js is the host's own (`hostThree`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerArchive } from '../src/archive';
import type { ThreeSceneOp } from '../src/types';
import { SplitRealmSceneHost } from '../src/vendor/webgl-scene-host';

vi.mock('three', () => {
  throw new Error('three is not installed');
});

const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function standInThree() {
  class Obj { children: Obj[] = []; parent: Obj | null = null; position = { set() {} }; rotation = { set() {} }; scale = { set() {} };
    add(c: Obj) { c.parent = this; this.children.push(c); } remove(c: Obj) { this.children = this.children.filter((x) => x !== c); } traverse(fn: (o: Obj) => void) { fn(this); } }
  class WebGLRenderer { static made = 0; constructor() { WebGLRenderer.made++; } setClearColor() {} render() {} setPixelRatio() {} setSize() {} dispose() {} getContext() { return null; } }
  return { WebGLRenderer, Scene: Obj, Group: Obj, PerspectiveCamera: Obj, Color: class {} };
}

describe('the scenes the page draws for an app', () => {
  const scope = globalThis as { WebGL2RenderingContext?: unknown };
  const had = scope.WebGL2RenderingContext;
  beforeEach(() => {
    scope.WebGL2RenderingContext = class {};
  });
  afterEach(() => {
    scope.WebGL2RenderingContext = had;
  });

  it('makes a new scene while four others are drawing (each counted once)', async () => {
    // A canvas with a scene and a frame waiting to be drawn was counted twice against the eight
    // scenes the page keeps: while four scenes drew, a fifth's first frame (the one that makes
    // its scene) was dropped, and that canvas stayed blank for good.
    const THREE = standInThree();
    const host = new SplitRealmSceneHost({} as ContainerArchive, 'http://softn.invalid/runtime/', () => Promise.resolve(THREE));
    const canvases = [1, 2, 3, 4, 5].map(() => document.createElement('canvas'));
    const init = [['init', {}], ['group', 1], ['camera', 2, 'perspective', [50, 1, 0.1, 100]]] as unknown as ThreeSceneOp[];
    const frame = [['render', 1, 2]] as unknown as ThreeSceneOp[];
    for (let id = 1; id <= 4; id++) host.enqueue(canvases[id - 1], id, init);
    await settle();
    expect(THREE.WebGLRenderer.made).toBe(4);
    // A turn in which the four draw a frame and a fifth scene is made.
    for (let id = 1; id <= 4; id++) host.enqueue(canvases[id - 1], id, frame);
    host.enqueue(canvases[4], 5, init);
    await settle();
    expect(THREE.WebGLRenderer.made).toBe(5);
    expect((host as unknown as { scenes: Map<number, unknown> }).scenes.has(5)).toBe(true);
    // Still no more than eight, made in one turn or in many.
    for (let id = 6; id <= 10; id++) host.enqueue(document.createElement('canvas'), id, init);
    await settle();
    host.enqueue(document.createElement('canvas'), 11, init);
    await settle();
    expect(THREE.WebGLRenderer.made).toBe(8);
    host.dispose();
  });
});
