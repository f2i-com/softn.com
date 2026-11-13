/**
 * The post-processing chain, owned properly.
 *
 * Any change to the `effects` prop used to tear the composer down and build
 * a new one — nudging bloom strength from a slider rebuilt every render
 * target and shader in the chain, several times a second — and the teardown
 * disposed the composer alone: `EffectComposer.dispose()` frees its own two
 * targets and copy pass, not the passes added to it, and UnrealBloomPass
 * carries five mip levels of render targets of its own. So the retune
 * leaked what it rebuilt.
 *
 * A rig now separates the two kinds of change. Its shape — which effects
 * are on — decides which passes exist; its tune — their numbers — is
 * written into the passes that already exist. Only a shape change
 * rebuilds, and a rebuild disposes every pass it owned.
 *
 * The chain, in the order a frame goes through it:
 *
 *   the scene → ambient occlusion → depth of field → bloom → tone mapping
 *   and the screen's colours → vignette and grain
 *
 * Occlusion is part of how the scene is shaded, so it comes first; depth of
 * field blurs the shaded picture; bloom glows over the blur, so a bright
 * thing out of focus glows as a soft disc; and all three work on the light
 * values of the scene, before tone mapping turns them into a picture.
 *
 * Smooth edges. The composer draws the scene into a target of its own, not
 * into the canvas, and that target had no multisampling: a scene that
 * turned bloom on lost the smoothing of every edge. The target the scene is
 * drawn into is now multisampled when the scene's `antialias` is on. Only
 * that one: the composer's other target, and every target a pass keeps for
 * itself (bloom's mips, the occlusion and depth buffers), hold pictures
 * that have no edges of geometry in them, and samples there would be memory
 * and fill for nothing. The composer swaps its two targets as it goes, so
 * left alone the scene would be drawn into each in turn; the rig puts them
 * back before every frame, and the scene is always drawn into the
 * multisampled one.
 */

import * as THREE from 'three';
import type { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { blurOfLens, focusDistanceAt, type FilmCamera } from './film-record';
import { sightScale } from './model-camera';
import type { PostprocessingModules } from './model-loaders';

/** Depth of field, as `effects.depthOfField` takes it. */
export interface Scene3DDepthOfField {
  /**
   * How far in front of the camera is sharp, in scene units, measured
   * straight ahead: everything on the plane that far in front of the camera
   * is in focus. Used when `focusOn` is not given.
   */
  focus?: number;
  /**
   * The `id` of an object to keep in focus: a top-level object, a group's
   * child or a model. The sharp distance is worked out on every frame from
   * the camera to where that object is drawn, so it stays sharp while the
   * camera moves or the object is eased. While no object has that id,
   * nothing is blurred.
   */
  focusOn?: string;
  /**
   * How quickly things go soft away from the sharp distance: the blur grows
   * by this much for each scene unit nearer or further (default 0.02). Small
   * (0.002) keeps nearly everything sharp; large (0.05 and up) leaves only a
   * thin slice sharp, as a close-up lens does.
   */
  aperture?: number;
  /**
   * The most anything is blurred, as a fraction of the picture's width
   * (default 0.012, held to 0.05). 0.005 is a gentle softness; 0.02 is
   * heavy.
   */
  maxBlur?: number;
  /**
   * Blur as a lens does, in place of `aperture` and `maxBlur`: the lens's
   * f-number. 1.4 is wide open (a thin slice sharp, the rest much blurred),
   * 2.8 a portrait, 8 nearly everything sharp. The blur is then worked out
   * from the camera's field of view and how far off the focus is, as a
   * camera's is: it grows quickly either side of the sharp distance, most
   * for what is near the camera, and levels off for what is far away. A
   * narrow field of view (a long lens) and a near subject blur more. Needs
   * a camera with perspective.
   */
  fstop?: number;
  /**
   * With `fstop`: the height of the camera's sensor in millimetres (default
   * 24, a full frame). A larger sensor blurs more at the same f-number.
   */
  sensorHeight?: number;
}

/** Ambient occlusion, as `effects.ambientOcclusion` takes it. */
export interface Scene3DAmbientOcclusion {
  /**
   * How far from a surface another surface still darkens it, in scene units
   * (default 0.5). The darkening has faded out about half that far from
   * where the two meet. Smaller keeps it tight in the creases; larger
   * spreads a soft shade around things that stand on something.
   */
  radius?: number;
  /**
   * How dark the darkening is: 0 is none; 1 (the default) is as worked out,
   * about a fifth of the light gone from a crease; 2 about a third; up to 3.
   */
  intensity?: number;
}

export interface Scene3DEffects {
  /**
   * Glow around bright things: true, or `{ strength, radius, threshold }`
   * (defaults 0.45, 0.4 and 0.85: how strong the glow is, how far it
   * spreads, and how bright a thing must be to glow).
   */
  bloom?: boolean | { strength?: number; radius?: number; threshold?: number };
  /** Darker corners, from 0 (none, the default) to 1. */
  vignette?: number;
  /** Film noise, from 0 (none, the default) to 1. */
  grain?: number;
  /**
   * Depth of field: what is at one distance from the camera is sharp, and
   * what is nearer or further is blurred, as through a lens.
   * `{ focusOn, aperture, maxBlur }` keeps the object with that id sharp;
   * `{ focus, aperture, maxBlur }` keeps a distance sharp, in scene units.
   * With neither `focus` nor `focusOn`, there is no depth of field.
   * `{ focusOn | focus, fstop, sensorHeight }` blurs as a lens of that
   * f-number does. `"camera"` takes the focus from the camera of a model the
   * scene is looking through (`camera={{ from }}`), as the file's record
   * has it: what it is focused on, or how far (a distance of the model's,
   * so as long in the scene as the model is drawn), and its f-number. A
   * camera with no focus in the record, and a scene not looking through
   * one, blurs nothing.
   */
  depthOfField?: Scene3DDepthOfField | 'camera';
  /**
   * Ambient occlusion: the soft darkening where surfaces meet (a wheel on
   * the ground, a bracket on a panel). True, or `{ radius, intensity }`.
   * The costliest effect: the scene's solid things are drawn a second time
   * and every pixel is then gone over twice, a few times what bloom costs.
   */
  ambientOcclusion?: boolean | Scene3DAmbientOcclusion;
}

export interface EffectsPlan {
  bloom: { strength: number; radius: number; threshold: number } | null;
  vignette: number;
  grain: number;
  /**
   * Present when depth of field is on. `focusOn` is the object to follow,
   * or null to hold `focus`. With `fstop` the blur is a lens's (and
   * `sensorHeight`, in millimetres, is its sensor's); with `camera` the
   * focus and the lens are those of the model's camera the scene looks
   * through.
   */
  depthOfField?: { focusOn: string | null; focus: number; aperture: number; maxBlur: number; fstop?: number; sensorHeight?: number; camera?: boolean };
  /** Present when ambient occlusion is on. */
  ambientOcclusion?: { radius: number; intensity: number };
}

// A NaN written into a pass is a NaN in every pixel it touches — a black
// frame with no error — so a number that is not finite is its default.
const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp01 = (value: number | undefined): number => Math.max(0, Math.min(1, finiteOr(value, 0)));

/** The starting pair for depth of field: a soft background behind a subject a few units away. */
const DEFAULT_APERTURE = 0.02;
const DEFAULT_MAX_BLUR = 0.012;
/** Beyond this the blur's forty-one samples stand apart as copies of the picture. */
const MOST_BLUR = 0.05;
const DEFAULT_OCCLUSION_RADIUS = 0.5;

function planDepthOfField(value: unknown): EffectsPlan['depthOfField'] {
  // The focus of the camera in force: nothing here to hold, the scene says each frame.
  if (value === 'camera') return { focusOn: null, focus: 0, aperture: DEFAULT_APERTURE, maxBlur: DEFAULT_MAX_BLUR, camera: true };
  if (typeof value !== 'object' || value === null) return undefined;
  const given = value as Scene3DDepthOfField;
  const focusOn = typeof given.focusOn === 'string' && given.focusOn !== '' ? given.focusOn : null;
  const holds = typeof given.focus === 'number' && Number.isFinite(given.focus);
  // Nothing to be sharp: no depth of field.
  if (focusOn === null && !holds) return undefined;
  const plan: NonNullable<EffectsPlan['depthOfField']> = {
    focusOn,
    focus: holds ? Math.max(0, given.focus as number) : 0,
    aperture: Math.max(0, finiteOr(given.aperture, DEFAULT_APERTURE)),
    maxBlur: Math.max(0, Math.min(MOST_BLUR, finiteOr(given.maxBlur, DEFAULT_MAX_BLUR))),
  };
  // A lens: its f-number, and the height of its sensor where that is given.
  if (typeof given.fstop === 'number' && Number.isFinite(given.fstop) && given.fstop > 0) {
    plan.fstop = given.fstop;
    if (typeof given.sensorHeight === 'number' && Number.isFinite(given.sensorHeight) && given.sensorHeight > 0) plan.sensorHeight = given.sensorHeight;
  }
  return plan;
}

function planAmbientOcclusion(value: unknown): EffectsPlan['ambientOcclusion'] {
  if (!value) return undefined;
  const given = typeof value === 'object' ? (value as Scene3DAmbientOcclusion) : {};
  const radius = finiteOr(given.radius, DEFAULT_OCCLUSION_RADIUS);
  return {
    radius: radius > 0 ? radius : DEFAULT_OCCLUSION_RADIUS,
    intensity: Math.max(0, Math.min(3, finiteOr(given.intensity, 1))),
  };
}

/** The effects as numbers, or null when nothing is on and the scene renders plainly. */
export function planEffects(effects: Scene3DEffects | undefined): EffectsPlan | null {
  if (!effects) return null;
  const tune = typeof effects.bloom === 'object' && effects.bloom ? effects.bloom : undefined;
  const bloom = effects.bloom
    ? {
        strength: finiteOr(tune?.strength, 0.45),
        radius: finiteOr(tune?.radius, 0.4),
        threshold: finiteOr(tune?.threshold, 0.85),
      }
    : null;
  const vignette = clamp01(effects.vignette);
  const grain = clamp01(effects.grain);
  const depthOfField = planDepthOfField(effects.depthOfField);
  const ambientOcclusion = planAmbientOcclusion(effects.ambientOcclusion);
  if (!bloom && vignette === 0 && grain === 0 && !depthOfField && !ambientOcclusion) return null;
  const plan: EffectsPlan = { bloom, vignette, grain };
  if (depthOfField) plan.depthOfField = depthOfField;
  if (ambientOcclusion) plan.ambientOcclusion = ambientOcclusion;
  return plan;
}

/** Which passes exist. Two plans with the same shape share a rig. */
export function effectsShapeKey(plan: EffectsPlan | null): string {
  if (!plan) return '';
  const base = `${plan.bloom ? 'bloom' : ''}|${plan.vignette > 0 || plan.grain > 0 ? 'grain' : ''}`;
  // Written out only when one is on, so a chain of the passes there always were has the key it always had.
  if (!plan.depthOfField && !plan.ambientOcclusion) return base;
  return `${base}|${plan.depthOfField ? 'focus' : ''}|${plan.ambientOcclusion ? 'occlusion' : ''}`;
}

/** The numbers written into those passes. */
export function effectsTuneKey(plan: EffectsPlan | null): string {
  if (!plan) return '';
  const b = plan.bloom;
  const base = `${b ? `${b.strength},${b.radius},${b.threshold}` : ''}|${plan.vignette}|${plan.grain}`;
  if (!plan.depthOfField && !plan.ambientOcclusion) return base;
  return `${base}|${JSON.stringify([plan.depthOfField ?? null, plan.ambientOcclusion ?? null])}`;
}

// Vignette and film grain, applied after tone mapping so they act on the
// final picture.
const GrainVignetteShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0 },
    grain: { value: 0 },
    time: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float grain;
    uniform float time;
    varying vec2 vUv;
    float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - smoothstep(0.3, 0.95, length(d) * 1.4) * vignette;
      float g = (rnd(vUv * 1024.0 + fract(time) * 7.0) - 0.5) * grain * 0.35;
      gl_FragColor = vec4(c.rgb * v + g, c.a);
    }`,
};

/** How many places around a pixel the blur reads. */
const BLUR_TAPS = 64;
/** The most a lens blurs: the radius of the blur, as a share of the picture's height. */
const MOST_LENS_BLUR = 0.04;

/**
 * The places the blur reads, on a disc of radius 1: spread evenly over the
 * disc's area (each a golden angle on from the last, a little further out),
 * as the light of a point out of focus is spread evenly over its circle.
 */
const BLUR_DISC = Array.from({ length: BLUR_TAPS }, (_, i) => {
  const radius = Math.sqrt((i + 0.5) / BLUR_TAPS);
  const angle = i * 2.399963229728653;
  return `vec2(${(radius * Math.cos(angle)).toFixed(5)}, ${(radius * Math.sin(angle)).toFixed(5)})`;
}).join(', ');

/**
 * The fragment shader of the depth-of-field pass, in place of three's own.
 *
 * Two things three's does not do. It knows one shape of blur: so much for
 * each unit of distance from the sharp one, up to a most. A lens's is
 * another shape: the circle a point is blurred to is `lens * |d - s| / d`
 * of the picture's height across, for a point `d` away and a lens focused
 * at `s`, so it grows fast for what is nearer than the focus and levels off
 * at `lens` for what is far beyond it. Both are here: `lens` above zero is
 * the lens's, and zero is the first.
 *
 * And three's reads forty-one places set on four rings, the same for every
 * pixel: at a large blur a bright point comes out as rings of dots. Here
 * the places fill the disc evenly, and the disc is turned by an angle of
 * its own at each pixel, so what is left of the pattern is a fine grain
 * and not a figure. Sixty-four places for forty-one: about half as many
 * readings again in this one pass.
 */
const LensBlurFragment = /* glsl */ `
  #include <common>
  varying vec2 vUv;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform float maxblur;
  uniform float aperture;
  uniform float nearClip;
  uniform float farClip;
  uniform float focus;
  uniform float aspect;
  uniform float lens;
  #include <packing>
  const vec2 disc[${BLUR_TAPS}] = vec2[${BLUR_TAPS}](${BLUR_DISC});
  float getDepth(const in vec2 at) {
    #if DEPTH_PACKING == 1
    return unpackRGBAToDepth(texture2D(tDepth, at));
    #else
    return texture2D(tDepth, at).x;
    #endif
  }
  float getViewZ(const in float depth) {
    #if PERSPECTIVE_CAMERA == 1
    return perspectiveDepthToViewZ(depth, nearClip, farClip);
    #else
    return orthographicDepthToViewZ(depth, nearClip, farClip);
    #endif
  }
  void main() {
    float away = max(-getViewZ(getDepth(vUv)), 0.0001);
    // How far the blur reaches at this pixel, as a share of the picture's height.
    float reach = lens > 0.0
      ? min(0.5 * lens * abs(away - focus) / away, ${MOST_LENS_BLUR})
      : min(abs(away - focus) * aperture, maxblur) * 0.4 * aspect;
    // A turn of the disc that is this pixel's own.
    float turn = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec2 along = vec2(cos(turn), sin(turn));
    vec2 across = vec2(reach / aspect, reach);
    vec4 sum = texture2D(tColor, vUv);
    for (int i = 0; i < ${BLUR_TAPS}; i++) {
      vec2 at = disc[i];
      sum += texture2D(tColor, vUv + vec2(along.x * at.x - along.y * at.y, along.y * at.x + along.x * at.y) * across);
    }
    gl_FragColor = sum / ${BLUR_TAPS + 1}.0;
    gl_FragColor.a = 1.0;
  }`;

/** The samples the scene's target is given for a scene that asked for smooth edges. */
const SCENE_SAMPLES = 4;

/**
 * How many samples the target the scene is drawn into has: four where the
 * scene was made with `antialias`, held to what the device allows, and none
 * where it was not.
 */
export function sceneSamples(renderer: THREE.WebGLRenderer, antialias: boolean): number {
  if (!antialias) return 0;
  const most: unknown = (renderer.capabilities as { maxSamples?: unknown } | undefined)?.maxSamples;
  if (typeof most !== 'number' || !Number.isFinite(most)) return SCENE_SAMPLES;
  return Math.max(0, Math.min(SCENE_SAMPLES, Math.floor(most)));
}

/** What a pass that draws the scene's geometry again hid for the length of that drawing. */
const hidden: THREE.Object3D[] = [];

const isSeeThrough = (material: THREE.Material | null | undefined): boolean =>
  !!material && (material.transparent === true || material.depthWrite === false);

/**
 * Hide a node that has no solid surface of its own: points, lines and
 * sprites, and a mesh that is see-through or writes no depth (glass, a
 * decal, an object the camera carries).
 */
function hideIfNoSurface(node: THREE.Object3D): void {
  if (!node.visible) return;
  const mesh = node as THREE.Mesh;
  let none = (node as THREE.Points).isPoints === true || (node as THREE.Line).isLine === true || (node as THREE.Sprite).isSprite === true;
  if (!none && mesh.isMesh) {
    const material = mesh.material;
    none = Array.isArray(material) ? material.length > 0 && material.every(isSeeThrough) : isSeeThrough(material);
  }
  if (!none) return;
  node.visible = false;
  hidden.push(node);
}

/**
 * Have `pass` draw the scene's solid geometry and nothing else, where it
 * draws the scene again for itself (its depths, its surface directions).
 *
 * Three things would otherwise go into that drawing that are not geometry.
 * The scene's background: a sky or a panorama is drawn by three as a mesh of
 * its own, and under the pass's material that mesh is a real square standing
 * at the middle of the world, which occlusion shaded and depth of field
 * focused on. The shadow maps, which the frame has drawn once already and
 * the pass does not read. And what has no solid surface (points, lines,
 * anything see-through): glass in front of a figure would be the distance
 * the figure is focused at, and would shade it as a wall does.
 */
function sceneGeometryOnly<T extends Pass>(pass: T, scene: THREE.Scene): T {
  const render = pass.render.bind(pass);
  pass.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
    const backdrop = scene.background;
    const shadowMap = renderer.shadowMap;
    const shadowsFollow = shadowMap.autoUpdate;
    scene.background = null;
    shadowMap.autoUpdate = false;
    scene.traverse(hideIfNoSurface);
    try {
      render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      hidden.length = 0;
      scene.background = backdrop;
      shadowMap.autoUpdate = shadowsFollow;
    }
  };
  return pass;
}

/** 1 for a camera with perspective, 0 for one without: what the passes' shaders are compiled for. */
const perspectiveOf = (camera: THREE.Camera): number => ((camera as THREE.PerspectiveCamera).isPerspectiveCamera === true ? 1 : 0);

function setDefine(material: THREE.ShaderMaterial, name: string, value: number): void {
  if (material.defines[name] === value) return;
  material.defines[name] = value;
  material.needsUpdate = true;
}

const focusAt = new THREE.Vector3();

/**
 * How far in front of `camera` the node is drawn, measured straight ahead;
 * null for a node whose place is not a number. The node's place is worked
 * out here, as it will be drawn in this frame.
 */
export function distanceAhead(node: THREE.Object3D, camera: THREE.Camera): number | null {
  node.updateWorldMatrix(true, false);
  camera.updateMatrixWorld();
  focusAt.setFromMatrixPosition(node.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
  return Number.isFinite(focusAt.z) ? Math.max(0, -focusAt.z) : null;
}

type Uniforms = Record<string, { value: unknown }>;

export interface EffectsRig {
  composer: EffectComposer;
  bloom: UnrealBloomPass | null;
  grain: ShaderPass | null;
  depthOfField: BokehPass | null;
  ambientOcclusion: GTAOPass | null;
  shape: string;
  /** How many samples the target the scene is drawn into has; 0 for none. */
  samples: number;
  /** Draw one frame through the chain. */
  render(): void;
  setSize(width: number, height: number): void;
  /** Follow the renderer to another pixel ratio: the chain took the renderer's own when it was built. */
  setPixelRatio(ratio: number): void;
  /** Draw the scene with another camera: the scene's kind of camera changed. */
  setCamera(camera: THREE.Camera): void;
  /** Write a plan of the same shape into the existing passes. */
  retune(plan: EffectsPlan): void;
  /** Every pass this rig made, then the composer. */
  dispose(): void;
}

/** The camera of a model the scene is looking through, as depth of field needs it. */
export interface RigModelView {
  /** Whether the scene is looking through one now. */
  on: boolean;
  /** The model it is in: where the thing it is focused on is looked for, by name. */
  model: THREE.Object3D | null;
  /** The model's camera itself. */
  camera: THREE.Camera | null;
  /** Seconds on the film's clock. */
  seconds: number;
  /** Its vertical field of view then, in radians, where the record keys it; undefined for the camera's own. */
  fov: number | undefined;
  /** What the record holds of it: its focus. */
  film: FilmCamera | undefined;
}

export interface EffectsRigOptions {
  /** Whether the scene was made with smooth edges (`antialias`). */
  antialias?: boolean;
  /** The node an object of the scene is drawn as, by its id: for `depthOfField.focusOn`. */
  find?: (id: string) => THREE.Object3D | null;
  /** The camera of a model the scene is looking through, as the render loop last took it: for `depthOfField: "camera"`. */
  view?: () => RigModelView | null;
}

const named = new WeakMap<THREE.Object3D, Map<string, THREE.Object3D | null>>();

/**
 * The node of `model` called `name`, as its author wrote the name or as
 * three did; found once for each name and remembered. Null for none.
 */
function nodeNamed(model: THREE.Object3D, name: string): THREE.Object3D | null {
  let known = named.get(model);
  if (!known) {
    known = new Map();
    named.set(model, known);
  }
  let node = known.get(name);
  if (node === undefined) {
    const loaded = THREE.PropertyBinding.sanitizeNodeName(name);
    node = null;
    model.traverse((child) => {
      if (node === null && child !== model && (child.name === name || child.name === loaded)) node = child;
    });
    if (known.size >= 64) known.clear();
    known.set(name, node);
  }
  return node;
}

/**
 * A chain for `plan`, or null when the plan is null. The caller has fetched
 * the modules: they are only worth fetching when a plan exists.
 */
export function buildEffectsRig(
  mods: PostprocessingModules,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  plan: EffectsPlan | null,
  width: number,
  height: number,
  options: EffectsRigOptions = {}
): EffectsRig | null {
  if (!plan) return null;
  const composer = new mods.EffectComposer(renderer);
  composer.setSize(width, height);
  // The composer's two targets: passes read from the second first, so that
  // is the one the scene is drawn into, and the one given samples. A target
  // takes its samples when it is first drawn into, which is not yet; a new
  // size or pixel ratio makes it anew with the samples it has.
  const sceneTarget = composer.renderTarget2 as THREE.WebGLRenderTarget | undefined;
  const spareTarget = composer.renderTarget1 as THREE.WebGLRenderTarget | undefined;
  const samples = sceneTarget ? sceneSamples(renderer, options.antialias === true) : 0;
  if (sceneTarget && samples > 0) sceneTarget.samples = samples;
  const owned: Pass[] = [];
  const add = <T extends Pass>(pass: T): T => {
    composer.addPass(pass);
    owned.push(pass);
    return pass;
  };
  let current = plan;
  const scenePass = add(new mods.RenderPass(scene, camera));

  let occlusion: GTAOPass | null = null;
  const tuneOcclusion = (pass: GTAOPass, tune: NonNullable<EffectsPlan['ambientOcclusion']>) => {
    // Up to 1 the darkening is mixed in by that much; beyond it, it is
    // deepened, which unlike mixing further cannot go below black.
    pass.blendIntensity = Math.min(1, tune.intensity);
    pass.updateGtaoMaterial({ radius: tune.radius, scale: Math.max(1, tune.intensity) });
  };
  if (plan.ambientOcclusion && mods.GTAOPass) {
    occlusion = add(sceneGeometryOnly(new mods.GTAOPass(scene, camera, width, height), scene));
    tuneOcclusion(occlusion, plan.ambientOcclusion);
  }

  let focus: BokehPass | null = null;
  const tuneFocus = (pass: BokehPass, tune: NonNullable<EffectsPlan['depthOfField']>) => {
    const uniforms = pass.uniforms as Uniforms;
    uniforms.aperture.value = tune.aperture;
    uniforms.maxblur.value = tune.maxBlur;
    if (tune.focusOn === null) uniforms.focus.value = tune.focus;
  };
  if (plan.depthOfField && mods.BokehPass) {
    focus = add(
      sceneGeometryOnly(
        new mods.BokehPass(scene, camera, {
          focus: plan.depthOfField.focus,
          aperture: plan.depthOfField.aperture,
          maxblur: plan.depthOfField.maxBlur,
        }),
        scene
      )
    );
    // The pass reads its depths as a camera with perspective lays them out, unless told.
    setDefine(focus.materialBokeh, 'PERSPECTIVE_CAMERA', perspectiveOf(camera));
    // The blur itself: a lens's shape where one is asked for, and a disc of
    // places that is filled, in place of three's rings (LensBlurFragment).
    if (typeof focus.materialBokeh.fragmentShader === 'string') {
      focus.materialBokeh.fragmentShader = LensBlurFragment;
      focus.materialBokeh.needsUpdate = true;
    }
    (focus.uniforms as Uniforms).lens = { value: 0 };
  }

  // The pass packs each depth into the four channels of a pixel, a byte's
  // worth in each, and three keeps that pixel in half floats, which cannot
  // hold a byte's worth exactly: about twelve bits of depth come back out.
  // With a camera that draws from 0.1 units that is an error of a quarter of
  // a unit ten units away, enough to blur what should be sharp. Kept in
  // bytes, which is what the packing was made for, the depth is exact.
  if (focus && focus.renderTargetDepth && typeof focus.renderTargetDepth.dispose === 'function') {
    focus.renderTargetDepth.dispose();
    focus.renderTargetDepth = new THREE.WebGLRenderTarget(focus.renderTargetDepth.width, focus.renderTargetDepth.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.UnsignedByteType,
    });
    focus.renderTargetDepth.texture.name = 'BokehPass.depth';
    (focus.uniforms as Uniforms).tDepth.value = focus.renderTargetDepth.texture;
  }

  const bloom = plan.bloom
    ? add(
        new mods.UnrealBloomPass(
          new THREE.Vector2(width, height),
          plan.bloom.strength,
          plan.bloom.radius,
          plan.bloom.threshold
        )
      )
    : null;
  // Tone mapping and the sRGB conversion the renderer would have done.
  add(new mods.OutputPass());
  let grain: ShaderPass | null = null;
  if (plan.vignette > 0 || plan.grain > 0) {
    grain = add(new mods.ShaderPass(GrainVignetteShader));
    grain.uniforms.vignette.value = plan.vignette;
    grain.uniforms.grain.value = plan.grain;
  }
  let disposed = false;
  return {
    composer,
    bloom,
    grain,
    depthOfField: focus,
    ambientOcclusion: occlusion,
    shape: effectsShapeKey(plan),
    samples,
    render: () => {
      // The scene into the multisampled target, on every frame: the composer
      // leaves its two targets swapped after a chain with an odd number of
      // passes that swap them.
      if (sceneTarget && spareTarget) {
        composer.readBuffer = sceneTarget;
        composer.writeBuffer = spareTarget;
      }
      const tune = current.depthOfField;
      if (focus && tune) {
        // The distance that is sharp: held, or worked out from where the
        // object it follows is drawn in this frame. With no such object
        // there is nothing to be sharp, and the pass stands aside.
        let sharp: number | null = null;
        // A lens's blur: how wide the circle of a point far beyond the focus
        // is, as a share of the picture's height; 0 for `aperture` and `maxBlur`.
        let lens = 0;
        const eye = focus.camera as THREE.PerspectiveCamera;
        const half = eye.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(eye.fov) / 2) : 0;
        if (tune.camera) {
          // The focus the model's camera has in the film's record: on a
          // thing of the model, as it is drawn, or at a distance, which may
          // move. No camera of a model in force, or one with no focus: nothing.
          const through = options.view?.() ?? null;
          const about = through && through.on ? through.film?.focus : undefined;
          if (through && about && half > 0) {
            if (about.object !== undefined) {
              const node = through.model ? nodeNamed(through.model, about.object) : null;
              sharp = node ? distanceAhead(node, eye) : null;
            } else {
              // A distance in the record is a length of the model: as long in
              // the scene as the model is drawn along its camera's line of sight.
              const off = focusDistanceAt(about, through.seconds);
              sharp = off === undefined ? null : off * (through.camera ? sightScale(through.camera) : 1);
            }
            if (sharp !== null) {
              // The lens is the model camera's own: its field of view as the
              // file or the record has it, which a scene narrower than its
              // picture has widened; the circle is the same on the sensor.
              const own = through.fov ?? ((through.camera as THREE.PerspectiveCamera | null)?.isPerspectiveCamera ? THREE.MathUtils.degToRad((through.camera as THREE.PerspectiveCamera).fov) : 2 * Math.atan(half));
              lens = (blurOfLens(about.fstop, own, sharp, about.sensorHeight) * Math.tan(own / 2)) / half;
            }
          }
        } else {
          sharp = tune.focus;
          if (tune.focusOn !== null) {
            const node = options.find?.(tune.focusOn) ?? null;
            sharp = node ? distanceAhead(node, eye) : null;
          }
          if (tune.fstop !== undefined && sharp !== null) lens = half > 0 ? blurOfLens(tune.fstop, 2 * Math.atan(half), sharp, tune.sensorHeight) : 0;
        }
        // A lens that blurs nothing (no lens at all, a camera without perspective) is no depth of field.
        if ((tune.camera || tune.fstop !== undefined) && !(lens > 0)) sharp = null;
        focus.enabled = sharp !== null;
        if (sharp !== null) {
          const uniforms = focus.uniforms as Uniforms;
          uniforms.focus.value = sharp;
          uniforms.lens.value = lens;
        }
      }
      composer.render();
    },
    setSize: (w, h) => composer.setSize(w, h),
    setPixelRatio: (ratio) => {
      if (typeof composer.setPixelRatio === 'function') composer.setPixelRatio(ratio);
    },
    setCamera: (next) => {
      scenePass.camera = next;
      if (focus) {
        focus.camera = next;
        setDefine(focus.materialBokeh, 'PERSPECTIVE_CAMERA', perspectiveOf(next));
      }
      if (occlusion) {
        occlusion.camera = next;
        setDefine(occlusion.gtaoMaterial, 'PERSPECTIVE_CAMERA', perspectiveOf(next));
      }
    },
    retune: (next) => {
      current = next;
      if (bloom && next.bloom) {
        bloom.strength = next.bloom.strength;
        bloom.radius = next.bloom.radius;
        bloom.threshold = next.bloom.threshold;
      }
      if (grain) {
        grain.uniforms.vignette.value = next.vignette;
        grain.uniforms.grain.value = next.grain;
      }
      if (focus && next.depthOfField) tuneFocus(focus, next.depthOfField);
      if (occlusion && next.ambientOcclusion) tuneOcclusion(occlusion, next.ambientOcclusion);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const pass of owned) pass.dispose();
      // The occlusion pass's own dispose leaves two of its materials behind.
      occlusion?.gtaoMaterial.dispose();
      occlusion?.blendMaterial.dispose();
      composer.dispose();
    },
  };
}
