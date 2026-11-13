/**
 * The examples the guides and the front page show (docs/examples/*.ui), run for real: parsed without a word, drawn
 * by the loader, their logic run in the engine, and used the way a reader would. Each is shown from its file — the
 * site imports it, and the guides' copy is held to it below — so what a page teaches is what runs.
 */
import React, { act } from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from '../src/parser';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { registerComponent, type SoftNComponent } from '../src/renderer/registry';
import { App } from '../../components/src/layout/App';
import { Stack } from '../../components/src/layout/Stack';
import { Card } from '../../components/src/layout/Card';
import { Heading } from '../../components/src/display/Heading';
import { Text } from '../../components/src/display/Text';
import { Button } from '../../components/src/form/Button';
import { Loop } from '../../components/src/utility/Loop';
import { Controls } from '../../components/src/utility/Controls';
import { DPad } from '../../components/src/utility/DPad';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXAMPLES = join(__dirname, '../../../../docs/examples');
const example = (name: string) => readFileSync(join(EXAMPLES, name), 'utf8');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the page handed its `<Scene3D>`, kept for the test to read and to
 * call: the scene itself needs a graphics card, and what an example has to
 * get right is the lists it gives the scene and what it does with a click.
 */
const scene: { props: Record<string, unknown> | null; anchors: Record<string, unknown>[] } = { props: null, anchors: [] };

beforeAll(() => {
  for (const [name, component] of Object.entries({ App, Stack, Card, Heading, Text, Button, Loop, Controls, DPad })) {
    registerComponent(name, component as unknown as SoftNComponent);
  }
  // What is written inside the scene (a `<SceneAnchor>` and what it holds) is on the page: the
  // real scene keeps it over its object, and what it holds is drawn by the page as anything is.
  registerComponent('Scene3D', ((props: Record<string, unknown>) => {
    scene.props = props;
    scene.anchors = [];
    return <div data-scene="">{props.children as React.ReactNode}</div>;
  }) as unknown as SoftNComponent);
  registerComponent('SceneAnchor', ((props: Record<string, unknown>) => {
    scene.anchors.push(props);
    return <div data-anchor={String(props.object ?? '')}>{props.children as React.ReactNode}</div>;
  }) as unknown as SoftNComponent);
});

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  scene.props = null;
  scene.anchors = [];
  vi.unstubAllGlobals();
});

async function mount(source: string, appId: string, ready: () => boolean, active = true) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const draw = (shown: boolean) => root!.render(<SoftNRenderer source={source} appId={appId} scriptExecutionMode="main" active={shown} />);
  await act(async () => {
    root = createRoot(container);
    draw(active);
  });
  for (let i = 0; i < 150 && !ready(); i++) {
    await act(async () => { await sleep(20); });
  }
  expect(ready(), 'the page and its logic loaded').toBe(true);
  /** Show the app or put it in the background, as a host with several open does. */
  return async (shown: boolean) => {
    await act(async () => {
      draw(shown);
      await sleep(30);
    });
  };
}

// ── The screen's frames, drawn when a test says ──────────────────────────────
let frames = new Map<number, (stamp: number) => void>();
let frameClock = 1000;

/** Take the screen's clock: a `<Loop frame>` ticks when `frame()` is called and not before. */
function ownTheFrames() {
  frames = new Map();
  frameClock = 1000;
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: (stamp: number) => void) => {
    frames.set(next, callback);
    return next++;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames.delete(handle);
  });
}

/** The screen draws once, `ms` after the last time, and the page settles. */
async function frame(ms = 16) {
  frameClock += ms;
  const due = [...frames.values()];
  frames = new Map();
  await act(async () => {
    for (const callback of due) callback(frameClock);
    await sleep(12);
  });
}

/** A key as a browser sends one, from the page with nothing focused. */
async function key(type: 'keydown' | 'keyup', name: string, code: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent(type, { key: name, code, bubbles: true, cancelable: true });
  await act(async () => {
    document.body.dispatchEvent(event);
    await sleep(12);
  });
  return event;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(20);
  });
}

async function press(button: HTMLElement) {
  await act(async () => {
    button.click();
    await sleep(60);
  });
}

const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('the examples the guides show', () => {
  it('every one parses without a word', () => {
    const files = readdirSync(EXAMPLES).filter((file) => file.endsWith('.ui'));
    expect(files).toEqual(expect.arrayContaining(['first-counter.ui', 'hello-name.ui']));
    for (const file of files) expect(parse(example(file)).diagnostics ?? [], file).toEqual([]);
  });

  it('the guide shows hello-name as the file has it', () => {
    const docs = JSON.parse(readFileSync(join(__dirname, '../../../../docs/content/softn-docs.json'), 'utf8')) as { pages: { slug: string; sections: { blocks: { type: string; code?: string; caption?: string }[] }[] }[] };
    const guide = docs.pages.find((page) => page.slug === 'html-and-softn')!;
    const shown = guide.sections.flatMap((section) => section.blocks).find((block) => block.caption?.includes('hello-name.ui'));
    expect(shown?.code?.trim()).toBe(example('hello-name.ui').replace(/\r\n/g, '\n').trim());
  });

  it('hello-name: an HTML page with SoftN in it — the field binds, the button runs the logic, the text shows it', async () => {
    await mount(example('hello-name.ui'), 'docs-hello-name', () => Boolean(container.querySelector('main.card input#visitor')) && Boolean(button('Say hello')));
    const label = container.querySelector('label') as HTMLLabelElement;
    expect(label.textContent).toBe('Your name');
    expect(label.getAttribute('for')).toBe('visitor');
    await type(container.querySelector('#visitor') as HTMLInputElement, 'Ada');
    await press(button('Say hello'));
    expect(container.querySelector('main.card p')?.textContent).toBe('Hello, Ada');
  });

  it('first-counter: SoftN components and a logic function', async () => {
    await mount(example('first-counter.ui'), 'docs-first-counter', () => (container.textContent ?? '').includes('Count: 0'));
    await press(button('Increment'));
    await press(button('Increment'));
    expect(container.textContent).toContain('Count: 2');
  });
});

/**
 * The examples of the guide to games and 3D scenes. Each is played here for a
 * few ticks, by a person's keys and clicks, so what the guide teaches is a
 * game that runs: the loop, the controls, the names shared with a scene.
 */
describe('the examples of the games and 3D guide', () => {
  const GUIDE_EXAMPLES = ['game-dodge.ui', 'scene-parts.ui', 'game-walk.ui', 'game-chase.ui', 'scene-film.ui'];
  const realWin = window as unknown as Record<string, unknown>;
  const SCENE_NAMES = ['__scene3dYaw', '__scene3dPitch', '__scene3dLocked', '__scene3dWantLock', '__scene3dReleaseLock'];

  afterEach(() => {
    for (const name of SCENE_NAMES) delete realWin[name];
  });

  it('the guide shows each as its file has it, and shows no page that is not one of them', () => {
    const docs = JSON.parse(readFileSync(join(__dirname, '../../../../docs/content/softn-docs.json'), 'utf8')) as {
      pages: { id: string; sections: { blocks: { type: string; language?: string; code?: string; caption?: string }[] }[] }[];
    };
    const blocks = docs.pages.find((page) => page.id === 'threejs-games')!.sections.flatMap((section) => section.blocks);
    for (const file of GUIDE_EXAMPLES) {
      const shown = blocks.find((block) => block.type === 'code' && block.caption?.includes(`docs/examples/${file}`));
      expect(shown, `${file} is shown in the guide`).toBeDefined();
      expect(shown!.code!.trim(), file).toBe(example(file).replace(/\r\n/g, '\n').trim());
    }
    // A whole page in the guide is one of the files above. A few lines shown
    // by themselves are taken from one of them, word for word, so they are
    // lines a test has run.
    const run = GUIDE_EXAMPLES.map((file) => example(file).replace(/\r\n/g, '\n'));
    const lines = (code: string) => code.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const block of blocks.filter((b) => b.type === 'code' && (b.language === 'softn' || b.language === 'javascript'))) {
      if (GUIDE_EXAMPLES.some((file) => block.caption?.includes(`docs/examples/${file}`))) continue;
      const from = run.find((source) => lines(block.code!).every((line) => source.includes(line)));
      expect(from, `these lines are in none of the examples the tests run:\n${block.code}`).toBeDefined();
    }
  });

  it('game-dodge: a 2D game on the screen’s frames, played with the keys', async () => {
    ownTheFrames();
    const show = await mount(example('game-dodge.ui'), 'docs-game-dodge', () => (container.textContent ?? '').includes('Press Space to start'));
    const text = () => container.textContent ?? '';
    const left = (selector: string) => parseFloat((container.querySelector(selector) as HTMLElement).style.left);
    const rocks = () => [...container.querySelectorAll<HTMLElement>('.rock')];
    expect(text()).toContain('Score 0');
    expect(rocks()).toHaveLength(0);

    // Nothing moves until the game is started: the loop is not running.
    await frame();
    await frame();
    expect(rocks()).toHaveLength(0);

    // Space starts it, and is kept from the page, which would have scrolled.
    const space = await key('keydown', ' ', 'Space');
    await key('keyup', ' ', 'Space');
    expect(space.defaultPrevented).toBe(true);
    expect(text()).not.toContain('Press Space to start');

    // The first frame sets the clock and each one after is a step: a rock falls.
    await frame();
    await frame();
    await frame();
    expect(rocks().length).toBeGreaterThanOrEqual(1);
    const fell = parseFloat(rocks()[0].style.top);
    await frame();
    expect(parseFloat(rocks()[0].style.top)).toBeGreaterThan(fell);

    // Held, the right arrow moves the player by its speed times the frame's time, and the page does not scroll.
    const before = left('.player');
    const right = await key('keydown', 'ArrowRight', 'ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    await frame(20);
    await frame(20);
    const moved = left('.player') - before;
    expect(moved).toBeGreaterThan(4);
    expect(moved).toBeLessThan(15);
    // Let go, it stops.
    await key('keyup', 'ArrowRight', 'ArrowRight');
    const stopped = left('.player');
    await frame(20);
    expect(left('.player')).toBe(stopped);

    // Put in the background, the game pauses itself (_onHide), and nothing falls.
    await show(false);
    expect(text()).toContain('Paused');
    const paused = rocks().map((rock) => rock.style.top);
    await frame(500);
    await frame(500);
    expect(rocks().map((rock) => rock.style.top)).toEqual(paused);

    // Back, it waits for the player, and goes on from where it was.
    await show(true);
    expect(text()).toContain('Paused');
    await press(button('Resume'));
    expect(text()).not.toContain('Paused');
    await frame();
    await frame();
    expect(parseFloat(rocks()[0].style.top)).toBeGreaterThan(parseFloat(paused[0]));

    // Played on, every rock either goes past (and scores) or hits (and ends the game).
    for (let i = 0; i < 60 && !text().includes('Hit!') && text().includes('Score 0'); i++) await frame(180);
    expect(text().includes('Hit!') || !text().includes('Score 0')).toBe(true);
  }, 60_000);

  it('game-dodge: the pad on screen moves the player as the keys do', async () => {
    ownTheFrames();
    await mount(example('game-dodge.ui'), 'docs-game-dodge-touch', () => (container.textContent ?? '').includes('Press Space to start'));
    const left = () => parseFloat((container.querySelector('.player') as HTMLElement).style.left);
    await press(button('Start'));
    await frame();
    const before = left();
    const padLeft = container.querySelector('button[aria-label="Left"]') as HTMLElement;
    await act(async () => {
      padLeft.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await sleep(12);
    });
    await frame(20);
    await frame(20);
    expect(left()).toBeLessThan(before - 4);
    await act(async () => {
      padLeft.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      await sleep(12);
    });
    const stopped = left();
    await frame(20);
    expect(left()).toBe(stopped);
  }, 60_000);

  it('scene-parts: a page with a 3D scene whose parts are clicked for their reading', async () => {
    await mount(example('scene-parts.ui'), 'docs-scene-parts', () => Array.isArray(scene.props?.objects) && (scene.props!.objects as unknown[]).length === 4);
    type Drawn = { id: string; type: string; emissiveIntensity?: number; scale?: number; pickable?: boolean };
    const objects = () => scene.props!.objects as Drawn[];
    const anchored = () => container.querySelector('[data-anchor]');
    expect(objects().map((object) => [object.id, object.type])).toEqual([['pump', 'cylinder'], ['valve', 'torus'], ['tank', 'capsule'], ['ground', 'plane']]);
    expect(scene.props!.lights).toHaveLength(2);
    expect(scene.props!.orbitControls).toBe(true);
    expect(scene.props!.orbit).toEqual({ minDistance: 4, maxDistance: 14, maxPolar: 1.45 });
    expect(scene.props!.transition).toBe(250);
    expect(scene.props!.fill).toBe(true);
    // The ground is scenery: the scene is told not to answer a click on it.
    expect(objects().find((object) => object.id === 'ground')!.pickable).toBe(false);
    expect(container.textContent).not.toContain('Open 40%');
    expect(anchored()).toBeNull();

    // A click on the valve, as the scene reports one.
    const click = async (objectId: string) => {
      await act(async () => {
        (scene.props!.onClick as (hit: { objectId: string }) => void)({ objectId });
        await sleep(60);
      });
    };
    await click('valve');
    // Its reading is pinned over it, in the scene, lifted clear of it.
    expect(anchored()?.getAttribute('data-anchor')).toBe('valve');
    expect(scene.anchors.at(-1)).toMatchObject({ object: 'valve', place: 'above', offset: { y: 0.8 } });
    expect(anchored()!.textContent).toContain('Valve');
    expect(anchored()!.textContent).toContain('Open 40%');
    // The chosen part is lit from within and a little larger; the scene eases it there.
    expect(objects().find((object) => object.id === 'valve')).toMatchObject({ emissiveIntensity: 0.6, scale: 1.15 });
    expect(objects().find((object) => object.id === 'pump')).toMatchObject({ emissiveIntensity: 0, scale: 1 });

    await click('tank');
    expect(anchored()?.getAttribute('data-anchor')).toBe('tank');
    expect(container.textContent).toContain('62% full');
    expect(container.textContent).not.toContain('Open 40%');

    // A click on nothing, as the scene reports one, puts the card away, and so does Close.
    await act(async () => {
      (scene.props!.onMiss as () => void)();
      await sleep(60);
    });
    expect(container.textContent).not.toContain('62% full');
    expect(anchored()).toBeNull();
    await click('pump');
    expect(container.textContent).toContain('1450 rpm');
    await press(button('Close'));
    expect(container.textContent).not.toContain('1450 rpm');
  }, 60_000);

  it('scene-film: a film made in Blender, held at the second the page’s clock says and seen through the file’s own cameras', async () => {
    ownTheFrames();
    await mount(example('scene-film.ui'), 'docs-scene-film', () => Array.isArray(scene.props?.objects) && (scene.props!.objects as unknown[]).length === 1);
    type Film = { id: string; type: string; modelUrl: string; animation: { clip: string; time: number }; lights: unknown };
    const film = () => (scene.props!.objects as Film[])[0];
    // The whole of the file is one object, held at the film's first moment, lit by its own lamps.
    expect(film()).toMatchObject({
      id: 'film',
      type: 'model',
      modelUrl: 'assets/film.glb',
      animation: { clip: '*', time: 0 },
      lights: { castShadow: true, shadowCameraSize: 20 },
    });
    // The view is a camera of the file, the focus is that camera's, and the sky that lights it is the one exported beside it.
    expect(scene.props!.camera).toEqual({ from: 'film' });
    expect(scene.props!.effects).toEqual({ depthOfField: 'camera', ambientOcclusion: true });
    expect(scene.props!.environment).toEqual({ url: 'assets/film.hdr' });
    // Until the file has loaded there is nothing to play.
    expect(button('Play').disabled).toBe(true);

    // The scene says the file has loaded, and what film is in it.
    await act(async () => {
      (scene.props!.onModelState as (info: Record<string, unknown>) => void)({
        objectId: 'film',
        state: 'loaded',
        attempt: 1,
        clips: ['Animation'],
        clipLengths: [2],
        cameras: ['Cam.Wide', 'Cam.Close'],
        film: { version: 1, fps: 30, duration: 2, clipStart: 0, cuts: [{ time: 0, camera: 'Cam.Wide' }, { time: 1, camera: 'Cam.Close' }], cameras: {} },
      });
      await sleep(60);
    });
    expect(button('Play').disabled).toBe(false);
    expect(container.textContent).toContain('0.0 of 2.0 seconds');

    // Played: each frame of the screen moves the film on by that frame's time, and the scene is handed the second.
    await press(button('Play'));
    expect(button('Stop')).toBeDefined();
    await frame();
    for (let i = 0; i < 5; i++) await frame(100);
    const half = film().animation.time;
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThanOrEqual(0.5 + 1e-9);

    // Stopped, the film stays where it is.
    await press(button('Stop'));
    await frame(100);
    await frame(100);
    expect(film().animation.time).toBe(half);

    // Played to its end, it stops there by itself; Play starts it again from the first moment.
    await press(button('Play'));
    await frame();
    for (let i = 0; i < 30 && film().animation.time < 2; i++) await frame(100);
    expect(film().animation.time).toBe(2);
    expect(button('Play')).toBeDefined();
    expect(container.textContent).toContain('2.0 of 2.0 seconds');
    await press(button('Play'));
    await frame();
    await frame(100);
    expect(film().animation.time).toBeLessThan(0.3);
  }, 60_000);

  it('game-chase: a car seen from behind, with a camera that follows, a count pinned over it and trees as one record', async () => {
    ownTheFrames();
    await mount(example('game-chase.ui'), 'docs-game-chase', () => Array.isArray(scene.props?.objects) && (scene.props!.objects as unknown[]).length === 5);
    type Placed = { id: string; position: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number } };
    const car = () => (scene.props!.objects as Placed[]).find((object) => object.id === 'car')!;
    const flags = () => (scene.props!.objects as Placed[]).filter((object) => object.id.startsWith('flag-')).map((object) => object.id);

    // What the scene is handed: a camera that follows the car, movement eased between steps, and no lights
    // of the page's own (the scene lights itself).
    expect(scene.props!.camera).toEqual({ follow: { target: 'car', distance: 7, height: 3.5, lookAhead: 2 }, fov: 60 });
    expect(scene.props!.transition).toBe(34);
    expect(scene.props!.cameraSmoothing).toBe(0.12);
    expect(scene.props!.lights).toBeUndefined();
    // The trees are one record: a place, a turn and a size for each.
    const trees = (scene.props!.staticObjects as Array<{ id: string; type: string; shape?: string; instances?: number[]; instanceRotations?: number[]; instanceScales?: number[] }>).find((object) => object.id === 'trees')!;
    expect([trees.type, trees.shape]).toEqual(['instanced', 'cone']);
    expect(trees.instances!.length / 3).toBe(6);
    expect([trees.instanceRotations!.length, trees.instanceScales!.length]).toEqual([6, 6]);
    // Each stands on the ground: its middle is half its own height up.
    for (let tree = 0; tree < 6; tree++) expect(trees.instances![tree * 3 + 1]).toBeCloseTo(1.5 * trees.instanceScales![tree], 9);
    // The count rides over the car, and lets a click through to the scene.
    expect(scene.anchors.at(-1)).toMatchObject({ object: 'car', place: 'above', clickThrough: true });
    expect(container.querySelector('[data-anchor="car"]')!.textContent).toContain('0 of 4');
    expect(car().position).toEqual({ x: 0, y: 0.3, z: 0 });

    // W drives the way the car faces, which at first is +z, and the first flag is straight ahead.
    expect((await key('keydown', 'w', 'KeyW')).defaultPrevented).toBe(true);
    for (let i = 0; i < 30 && flags().includes('flag-1'); i++) await frame(50);
    expect(flags()).toEqual(['flag-2', 'flag-3', 'flag-4']);
    expect(container.querySelector('[data-anchor="car"]')!.textContent).toContain('1 of 4');
    expect(car().position.z).toBeGreaterThan(4);
    expect(Math.abs(car().position.x)).toBeLessThan(0.001);

    // A turns it left, which from behind is toward +x: the car is turned, and goes that way.
    const z = car().position.z;
    await key('keydown', 'a', 'KeyA');
    for (let i = 0; i < 10; i++) await frame(50);
    await key('keyup', 'a', 'KeyA');
    expect(car().rotation!.y).toBeGreaterThan(0.5);
    expect(car().position.x).toBeGreaterThan(0.5);
    expect(car().position.z).toBeGreaterThan(z);
    await key('keyup', 'w', 'KeyW');

    // Let go, it rolls to a stop and stays in the field.
    for (let i = 0; i < 60; i++) await frame(50);
    const stopped = car().position;
    await frame(50);
    expect(Math.hypot(car().position.x - stopped.x, car().position.z - stopped.z)).toBeLessThan(0.01);
  }, 60_000);

  it('game-walk: a first-person game that takes the pointer, walks where the scene looks, and waits when it is let go', async () => {
    ownTheFrames();
    await mount(example('game-walk.ui'), 'docs-game-walk', () => Array.isArray(scene.props?.objects) && (scene.props!.objects as unknown[]).length === 4);
    const at = () => (scene.props!.camera as { position: { x: number; y: number; z: number } }).position;
    expect(scene.props!.pointerLock).toBe(true);
    expect(scene.props!.staticObjects).toHaveLength(5);
    expect(at()).toEqual({ x: 0, y: 1.6, z: -6 });
    expect(container.textContent).toContain('0 of 4 coins');

    // Start asks the scene for the pointer, by the end of the click that asked.
    await press(button('Start'));
    expect(realWin.__scene3dWantLock).toBe(true);
    // What a pointerLock scene does then: takes the request, holds the pointer, and looks along +z.
    realWin.__scene3dWantLock = false;
    realWin.__scene3dLocked = true;
    realWin.__scene3dYaw = 0;
    await frame();
    await frame();

    // W walks the way the camera faces, at its speed times the frame's time.
    const w = await key('keydown', 'w', 'KeyW');
    expect(w.defaultPrevented).toBe(true);
    await frame(50);
    await frame(50);
    expect(at().z).toBeGreaterThan(-6 + 0.2);
    expect(Math.abs(at().x)).toBeLessThan(0.001);

    // The mouse turns the view a quarter turn: forward is now along +x.
    realWin.__scene3dYaw = Math.PI / 2;
    const z = at().z;
    await frame(50);
    await frame(50);
    expect(at().x).toBeGreaterThan(0.2);
    expect(at().z).toBeCloseTo(z, 3);
    await key('keyup', 'w', 'KeyW');

    // Escape: the scene lets the pointer go, and the game waits with its menu up.
    realWin.__scene3dLocked = false;
    await frame();
    await frame();
    expect(button('Start') ?? button('Go on')).toBeDefined();
    const stood = at();
    await frame(50);
    expect(at()).toEqual(stood);
    // While it waits it takes no keys: W is the page's again.
    expect((await key('keydown', 'w', 'KeyW')).defaultPrevented).toBe(false);
    await key('keyup', 'w', 'KeyW');
  }, 60_000);
});
