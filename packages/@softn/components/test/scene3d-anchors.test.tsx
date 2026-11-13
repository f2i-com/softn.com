/**
 * Page content pinned to a place in the scene (`<SceneAnchor>`).
 *
 * The scene is 800 by 600 with its camera five units back from the middle,
 * so the middle of the scene is the pixel (400, 300). Each test asks three.js
 * itself where a point of the world is drawn and holds the anchor's CSS
 * transform to that. The render loop is run by hand; nothing is drawn (the
 * renderer is a double), which is also how it is known that an anchor is
 * moved without the page being rendered again.
 */

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRoot, type Root } from 'react-dom/client';
import { ComponentRegistry, parse, renderDocument, type SoftNRenderContext } from '@softn/core';
import { Scene3D, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { SceneAnchor } from '../src/threed/SceneAnchor';
import { registerBuiltinComponents } from '../src/registry';
import { registerRuntimeComponents } from '../src/entries/lazy';
import { stubFetch, stubFrames, type FrameStub } from './scene3d-doubles';

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

type Canvas = HTMLCanvasElement & { __softnScene: THREE.Scene; __softnCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera };
const canvasOf = () => container.querySelector('canvas') as Canvas;
const v = (x: number, y: number, z: number) => ({ x, y, z });
const camera = { position: v(0, 0, 5), lookAt: v(0, 0, 0) };

function show(objects: Scene3DObject[], children: React.ReactNode, props: Partial<Scene3DProps> = {}): void {
  act(() =>
    root.render(
      <Scene3D objects={objects} camera={camera} lights={[]} {...props}>
        {children}
      </Scene3D>
    )
  );
}
function frame(ms = 16): void {
  now += ms;
  act(() => frames.runFrame(now));
}
const anchorEl = (index = 0) => container.querySelectorAll<HTMLElement>('[data-scene-anchor]')[index];
/** Where an anchor has been put, and how its content sits about that place. */
function placed(el: HTMLElement): { x: number; y: number; shift: string } {
  const match = /^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0(?:px)?\) (.+)$/.exec(el.style.transform);
  if (!match) throw new Error(`not a place: "${el.style.transform}"`);
  return { x: Number(match[1]), y: Number(match[2]), shift: match[3] };
}
/** Where three.js draws a point of the world, in the scene's 800 by 600 pixels. */
function drawnAt(x: number, y: number, z: number): { x: number; y: number } {
  const cam = canvasOf().__softnCamera;
  cam.updateMatrixWorld();
  const p = new THREE.Vector3(x, y, z).project(cam);
  return { x: Math.round((p.x + 1) * 0.5 * 800 * 10) / 10, y: Math.round((1 - p.y) * 0.5 * 600 * 10) / 10 };
}
const box = (id: string, x: number, y = 0, z = 0, extra: Partial<Scene3DObject> = {}): Scene3DObject => ({ id, type: 'box', position: v(x, y, z), ...extra });

describe('an anchor on an object', () => {
  it('is put over where the object is drawn, its middle on the object’s own place', () => {
    show([box('pump', 0)], <SceneAnchor object="pump">Pump</SceneAnchor>);
    const el = anchorEl();
    // Not shown until the scene has put it somewhere.
    expect(el.style.visibility).toBe('hidden');
    frame();
    expect(el.style.visibility).toBe('visible');
    expect(placed(el)).toEqual({ x: 400, y: 300, shift: 'translate(-50%, -50%)' });
    expect(el.textContent).toBe('Pump');
    expect(el.style.position).toBe('absolute');

    show([box('pump', 1.5, -1, 0)], <SceneAnchor object="pump">Pump</SceneAnchor>);
    frame();
    expect(placed(el)).toMatchObject(drawnAt(1.5, -1, 0));
    // To the right of the middle and below it.
    expect(placed(el).x).toBeGreaterThan(400);
    expect(placed(el).y).toBeGreaterThan(300);
  });

  it('is offset along the scene’s axes, however the object is turned', () => {
    show(
      [box('figure', 1, 0, 0, { rotation: v(0, 0, Math.PI / 2) })],
      <SceneAnchor object="figure" offset={{ y: 1 }}>
        Ada
      </SceneAnchor>
    );
    frame();
    expect(placed(anchorEl())).toMatchObject(drawnAt(1, 1, 0));
  });

  it('sits about the pin as `place` says', () => {
    const at = (place: 'center' | 'above' | 'below' | 'left' | 'right') => {
      show([box('pump', 0)], <SceneAnchor object="pump" place={place} />);
      frame();
      return placed(anchorEl()).shift;
    };
    expect(at('above')).toBe('translate(-50%, -100%)');
    expect(at('below')).toBe('translate(-50%, 0)');
    expect(at('left')).toBe('translate(-100%, -50%)');
    expect(at('right')).toBe('translate(0, -50%)');
    expect(at('center')).toBe('translate(-50%, -50%)');
  });

  it('goes with a group’s child, where the child is in the world', () => {
    const train: Scene3DObject = { id: 'train', type: 'group', position: v(1, 0, 0), children: [box('cab', 0, 1, 0)] };
    show([train], <SceneAnchor object="cab">Cab</SceneAnchor>);
    frame();
    expect(placed(anchorEl())).toMatchObject(drawnAt(1, 1, 0));
    show([{ ...train, position: v(-1, 0, 0) }], <SceneAnchor object="cab">Cab</SceneAnchor>);
    frame();
    expect(placed(anchorEl())).toMatchObject(drawnAt(-1, 1, 0));
  });

  it('goes with a model, from the moment it is asked for', () => {
    stubFetch({});
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const robot = (x: number): Scene3DObject => ({ id: 'robot', type: 'model', modelUrl: 'https://models.test/robot.glb', position: v(x, 0, 0) });
    show([robot(1)], <SceneAnchor object="robot">Robot</SceneAnchor>);
    frame();
    expect(placed(anchorEl())).toMatchObject(drawnAt(1, 0, 0));
    show([robot(-1)], <SceneAnchor object="robot">Robot</SceneAnchor>);
    frame();
    expect(placed(anchorEl())).toMatchObject(drawnAt(-1, 0, 0));
  });

  it('follows the camera as well as the object', () => {
    show([box('pump', 1)], <SceneAnchor object="pump" />);
    frame();
    const before = placed(anchorEl());
    show([box('pump', 1)], <SceneAnchor object="pump" />, { camera: { position: v(0, 0, 10), lookAt: v(0, 0, 0) } });
    frame();
    const after = placed(anchorEl());
    // Twice as far away, the object is drawn half as far from the middle.
    expect(after.x - 400).toBeCloseTo((before.x - 400) / 2, 0);
    expect(after).toMatchObject(drawnAt(1, 0, 0));

    show([box('pump', 1)], <SceneAnchor object="pump" />, { camera: { type: 'orthographic', size: 6, position: v(0, 0, 10), lookAt: v(0, 0, 0) } });
    frame();
    // Six units in 600 pixels: a unit is a hundred of them.
    expect(placed(anchorEl())).toEqual({ x: 500, y: 300, shift: 'translate(-50%, -50%)' });
  });
});

describe('an anchor at a fixed position', () => {
  it('is put where that position is drawn', () => {
    show([], <SceneAnchor position={v(-1, 1, 0)} offset={{ x: 0.5 }} place="right">Exit</SceneAnchor>);
    frame();
    expect(placed(anchorEl())).toEqual({ ...drawnAt(-0.5, 1, 0), shift: 'translate(0, -50%)' });
    expect(anchorEl().style.visibility).toBe('visible');
  });
});

describe('an anchor moves with its object without the page being rendered again', () => {
  it('through an eased move: one transform a frame, and its content rendered once', () => {
    let renders = 0;
    const Label = () => {
      renders++;
      return <span>Ada</span>;
    };
    const label = (
      <SceneAnchor object="figure" offset={{ y: 1 }} place="above">
        <Label />
      </SceneAnchor>
    );
    show([box('figure', 0)], label, { transition: 400 });
    frame();
    const el = anchorEl();
    expect(placed(el)).toMatchObject(drawnAt(0, 1, 0));
    const rendered = renders;

    // The tick moves the figure; the page is rendered for that, once.
    show([box('figure', 2)], label, { transition: 400 });
    const afterTick = renders;
    expect(afterTick - rendered).toBeLessThanOrEqual(1);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      frame(100);
      seen.push(placed(el).x);
    }
    // A quarter, a half, three quarters of the way, and there: each a new place.
    expect(seen[0]).toBe(drawnAt(0.5, 1, 0).x);
    expect(seen[1]).toBe(drawnAt(1, 1, 0).x);
    expect(seen[2]).toBe(drawnAt(1.5, 1, 0).x);
    expect(seen[3]).toBe(drawnAt(2, 1, 0).x);
    // And nothing was rendered for any of them.
    expect(renders).toBe(afterTick);
    expect(anchorEl()).toBe(el);
  });

  it('is written only when it has moved', () => {
    show([box('pump', 1)], <SceneAnchor object="pump" />);
    frame();
    const el = anchorEl();
    const observer = new MutationObserver(() => undefined);
    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    for (let i = 0; i < 5; i++) frame();
    expect(observer.takeRecords()).toHaveLength(0);
    show([box('pump', 1.2)], <SceneAnchor object="pump" />);
    frame();
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
  });
});

describe('an anchor hides', () => {
  it('while its place is behind the camera, and shows again when it is in front', () => {
    show([box('pump', 0, 0, 8)], <SceneAnchor object="pump" />);
    frame();
    const el = anchorEl();
    expect(el.style.visibility).toBe('hidden');
    show([box('pump', 0, 0, -8)], <SceneAnchor object="pump" />);
    frame();
    expect(el.style.visibility).toBe('visible');
    expect(placed(el)).toMatchObject({ x: 400, y: 300 });
  });

  it('while its place is outside the view, or beyond what the camera draws', () => {
    show([box('pump', 30, 0, 0)], <SceneAnchor object="pump" />);
    frame();
    const el = anchorEl();
    expect(el.style.visibility).toBe('hidden');
    show([box('pump', 2, 0, 0)], <SceneAnchor object="pump" />);
    frame();
    expect(el.style.visibility).toBe('visible');
    show([box('pump', 0, 40, 0)], <SceneAnchor object="pump" />);
    frame();
    expect(el.style.visibility).toBe('hidden');
    show([box('pump', 0, 0, -200)], <SceneAnchor object="pump" />, { camera: { ...camera, far: 50 } });
    frame();
    expect(el.style.visibility).toBe('hidden');
  });

  it('while no object has the id it names, and comes back with the object', () => {
    show([box('other', 0)], <SceneAnchor object="pump" />);
    frame();
    const el = anchorEl();
    expect(el.style.visibility).toBe('hidden');
    show([box('other', 0), box('pump', 1)], <SceneAnchor object="pump" />);
    frame();
    expect(el.style.visibility).toBe('visible');
    show([box('other', 0)], <SceneAnchor object="pump" />);
    frame();
    expect(el.style.visibility).toBe('hidden');
    // An anchor that names nothing at all has nowhere to be.
    show([box('other', 0)], <SceneAnchor />);
    frame();
    expect(anchorEl().style.visibility).toBe('hidden');
  });

  it('by the size of its content, where that is known: a card half out of the view is still shown', () => {
    // jsdom lays nothing out and has no ResizeObserver: the anchor is told
    // its size here as a browser would have told it.
    const measured: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(measure: () => void) {
          measured.push(measure);
        }
        observe() {}
        disconnect() {}
      }
    );
    show([box('pump', -4.5, 0, 0)], <SceneAnchor object="pump" place="right" />);
    const card = anchorEl();
    Object.defineProperty(card, 'offsetWidth', { configurable: true, value: 200 });
    Object.defineProperty(card, 'offsetHeight', { configurable: true, value: 100 });
    act(() => {
      for (const measure of measured) measure();
    });
    frame();
    // Its pin is off the left edge, but it reaches 200 pixels to the right of that.
    expect(drawnAt(-4.5, 0, 0).x).toBeLessThan(0);
    expect(drawnAt(-4.5, 0, 0).x).toBeGreaterThan(-200);
    expect(card.style.visibility).toBe('visible');
    show([box('pump', -8, 0, 0)], <SceneAnchor object="pump" place="right" />);
    frame();
    expect(card.style.visibility).toBe('hidden');
  });
});

describe('what a scene shows of its children', () => {
  it('is its anchors and nothing else: anything else written inside it stays unseen, as it was', () => {
    show(
      [box('pump', 0)],
      <>
        <p id="stray">not an anchor</p>
        <SceneAnchor object="pump">Pump</SceneAnchor>
      </>
    );
    frame();
    const layer = container.querySelector<HTMLElement>('[data-scene-anchors]') as HTMLElement;
    expect(layer.style.visibility).toBe('hidden');
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.contains(container.querySelector('#stray'))).toBe(true);
    expect(anchorEl().style.visibility).toBe('visible');
  });

  it('has no layer for them when it has none', () => {
    act(() => root.render(<Scene3D objects={[box('pump', 0)]} camera={camera} lights={[]} />));
    expect(container.querySelector('[data-scene-anchors]')).toBeNull();
  });

  it('several anchors are each put in their own place, and one that goes is no longer moved', () => {
    const anchors = (ids: string[]) => ids.map((id) => <SceneAnchor key={id} object={id}>{id}</SceneAnchor>);
    show([box('a', -1), box('b', 1)], anchors(['a', 'b']));
    frame();
    expect(placed(anchorEl(0))).toMatchObject(drawnAt(-1, 0, 0));
    expect(placed(anchorEl(1))).toMatchObject(drawnAt(1, 0, 0));
    const gone = anchorEl(0);
    const kept = anchorEl(1);
    const left = gone.style.transform;
    show([box('a', -2), box('b', 2)], anchors(['b']));
    frame();
    expect(container.querySelectorAll('[data-scene-anchor]')).toHaveLength(1);
    expect(anchorEl(0)).toBe(kept);
    expect(placed(kept)).toMatchObject(drawnAt(2, 0, 0));
    expect(gone.style.transform).toBe(left);
  });

  it('an anchor told to name another object goes to that one, as the same element', () => {
    show([box('a', -1), box('b', 1)], <SceneAnchor object="a">Selected</SceneAnchor>);
    frame();
    const el = anchorEl();
    expect(placed(el)).toMatchObject(drawnAt(-1, 0, 0));
    show([box('a', -1), box('b', 1)], <SceneAnchor object="b">Selected</SceneAnchor>);
    frame();
    expect(anchorEl()).toBe(el);
    expect(placed(el)).toMatchObject(drawnAt(1, 0, 0));
  });

  it('takes the pointer for its content unless it is told to let it through', () => {
    show(
      [box('pump', 0)],
      <>
        <SceneAnchor object="pump">
          <button>Open</button>
        </SceneAnchor>
        <SceneAnchor object="pump" clickThrough>
          Pump
        </SceneAnchor>
      </>
    );
    expect(anchorEl(0).style.pointerEvents).toBe('auto');
    expect(anchorEl(1).style.pointerEvents).toBe('none');
  });
});

describe('written in a page, as tags', () => {
  const page = `<Scene3D objects={things} camera={cam} lights={none}>
  <SceneAnchor object="pump" offset={{ y: 1 }} place="above" clickThrough>
    <Text>Pump {level}%</Text>
  </SceneAnchor>
  <SceneAnchor if={picked} object={picked} place="right">
    <Button>Open</Button>
  </SceneAnchor>
</Scene3D>`;
  const state = (picked: string) => ({
    things: [box('pump', 1), box('valve', -1)],
    cam: camera,
    none: [],
    level: 62,
    picked,
  });
  const drawPage = (registry: ComponentRegistry, picked: string) => {
    const doc = parse(page);
    expect(doc.diagnostics ?? []).toEqual([]);
    const context = { state: state(picked), setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
    act(() => root.render(<>{renderDocument(doc, context, registry)}</>));
  };

  it('through the registry every built-in is in: the label is over its object, and the second anchor comes and goes', () => {
    const registry = new ComponentRegistry();
    registerBuiltinComponents(registry);
    drawPage(registry, '');
    frame();
    expect(container.querySelectorAll('[data-scene-anchor]')).toHaveLength(1);
    const label = anchorEl(0);
    expect(label.textContent).toContain('Pump 62%');
    expect(label.style.visibility).toBe('visible');
    expect(label.style.pointerEvents).toBe('none');
    expect(placed(label)).toEqual({ ...drawnAt(1, 1, 0), shift: 'translate(-50%, -100%)' });

    drawPage(registry, 'valve');
    frame();
    expect(container.querySelectorAll('[data-scene-anchor]')).toHaveLength(2);
    expect(anchorEl(0)).toBe(label);
    expect(placed(anchorEl(1))).toEqual({ ...drawnAt(-1, 0, 0), shift: 'translate(0, -50%)' });
    expect(anchorEl(1).querySelector('button')?.textContent).toBe('Open');
    expect(anchorEl(1).style.pointerEvents).toBe('auto');
  });

  it('through the registry a browser host uses, where the scene and its anchors are one chunk fetched on demand', async () => {
    const registry = new ComponentRegistry();
    registerRuntimeComponents(registry);
    expect(registry.getFeature('SceneAnchor')).toBe('scene3d');
    expect(registry.getFeature('SceneAnchor')).toBe(registry.getFeature('Scene3D'));
    await act(() => registry.preload(['Scene3D', 'SceneAnchor', 'Text', 'Button']));
    drawPage(registry, 'valve');
    // Every frame asked for so far: the scene's, and the one the registry's
    // own loading asked for before it.
    now += 16;
    act(() => {
      for (let pending = frames.frames.length; pending > 0; pending--) frames.runFrame(now);
    });
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(container.querySelectorAll('[data-scene-anchor]')).toHaveLength(2);
    expect(placed(anchorEl(0))).toMatchObject(drawnAt(1, 1, 0));
    expect(placed(anchorEl(1))).toMatchObject(drawnAt(-1, 0, 0));
  });
});

describe('an anchor outside a scene', () => {
  it('shows nothing, and says why once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    act(() =>
      root.render(
        <div>
          <SceneAnchor object="pump">Pump</SceneAnchor>
          <SceneAnchor object="pump">Pump</SceneAnchor>
        </div>
      )
    );
    expect(container.textContent).toBe('');
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('SceneAnchor')).length).toBeLessThanOrEqual(1);
  });
});
