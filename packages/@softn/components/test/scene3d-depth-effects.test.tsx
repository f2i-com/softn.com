/**
 * Depth of field and ambient occlusion: `effects.depthOfField` and
 * `effects.ambientOcclusion`.
 *
 * The composer and the passes are three's own (BokehPass, GTAOPass), built
 * against a renderer that draws nothing. Where a pass is run here it is run
 * against a renderer that records what it was asked to draw, which is enough
 * to see what the pass was shown of the scene. That the picture comes out
 * blurred where it should, and darker in a crease, is checked in a browser.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Scene3D, type Scene3DObject, type Scene3DProps } from '../src/threed/Scene3D';
import { distanceAhead, effectsShapeKey, effectsTuneKey, planEffects, type EffectsRig } from '../src/threed/effects';
import { blurOfLens } from '../src/threed/film-record';
import { stubFrames, tick, waitFor, type FrameStub } from './scene3d-doubles';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

import * as THREE from 'three';

type Handles = HTMLCanvasElement & { __softnEffects: () => EffectsRig | null; __softnScene: THREE.Scene; __softnCamera: THREE.Camera };
type Uniforms = Record<string, { value: number }>;

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

const canvas = () => container.querySelector('canvas') as Handles;
const rig = () => canvas()?.__softnEffects() ?? null;
const show = (props: Partial<Scene3DProps>) => act(() => root.render(<Scene3D lights={[]} {...props} />));
/** Show a scene and wait for its chain; the chain's own drawing is stood in for, since the renderer draws no pass. */
async function build(props: Partial<Scene3DProps>): Promise<EffectsRig> {
  show(props);
  await waitFor(() => rig() !== null, 'the chain to be built');
  const built = rig() as EffectsRig;
  vi.spyOn(built.composer, 'render').mockImplementation(() => {});
  return built;
}
function frame(ms = 16): void {
  now += ms;
  act(() => frames.runFrame(now));
}
const focusOf = (built: EffectsRig) => (built.depthOfField as BokehPass).uniforms as Uniforms;
const camera = { position: { x: 0, y: 0, z: 6 }, lookAt: { x: 0, y: 0, z: 0 } };
const box = (id: string, z: number, extra: Partial<Scene3DObject> = {}): Scene3DObject => ({ id, type: 'box', position: { x: 0, y: 0, z }, ...extra });

/** A renderer that draws nothing and says what it was asked to draw of a scene. */
function recordingRenderer(seen: (scene: THREE.Scene, renderer: THREE.WebGLRenderer) => void): THREE.WebGLRenderer {
  const renderer = {
    autoClear: true,
    shadowMap: { autoUpdate: true },
    getClearColor: (into: THREE.Color) => into,
    getClearAlpha: () => 1,
    setClearColor() {},
    setClearAlpha() {},
    setRenderTarget() {},
    clear() {},
    render(drawn: THREE.Object3D) {
      if ((drawn as THREE.Scene).isScene) seen(drawn as THREE.Scene, renderer as unknown as THREE.WebGLRenderer);
    },
  };
  return renderer as unknown as THREE.WebGLRenderer;
}

describe('the plan of the effects', () => {
  it('reads depth of field: an object to follow or a distance to hold, with a starting aperture and blur', () => {
    expect(planEffects({ depthOfField: { focusOn: 'rover', aperture: 0.02, maxBlur: 0.012 } })).toEqual({
      bloom: null,
      vignette: 0,
      grain: 0,
      depthOfField: { focusOn: 'rover', focus: 0, aperture: 0.02, maxBlur: 0.012 },
    });
    expect(planEffects({ depthOfField: { focus: 4.5 } })?.depthOfField).toEqual({ focusOn: null, focus: 4.5, aperture: 0.02, maxBlur: 0.012 });
    // The object wins where both are given; the distance is kept for nothing.
    expect(planEffects({ depthOfField: { focusOn: 'rover', focus: 3 } })?.depthOfField?.focusOn).toBe('rover');
    // Nothing to be sharp is no depth of field, and a scene with no other effect draws plainly.
    expect(planEffects({ depthOfField: {} })).toBeNull();
    expect(planEffects({ depthOfField: { aperture: 0.5 } })).toBeNull();
    expect(planEffects({ depthOfField: { focusOn: '' } })).toBeNull();
    // Numbers that are none are the defaults; a blur beyond what holds together is held.
    expect(planEffects({ depthOfField: { focus: -2, aperture: Number.NaN, maxBlur: 3 } })?.depthOfField).toEqual({
      focusOn: null,
      focus: 0,
      aperture: 0.02,
      maxBlur: 0.05,
    });
  });

  it('reads ambient occlusion: on, or with a radius and an intensity', () => {
    expect(planEffects({ ambientOcclusion: true })).toEqual({ bloom: null, vignette: 0, grain: 0, ambientOcclusion: { radius: 0.5, intensity: 1 } });
    expect(planEffects({ ambientOcclusion: { radius: 0.6, intensity: 1 } })?.ambientOcclusion).toEqual({ radius: 0.6, intensity: 1 });
    expect(planEffects({ ambientOcclusion: { radius: -1, intensity: 9 } })?.ambientOcclusion).toEqual({ radius: 0.5, intensity: 3 });
    expect(planEffects({ ambientOcclusion: false })).toBeNull();
  });

  it('counts each as a pass of its own, and its numbers as numbers', () => {
    const plain = planEffects({ bloom: true });
    const focused = planEffects({ bloom: true, depthOfField: { focus: 2 } });
    const refocused = planEffects({ bloom: true, depthOfField: { focusOn: 'a', aperture: 0.1 } });
    const shaded = planEffects({ bloom: true, ambientOcclusion: true });
    expect(effectsShapeKey(focused)).not.toBe(effectsShapeKey(plain));
    expect(effectsShapeKey(shaded)).not.toBe(effectsShapeKey(plain));
    expect(effectsShapeKey(shaded)).not.toBe(effectsShapeKey(focused));
    expect(effectsShapeKey(refocused)).toBe(effectsShapeKey(focused));
    expect(effectsTuneKey(refocused)).not.toBe(effectsTuneKey(focused));
    // A chain of the passes there always were has the key it always had.
    expect(effectsShapeKey(plain)).toBe('bloom|');
  });
});

describe('`effects.depthOfField`', () => {
  it('is three’s BokehPass, between the scene and bloom, with tone mapping still at the end', async () => {
    const built = await build({ effects: { depthOfField: { focus: 4.5, aperture: 0.03, maxBlur: 0.01 }, ambientOcclusion: true, bloom: true, grain: 0.2 } });
    const passes = built.composer.passes;
    expect(passes[0]).toBeInstanceOf(RenderPass);
    expect(passes[1]).toBe(built.ambientOcclusion);
    expect(passes[1]).toBeInstanceOf(GTAOPass);
    expect(passes[2]).toBe(built.depthOfField);
    expect(passes[2]).toBeInstanceOf(BokehPass);
    expect(passes[3]).toBe(built.bloom);
    expect(passes[4]).toBeInstanceOf(OutputPass);
    expect(passes[5]).toBe(built.grain);
    expect(focusOf(built).focus.value).toBe(4.5);
    expect(focusOf(built).aperture.value).toBe(0.03);
    expect(focusOf(built).maxblur.value).toBe(0.01);
    // Its own buffer of depths has no samples: there is nothing in it to smooth.
    const depths = (built.depthOfField as BokehPass).renderTargetDepth;
    expect(depths.samples).toBe(0);
    expect(built.composer.renderTarget2.samples).toBe(4);
    // Kept in bytes: the pass packs a depth a byte to a channel, and three's own half floats give
    // back about twelve bits of it, which blurs what is in focus a few units from the camera.
    expect(depths.texture.type).toBe(THREE.UnsignedByteType);
    expect((focusOf(built) as unknown as Record<string, { value: unknown }>).tDepth.value).toBe(depths.texture);
    // The size of the picture, and it follows a new one.
    expect([depths.width, depths.height]).toEqual([300, 150]);
    built.setSize(640, 360);
    expect([depths.width, depths.height]).toEqual([640, 360]);
  });

  it('follows its numbers without the chain being made again, and is made when switched on and disposed when switched off', async () => {
    const disposed = vi.spyOn(BokehPass.prototype, 'dispose');
    const built = await build({ effects: { depthOfField: { focus: 4.5 } } });
    const pass = built.depthOfField;
    show({ effects: { depthOfField: { focus: 2, aperture: 0.05, maxBlur: 0.02 } } });
    await act(() => tick());
    expect(rig()).toBe(built);
    expect(built.depthOfField).toBe(pass);
    frame();
    expect([focusOf(built).focus.value, focusOf(built).aperture.value, focusOf(built).maxblur.value]).toEqual([2, 0.05, 0.02]);
    expect(disposed).not.toHaveBeenCalled();

    show({ effects: { bloom: true } });
    await waitFor(() => rig() !== built && rig() !== null, 'the chain without it');
    expect(rig()?.depthOfField).toBeNull();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('keeps the object `focusOn` names sharp: the distance is worked out on every frame from the camera to where it is drawn', async () => {
    const effects = { depthOfField: { focusOn: 'rover' } };
    const built = await build({ effects, camera, objects: [box('rover', -2)] });
    frame();
    expect(focusOf(built).focus.value).toBeCloseTo(8, 9);
    expect(built.depthOfField?.enabled).toBe(true);

    // The object is eased to a new place: the focus goes with it, frame by frame.
    show({ effects, camera, objects: [box('rover', 2)], transition: 100 });
    frame(50);
    expect(focusOf(built).focus.value).toBeCloseTo(6, 6);
    frame(60);
    expect(focusOf(built).focus.value).toBeCloseTo(4, 9);

    // The camera moves: measured straight ahead of where it stands now.
    show({ effects, camera: { position: { x: 0, y: 0, z: 10 }, lookAt: { x: 0, y: 0, z: 0 } }, objects: [box('rover', 2)] });
    frame();
    expect(focusOf(built).focus.value).toBeCloseTo(8, 9);
    // Off to one side it is no further ahead: the sharp distance is a plane, as a lens has.
    show({ effects, camera: { position: { x: 0, y: 0, z: 10 }, lookAt: { x: 0, y: 0, z: 0 } }, objects: [box('rover', 2, { position: { x: 3, y: 1, z: 2 } })] });
    frame();
    expect(focusOf(built).focus.value).toBeCloseTo(8, 9);
  });

  it('follows a group’s child, and blurs nothing while no object has the id', async () => {
    const effects = { depthOfField: { focusOn: 'cab' } };
    const built = await build({ effects, camera, objects: [box('other', 0)] });
    frame();
    // Nothing to be sharp: the pass stands aside, and the rest of the chain goes on.
    expect(built.depthOfField?.enabled).toBe(false);

    const lorry: Scene3DObject = { id: 'lorry', type: 'group', position: { x: 0, y: 0, z: -4 }, children: [box('cab', 1)] };
    show({ effects, camera, objects: [lorry] });
    frame();
    expect(built.depthOfField?.enabled).toBe(true);
    // The group four back, the cab one forward in it: nine from a camera at six.
    expect(focusOf(built).focus.value).toBeCloseTo(9, 9);

    show({ effects, camera, objects: [] });
    frame();
    expect(built.depthOfField?.enabled).toBe(false);
  });

  it('reads its depths as the camera in use lays them out, when that changes kind too', async () => {
    const effects = { depthOfField: { focus: 3 }, ambientOcclusion: true };
    const built = await build({ effects, camera: { ...camera, type: 'orthographic', size: 8 } });
    const bokeh = (built.depthOfField as BokehPass).materialBokeh;
    const occlusion = (built.ambientOcclusion as GTAOPass).gtaoMaterial;
    expect(bokeh.defines.PERSPECTIVE_CAMERA).toBe(0);
    expect(occlusion.defines.PERSPECTIVE_CAMERA).toBe(0);
    const compiled = [bokeh.version, occlusion.version];

    show({ effects, camera: { ...camera, type: 'perspective' } });
    expect(rig()).toBe(built);
    expect(bokeh.defines.PERSPECTIVE_CAMERA).toBe(1);
    expect(occlusion.defines.PERSPECTIVE_CAMERA).toBe(1);
    // Each is compiled again for it, and draws with the camera there is now.
    expect(bokeh.version).toBeGreaterThan(compiled[0]);
    expect(occlusion.version).toBeGreaterThan(compiled[1]);
    expect((built.depthOfField as BokehPass).camera).toBe(canvas().__softnCamera);
    expect((built.ambientOcclusion as GTAOPass).camera).toBe(canvas().__softnCamera);
  });

  it('distanceAhead measures along the view, as three places things', () => {
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(4, 0, 0);
    cam.lookAt(0, 0, 0);
    const holder = new THREE.Group();
    holder.position.set(-1, 5, 0);
    const node = new THREE.Object3D();
    node.position.set(-2, 0, 7);
    holder.add(node);
    // Seven units along x from the camera, however far up or aside.
    expect(distanceAhead(node, cam)).toBeCloseTo(7, 9);
    // Behind the camera is no distance ahead; a place that is not a number is none at all.
    node.position.set(20, 0, 0);
    expect(distanceAhead(node, cam)).toBe(0);
    node.position.set(Number.NaN, 0, 0);
    expect(distanceAhead(node, cam)).toBeNull();
  });
});

describe('depth of field as a lens: `fstop`', () => {
  it('is read beside the other form, and "camera" is the focus of the camera in force', () => {
    expect(planEffects({ depthOfField: { focusOn: 'rover', fstop: 2.8 } })?.depthOfField).toEqual({ focusOn: 'rover', focus: 0, aperture: 0.02, maxBlur: 0.012, fstop: 2.8 });
    expect(planEffects({ depthOfField: { focus: 3, fstop: 2, sensorHeight: 15.063 } })?.depthOfField).toMatchObject({ focus: 3, fstop: 2, sensorHeight: 15.063 });
    // An f-number that is none is no lens: the other form, as it was.
    for (const none of [0, -1, Number.NaN]) expect(planEffects({ depthOfField: { focus: 3, fstop: none } })?.depthOfField).toEqual({ focusOn: null, focus: 3, aperture: 0.02, maxBlur: 0.012 });
    expect(planEffects({ depthOfField: 'camera' })?.depthOfField).toMatchObject({ camera: true });
    // A lens is the same pass with other numbers: nothing is made again for it.
    const plain = planEffects({ depthOfField: { focus: 3 } });
    const lens = planEffects({ depthOfField: { focus: 3, fstop: 2 } });
    expect(effectsShapeKey(lens)).toBe(effectsShapeKey(plain));
    expect(effectsShapeKey(planEffects({ depthOfField: 'camera' }))).toBe(effectsShapeKey(plain));
    expect(effectsTuneKey(lens)).not.toBe(effectsTuneKey(plain));
  });

  it('gives the pass the lens’s blur for the scene’s field of view and the distance in focus, and stands aside for a camera without perspective', async () => {
    const effects = { depthOfField: { focusOn: 'rover', fstop: 2.8, sensorHeight: 15 } };
    const built = await build({ effects, camera: { ...camera, fov: 40 }, objects: [box('rover', -2)] });
    frame();
    expect(focusOf(built).focus.value).toBeCloseTo(8, 9);
    expect(focusOf(built).lens.value).toBeCloseTo(blurOfLens(2.8, THREE.MathUtils.degToRad(40), 8, 15), 12);
    // Nearer, and through a longer lens: more blur.
    show({ effects, camera: { position: { x: 0, y: 0, z: 2 }, lookAt: { x: 0, y: 0, z: 0 }, fov: 20 }, objects: [box('rover', -2)] });
    frame();
    expect(focusOf(built).lens.value).toBeCloseTo(blurOfLens(2.8, THREE.MathUtils.degToRad(20), 4, 15), 12);
    expect(focusOf(built).lens.value).toBeGreaterThan(blurOfLens(2.8, THREE.MathUtils.degToRad(40), 8, 15) * 4);
    // The other form is the pass's own shape: no lens.
    show({ effects: { depthOfField: { focusOn: 'rover', aperture: 0.03 } }, camera, objects: [box('rover', -2)] });
    await act(() => tick());
    frame();
    expect(rig()).toBe(built);
    expect([focusOf(built).lens.value, focusOf(built).aperture.value]).toEqual([0, 0.03]);

    show({ effects, camera: { ...camera, type: 'orthographic', size: 8 }, objects: [box('rover', -2)] });
    await act(() => tick());
    frame();
    expect(built.depthOfField?.enabled).toBe(false);
    // And the camera's own focus, with no camera of a model in force, is none.
    show({ effects: { depthOfField: 'camera' }, camera, objects: [box('rover', -2)] });
    await act(() => tick());
    frame();
    expect(built.depthOfField?.enabled).toBe(false);
  });

  it('reads the picture at sixty-four places that fill a disc evenly, in place of three’s four rings', async () => {
    const built = await build({ effects: { depthOfField: { focus: 3 } } });
    const shader = (built.depthOfField as BokehPass).materialBokeh.fragmentShader;
    expect(shader).toContain('uniform float lens;');
    const disc = /vec2\[64\]\((.*?)\);/s.exec(shader)?.[1] ?? '';
    const places = [...disc.matchAll(/vec2\((-?\d+\.\d+), (-?\d+\.\d+)\)/g)].map((m) => Math.hypot(Number(m[1]), Number(m[2])));
    expect(places).toHaveLength(64);
    expect(Math.max(...places)).toBeLessThanOrEqual(1);
    // Evenly over the disc's area: a quarter of them within half the radius, half within 0.707 of it.
    expect(places.filter((r) => r <= 0.5)).toHaveLength(16);
    expect(places.filter((r) => r <= Math.SQRT1_2)).toHaveLength(32);
  });
});

describe('`effects.ambientOcclusion`', () => {
  it('is three’s GTAOPass, straight after the scene, with its radius in scene units and its strength', async () => {
    const built = await build({ effects: { ambientOcclusion: true } });
    const pass = built.ambientOcclusion as GTAOPass;
    expect(built.composer.passes.map((p) => p.constructor.name)).toEqual(['RenderPass', 'GTAOPass', 'OutputPass']);
    expect(pass.gtaoMaterial.uniforms.radius.value).toBe(0.5);
    expect(pass.blendIntensity).toBe(1);
    expect(pass.gtaoMaterial.uniforms.scale.value).toBe(1);

    // Its numbers follow in place.
    show({ effects: { ambientOcclusion: { radius: 0.6, intensity: 0.5 } } });
    await act(() => tick());
    expect(rig()).toBe(built);
    expect(pass.gtaoMaterial.uniforms.radius.value).toBe(0.6);
    expect(pass.blendIntensity).toBe(0.5);
    // Above 1 the shade is deepened, not mixed in further: mixing past 1 goes below black.
    show({ effects: { ambientOcclusion: { radius: 0.6, intensity: 2 } } });
    await act(() => tick());
    expect(pass.blendIntensity).toBe(1);
    expect(pass.gtaoMaterial.uniforms.scale.value).toBe(2);
    // None of its own buffers has samples.
    expect([pass.gtaoRenderTarget.samples, pass.pdRenderTarget.samples]).toEqual([0, 0]);
  });

  it('is disposed with the chain, the two materials its own dispose leaves behind included', async () => {
    const disposed = vi.spyOn(GTAOPass.prototype, 'dispose');
    const built = await build({ effects: { ambientOcclusion: true } });
    const pass = built.ambientOcclusion as GTAOPass;
    const left = [vi.spyOn(pass.gtaoMaterial, 'dispose'), vi.spyOn(pass.blendMaterial, 'dispose')];
    act(() => root.unmount());
    root = createRoot(container);
    expect(disposed).toHaveBeenCalledOnce();
    expect(left.map((spy) => spy.mock.calls.length)).toEqual([1, 1]);
  });
});

describe('what a pass that draws the scene again is shown of it', () => {
  const objects: Scene3DObject[] = [
    box('solid', 0),
    box('glass', 1, { opacity: 0.4 }),
    { id: 'dust', type: 'particles', particlePositions: [0, 0, 0, 1, 1, 1] },
    { id: 'held', type: 'box', attach: 'camera', position: { x: 0, y: 0, z: -1 } },
  ];
  const nodeOf = (id: string) => canvas().__softnScene.children.find((node) => node.userData.__softnId === id) as THREE.Object3D;

  for (const which of ['depthOfField', 'ambientOcclusion'] as const) {
    it(`${which}: the solid geometry alone, with no background and no shadow maps drawn again, and everything put back after`, async () => {
      const built = await build({ effects: { depthOfField: { focus: 3 }, ambientOcclusion: true }, objects });
      const scene = canvas().__softnScene;
      // A sky: a picture three draws as a mesh of its own.
      const sky = new THREE.Texture();
      scene.background = sky;
      const seen: Array<Record<string, unknown>> = [];
      const renderer = recordingRenderer((drawn, by) =>
        seen.push({
          background: drawn.background,
          shadowsFollow: by.shadowMap.autoUpdate,
          override: drawn.overrideMaterial?.type,
          solid: nodeOf('solid').visible,
          glass: nodeOf('glass').visible,
          dust: nodeOf('dust').visible,
          held: nodeOf('held').visible,
        })
      );
      const pass = built[which] as BokehPass | GTAOPass;
      const target = () => new THREE.WebGLRenderTarget(4, 4);
      pass.render(renderer, target(), target(), 0.016, false);

      // The scene was drawn once, for its depths or its surface directions.
      expect(seen).toEqual([
        {
          background: null,
          shadowsFollow: false,
          override: which === 'depthOfField' ? 'MeshDepthMaterial' : 'MeshNormalMaterial',
          solid: true,
          // See-through, points, and what the camera carries without writing depth: no surface to focus on or to shade.
          glass: false,
          dust: false,
          held: false,
        },
      ]);
      expect(scene.background).toBe(sky);
      expect(renderer.shadowMap.autoUpdate).toBe(true);
      expect(scene.overrideMaterial).toBeNull();
      expect(objects.map((object) => nodeOf(object.id).visible)).toEqual([true, true, true, true]);
    });
  }

  it('puts everything back when the pass fails part of the way', async () => {
    const built = await build({ effects: { depthOfField: { focus: 3 } }, objects });
    const scene = canvas().__softnScene;
    const sky = new THREE.Texture();
    scene.background = sky;
    const renderer = recordingRenderer(() => {
      throw new Error('the context was lost');
    });
    const target = () => new THREE.WebGLRenderTarget(4, 4);
    expect(() => (built.depthOfField as BokehPass).render(renderer, target(), target(), 0.016, false)).toThrow('the context was lost');
    expect(scene.background).toBe(sky);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    expect(nodeOf('glass').visible).toBe(true);
    expect(nodeOf('dust').visible).toBe(true);
  });
});
