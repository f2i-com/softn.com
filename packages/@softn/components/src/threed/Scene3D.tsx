import { applyModelAppearance, type ModelAppearance } from './model-appearance';
import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { prepareModelMaterials } from './model-material-quality';
import { BoundedTextureCache } from './textureCache';
import {
  describeMarkupEgress,
  useAppActive,
  useAppAssets,
  useAppScope,
  useCapabilityState,
} from '@softn/core';
import {
  detectModelFormat,
  importBokehPass,
  importGTAOPass,
  importOrbitControls,
  importPostprocessing,
  importRoomEnvironment,
  loadModelTemplate,
  type ModelFormat,
} from './model-loaders';
import { loadTextureThrough, type ModelResourcePolicy } from './model-resources';
import { modelTemplateAddress, modelTemplateCache, type ModelInstance } from './model-cache';
import { copyContents, firstKeyOf, fitModel, restoreOwnTransform, wantsFit, type ModelContents } from './model-info';
import type { FilmRecord } from './film-record';
import { chooseModelView, lookThrough, modelCameras, type Lens, type ModelCameras, type ModelView } from './model-camera';
import { ModelLights, MODEL_LIGHT_KEY, type Scene3DModelLights } from './model-lights';
import { ModelParts, namesParts, type PartProperty, type Scene3DPart } from './model-parts';
import { ParticleSprites, particleShapeOf, SHARED_SPRITE_KEY, type ParticleShape } from './particle-sprites';
import { nearestHit, PICKABLE_KEY } from './picking';
import { Easer, transitionOf } from './motion';
import { orientationOf, pointsSomewhere, rotationOrderOf } from './pointing';
import { placeInstances } from './instances';
import {
  aboveZero,
  applyOrbitLimits,
  createCamera,
  createFollowState,
  DEFAULT_CAMERA_SHAPE,
  describeCamera,
  followGoal,
  shapeCamera,
  type CameraShape,
  type SceneCamera,
} from './camera-rig';
import { SceneNodes } from './scene-nodes';
import { AnchorSet, SceneAnchorContext } from './anchors';
import { StatsMeter } from './scene-stats';
import { resolveBundleSrc } from '../utils/bundle-src';
import {
  buildEffectsRig,
  effectsShapeKey,
  effectsTuneKey,
  planEffects,
  type EffectsRig,
  type Scene3DEffects,
} from './effects';
import { FrameLoop, useDocumentVisible } from './activity';
import {
  environmentFormatOf,
  environmentLookOf,
  isEnvironmentImage,
  SceneEnvironment,
  type Scene3DEnvironment,
} from './environment';
import {
  MARK_ASSETS_READY,
  MARK_FIRST_FRAME,
  MARK_RENDERER_READY,
  markInstant,
  RequiredAssets,
} from './milestones';

export type { ModelFormat } from './model-loaders';
export type { Scene3DEffects } from './effects';
export type { Scene3DEnvironment, EnvironmentFormat } from './environment';
export type { Scene3DPart } from './model-parts';
export type { Scene3DModelLights } from './model-lights';
export type { ParticleShape } from './particle-sprites';
export type { FilmRecord, FilmCamera, FilmCut, FilmFocus } from './film-record';
export { modelTemplateCacheStats } from './model-cache';

/** Scenes listening for `gameControls`, which share `window.__softnKeys`. */
let gameControlScenes = 0;

type Scene3DWindow = Window & {
  __scene3dYaw?: number;
  __scene3dPitch?: number;
  /** True while a `pointerLock` scene owns the mouse; a game reads it to pause. */
  __scene3dLocked?: boolean;
  /**
   * A game sets this true from a button that starts or resumes play; the
   * scene takes the pointer on the next frame, inside the click's user
   * activation, so the player is not left clicking the world to get the
   * mouse back.
   */
  __scene3dWantLock?: boolean;
  /** Set by a script to give the pointer back (a panel opened); consumed each frame. */
  __scene3dReleaseLock?: boolean;
  /** Set false to lock with the platform's adjusted movement instead of raw input. */
  __scene3dRawInput?: boolean;
};

interface MouseLookOwner {
  token: symbol;
  yawRef: { current: number };
  pitchRef: { current: number };
}

interface MouseLookSnapshot {
  hadYaw: boolean;
  yaw: number | undefined;
  hadPitch: boolean;
  pitch: number | undefined;
}

// The public window values are retained for backwards compatibility with
// game logic that steers the active scene directly. Keep an ownership stack so
// two mounted scenes do not read each other's camera state or delete each
// other's globals during cleanup.
const mouseLookOwners: MouseLookOwner[] = [];
let mouseLookBaseSnapshot: MouseLookSnapshot | null = null;

function activateMouseLookOwner(sceneWindow: Scene3DWindow, owner: MouseLookOwner): void {
  if (mouseLookOwners.length === 0) {
    mouseLookBaseSnapshot = {
      hadYaw: Object.prototype.hasOwnProperty.call(sceneWindow, '__scene3dYaw'),
      yaw: sceneWindow.__scene3dYaw,
      hadPitch: Object.prototype.hasOwnProperty.call(sceneWindow, '__scene3dPitch'),
      pitch: sceneWindow.__scene3dPitch,
    };
  }
  mouseLookOwners.push(owner);
  sceneWindow.__scene3dYaw = owner.yawRef.current;
  sceneWindow.__scene3dPitch = owner.pitchRef.current;
}

function isActiveMouseLookOwner(owner: MouseLookOwner): boolean {
  return mouseLookOwners.at(-1)?.token === owner.token;
}

function releaseMouseLookOwner(sceneWindow: Scene3DWindow, owner: MouseLookOwner): void {
  const index = mouseLookOwners.findIndex((candidate) => candidate.token === owner.token);
  if (index === -1) return;
  const wasActive = index === mouseLookOwners.length - 1;
  mouseLookOwners.splice(index, 1);
  if (!wasActive) return;

  const nextOwner = mouseLookOwners.at(-1);
  if (nextOwner) {
    sceneWindow.__scene3dYaw = nextOwner.yawRef.current;
    sceneWindow.__scene3dPitch = nextOwner.pitchRef.current;
    return;
  }

  const snapshot = mouseLookBaseSnapshot;
  mouseLookBaseSnapshot = null;
  if (snapshot?.hadYaw) sceneWindow.__scene3dYaw = snapshot.yaw;
  else delete sceneWindow.__scene3dYaw;
  if (snapshot?.hadPitch) sceneWindow.__scene3dPitch = snapshot.pitch;
  else delete sceneWindow.__scene3dPitch;
}

export type Scene3DShape =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'capsule'
  | 'prism'
  | 'plane'
  | 'torus'
  | 'cone'
  | 'ring'
  | 'dodecahedron'
  | 'icosahedron'
  | 'octahedron';

export interface Scene3DObject {
  /** Named morph weights, material colours and mesh visibility for imported assets. */
  appearance?: ModelAppearance;
  id: string;
  type: Scene3DShape | 'model' | 'instanced' | 'group' | 'particles';
  /**
   * For `type: 'model'`: where the model is. A path with no scheme
   * (`"assets/robot.glb"`) names a file in the app's own bundle, so logic can
   * name a model without `asset()`; a path the bundle does not have is
   * fetched as written. A model can also be a child of a group.
   */
  modelUrl?: string;
  modelFormat?: ModelFormat;
  /**
   * For `type: 'model'`: scale the model so its longest side is this many
   * units, centred on the object's position and standing on its ground
   * (lowest point at y = 0 before `position`). `scale` then multiplies it.
   * The "loaded" state of `onModelState` gives the size the file had.
   */
  fit?: number;
  /**
   * For `type: 'model'`: change this number to fetch the same URL again —
   * after a failure, or when the file behind the URL has changed. Each
   * change is a new attempt, reported through `onModelState`; the URL
   * itself changing starts the count over.
   */
  reload?: number;
  /**
   * For `type: 'model'`: move the named parts of the model, each by the
   * name its node has in the file (the "loaded" state of `onModelState`
   * lists them as `nodes`):
   * `{ Wheel_FL: { rotation: { x: 1.2, y: 0, z: 0 } }, Hatch: { visible: false }, Arm: { position: { x: 0, y: 0.2, z: 0 }, scale: 1.1 } }`.
   * `rotation` is a turn on top of the pose the file gives the part, about
   * the part's own x, y and z, in radians, applied in that order: `{ x: a }`
   * rolls a wheel about its own axle whichever way the wheel was modelled.
   * `position` is how far the part is moved from where the file puts it, in
   * the units and directions of what it hangs from in the file. `scale` (a
   * number, or `{ x, y, z }`) multiplies the size the file gives it.
   * `visible` shows or hides the part and everything that hangs from it,
   * and has the last word over `appearance.hiddenMeshes`. A part left out,
   * or a field left out of one, is as the file has it (default: none are
   * moved).
   *
   * Names are as the file is loaded, which writes them its own way: a space
   * becomes an underscore and `.`, `:`, `/`, `[` and `]` are dropped, so
   * "Wheel.FL" in Blender is "WheelFL" here, and either spelling finds it.
   * Where two nodes have one name the first is the one moved. The model's
   * own top node is not a part: it is the object, moved by `position`,
   * `rotation` and `scale`. A name the model has no node for is warned of
   * once in the console.
   *
   * With an `animation` playing, the clip plays and `parts` is applied
   * after it on every frame: where a part is given a rotation, a position
   * or a scale, that replaces what the clip gives the same part, and the
   * clip keeps whatever the part is not given. With a `transition` (the
   * scene's or the object's) a part's rotation, position and scale are
   * eased to each new value, a rotation the short way round, however far it
   * goes; `visible` changes at once.
   */
  parts?: Record<string, Scene3DPart>;
  /**
   * For `type: 'model'`: the lights that are in the model's file (a scene
   * exported from Blender has its sun and its lamps in it; the "loaded"
   * state lists them as `lights`). Left out, they shine as the file has
   * them. `false` switches them all off. `{ intensity: 0.5 }` is each at
   * that multiple of its own strength (1 / 683 turns a Blender export in
   * its "Standard" units into plain numbers). `{ castShadow: true }` lets
   * the model's directional and spot lights cast shadows, with the scene's
   * `shadows` on; with it `shadowMapSize` (pixels; 1024 for a directional
   * light, 512 for a spot), `shadowCameraSize` (a directional light's
   * shadows cover a box this many units each way, 15 unless given, kept
   * about what the camera sees wherever the light is in the model),
   * `shadowBias` and `shadowNormalBias` are as a scene light's. A lamp
   * that shines every way (a point light) casts none. A light of a model
   * moves with the model and with its clip. May change at any time.
   */
  lights?: false | Scene3DModelLights;
  /**
   * For `type: 'instanced'`: one mesh, drawn once, standing in for thousands
   * of copies of `shape` — a voxel world, a forest, a crowd of the same crate.
   * `instances` is flat: x, y, z and a palette index per copy (stride 4) when
   * `palette` is given, x, y, z (stride 3) when every copy is `color`. A flat
   * number array is the cheapest thing that crosses the scripting boundary.
   */
  shape?: Scene3DShape;
  instances?: number[];
  palette?: string[];
  /**
   * For `type: 'instanced'`: how each copy is turned, as a flat array beside
   * `instances`. One number a copy is a turn about the upright (y) axis, in
   * radians: a fence rail running north or east, a walker's heading. Three
   * numbers a copy are its turns about x, y and z. Which it is goes by the
   * length: three times the number of copies (or more) is three each,
   * anything shorter is one each. A copy the array does not reach is not
   * turned.
   */
  instanceRotations?: number[];
  /**
   * For `type: 'instanced'`: how big each copy is, as a flat array beside
   * `instances`. One number a copy is its size in every direction (1 is the
   * shape's own size): grass at each stage of growth in one batch. Three
   * numbers a copy are its sizes along x, y and z. Which it is goes by the
   * length, as for `instanceRotations`.
   */
  instanceScales?: number[];
  /**
   * For `type: 'group'`: a composite object made of child objects.
   * All child positions, rotations, and scales are local to the parent group.
   * Moving or rotating the group moves all children together without clipping or trig.
   */
  children?: Scene3DObject[];
  /**
   * For `type: 'particles'`: high-performance particle system using THREE.Points.
   * Flat array of x, y, z positions.
   */
  particlePositions?: number[];
  particleColors?: number[];
  particleSize?: number;
  /**
   * For `type: 'particles'`: what each particle is drawn as. 'square' (the
   * default) is a hard square, as particles always were; 'round' is a disc
   * with a clean edge; 'soft' is a disc that fades to nothing at its edge:
   * dust, smoke, sparks. A round or a soft cloud is drawn see-through: after
   * everything solid, so it is never painted over by a solid thing behind
   * it, and among other see-through things in order of how far its middle
   * is. Its particles write no depth and are not sorted by distance among
   * themselves, so where two of one cloud overlap, the one listed later is
   * on top. Each is solid at its middle unless `opacity` says less (default
   * 1 for these two shapes). May change at any time.
   */
  particleShape?: ParticleShape;
  /** Custom cursor when hovering over this object (e.g. 'pointer', 'grab'). Any type of object, top-level or a group's child. */
  cursor?: string;
  /** If true, hover sets cursor to pointer. Any type of object, top-level or a group's child. */
  interactive?: boolean;
  /**
   * Whether a click or a hover can land on this object. Set false to let
   * the pointer through to what is behind it: a ground plane, a glass wall,
   * a marker. False on a group leaves out everything in it. Particles are
   * the other way about: they are not picked unless this is true, and then
   * at the size the points are drawn.
   */
  pickable?: boolean;
  /**
   * `'camera'` pins the object to the camera: `position` becomes an offset in
   * camera space (x right, y up, z forward is negative) and `rotation` a local
   * turn — a first-person weapon, a held block, a helmet edge. It is moved by
   * the render loop every frame, so it never lags the view, and it is left out
   * of the centre-ray picking a pointer-locked scene reports.
   */
  attach?: 'camera';
  position?: { x: number; y: number; z: number };
  /** The object's turn about x, y and z, in radians, applied in `rotationOrder`. */
  rotation?: { x: number; y: number; z: number };
  /**
   * The order `rotation`'s three angles are applied in: 'XYZ' (the default),
   * 'YXZ', 'ZXY', 'ZYX', 'YZX' or 'XZY'. 'YXZ' is the one for a figure that
   * turns to a heading (y) and then leans or nods (x): in 'XYZ' the lean
   * tips the heading with it.
   */
  rotationOrder?: 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';
  /**
   * Turn the object so its front faces this point, `{ x, y, z }`, keeping it
   * as upright as that allows: a turret at its target, a sign at the
   * player. The front is the object's +z, as it is for a model made facing
   * forward. The point is in the same space as `position`: the scene, or the
   * group for a group's child. `rotation`, when also given, is then a turn of
   * the object's own applied first: the quarter turn a model needs whose
   * front is not its +z.
   */
  lookAt?: { x: number; y: number; z: number };
  /**
   * Lay the object's long axis along this direction, `{ x, y, z }` (any
   * length): the long axis is the object's +y, the one a cylinder, a capsule
   * or a cone stands along. An arm from shoulder to hand, a beam between two
   * posts, an arrow in flight. `rotation`, when also given, is applied
   * first, so its `y` rolls the object about that axis. `lookAt` is used if
   * both are given.
   */
  align?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number } | number;
  /**
   * Take this object to a new `position`, `rotation` (or `lookAt`, `align`),
   * `scale`, `color`, `opacity`, `emissive` or `emissiveIntensity` over this
   * many milliseconds instead of at once, in place of the scene's
   * `transition`; 0 makes this object jump whatever the scene says. A group's
   * `transition` is its children's too, unless a child gives its own.
   */
  transition?: number;
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  /**
   * How solid the object is, from 0 (not seen) to 1 (solid, the default).
   * Anything below 1 is drawn see-through. A cloud of particles is solid
   * too unless it gives one below 1.
   */
  opacity?: number;
  metalness?: number;
  roughness?: number;
  wireframe?: boolean;
  /** Low-poly faceted shading for stylized diorama / retro aesthetics. */
  flatShading?: boolean;
  /**
   * Procedural texture preset: 'stone' | 'brick' | 'tile' | 'wood' | 'grass' |
   * 'checker' | 'stripes' | 'dots' | 'metal' | 'sand' | 'grid' | 'noise' |
   * 'concrete' | 'rust', and the cut-out decals 'bullethole' | 'blood' |
   * 'scorch' (transparent outside the mark; put them on a plane a few
   * millimetres in front of a surface).
   */
  texture?: string;
  /** Texture tiling repeat across the surface, e.g. { x: 2, y: 2 }. */
  textureRepeat?: { x: number; y: number };
  /**
   * Image texture URL. A path with no scheme (`"assets/crate.png"`) names a
   * file in the app's own bundle, so logic can name one without `asset()`;
   * a path the bundle does not have is fetched as written.
   */
  textureUrl?: string;
  /** How deep a texture's relief looks (default 0.03). May change at any time. */
  bumpScale?: number;
  /** Cut-out threshold for a texture with transparent pixels (a decal). May change at any time. */
  alphaTest?: number;
  /** Draw both faces: a flat leaf or a decal seen from behind. May change at any time. */
  doubleSided?: boolean;
  /** Set false to keep the object out of the fog: a star field, a moon. May change at any time. */
  fog?: boolean;
  /**
   * Whether the object casts a shadow (with the scene's `shadows` on, from a
   * light with `castShadow`). A group's is what its children have, unless a
   * child says otherwise for itself.
   */
  castShadow?: boolean;
  /** Whether shadows fall on the object. A group's is its children's, unless a child says otherwise for itself. */
  receiveShadow?: boolean;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  /** Torus tube thickness. Defaults to 40% of `radius` so small rings stay rings. */
  tube?: number;
  /**
   * Motion the scene keeps up by itself, with no tick from logic: a turn of
   * `rotateX`/`rotateY`/`rotateZ` radians per frame at 60 frames a second
   * (0.01 is a slow spin), and a bob of `floatAmplitude` units up and down
   * around `position.y`, `floatSpeed` radians of the wave per second
   * (default 1). Works on a top-level object and on a group's child.
   */
  animate?: {
    rotateX?: number;
    rotateY?: number;
    rotateZ?: number;
    floatAmplitude?: number;
    floatSpeed?: number;
  };
  /**
   * For `type: 'model'`: which of the model's clips plays (the "loaded"
   * state of `onModelState` lists their names, and how long each is; the
   * first when none is named), and how. `clip: "*"` is every clip of the
   * model at once, on one clock: a scene whose camera, figures and
   * machines were each animated as a clip of their own plays as it was
   * made. Each clip of the set that is shorter than the longest holds its
   * last pose until the longest ends, and with `loop: 'repeat'` (the
   * default) they all start again together; `"*"` is not cross-faded to or
   * from. (A clip whose own name is `*` cannot be played alone by that
   * name: `"*"` is always all of them.)
   */
  animation?: {
    clip?: string;
    playing?: boolean;
    loop?: 'once' | 'repeat';
    speed?: number;
    crossFadeMs?: number;
    clampWhenFinished?: boolean;
    /**
     * Hold the clip at this point instead of playing it: 0 is its start, 1
     * its end, 0.62 is 62% of the way through (of the longest, for
     * `clip: "*"`). A gauge's needle, a tank's level, a door half open. Take
     * it away and the clip plays on from there.
     */
    progress?: number;
    /**
     * Hold the clip at this many seconds from its first key, instead of
     * playing it: the way to run a clip from a clock of the app's own (a
     * film scrubbed, paused or played to a sound track). Given on every
     * frame it costs no more than the pose: nothing is started again or
     * faded. Before the start is the start; past the end is the end. Used
     * in place of `progress` when both are given. For a model that is a
     * film looked through with `camera={{ from }}`, this is also the film's
     * second: its cuts, a lens that changes and a focus that moves follow
     * it up to the film's own `duration`, however short the clip is and
     * whether or not the model has one (a still scene whose cameras cut is
     * run by `animation: { time }` alone).
     */
    time?: number;
  };
}

/**
 * What a click landed on. `objectId` is the empty string when the ray hit
 * nothing, which a pointer-locked scene still reports so a game can fire into
 * the sky. `instanceId` is set for an `instanced` object; `normal` is the face
 * that was hit, in world space, which is what tells a builder where a new
 * block goes.
 */
export interface Scene3DHit {
  objectId: string;
  /** The top-level object the hit belongs to: the group, for a group's child. */
  rootObjectId?: string;
  cursor?: string;
  /** The button pressed: 0 the main one, 1 the middle, 2 the other. -1 where no button was (a move, a hover). */
  button: number;
  locked: boolean;
  instanceId: number | null;
  distance: number | null;
  point: { x: number; y: number; z: number } | null;
  normal: { x: number; y: number; z: number } | null;
  /**
   * Where the pointer is, in CSS pixels from the scene's top-left corner: the
   * place to put a tooltip or a menu beside what was clicked. The middle of
   * the scene while the pointer is locked.
   */
  screen: { x: number; y: number };
  /**
   * Whether the pointer moved between going down and coming up: true for the
   * end of an orbit or a drag, false for a press that stayed put. Always
   * false in a click, which a drag never is.
   */
  dragged: boolean;
}

/** What a ray hit, before the event it is reported in adds the pointer's own facts. */
type PickedHit = Omit<Scene3DHit, 'button' | 'locked' | 'screen' | 'dragged'>;

export interface Scene3DLight {
  id?: string;
  type: 'ambient' | 'directional' | 'point' | 'spot' | 'hemisphere';
  color?: string;
  groundColor?: string;
  intensity?: number;
  position?: { x: number; y: number; z: number };
  /**
   * Whether the light casts shadows (directional, point and spot lights; the
   * scene's `shadows` must be on). May be turned on or off at any time, and
   * so may `shadowMapSize`, `shadowBias`, `shadowNear` and `shadowFar`, and a
   * directional light's `shadowCameraSize`.
   */
  castShadow?: boolean;
  /**
   * For a directional light: `'camera'` carries the light with the camera,
   * keeping its direction (`position` is then where it stands from the
   * camera, and so which way it shines). Its shadows cover the ground around
   * the camera wherever the camera goes, where a light that stays put shadows
   * only `shadowCameraSize` units around the middle of the world. `'view'`
   * does the same with the box of its shadows moved forward, its middle
   * `0.8 * shadowCameraSize` ahead of the camera along its line of sight: a
   * box about the camera has half of itself behind the camera, and this one
   * covers what is in the picture with the same map. The default is neither:
   * the light stays where `position` puts it.
   */
  follow?: 'camera' | 'view';
  /** Spot cone half-angle in radians (default 0.5), and how soft its edge is, 0..1. */
  angle?: number;
  penumbra?: number;
  /** Point and spot: how far the light reaches (0 = no limit) and how fast it falls off. */
  distance?: number;
  decay?: number;
  /** Shadow map resolution in pixels (e.g. 1024 or 2048). Defaults to 1024 for a directional light, 512 for a point or spot light. */
  shadowMapSize?: number;
  /**
   * A directional light's shadows cover a box this many units each way from where the light
   * aims (default 15). Larger covers more ground with coarser shadows at the same `shadowMapSize`.
   */
  shadowCameraSize?: number;
  /** Shadow bias to avoid self-shadowing acne (default -0.0005 for a directional light, none for a point or spot light). */
  shadowBias?: number;
  /**
   * How far off a surface, along the way it faces, the place a shadow is
   * looked up for is moved, in scene units (default 0: not moved). For a
   * light that grazes smooth-shaded ground made of large faces: each face
   * that turns a little away from the light, while its smoothed shading
   * still faces it, shadows itself, and thin dark streaks run along the
   * lines between faces. A few hundredths of a unit takes them away, where
   * `shadowBias` large enough to do it would lift every shadow off the foot
   * of what casts it. Too much thins the shadows of thin things. May change
   * at any time.
   */
  shadowNormalBias?: number;
  /**
   * How near to the light and how far from it shadows are drawn: from 0.5 to 150 for a
   * directional light, from 0.5 to 500 for a point or spot light (which, given a `distance`,
   * draws them that far). A point or spot light's nearest must be above zero.
   */
  shadowNear?: number;
  shadowFar?: number;
  /**
   * `'camera'` carries the light with the view: `position` is an offset in
   * camera space, and a spot light points where the camera points — a torch
   * in the player's hand, a miner's lamp on a helmet.
   */
  attach?: 'camera';
}

/**
 * Where a model's load stands, as `onModelState` reports it. Each list of
 * names holds at most 256, and leaves out any name longer than 200
 * characters: the thing is still in the model, but that is not a name an
 * author will type.
 */
export interface ModelLoadState {
  state: 'pending' | 'loaded' | 'error';
  /** 1 for the first load of a URL; one more for each `reload` of it. */
  attempt: number;
  error?: string;
  /** With `loaded`: the names of the model's animation clips, for `animation.clip`. */
  clips?: string[];
  /** With `loaded`: the names of its materials, for `appearance.colors`. */
  materials?: string[];
  /** With `loaded`: the names of its meshes, for `appearance.hiddenMeshes`. */
  meshes?: string[];
  /** With `loaded`: the names of its morph targets, for `appearance.morphs`. */
  morphs?: string[];
  /**
   * With `loaded`: the names of its nodes, for `parts`: what its author
   * named (a wheel, a hatch, a bone), without the model's own top node and
   * without the pieces a mesh of several materials is loaded as. At most
   * 256 are listed.
   */
  nodes?: string[];
  /** With `loaded`: how long each clip of `clips` is, in seconds from its first key to its last, in the same order. */
  clipLengths?: number[];
  /** With `loaded`: the names of the model's cameras, for `camera={{ from, name }}`. */
  cameras?: string[];
  /** With `loaded`: the names of the model's lights (the object's `lights` dims them, switches them off or lets them cast shadows). */
  lights?: string[];
  /**
   * With `loaded`, for a file that carries one (a scene exported from
   * Blender with SoftN's export script): what the file says of itself as a
   * film. `duration` (seconds), `fps`, `clip` (the clip to play, or "*" for
   * all of them together), `cuts` (`[{ time, camera }]`: which camera from
   * which second), `cameras` (by name: `fov`, the keys of a lens that
   * changes, as `[seconds, radians]`; `focus`, what it is focused on:
   * `{ object | distance, fstop, sensorHeight }`), `view` (`{ transform,
   * exposure, look }`, as Blender showed it) and `environment` (`{ file,
   * strength, rotation }`: the panorama it was lit by). At most 256 cuts,
   * 64 cameras and 256 keys of each lens or focus are given.
   */
  film?: FilmRecord;
  /** With `loaded`: how big the model is as its file gives it, before `scale` or `fit`. */
  size?: { x: number; y: number; z: number };
  /** With `loaded`: the middle of the model as its file gives it. */
  center?: { x: number; y: number; z: number };
}

export interface Scene3DModelStateInfo extends ModelLoadState {
  objectId: string;
  /** For a model that is a group's child: the id of that group. */
  parentId?: string;
}

/** A clip that ended, or one a model was asked for and does not have. */
export interface Scene3DAnimationInfo {
  objectId: string;
  /** For a model that is a group's child: the id of that group. */
  parentId?: string;
  clip: string;
  type: 'finished' | 'missing';
}

/** A camera that keeps behind an object, worked out on every frame the scene draws. */
export interface Scene3DFollow {
  /** The `id` of the object to follow: a top-level object, or a group's child. */
  target: string;
  /** How far behind the object the camera stands, in scene units (default 6). */
  distance?: number;
  /** How far above the object's position the camera stands (default 3). */
  height?: number;
  /** How far in front of the object the camera looks (default 0: at the object itself). */
  lookAhead?: number;
}

export interface Scene3DCamera {
  /** Where the camera stands, `{ x, y, z }` (at first `{ x: 0, y: 3, z: 8 }`). */
  position?: { x: number; y: number; z: number };
  /** The point the camera looks at, `{ x, y, z }` (at first the middle of the scene). */
  lookAt?: { x: number; y: number; z: number };
  /** A perspective camera's field of view from top to bottom, in degrees (at first 60). */
  fov?: number;
  /** The nearest the camera draws, in scene units from itself (at first 0.1). Nothing nearer is shown. */
  near?: number;
  /** The farthest the camera draws (at first 1000). A large world needs more; a small one is sharper with less. */
  far?: number;
  /**
   * 'perspective' (the default: far things are smaller) or 'orthographic'
   * (they are not: a plan, an elevation, a board seen square on). May change
   * at any time; the camera stays where it is.
   */
  type?: 'perspective' | 'orthographic';
  /** For `type: 'orthographic'`: how much of the scene is in view from top to bottom, in scene units (at first 10). */
  size?: number;
  /**
   * Keep the camera behind an object: `{ target, distance, height, lookAhead }`.
   * It stands `distance` behind the object named by `target` (behind is away
   * from the object's front, its +z, turned as the object is turned) and
   * `height` above it, and looks at the point `lookAhead` in front of it.
   * Worked out on every frame from where the object is drawn, so it follows
   * an object that `transition` is easing without shaking, and is eased
   * itself by `cameraSmoothing`. While no object has that id the camera is
   * `position` and `lookAt`. Not used while `mouseLook` or `pointerLock` is
   * on; orbit controls wait while it follows.
   */
  follow?: Scene3DFollow;
  /**
   * Look through a camera that is in a model: the `id` of a `type: 'model'`
   * object (top-level, or a group's child) whose file has cameras in it, as
   * a scene exported from Blender has. While that model is loaded and has
   * the camera, the scene's view is that camera on every frame: where it
   * stands and which way it faces as the model is drawn (after its clip
   * and its `parts`), its vertical field of view, and its nearest and
   * farthest unless `near` and `far` are given here (the file's are lengths
   * of the model, so a model drawn at a hundredth of its size has them a
   * hundredth as long; `near` and `far` given here are in the scene's units
   * and are used as they are; a camera whose file gives it no farthest
   * keeps the scene's). A cut from one camera
   * to another is never eased: one frame is the old camera's, the next the
   * new one's. A scene narrower than the picture the camera was made for
   * widens the view up and down so the sides of that picture are kept; a
   * wider one keeps it and shows more at the sides. Until the model has
   * loaded, and for a model with no camera, the view is `position` and
   * `lookAt` as it always was. While a model's camera is in force,
   * `follow`, `cameraSmoothing`, `mouseLook` and orbit controls do nothing.
   * When `from` goes (or its model does), the scene's own camera is back at
   * once where it would have been: at `position` and looking at `lookAt`
   * where those are given, and otherwise where it stood before (where the
   * person had orbited it to, say).
   */
  from?: string;
  /**
   * With `from`: the name of the camera to look through (the model's
   * "loaded" state lists them as `cameras`). Left out, it is the camera the
   * file's own cuts name for the second the film stands at (a film cuts
   * from camera to camera by itself), and for a file with no cuts the
   * model's first camera, whether or not that one has a name. A camera
   * with no name cannot be asked for by one, and is not in the list.
   */
  name?: string;
}

/** How far the person may take the camera with `orbitControls`. Each limit left out is not a limit. */
export interface Scene3DOrbit {
  /** The nearest the camera may come to what it orbits, in scene units: it cannot be zoomed through an object. */
  minDistance?: number;
  /** The farthest it may go. */
  maxDistance?: number;
  /** The highest the camera may go, as an angle from straight above, in radians (0 is straight above). */
  minPolar?: number;
  /** The lowest it may go: `Math.PI / 2` (1.5708) stops it at the ground, so it cannot orbit under the floor. */
  maxPolar?: number;
  /** Set false so the person cannot slide the view sideways (pan). */
  pan?: boolean;
  /** Set false so the person cannot zoom. */
  zoom?: boolean;
}

/** Where the person left the camera, as `onCameraChange` reports it. */
export interface Scene3DCameraInfo {
  /** Where the camera stands: give it back as `camera.position`. */
  position: { x: number; y: number; z: number };
  /** The point it orbits and looks at: give it back as `camera.lookAt`. */
  target: { x: number; y: number; z: number };
  /** For an orthographic camera: how much is in view from top to bottom, as zoomed. Give it back as `camera.size`. */
  size?: number;
}

/** The scene's readout, as `onStats` reports it. */
export interface Scene3DStats {
  /** Frames drawn per second, over about the last second. */
  fps: number;
  /** Separate things the last frame drew: each object, each batch of instances, each pass of an effect. */
  drawCalls: number;
  /** Triangles in the last frame. */
  triangles: number;
}

export interface Scene3DProps {
  /**
   * How wide the scene is, in CSS pixels (default 800). It is never wider
   * than the space it is given: in a narrower place, a phone, it shrinks to
   * fit and keeps the shape `width` and `height` describe.
   */
  width?: number;
  /** How tall the scene is at its full `width`, in CSS pixels (default 600). */
  height?: number;
  /**
   * Size the canvas to whatever box it sits in, instead of `width`/`height`,
   * and follow that box as it changes — a game that wants the whole viewport
   * puts the scene in a fixed, inset-0 container and says `fill`.
   */
  fill?: boolean;
  /**
   * What is in the scene: a list of records, each with an `id` and a `type`:
   * a shape ('box', 'sphere', 'cylinder', 'capsule', 'prism', 'plane',
   * 'torus', 'cone', 'ring', 'dodecahedron', 'icosahedron', 'octahedron'),
   * or 'model', 'instanced', 'group' or 'particles'. An object whose id is
   * still in the list is changed in place; one whose id has gone is removed.
   * Every object takes `position` and `rotation` (`{ x, y, z }`, rotation in
   * radians, applied in `rotationOrder`, 'XYZ' unless given), `scale`,
   * `color`, `opacity`, `castShadow`, `receiveShadow`, `cursor` or
   * `interactive` (the pointer shown over it), `pickable` (false lets a
   * click through to what is behind; particles are picked only when it is
   * true) and `animate` (`{ rotateY, floatAmplitude }`: a turn and a bob the
   * scene keeps up by itself). In place of working out a rotation, `lookAt`
   * (`{ x, y, z }`: a point the object's front, its +z, faces) or `align`
   * (`{ x, y, z }`: a direction its long axis, its +y, lies along).
   * `transition` (milliseconds) eases this object's changes in place of the
   * scene's `transition`. A shape takes `width`, `height`, `depth` or
   * `radius`, and `texture` (a painted one, by name) or `textureUrl`. A
   * model takes `modelUrl` (a URL, or a path in the app's own bundle such as
   * "assets/robot.glb"), `fit` (scale it so its longest side is that many
   * units, standing on the ground), `animation` (`{ clip, loop, progress }`:
   * `progress` from 0 to 1 holds the clip at that point, `time` holds it at
   * that many seconds, and `clip: "*"` is every clip of the model at once),
   * `lights` (the lights that are in the model's file: `false` for none of
   * them, `{ intensity }` to dim them, `{ castShadow: true }` for shadows
   * from its sun), `appearance` and
   * `parts` (`{ Wheel_FL: { rotation: { x, y, z } }, Hatch: { visible: false } }`:
   * a named node of the model turned, moved, scaled or hidden, measured from
   * the pose its file gives it; rotation in radians about the part's own axes).
   * An 'instanced' object takes `shape`, `instances` (a flat array, x, y, z
   * a copy, and a `palette` index after them when `palette` is given) and,
   * beside it, `instanceRotations` (one turn about the upright axis a copy,
   * or three angles a copy) and `instanceScales` (one size a copy, or
   * three). A group takes `children`, placed relative to it: a child may be
   * of any type, a model included. A 'particles' cloud takes
   * `particlePositions` (a flat array, x, y, z a particle), `particleSize`
   * and `particleShape` ('square', the default; 'round', a disc with a clean
   * edge; 'soft', a disc that fades out at its edge, for dust, smoke and
   * sparks: these two are drawn see-through, after everything solid).
   */
  objects?: Scene3DObject[];
  /**
   * Scenery that does not change between frames, kept apart from `objects`.
   *
   * The two are concatenated here, so this is purely about what crosses into
   * the component each frame. A scene's static geometry is usually most of
   * its bytes and almost none of its motion; passing it through `objects`
   * means a host that mirrors state rebuilds all of it every tick to move a
   * few characters. Passed here it is rebuilt only when it actually changes.
   */
  staticObjects?: Scene3DObject[];
  /**
   * The scene's lights, each `{ type, color, intensity, position, castShadow }`
   * with `type` one of 'ambient', 'directional', 'point', 'spot' or
   * 'hemisphere'. A directional light with `follow: 'camera'` goes with the
   * camera, so its shadows cover the ground around the camera wherever that
   * is; with `follow: 'view'` the box of its shadows is moved forward to
   * cover what is in the picture (its middle `0.8 * shadowCameraSize` ahead
   * of the camera). `shadowNormalBias` (scene units, none by default) takes
   * the dark banding off smooth ground that a low light grazes. Left out altogether, the scene is lit so that what is in it can be
   * seen: a soft ambient light and one sun, which casts shadows when
   * `shadows` is on (not with an `environment`, 'studio' or a panorama, which
   * lights the scene itself). An empty list, `lights={[]}`, is a scene with no light in it,
   * and so is `lights={null}`: only leaving `lights` out asks for the two.
   * A light's `castShadow`, `shadowMapSize`, `shadowBias`, `shadowNear` and
   * `shadowFar`, and a directional light's `shadowCameraSize`, may change
   * at any time.
   */
  lights?: Scene3DLight[];
  /**
   * The camera: `{ position, lookAt, fov, near, far, type, size, follow }`.
   * `position` and `lookAt` are `{ x, y, z }`; `fov` is in degrees (60);
   * `near` and `far` are the nearest and farthest it draws (0.1 and 1000).
   * `type: 'orthographic'` is a camera with no perspective, for a plan or a
   * board seen square on, showing `size` scene units from top to bottom
   * (10). `follow: { target, distance, height, lookAhead }` keeps the camera
   * `distance` behind and `height` above the object whose id is `target`,
   * looking `lookAhead` in front of it, worked out on every frame from where
   * the object is drawn: a chase camera with no arithmetic in the app.
   * `from: "film"` looks through a camera that is in the model with that
   * id (a scene exported from Blender has its cameras in it): the view is
   * that camera on every frame, with its lens, and `name` says which of the
   * model's cameras; left out, it is the one the file's own cuts name for
   * the second its clip stands at. Each field may change at any time; one
   * left out leaves the camera as it is.
   */
  camera?: Scene3DCamera;
  /**
   * Ease what changes instead of jumping to it, over this many milliseconds
   * (default 0: off). When an object's `position`, `rotation` (or `lookAt`,
   * `align`), `scale`, `color`, `opacity`, `emissive` or `emissiveIntensity`
   * changes, the scene takes it there at a steady rate from where it is
   * drawn now. A game that moves things thirty times a second draws them
   * moving at the screen's rate with `transition={40}`; a figure that
   * follows data glides with 400. An object's own `transition` is used in
   * place of this one. Not eased: an object as it first appears, a move
   * further than `jumpDistance`, anything while the app is hidden, the
   * copies of an 'instanced' object (the object as a whole is), an object
   * whose painted `texture` changes colour, and the height or the turn that
   * `animate` is already moving. A turn goes the short way round.
   */
  transition?: number;
  /**
   * How far is too far to ease, in scene units (default 4): a move longer
   * than this in one update is a jump, for an object under `transition` and
   * for a camera under `cameraSmoothing`, so a thing that is put somewhere
   * else does not sweep across the view. 0 is no limit: everything is eased
   * however far it goes.
   */
  jumpDistance?: number;
  background?: string;
  /**
   * Procedural atmospheric sky gradient: 'day' | 'sunset' | 'night' | 'dusk' |
   * 'overcast' | 'dawn' | { top: string; bottom: string; middle?: string }.
   */
  sky?: 'day' | 'sunset' | 'night' | 'dusk' | 'overcast' | 'dawn' | { top: string; bottom: string; middle?: string };
  /** Ground / level editor helper grid. May be turned on, off or changed at any time. */
  grid?: boolean | { size?: number; divisions?: number; color?: string; centerColor?: string; position?: { x: number; y: number; z: number } };
  /** Whether to show a first-person aiming crosshair (defaults to true when pointerLock is active). */
  crosshair?: boolean;
  /**
   * The scene keeps a record of which of W A S D, the arrows, Space and Shift are held, for logic
   * to read as `softn.input.keys` or `softn.input.down("w")` (the same record as
   * `window.__softnKeys`). These keys are fixed and touch cannot press them: for keys of your
   * own choosing, a gamepad and an on-screen pad as one record, use `<Controls>`.
   */
  gameControls?: boolean;
  /**
   * A see-through canvas, with the page behind showing where nothing is
   * drawn. Read when the scene is made: the drawing context cannot change
   * it afterwards, so a change needs a new scene (an `if=` around it).
   */
  alpha?: boolean;
  /**
   * Smooth edges (default true). Read when the scene is made: the drawing
   * context cannot change it afterwards, so a change needs a new scene (an
   * `if=` around it).
   */
  antialias?: boolean;
  /**
   * Draw shadows: from lights with `castShadow`, by objects with
   * `castShadow`, on objects with `receiveShadow`. May be turned on or off
   * at any time, as a graphics setting is.
   */
  shadows?: boolean;
  fog?: { color: string; near: number; far: number };
  /**
   * Let the person turn the view by dragging, zoom with the wheel and pan,
   * around `camera.lookAt`. May be turned on or off at any time: off, the
   * camera stays where it was left. Ignored while `mouseLook` or
   * `pointerLock` is on. `orbit` limits how far the person can take it, and
   * `onCameraChange` says where they left it.
   */
  orbitControls?: boolean;
  /**
   * Limits on `orbitControls`: `{ minDistance, maxDistance, minPolar,
   * maxPolar, pan, zoom }`. `minDistance` and `maxDistance` are how near and
   * how far the camera may be from what it orbits, in scene units;
   * `minPolar` and `maxPolar` how high and how low it may go, as angles from
   * straight above in radians (`maxPolar: 1.5708` stops it at the ground);
   * `pan: false` and `zoom: false` switch those off. May change at any
   * time. With an orthographic camera the distances limit nothing: it is
   * zoomed by its size.
   */
  orbit?: Scene3DOrbit;
  autoRotate?: boolean;
  autoRotateSpeed?: number;
  expandable?: boolean;
  /**
   * Drag on the scene to look around from where the camera stands. May be
   * turned on or off at any time; turned on, the view starts out facing
   * `camera.lookAt`.
   */
  mouseLook?: boolean;
  /** How far the view turns for each pixel the mouse moves, in radians (default 0.003). May change at any time. */
  mouseLookSensitivity?: number;
  /**
   * First-person mouse capture. A click on the canvas locks the pointer (the
   * browser's Escape releases it); while locked, moving the mouse turns the
   * camera and every button press is reported through `onClick` with what the
   * centre of the screen is pointing at. Implies `mouseLook`. May be turned
   * on or off at any time; turned off, a pointer it holds is given back.
   */
  pointerLock?: boolean;
  /** How far the view may tilt, in radians (default 0.8 — about 45°). May change at any time. */
  pitchLimit?: number;
  /**
   * Ease the camera toward each new `camera.position` instead of jumping to
   * it, 0..1 per frame (0 = off). A game that moves its player thirty times
   * a second reads as sixty when the render loop closes the gap between
   * ticks; 0.35 keeps under a frame of lag. A new `camera.lookAt` is eased
   * the same way, so the view turns to it and does not snap, and so is a
   * camera that follows (`camera.follow`). A move further than
   * `jumpDistance` is not eased, nor is anything while the person steers
   * with orbit controls: the camera is theirs then.
   */
  cameraSmoothing?: number;
  /**
   * The most device pixels drawn per CSS pixel (default 2). A full-viewport
   * game on a high-density screen pays four times the fill rate at 2; 1 or
   * 1.25 keeps it fast with little visible cost. May change at any time, as
   * a graphics setting does.
   */
  maxPixelRatio?: number;
  /** Tone mapping curve for cinematic highlights. Defaults to 'aces'. */
  toneMapping?: 'aces' | 'agx' | 'linear' | 'reinhard' | 'cineon' | 'none';
  /**
   * Light from the scene's surroundings: 'none' (the default), 'studio', or
   * a panorama of the app's own, `{ url, background, rotation, blur,
   * backgroundIntensity, format }`. 'studio' is a room worked out on the
   * GPU: no download but a small chunk, fetched the first time a scene asks
   * for it. A panorama is a picture of everything around one point, twice as
   * wide as it is tall: it lights the scene, and it is what metal and glossy
   * things reflect. `url` is a Radiance `.hdr` or an OpenEXR `.exr` (real
   * light values, which is what looks right) or a `.jpg`, `.png` or `.webp`
   * (an ordinary picture, fainter and flatter light); a path with no scheme
   * (`"assets/sky.hdr"`) is a file in the app's own bundle, as `modelUrl`
   * is. `format` ('hdr', 'exr' or 'image') says the kind where the
   * address's ending does not. `background: true` also shows the panorama
   * behind everything (default false: the scene's `background` or `sky`
   * stands), `blur` from 0 (sharp, the default) to 1 softens what is shown,
   * and `backgroundIntensity` is how bright it is shown (default 1).
   * `rotation` turns the panorama about the upright axis, in radians
   * (default 0): lighting, reflections and background together. Every field
   * may change at any time; another `url` is shown once it has loaded, the
   * last one staying until then. A file that cannot be loaded is warned of
   * once in the console and leaves the scene as it was; so is an `.hdr` or
   * `.exr` larger than 8192 by 4096, or than the device can draw, or one
   * that is not the picture its own header declares. With an
   * orthographic camera the panorama lights the scene just the same but is
   * not shown behind it (a view with no perspective has no panorama): the
   * scene's `background` or `sky` stands. A scene with any environment but
   * 'none' and no `lights` is lit by the environment alone.
   */
  environment?: 'none' | 'studio' | Scene3DEnvironment;
  /**
   * How strongly the environment lights the scene, 'studio' or a panorama
   * alike: a multiple from 0 to 4 (default 0.7).
   */
  environmentIntensity?: number;
  /** Exposure multiplier for tone mapping (default 1.0). */
  toneMappingExposure?: number;
  /**
   * Post-processing: `{ bloom, vignette, grain, depthOfField,
   * ambientOcclusion }`, each left out for none. `bloom` (true, or
   * `{ strength, radius, threshold }`, defaults 0.45, 0.4 and 0.85) makes
   * bright and emissive things glow; `vignette` darkens the corners (0 to
   * 1); `grain` adds film noise (0 to 1).
   *
   * `depthOfField` blurs what is nearer or further than one distance, as a
   * lens does: `{ focusOn: "rover", aperture: 0.02, maxBlur: 0.012 }` keeps
   * the object with that id sharp (a top-level object, a group's child or a
   * model; the distance is worked out on every frame, so it stays sharp as
   * the camera or the object moves, and while no object has that id nothing
   * is blurred), and `{ focus: 4.5, aperture, maxBlur }` keeps a distance
   * sharp, in scene units straight ahead of the camera. `aperture` is how
   * quickly things go soft away from that distance (default 0.02; 0.002
   * keeps nearly everything sharp, 0.05 leaves a thin slice sharp);
   * `maxBlur` is the most anything is blurred, as a fraction of the
   * picture's width (default 0.012; 0.005 is gentle, 0.02 heavy). An
   * orthographic camera is focused the same way, by distance from the
   * camera. In place of `aperture` and `maxBlur`, `fstop` blurs as a lens
   * of that f-number does: `{ focusOn: "rover", fstop: 2.8 }` (1.4 is wide
   * open, 8 nearly all sharp; `sensorHeight` is the sensor's height in
   * millimetres, 24 unless given). A lens's blur grows fast either side of
   * the sharp distance and levels off far beyond it, and is more with a
   * narrow field of view and a near subject; it needs a camera with
   * perspective. `depthOfField: "camera"` is the focus of the model's
   * camera the scene looks through (`camera={{ from }}`), as a file
   * exported from Blender records it: the thing it is focused on, or the
   * distance, and its f-number; a camera with no focus recorded blurs
   * nothing. What is in focus keeps the detail on its surfaces; its outline
   * against something far out of focus is softened by a few pixels, since
   * the blur gathers what is around each pixel. See-through things and
   * particles take the blur of what is behind them. It fills the whole
   * picture: with `alpha`, the page no longer shows through.
   *
   * `ambientOcclusion` (true, or `{ radius, intensity }`) darkens softly
   * where surfaces meet: a wheel on the ground, a bracket on a panel.
   * `radius` is how far the darkening reaches, in scene units (default
   * 0.5; it has faded out about half that far from the crease);
   * `intensity` is how dark it is, from 0 to 3 (default 1, which takes
   * about a fifth of the light from a crease; 2 takes about a third). It is
   * the costly one: the scene's solid things are drawn a second time, and
   * every pixel of the picture is then gone over twice, sixteen readings
   * each time, a few times what bloom costs. On a fast desktop graphics
   * card that is a millisecond or so a frame at 1600 by 900; a laptop's
   * built-in graphics or a phone is many times slower, so there keep it
   * for close views, or lower `maxPixelRatio`. See-through things and
   * particles are left out of where the darkening is worked out, so they
   * cast none and none is worked out on them; but it is laid over the
   * finished picture, so glass or a particle in front of a crease is
   * darkened where the crease behind it is.
   *
   * Any effect switches the frame to a chain of passes with tone mapping
   * applied at the end; its edges are smoothed when `antialias` is on, as
   * they are without effects. Each effect's numbers may change at any time
   * without the chain being made again.
   */
  effects?: Scene3DEffects;
  /**
   * Three milestones, in order. `onReady`: the renderer exists and has
   * drawn a frame — the world may still be empty. `onAssetsReady`: every
   * model the scene opened with has settled, loaded or failed (a failure is
   * reported through `onModelState`; a model withheld by the permission
   * policy is not counted, since it is not loading), and so has the
   * panorama of its `environment`, if it opened with one. `onFirstFrame`: the
   * first frame drawn after that — the one a loading screen should wait
   * for. Each fires once per mount.
   */
  onReady?: () => void;
  onAssetsReady?: () => void;
  onFirstFrame?: () => void;
  /**
   * Each model's load as it happens, as `{ objectId, state, attempt }`:
   * `pending` when a fetch starts, `loaded` or `error` (with `error`, the
   * reason, naming a refused subresource when that is why) when it settles.
   * `attempt` counts `reload`s of the same URL. `loaded` also says what is
   * in the model: `clips`, `materials`, `meshes` and `morphs` (lists of
   * names, for `animation.clip` and `appearance`), `clipLengths` (seconds,
   * one for each of `clips`), `nodes` (the names of its nodes, for
   * `parts`), `cameras` and `lights` (the names of the cameras and lights
   * the file has, for `camera={{ from, name }}` and the object's `lights`),
   * `size` and `center` (`{ x, y, z }`, as the file gives them) and, for a
   * file exported with SoftN's Blender script, `film` (how long it is, its
   * cuts from camera to camera, each camera's lens and focus, its exposure
   * and its panorama). A model in a group reports its group as `parentId`.
   */
  onModelState?: (info: Scene3DModelStateInfo) => void;
  /**
   * A click that landed on an object (a press and release without a drag,
   * left button). The handler is given the hit: `objectId`, `rootObjectId`
   * (the group, for a group's child), `instanceId` (for an instanced
   * object), `point` and `normal` (`{ x, y, z }` in the world), `distance`,
   * `screen` (`{ x, y }` in CSS pixels within the scene), `button`,
   * `dragged` and `locked`. With `pointerLock`, every press is reported
   * here while the pointer is locked, with `objectId` empty when it hit
   * nothing.
   */
  onClick?: (info: Scene3DHit) => void;
  /**
   * A click that landed on nothing: the way to deselect by clicking away.
   * Given the same record as `onClick`, with `objectId` empty and `screen`
   * where the click was. Not sent for the end of a drag, nor while the
   * pointer is locked.
   */
  onMiss?: (info: Scene3DHit) => void;
  /** A button went down on the scene; the hit is what it went down on (`objectId` empty for nothing). */
  onPointerDown?: (info: Scene3DHit) => void;
  /**
   * The pointer moved with a button held: at most once a frame, with where
   * it is by then and what is under it. `dragged` is true once it has moved
   * more than a few pixels. The last place it moved to is always sent before
   * `onPointerUp`.
   */
  onPointerMove?: (info: Scene3DHit) => void;
  /** The button came up. `dragged` tells the end of an orbit or a drag (true) from a press that stayed put (false). */
  onPointerUp?: (info: Scene3DHit) => void;
  /**
   * The pointer moved over the scene with no button held: at most once a
   * frame, with where it is now and what is under it (`objectId` empty for
   * nothing). To react only when the object changes, use `onHoverChange`.
   */
  onHover?: (info: Scene3DHit) => void;
  /**
   * What is under the pointer changed: to another object, to another copy
   * of an instanced object, or to nothing (`objectId` empty), which is also
   * sent when the pointer leaves the scene, and when the object under a
   * pointer that has not moved is taken out of the scene. The event for a
   * highlight or a tooltip: it is not sent while the pointer moves over one
   * object.
   */
  onHoverChange?: (info: Scene3DHit) => void;
  /** A model's clip ended (`type: 'finished'`) or it has no clip of the name asked for (`'missing'`): `{ objectId, clip, type }`. */
  onAnimation?: (info: Scene3DAnimationInfo) => void;
  /**
   * The person finished turning, zooming or panning the view with orbit
   * controls, and the camera has come to rest. Given `{ position, target }`,
   * both `{ x, y, z }` (and `size` for an orthographic camera): keep them,
   * and give them back as `camera.position` and `camera.lookAt` (and
   * `camera.size`) to show the same view again.
   */
  onCameraChange?: (info: Scene3DCameraInfo) => void;
  /**
   * A readout about once a second while the scene is drawn: `{ fps,
   * drawCalls, triangles }`, the frames drawn per second and what the last
   * frame took. For a counter while an app is being made, or for an app that
   * lowers its own quality when it runs slowly. Nothing is counted unless
   * this is bound.
   */
  onStats?: (info: Scene3DStats) => void;
  /**
   * `<SceneAnchor>` tags: page content pinned to places in the scene (a name
   * over a figure, a card beside a part). Anything else written inside a
   * `<Scene3D>` is not shown.
   */
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

function createPrismGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -h / 2);
  shape.lineTo(w / 2, -h / 2);
  shape.lineTo(0, h / 2);
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geom.center();
  return geom;
}

function createGeometry(obj: Scene3DObject): THREE.BufferGeometry {
  const w = obj.width ?? 1;
  const h = obj.height ?? 1;
  const d = obj.depth ?? 1;
  const r = obj.radius ?? 0.5;
  const shape = obj.type === 'instanced' ? (obj.shape ?? 'box') : obj.type;

  switch (shape) {
    case 'box':
      return new THREE.BoxGeometry(w, h, d);
    case 'sphere':
      return new THREE.SphereGeometry(r, 32, 32);
    case 'cylinder':
      return new THREE.CylinderGeometry(r, r, h, 32);
    case 'capsule': {
      const capR = obj.radius ?? 0.5;
      const capH = Math.max(0.01, (obj.height ?? 1) - 2 * capR);
      return new THREE.CapsuleGeometry(capR, capH, 8, 16);
    }
    case 'prism':
      return createPrismGeometry(w, h, d);
    case 'cone':
      return new THREE.ConeGeometry(r, h, 32);
    case 'plane':
      return new THREE.PlaneGeometry(w, h);
    // The tube was a fixed 0.4m, so any ring smaller than that came out as a
    // solid ball — a 4cm mug handle rendered as a 90cm sphere. Scale it with
    // the radius instead; at r = 1 this is what the old constant gave.
    case 'torus':
      return new THREE.TorusGeometry(r, obj.tube ?? r * 0.4, 16, 100);
    case 'ring':
      return new THREE.RingGeometry(r * 0.5, r, 32);
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(r);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(r);
    case 'octahedron':
      return new THREE.OctahedronGeometry(r);
    default:
      return new THREE.BoxGeometry(w, h, d);
  }
}

/**
 * Procedural textures shared across every Scene3D on the page, counted per
 * material and bounded when idle. See textureCache.ts for the rules; the
 * numbers: a 256x256 canvas texture is 256 KB on the GPU, so the idle budget
 * below is a few megabytes at most kept for reuse between scenes.
 */
const PROCEDURAL_TEXTURE_IDLE_BUDGET = 24;
// An idle texture's uploads are let go and the canvas kept, to upload again
// when next used. Each renderer leaves a listener on a texture it uploads,
// which its own dispose() does not take off: a closed scene's renderer,
// context and canvas stayed reachable from this cache.
const proceduralTextureCache = new BoundedTextureCache<THREE.CanvasTexture>(PROCEDURAL_TEXTURE_IDLE_BUDGET, (texture) =>
  texture.dispose()
);
/** Set on each cached texture so a material's disposal can hand it back. */
const TEXTURE_CACHE_KEY = '__softnTextureKey';

/** Cache counts, for a development inspector. Not for apps. */
export function proceduralTextureCacheStats() {
  return proceduralTextureCache.stats();
}

/**
 * The cached texture for these parameters, counted as in use by the caller's
 * material until releaseMaterialTextures runs on it.
 */
function createProceduralTexture(type: string, baseColorStr?: string, repeat?: { x: number; y: number }): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const key = `${type}_${baseColorStr || ''}_${repeat?.x ?? 1}_${repeat?.y ?? 1}`;
  return proceduralTextureCache.acquire(key, () => {
    const texture = paintProceduralTexture(type, baseColorStr, repeat);
    if (texture) texture.userData[TEXTURE_CACHE_KEY] = key;
    return texture;
  });
}

/** Give back the procedural texture a material was holding, if it held one; dispose any other. */
function releaseMaterialTextures(mat: THREE.Material): void {
  const m = mat as THREE.MeshStandardMaterial;
  const maps = [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.emissiveMap, m.aoMap, m.alphaMap, m.envMap];
  for (const tex of maps) {
    if (!tex) continue;
    // The picture a round or a soft particle is drawn with is every cloud's: the scene's to let go of, not a material's.
    if (tex.userData?.[SHARED_SPRITE_KEY]) continue;
    const key = tex.userData?.[TEXTURE_CACHE_KEY];
    if (typeof key === 'string') proceduralTextureCache.release(key);
    else tex.dispose();
  }
}

/** A material and whatever it was holding: shared textures released, its own disposed. */
function disposeMaterial(mat: THREE.Material): void {
  releaseMaterialTextures(mat);
  mat.dispose();
}

function paintProceduralTexture(type: string, baseColorStr?: string, repeat?: { x: number; y: number }): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return null;

  const baseColor = baseColorStr || '#888888';
  const cutout = type === 'bullethole' || type === 'blood' || type === 'scorch';
  if (!cutout) {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, 256, 256);
  }
  // A tiny deterministic generator so a texture is the same every time.
  let seed = 12345;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };

  if (type === 'bullethole') {
    // A dark crater with a lighter chipped rim and a few flecks around it.
    const g = ctx.createRadialGradient(128, 128, 6, 128, 128, 88);
    g.addColorStop(0, 'rgba(8, 8, 10, 1)');
    g.addColorStop(0.35, 'rgba(20, 18, 16, 0.98)');
    g.addColorStop(0.6, 'rgba(70, 64, 58, 0.55)');
    g.addColorStop(1, 'rgba(90, 84, 78, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(128, 128, 88, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, r = 40 + rnd() * 70;
      ctx.fillStyle = `rgba(${60 + Math.floor(rnd() * 60)}, ${52 + Math.floor(rnd() * 50)}, ${44 + Math.floor(rnd() * 40)}, ${0.35 + rnd() * 0.5})`;
      ctx.beginPath(); ctx.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 2 + rnd() * 5, 0, Math.PI * 2); ctx.fill();
    }
  } else if (type === 'blood') {
    // A splatter: a heavy centre, drips and flecks, all dark red.
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2, r = i === 0 ? 0 : 20 + rnd() * 60;
      const rad = i === 0 ? 62 : 14 + rnd() * 30;
      const g = ctx.createRadialGradient(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, rad * 0.2, 128 + Math.cos(a) * r, 128 + Math.sin(a) * r, rad);
      g.addColorStop(0, 'rgba(96, 8, 12, 0.98)');
      g.addColorStop(0.7, 'rgba(110, 12, 16, 0.85)');
      g.addColorStop(1, 'rgba(120, 16, 20, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, rad, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 60; i++) {
      const a = rnd() * Math.PI * 2, r = 30 + rnd() * 90;
      ctx.fillStyle = `rgba(${80 + Math.floor(rnd() * 40)}, 6, 10, ${0.5 + rnd() * 0.5})`;
      ctx.beginPath(); ctx.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 1 + rnd() * 4, 0, Math.PI * 2); ctx.fill();
    }
  } else if (type === 'scorch') {
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 120);
    g.addColorStop(0, 'rgba(10, 8, 6, 0.9)');
    g.addColorStop(0.5, 'rgba(30, 24, 18, 0.55)');
    g.addColorStop(1, 'rgba(40, 32, 24, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(128, 128, 120, 0, Math.PI * 2); ctx.fill();
  } else if (type === 'concrete') {
    // Mottled grey with hairline cracks and pits.
    for (let i = 0; i < 900; i++) {
      const v = Math.floor(rnd() * 40);
      ctx.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${v / 400})` : `rgba(0,0,0,${v / 300})`;
      ctx.fillRect(Math.floor(rnd() * 256), Math.floor(rnd() * 256), 2 + Math.floor(rnd() * 5), 2 + Math.floor(rnd() * 5));
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      let x = rnd() * 256, y = rnd() * 256;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += (rnd() - 0.5) * 40; y += (rnd() - 0.5) * 40; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  } else if (type === 'rust') {
    // Streaks of orange-brown over the base, heavier toward the bottom.
    for (let i = 0; i < 260; i++) {
      const y = Math.floor(rnd() * 256);
      const w = 6 + Math.floor(rnd() * 40), h = 2 + Math.floor(rnd() * 14);
      ctx.fillStyle = `rgba(${120 + Math.floor(rnd() * 60)}, ${50 + Math.floor(rnd() * 30)}, ${10 + Math.floor(rnd() * 20)}, ${0.12 + (y / 256) * 0.3 * rnd()})`;
      ctx.fillRect(Math.floor(rnd() * 256), y, w, h);
    }
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.2})`;
      ctx.fillRect(Math.floor(rnd() * 256), Math.floor(rnd() * 256), 1 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 3));
    }
  } else if (type === 'checker') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillRect(128, 128, 128, 128);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fillRect(128, 0, 128, 128);
    ctx.fillRect(0, 128, 128, 128);
  } else if (type === 'tile') {
    const tileSize = 64;
    for (let x = 0; x < 256; x += tileSize) {
      for (let y = 0; y < 256; y += tileSize) {
        const shade = ((x + y) % 128 === 0) ? 0.08 : -0.05;
        ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
        ctx.fillRect(x + 2, y + 2, tileSize - 4, tileSize - 4);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 3, y + 3, tileSize - 6, tileSize - 6);
      }
    }
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 3;
    for (let i = 0; i <= 256; i += tileSize) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
  } else if (type === 'brick') {
    const bh = 32;
    const bw = 64;
    for (let y = 0; y < 256; y += bh) {
      const row = Math.floor(y / bh);
      const offset = (row % 2) * (bw / 2);
      for (let x = -bw; x <= 256 + bw; x += bw) {
        const bx = x + offset;
        const shade = ((row * 7 + Math.floor(x / bw) * 13) % 20) / 100 - 0.1;
        ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
        ctx.fillRect(bx + 2, y + 2, bw - 4, bh - 4);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.strokeRect(bx + 3, y + 3, bw - 6, bh - 6);
      }
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
    }
  } else if (type === 'stone') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(0, 0, 256, 256);
    const stones = [
      { x: 4, y: 4, w: 120, h: 56 }, { x: 130, y: 4, w: 122, h: 56 },
      { x: 4, y: 66, w: 76, h: 56 }, { x: 86, y: 66, w: 90, h: 56 }, { x: 182, y: 66, w: 70, h: 56 },
      { x: 4, y: 128, w: 110, h: 58 }, { x: 120, y: 128, w: 132, h: 58 },
      { x: 4, y: 192, w: 84, h: 60 }, { x: 94, y: 192, w: 96, h: 60 }, { x: 196, y: 192, w: 56, h: 60 },
    ];
    for (const s of stones) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 4;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      for (let f = 0; f < 10; f++) {
        ctx.fillRect(s.x + (f * 17) % (s.w - 8) + 4, s.y + (f * 23) % (s.h - 8) + 4, 3, 3);
      }
    }
  } else if (type === 'wood') {
    const plankH = 64;
    for (let y = 0; y < 256; y += plankH) {
      const shade = ((y / plankH) % 2 === 0) ? 0.06 : -0.06;
      ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
      ctx.fillRect(0, y + 2, 256, plankH - 4);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
      ctx.lineWidth = 1;
      for (let g = 8; g < plankH - 4; g += 10) {
        ctx.beginPath();
        ctx.moveTo(0, y + g);
        ctx.bezierCurveTo(80, y + g + 2, 180, y + g - 2, 256, y + g);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
    }
  } else if (type === 'grass') {
    for (let i = 0; i < 350; i++) {
      const gx = (i * 37) % 256;
      const gy = (i * 71) % 256;
      const gh = 6 + (i % 8);
      ctx.strokeStyle = (i % 3 === 0) ? 'rgba(34, 197, 94, 0.35)' : ((i % 3 === 1) ? 'rgba(21, 128, 61, 0.45)' : 'rgba(250, 204, 21, 0.2)');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + (i % 5) - 2, gy - gh);
      ctx.stroke();
    }
  } else if (type === 'metal') {
    for (let y = 0; y < 256; y += 3) {
      const a = 0.05 + ((y * 19) % 10) / 100;
      ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
      ctx.fillRect(0, y, 256, 1.5);
    }
  } else if (type === 'sand') {
    for (let y = 0; y < 256; y += 16) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(70, y + 4, 190, y - 4, 256, y);
      ctx.stroke();
    }
  } else if (type === 'grid') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 256; i += 32) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
  } else if (type === 'stripes') {
    // Bands across the surface, one darker and the next lighter, so they
    // show on any base colour. Four pairs, which meet at the edges.
    for (let x = 0; x < 256; x += 64) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(x, 0, 32, 256);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(x + 32, 0, 32, 256);
    }
  } else if (type === 'dots') {
    // Rows of dots, every other row half a step along; none crosses an
    // edge, so the pattern repeats without a seam.
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 4; col++) {
        const cx = col * 64 + 16 + (row % 2) * 32;
        const cy = row * 32 + 16;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.34)';
        ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
      }
    }
  } else {
    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = (i % 2 === 0) ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      ctx.fillRect((i * 47) % 256, (i * 83) % 256, 4, 4);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat?.x ?? 1, repeat?.y ?? 1);
  return texture;
}

function createSkyTexture(sky: Scene3DProps['sky']): THREE.CanvasTexture | null {
  if (!sky || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 256;
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return null;

  let top = '#1d4ed8';
  let bottom = '#93c5fd';
  let middle: string | undefined;

  if (typeof sky === 'string') {
    if (sky === 'sunset') {
      top = '#1e1b4b';
      middle = '#e11d48';
      bottom = '#fbbf24';
    } else if (sky === 'night') {
      top = '#020617';
      bottom = '#0f172a';
    } else if (sky === 'dusk') {
      top = '#09090b';
      middle = '#581c87';
      bottom = '#a855f7';
    } else if (sky === 'overcast') {
      top = '#334155';
      bottom = '#94a3b8';
    } else if (sky === 'dawn') {
      top = '#1e293b';
      middle = '#f43f5e';
      bottom = '#fdba74';
    } else {
      top = '#1d4ed8';
      bottom = '#93c5fd';
    }
  } else if (typeof sky === 'object') {
    top = sky.top || top;
    bottom = sky.bottom || bottom;
    middle = sky.middle;
  }

  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  if (middle) grad.addColorStop(0.5, middle);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, 256);

  const tex = new THREE.CanvasTexture(canvas);
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Paint the scene's background: none for a transparent canvas, else the sky's
 * gradient, else the colour. Returns the sky texture it made, for the caller
 * to dispose when the background changes or the scene goes.
 */
function paintBackground(
  scene: THREE.Scene,
  alpha: boolean,
  background: string,
  sky: Scene3DProps['sky']
): THREE.Texture | null {
  if (alpha) {
    scene.background = null;
    return null;
  }
  const skyTexture = createSkyTexture(sky);
  scene.background = skyTexture ?? new THREE.Color(background);
  return skyTexture;
}

/** What a background is painted from, to tell a new one from a re-render with the same. */
function backgroundKey(alpha: boolean, background: string, sky: Scene3DProps['sky']): string {
  return alpha ? 'transparent' : JSON.stringify([background, sky ?? null]);
}

/**
 * The material for a primitive. `policy` is the scene's: an image texture
 * named by URL is fetched through a manager of its own, like a model's
 * images, never through three's page-wide default.
 */
function createMaterial(obj: Scene3DObject, policy: ModelResourcePolicy): THREE.MeshStandardMaterial {
  let map: THREE.Texture | undefined;
  if (obj.texture) {
    const tex = createProceduralTexture(obj.texture, obj.color, obj.textureRepeat);
    if (tex) map = tex;
  } else if (obj.textureUrl) {
    const tex = loadTextureThrough(obj.textureUrl, policy, obj.textureRepeat);
    if (tex) map = tex;
  }
  // A decal is flat: its texture is its picture, not also its relief.
  const mat = new THREE.MeshStandardMaterial(
    map ? (isCutoutTexture(obj.texture) ? { map } : { map, bumpMap: map }) : {}
  );
  writeMaterial(mat, obj);
  return mat;
}

/** The decal textures, which are transparent outside the mark. */
function isCutoutTexture(texture: string | undefined): boolean {
  return texture === 'bullethole' || texture === 'blood' || texture === 'scorch';
}

/** On the node of an object the camera carries (`attach: 'camera'`). */
const ATTACHED_KEY = '__softnAttached';
/**
 * How each material of a camera-attached object tested and wrote depth
 * before it was attached, to give back when it is let go.
 */
const depthBeforeAttach = new WeakMap<THREE.Material, { test: boolean; write: boolean }>();

function eachMaterialUnder(root: THREE.Object3D, fn: (material: THREE.Material) => void): void {
  root.traverse((child) => {
    const held = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(held)) {
      for (const material of held) if (material) fn(material);
    } else if (held) {
      fn(held);
    }
  });
}

/**
 * A camera-attached object is drawn last and without a depth test, so a
 * weapon held against a wall stays in front of the wall. An object that
 * stops being attached is given back what it had: it used to keep the raised
 * order and the switched-off depth test, and was drawn through walls from
 * then on.
 */
function holdAtCamera(node: THREE.Object3D, attached: boolean): void {
  if (attached) {
    node.userData[ATTACHED_KEY] = true;
    node.renderOrder = 1000;
    eachMaterialUnder(node, (material) => {
      if (!depthBeforeAttach.has(material)) {
        depthBeforeAttach.set(material, { test: material.depthTest, write: material.depthWrite });
      }
      material.depthTest = false;
      material.depthWrite = false;
    });
  } else if (node.userData[ATTACHED_KEY]) {
    delete node.userData[ATTACHED_KEY];
    node.renderOrder = 0;
    eachMaterialUnder(node, (material) => {
      const before = depthBeforeAttach.get(material);
      if (!before) return;
      material.depthTest = before.test;
      material.depthWrite = before.write;
      depthBeforeAttach.delete(material);
    });
  }
}

/**
 * Write into a material everything an object says about it but which
 * texture it holds. A new material is written once; one that exists is
 * written again when the object changes, in place of being thrown away and
 * made anew: a decal fading out, or every part of a figure flashing when it
 * is hit, changed a number or two and paid for a material each time. And
 * what was only read when the material was made (`doubleSided`, `alphaTest`,
 * `fog`, `bumpScale`) was never read again.
 */
function writeMaterial(mat: THREE.MeshStandardMaterial, obj: Scene3DObject): void {
  const opacity = obj.opacity ?? 1;
  // Instance colours multiply the material's, so a palette needs a white base.
  const usesPalette = obj.type === 'instanced' && Array.isArray(obj.palette) && obj.palette.length > 0;
  // A decal texture has transparent pixels: cut them out, and draw the
  // decal a hair in front of whatever it sits on rather than z-fighting.
  const cutout = isCutoutTexture(obj.texture);
  const cut = cutout || obj.alphaTest != null;
  const transparent = opacity < 1 || cutout;
  const side = obj.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  const fog = obj.fog ?? true;
  const flatShading = obj.flatShading ?? false;
  const alphaTest = cut ? (obj.alphaTest ?? 0.08) : 0;
  // These decide what the shader is compiled with, so a change to one asks
  // for the program again; three hands back the one it has when it fits.
  if (
    mat.transparent !== transparent ||
    mat.side !== side ||
    mat.fog !== fog ||
    mat.flatShading !== flatShading ||
    (mat.alphaTest > 0) !== (alphaTest > 0)
  ) {
    mat.needsUpdate = true;
  }
  mat.color.set(usesPalette ? '#ffffff' : (obj.texture ? '#ffffff' : (obj.color || '#6366f1')));
  mat.metalness = obj.metalness ?? (obj.texture === 'metal' ? 0.6 : (obj.texture === 'rust' ? 0.35 : 0.1));
  mat.roughness = obj.roughness ?? (obj.texture === 'metal' ? 0.3 : (obj.texture === 'tile' ? 0.25 : (obj.texture === 'rust' ? 0.8 : 0.6)));
  mat.wireframe = obj.wireframe ?? false;
  mat.flatShading = flatShading;
  mat.opacity = opacity;
  mat.transparent = transparent;
  mat.side = side;
  mat.fog = fog;
  if (mat.bumpMap) mat.bumpScale = obj.bumpScale ?? 0.03;
  if (obj.emissive) mat.emissive.set(obj.emissive);
  else mat.emissive.setRGB(0, 0, 0);
  mat.emissiveIntensity = obj.emissiveIntensity ?? 1;
  mat.alphaTest = alphaTest;
  mat.depthWrite = !cut;
  // While the camera carries the object its materials write no depth
  // (holdAtCamera): what this one would write is kept for when it is let go.
  const held = depthBeforeAttach.get(mat);
  if (held) {
    held.write = mat.depthWrite;
    mat.depthWrite = false;
  }
  mat.polygonOffset = cut;
  mat.polygonOffsetFactor = cut ? -2 : 0;
  mat.polygonOffsetUnits = cut ? -2 : 0;
}

/**
 * Bring a mesh's material up to date with its object: written in place when
 * only its numbers and colours changed, replaced (the old one disposed, its
 * shared texture handed back) when it needs a different texture.
 */
function updateMeshMaterial(
  mesh: THREE.Mesh,
  prev: Scene3DObject,
  next: Scene3DObject,
  policy: ModelResourcePolicy,
  easer?: Easer,
  ms = 0
): void {
  if (needsMaterialRebuild(prev, next)) {
    disposeMaterial(mesh.material as THREE.Material);
    mesh.material = createMaterial(next, policy);
  } else if (needsMaterialUpdate(prev, next)) {
    writeMaterialEased(mesh.material as THREE.MeshStandardMaterial, next, easer, ms);
  }
}

/**
 * `writeMaterial`, with its colour, opacity and glow taken there over `ms`
 * when the scene eases what changes (motion.ts); everything else it writes
 * is written at once.
 */
function writeMaterialEased(mat: THREE.MeshStandardMaterial, obj: Scene3DObject, easer: Easer | undefined, ms: number): void {
  const eased = !!easer && easer.beginLook(mat, ms);
  writeMaterial(mat, obj);
  if (eased) (easer as Easer).endLook(mat);
}

/** How many numbers describe one instance: a palette index rides along when there is a palette. */
function instanceStride(obj: Scene3DObject): number {
  return Array.isArray(obj.palette) && obj.palette.length > 0 ? 4 : 3;
}

function instanceCount(obj: Scene3DObject): number {
  return Array.isArray(obj.instances) ? Math.floor(obj.instances.length / instanceStride(obj)) : 0;
}

/**
 * Write every instance's matrix and colour. The mesh is sized for exactly
 * `count` copies, so a change in count recreates it; a change in placement
 * only rewrites the buffers, which is the cheap path a builder edits through.
 */
function fillInstances(mesh: THREE.InstancedMesh, obj: Scene3DObject): void {
  const data = obj.instances ?? [];
  const stride = instanceStride(obj);
  const count = instanceCount(obj);
  const palette = stride === 4 ? (obj.palette ?? []).map((c) => new THREE.Color(c)) : null;
  const fallback = new THREE.Color(obj.color || '#6366f1');
  // Where each copy stands, and how it is turned and sized (instances.ts).
  placeInstances(mesh, data, stride, count, obj.instanceRotations, obj.instanceScales);
  if (palette) {
    for (let i = 0; i < count; i++) {
      const idx = data[i * stride + 3] | 0;
      mesh.setColorAt(i, palette[idx] ?? fallback);
    }
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Without this the mesh is culled by its geometry's own bounds at the origin.
  mesh.computeBoundingSphere();
}

function createInstanced(obj: Scene3DObject, policy: ModelResourcePolicy): THREE.InstancedMesh {
  const count = Math.max(1, instanceCount(obj));
  const mesh = new THREE.InstancedMesh(createGeometry(obj), createMaterial(obj, policy), count);
  mesh.frustumCulled = true;
  fillInstances(mesh, obj);
  return mesh;
}

// Apply material overrides to all meshes in an Object3D hierarchy.
// Uses duck-typed property checks so it works with Standard, Phong, Lambert, and Basic materials.
// With an easer and a time, what changes of each material's colour, opacity
// and glow is taken there over that time (motion.ts).
function applyMaterialOverrides(root: THREE.Object3D, obj: Scene3DObject, easer?: Easer, ms = 0) {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      const eased = !!easer && easer.beginLook(mat, ms);
      // Cast for property access; guard each with 'in' check for safety
      const m = mat as THREE.MeshStandardMaterial;
      if (obj.color && m.color) m.color.set(obj.color);
      if (obj.wireframe != null && 'wireframe' in mat) m.wireframe = obj.wireframe;
      if (obj.flatShading != null && 'flatShading' in mat) {
        m.flatShading = obj.flatShading;
        mat.needsUpdate = true;
      }
      if (obj.opacity != null) {
        mat.opacity = obj.opacity;
        mat.transparent = obj.opacity < 1;
      }
      if (obj.metalness != null && 'metalness' in mat) m.metalness = obj.metalness;
      if (obj.roughness != null && 'roughness' in mat) m.roughness = obj.roughness;
      if (obj.emissive && m.emissive) m.emissive.set(obj.emissive);
      if (obj.emissiveIntensity != null && 'emissiveIntensity' in mat)
        m.emissiveIntensity = obj.emissiveIntensity;
      if (eased) (easer as Easer).endLook(mat);
    }
  });
}

/** On the node of a model that is a group's child: gives its instance back to the template cache. */
const RELEASE_KEY = '__softnRelease';

// Dispose all geometries, materials, and textures in an Object3D hierarchy
function disposeObject3D(obj: THREE.Object3D) {
  // A model in a group is not the scene's to dispose: its geometry and
  // textures are the template cache's, shared with every other instance.
  // Its node knows how to hand it back, and nothing under it is touched.
  const release = obj.userData[RELEASE_KEY] as (() => void) | undefined;
  if (typeof release === 'function') {
    release();
    return;
  }
  if ((obj as THREE.Mesh).isMesh || (obj as THREE.Points).isPoints) {
    const mesh = obj as THREE.Mesh;
    // An instanced mesh's own dispose is what frees its instance matrices
    // and colours on the GPU; without it they waited for the collector, at
    // every rebuild of a count that changed.
    if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      // Textures the material owns are disposed; a procedural texture from
      // the shared cache is handed back instead. Disposing it here used to
      // free a texture other meshes were still drawing with, which three.js
      // silently re-uploaded on the next frame — and the cache still held
      // the entry, so nothing was ever freed for good either.
      disposeMaterial(mat);
    }
  }
  for (const child of obj.children) disposeObject3D(child);
}

function createParticles(obj: Scene3DObject, sprites?: ParticleSprites): THREE.Points {
  const geom = new THREE.BufferGeometry();
  const positions = obj.particlePositions ?? [];
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (obj.particleColors && obj.particleColors.length > 0) {
    geom.setAttribute('color', new THREE.Float32BufferAttribute(obj.particleColors, 3));
  }
  const mat = new THREE.PointsMaterial({ depthWrite: false });
  writeParticleMaterial(mat, obj, sprites);
  const points = new THREE.Points(geom, mat);
  points.userData.__softnId = obj.id;
  return points;
}

const hasParticleColors = (obj: Scene3DObject): boolean => !!(obj.particleColors && obj.particleColors.length > 0);

/**
 * How a cloud of particles looks, written into its material: when it is
 * made, and when it changes. `sprites` is the scene's hold on the pictures a
 * round or a soft particle is drawn with (particle-sprites.ts).
 */
function writeParticleMaterial(mat: THREE.PointsMaterial, obj: Scene3DObject, sprites?: ParticleSprites): void {
  // A round or a soft particle is the square with a picture of a disc on it,
  // see-through outside the disc: such a cloud is always drawn see-through,
  // after everything solid, and is solid at each particle's middle unless
  // its `opacity` says less. With no scene to take the picture from, a
  // square is what there is.
  const shape = sprites ? particleShapeOf(obj.particleShape) : 'square';
  const map = sprites ? sprites.texture(shape) : null;
  const disc = map !== null;
  // Square particles are solid unless they give an `opacity` below 1, as they
  // always were drawn. (With none given the material carries 0.8 and is not
  // drawn see-through: that is how every cloud made so far looks, and drawing
  // it at 0.8 would change them all and move them to the see-through pass.)
  const opacity = obj.opacity ?? (disc ? 1 : 0.8);
  const transparent = disc || (obj.opacity ?? 1) < 1;
  const fog = obj.fog ?? true;
  const vertexColors = hasParticleColors(obj);
  if (mat.transparent !== transparent || mat.fog !== fog || mat.vertexColors !== vertexColors || mat.map !== map) mat.needsUpdate = true;
  mat.size = obj.particleSize ?? 0.3;
  mat.color.set(obj.color || '#ffffff');
  mat.map = map;
  mat.transparent = transparent;
  mat.opacity = opacity;
  mat.fog = fog;
  mat.vertexColors = vertexColors;
}

/** `writeParticleMaterial`, with the colour and opacity taken there over `ms` when the scene eases what changes. */
function writeParticleMaterialEased(
  mat: THREE.PointsMaterial,
  obj: Scene3DObject,
  easer: Easer | undefined,
  ms: number,
  sprites?: ParticleSprites
): void {
  const eased = !!easer && easer.beginLook(mat, ms);
  writeParticleMaterial(mat, obj, sprites);
  if (eased) (easer as Easer).endLook(mat);
}

/** Whether anything a cloud's material is written from differs between two specs. */
function particleLookChanged(prev: Scene3DObject, next: Scene3DObject): boolean {
  return (
    prev.color !== next.color ||
    prev.particleSize !== next.particleSize ||
    prev.particleShape !== next.particleShape ||
    prev.opacity !== next.opacity ||
    prev.fog !== next.fog ||
    hasParticleColors(prev) !== hasParticleColors(next)
  );
}

function updateParticles(points: THREE.Points, obj: Scene3DObject): void {
  const geom = points.geometry;
  const positions = obj.particlePositions ?? [];
  const colors = obj.particleColors && obj.particleColors.length > 0 ? obj.particleColors : null;
  const currentPos = geom.getAttribute('position');
  const currentCols = geom.getAttribute('color');
  const count = Math.floor(positions.length / 3);
  const resized =
    !currentPos || currentPos.count !== count || (colors !== null && (!currentCols || currentCols.count !== Math.floor(colors.length / 3)));
  if (resized) {
    // Buffers of another size are new buffers, on a new geometry, and the old
    // one is disposed: set on the old geometry, each one it replaced stayed on
    // the GPU until the collector found it, which a count that changes every
    // frame outran.
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (colors) next.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    else if (currentCols && currentCols.count === count) next.setAttribute('color', currentCols.clone());
    geom.dispose();
    points.geometry = next;
    next.computeBoundingSphere();
    return;
  }
  (currentPos as THREE.BufferAttribute).copyArray(positions);
  currentPos.needsUpdate = true;
  if (colors && currentCols) {
    (currentCols as THREE.BufferAttribute).copyArray(colors);
    currentCols.needsUpdate = true;
  }
  geom.computeBoundingSphere();
}

/** On the node of an object that said for itself whether it casts a shadow, and whether shadows fall on it. */
const CAST_KEY = '__softnCast';
const RECEIVE_KEY = '__softnReceive';

/**
 * What the picker reads off a node: its id, its parent, its cursor, and
 * whether it is picked at all. Every object of the scene is tagged, at the
 * top level or in a group; only groups and their children used to be, and
 * `cursor` and `interactive` did nothing on anything else.
 */
function tagNode(node: THREE.Object3D, spec: Scene3DObject, parentId?: string): void {
  node.userData.__softnId = spec.id;
  if (parentId !== undefined) node.userData.__softnParentId = parentId;
  if (spec.cursor) node.userData.__softnCursor = spec.cursor;
  else delete node.userData.__softnCursor;
  if (spec.interactive) node.userData.__softnInteractive = spec.interactive;
  else delete node.userData.__softnInteractive;
  if (typeof spec.pickable === 'boolean') node.userData[PICKABLE_KEY] = spec.pickable;
  else delete node.userData[PICKABLE_KEY];
  // Its own word on shadows, where it gave one: what passDownShadows reads
  // to tell a child that said so from one that takes its group's.
  if (typeof spec.castShadow === 'boolean') node.userData[CAST_KEY] = spec.castShadow;
  else delete node.userData[CAST_KEY];
  if (typeof spec.receiveShadow === 'boolean') node.userData[RECEIVE_KEY] = spec.receiveShadow;
  else delete node.userData[RECEIVE_KEY];
}

/** Take off a node what `tagNode` put on it: it is no longer an object of the scene itself. */
function untagNode(node: THREE.Object3D): void {
  delete node.userData.__softnId;
  delete node.userData.__softnParentId;
  delete node.userData.__softnCursor;
  delete node.userData.__softnInteractive;
  delete node.userData[PICKABLE_KEY];
  delete node.userData[CAST_KEY];
  delete node.userData[RECEIVE_KEY];
}

/**
 * Give a node and everything under it their shadows. An object of the scene
 * takes its own word where it gave one and its group's where it did not;
 * a node inside a loaded model takes the model's. A group's used to be
 * written over every child's own, so a child could neither cast a shadow
 * its group did not nor be kept out of one its group cast.
 */
function passDownShadows(node: THREE.Object3D, cast: boolean, receive: boolean): void {
  // A light of a model whose object speaks of its `lights` casts shadows as that says, not as the object's meshes do.
  if (!node.userData[MODEL_LIGHT_KEY]) node.castShadow = cast;
  node.receiveShadow = receive;
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const own = child.userData;
    if (typeof own.__softnId === 'string') {
      passDownShadows(
        child,
        typeof own[CAST_KEY] === 'boolean' ? (own[CAST_KEY] as boolean) : cast,
        typeof own[RECEIVE_KEY] === 'boolean' ? (own[RECEIVE_KEY] as boolean) : receive
      );
    } else {
      passDownShadows(child, cast, receive);
    }
  }
}

/**
 * What a top-level object passes down to everything in it: a camera-attached
 * object's depth settings, and its shadows. Run when the object is placed,
 * and again when a model has arrived somewhere under it.
 */
function applyInherited(node: THREE.Object3D, obj: Scene3DObject): void {
  holdAtCamera(node, obj.attach === 'camera');
  passDownShadows(node, obj.castShadow ?? false, obj.receiveShadow ?? false);
}

/** What the render loop reads off a group's child to keep it moving (`animate`). */
function tagChildMotion(node: THREE.Object3D, spec: Scene3DObject): void {
  if (spec.animate) {
    node.userData.__softnAnimate = spec.animate;
    node.userData.__softnBaseY = spec.position?.y ?? 0;
  } else {
    delete node.userData.__softnAnimate;
    delete node.userData.__softnBaseY;
  }
}

/**
 * The children of a group, at any depth, that `animate` keeps moving; none
 * is undefined, which is most groups. Found again when the group's children
 * change, so the render loop walks a list and not the group.
 */
function animatedChildren(group: THREE.Object3D): THREE.Object3D[] | undefined {
  const found: THREE.Object3D[] = [];
  const walk = (parent: THREE.Object3D) => {
    for (const child of parent.children) {
      if (child.userData.__softnAnimate) found.push(child);
      if (child.userData.__softnGroup) walk(child);
    }
  };
  walk(group);
  return found.length > 0 ? found : undefined;
}

/** Loads the models that are children of groups, and keeps them: see createChildModelHost. */
interface ChildModelHost {
  /** The node for a model child: empty now, holding the model once it has loaded. */
  create(spec: Scene3DObject, parentId: string): THREE.Group;
  /**
   * Bring a model child up to date; false when it names another model now,
   * and its node is to be replaced. `ms` is the `transition` its colour,
   * opacity and glow are eased over.
   */
  patch(node: THREE.Object3D, next: Scene3DObject, ms?: number): boolean;
  /** Whether `node` is one `create` made. */
  owns(node: THREE.Object3D): boolean;
}

/** What building a group's children takes from the scene they are in. */
interface GroupBuild {
  policy: ModelResourcePolicy;
  models: ChildModelHost;
  /** The scene's easer, and the `transition` these children have unless they give their own. */
  easer?: Easer;
  ms?: number;
  /** The scene's hold on the pictures round and soft particles are drawn with. */
  sprites?: ParticleSprites;
}

const EMPTY_MODEL_KEY = '__softnEmptyModel';

/**
 * The node of a model that has no file to load: none named, or one the
 * permission policy withheld. Nothing is drawn for it. It used to be drawn
 * as a one-unit box, which was a model nobody had asked for.
 */
function createEmptyModel(): THREE.Group {
  const node = new THREE.Group();
  node.userData[EMPTY_MODEL_KEY] = true;
  return node;
}

function createSubObject(child: Scene3DObject, parentId: string, build: GroupBuild): THREE.Object3D {
  let sub: THREE.Object3D;
  if (child.type === 'group') {
    sub = createGroup(child, build);
  } else if (child.type === 'particles') {
    sub = createParticles(child, build.sprites);
  } else if (child.type === 'instanced') {
    sub = createInstanced(child, build.policy);
  } else if (child.type === 'model') {
    // A model with no URL to load is nothing to draw, here as at the top level.
    sub = child.modelUrl ? build.models.create(child, parentId) : createEmptyModel();
  } else {
    const geom = createGeometry(child);
    const mat = createMaterial(child, build.policy);
    sub = new THREE.Mesh(geom, mat);
  }
  tagNode(sub, child, parentId);
  tagChildMotion(sub, child);
  applyTransform(sub, child, false, build.easer, 0, false);
  return sub;
}

function createGroup(obj: Scene3DObject, build: GroupBuild): THREE.Group {
  const group = new THREE.Group();
  group.userData.__softnGroup = true;
  tagNode(group, obj);
  if (Array.isArray(obj.children)) {
    // Two children with one id: the first wins and the rest are skipped,
    // the rule the reconcile applies. Building both would leave the
    // reconcile a second node it can neither patch nor find to remove.
    const seen = new Set<string>();
    for (const child of obj.children) {
      if (!child || typeof child.id !== 'string' || seen.has(child.id)) continue;
      seen.add(child.id);
      group.add(createSubObject(child, obj.id, build));
    }
  }
  return group;
}

/**
 * Bring one child of a group up to date in place. False means the change
 * is not one that can be patched — a different type, a new geometry count —
 * and the caller replaces the node.
 */
function patchSubObject(
  node: THREE.Object3D,
  prev: Scene3DObject,
  next: Scene3DObject,
  build: GroupBuild
): boolean {
  if (prev.type !== next.type) return false;
  // A model with a URL is loaded; one without is nothing to draw. Going from
  // one to the other (a URL the permission policy withheld and then allowed)
  // is a different node.
  const loads = next.type === 'model' && !!next.modelUrl;
  if (build.models.owns(node) !== loads) return false;
  // This child's own `transition`, or its group's: its children's in turn.
  const easer = build.easer;
  const ms = transitionOf(next.transition, build.ms ?? 0);
  if (loads) {
    if (!build.models.patch(node, next, ms)) return false;
  } else if (next.type === 'model') {
    // No file to load: an empty node, with nothing of its own to bring up to date.
    if (!node.userData[EMPTY_MODEL_KEY]) return false;
  } else if (next.type === 'group') {
    const within = ms === build.ms ? build : { ...build, ms };
    reconcileGroupChildren(node as THREE.Group, prev.children, next.children, next.id, within);
  } else if (next.type === 'particles') {
    const points = node as THREE.Points;
    if (particleLookChanged(prev, next)) {
      writeParticleMaterialEased(points.material as THREE.PointsMaterial, next, easer, ms, build.sprites);
    }
    updateParticles(points, next);
  } else if (next.type === 'instanced') {
    if (
      needsGeometryUpdate(prev, next) ||
      needsMaterialRebuild(prev, next) ||
      instanceCount(prev) !== instanceCount(next)
    ) {
      return false;
    }
    updateInstanced(node as THREE.InstancedMesh, prev, next, easer, ms);
  } else {
    const mesh = node as THREE.Mesh;
    if (needsGeometryUpdate(prev, next)) {
      mesh.geometry.dispose();
      mesh.geometry = createGeometry(next);
    }
    updateMeshMaterial(mesh, prev, next, build.policy, easer, ms);
  }
  tagNode(node, next, node.userData.__softnParentId as string | undefined);
  tagChildMotion(node, next);
  // As an update, so an axis that `animate` is turning is left to it; with
  // no `animate` every axis is the spec's, as it always was.
  applyTransform(node, next, true, easer, ms, false);
  return true;
}

/**
 * Bring an instanced mesh whose shape, texture and count are unchanged up to
 * date: its material written in place, its copies placed again when their
 * placement, turn, size, palette or fallback colour changed.
 */
function updateInstanced(
  mesh: THREE.InstancedMesh,
  prev: Scene3DObject,
  next: Scene3DObject,
  easer?: Easer,
  ms = 0
): void {
  if (needsMaterialUpdate(prev, next)) {
    writeMaterialEased(mesh.material as THREE.MeshStandardMaterial, next, easer, ms);
  }
  if (
    prev.instances !== next.instances ||
    prev.instanceRotations !== next.instanceRotations ||
    prev.instanceScales !== next.instanceScales ||
    prev.palette !== next.palette ||
    prev.color !== next.color
  ) {
    fillInstances(mesh, next);
  }
}

/**
 * Reconcile a group's children by id. A whole group used to be rebuilt
 * whenever any child changed — a train of forty parts recreated its forty
 * meshes to move one wheel — so a child whose id persists is patched, one
 * whose id is gone is disposed, and only a new id is built. A child whose
 * spec is the same object as last time is not even looked at.
 */
function reconcileGroupChildren(
  group: THREE.Group,
  prevChildren: Scene3DObject[] | undefined,
  nextChildren: Scene3DObject[] | undefined,
  parentId: string,
  build: GroupBuild
): void {
  const prevById = new Map<string, Scene3DObject>();
  for (const child of prevChildren ?? []) {
    if (child && typeof child.id === 'string' && !prevById.has(child.id)) prevById.set(child.id, child);
  }
  const nodeById = new Map<string, THREE.Object3D>();
  for (const node of group.children) {
    const id = node.userData.__softnId;
    if (typeof id === 'string' && !nodeById.has(id)) nodeById.set(id, node);
  }
  const keep = new Set<string>();
  for (const child of nextChildren ?? []) {
    if (!child || typeof child.id !== 'string' || keep.has(child.id)) continue;
    keep.add(child.id);
    const node = nodeById.get(child.id);
    const prev = prevById.get(child.id);
    if (node && prev === child) continue;
    if (node && prev && patchSubObject(node, prev, child, build)) continue;
    if (node) {
      group.remove(node);
      disposeObject3D(node);
    }
    group.add(createSubObject(child, parentId, build));
  }
  for (const [id, node] of nodeById) {
    if (keep.has(id)) continue;
    group.remove(node);
    disposeObject3D(node);
  }
}

const facing = new THREE.Quaternion();
const restAngles = new THREE.Euler();

/**
 * Put a node where its object says: its place, the way it faces and its
 * size, and what it passes down to whatever is under it.
 *
 * On an update (`isUpdate`) an axis that `animate` is moving is left to the
 * render loop, so it does not snap back; and with an `easer` and a time
 * (`ms`, the object's `transition`), what changed is not written here but
 * handed to the easer, which takes the node there frame by frame
 * (motion.ts). `top` is false for a group's child: its shadows are settled
 * by the pass its top-level group makes, which knows what it inherits.
 */
function applyTransform(
  mesh: THREE.Object3D,
  obj: Scene3DObject,
  isUpdate: boolean,
  easer?: Easer,
  ms = 0,
  top = true
) {
  const anim = obj.animate;
  // A camera-attached object is placed by the render loop from its offset;
  // its own position and rotation fields are read there, not here.
  const carried = obj.attach === 'camera';
  let over = isUpdate ? ms : 0;

  // Let go by the camera, it stands where its object says, and at the
  // middle of the scene facing forward where the object does not say: not
  // wherever the camera last held it, and not swept there from it.
  if (!carried && mesh.userData[ATTACHED_KEY]) {
    easer?.forget(mesh);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    over = 0;
  }

  if (obj.position && !carried) {
    const p = obj.position;
    // The height of an object `animate` is bobbing is the render loop's.
    const bobbing = isUpdate && !!anim?.floatAmplitude;
    if (!easer || !easer.moveTo(mesh, p.x, p.y, p.z, over, !bobbing)) {
      mesh.position.x = p.x;
      if (!bobbing) mesh.position.y = p.y;
      mesh.position.z = p.z;
    }
  }

  if (!carried) {
    const turning = isUpdate && !!(anim?.rotateX || anim?.rotateY || anim?.rotateZ);
    if (pointsSomewhere(obj)) {
      // `lookAt` or `align`: a direction, not three angles. A turn `animate`
      // keeps up takes it from there.
      if (turning) {
        easer?.turnTo(mesh, mesh.quaternion, 0);
      } else {
        orientationOf(obj, facing);
        if (!easer || !easer.turnTo(mesh, facing, over)) mesh.quaternion.copy(facing);
      }
    } else if (obj.rotation) {
      const order = rotationOrderOf(obj.rotationOrder);
      if (mesh.rotation.order !== order) mesh.rotation.order = order;
      let eased = false;
      if (easer && over > 0 && !turning) {
        restAngles.set(obj.rotation.x, obj.rotation.y, obj.rotation.z, order);
        eased = easer.turnTo(mesh, facing.setFromEuler(restAngles), over, restAngles);
      } else {
        // Written at once: a turn it was being eased through is dropped.
        easer?.turnTo(mesh, mesh.quaternion, 0);
      }
      if (!eased) {
        // On update, skip axes owned by rotation animation to avoid snapping
        if (!isUpdate || !anim?.rotateX) mesh.rotation.x = obj.rotation.x;
        if (!isUpdate || !anim?.rotateY) mesh.rotation.y = obj.rotation.y;
        if (!isUpdate || !anim?.rotateZ) mesh.rotation.z = obj.rotation.z;
      }
    }
  }

  if (obj.scale != null) {
    const s = obj.scale;
    const sx = typeof s === 'number' ? s : s.x;
    const sy = typeof s === 'number' ? s : s.y;
    const sz = typeof s === 'number' ? s : s.z;
    if (!easer || !easer.scaleTo(mesh, sx, sy, sz, over)) mesh.scale.set(sx, sy, sz);
  }

  if (top) {
    applyInherited(mesh, obj);
  } else {
    holdAtCamera(mesh, carried);
    mesh.castShadow = obj.castShadow ?? false;
    mesh.receiveShadow = obj.receiveShadow ?? false;
  }
}

function needsGeometryUpdate(prev: Scene3DObject, next: Scene3DObject): boolean {
  return (
    prev.type !== next.type ||
    prev.shape !== next.shape ||
    prev.width !== next.width ||
    prev.height !== next.height ||
    prev.depth !== next.depth ||
    prev.radius !== next.radius ||
    prev.tube !== next.tube
  );
}

/**
 * Whether an object needs a material other than the one it has: a different
 * texture, which is the one thing `writeMaterial` does not write.
 */
function needsMaterialRebuild(prev: Scene3DObject, next: Scene3DObject): boolean {
  return (
    prev.texture !== next.texture ||
    // A `textureUrl` the policy withheld and later allowed arrives as a
    // change here, and is the only way the texture ever gets fetched.
    prev.textureUrl !== next.textureUrl ||
    (prev.textureRepeat?.x ?? 1) !== (next.textureRepeat?.x ?? 1) ||
    (prev.textureRepeat?.y ?? 1) !== (next.textureRepeat?.y ?? 1) ||
    (prev.palette?.length ?? 0) !== (next.palette?.length ?? 0) ||
    // A painted texture is painted in the object's colour.
    (!!next.texture && prev.color !== next.color)
  );
}

/** Whether anything about how an object's surface looks changed. */
function needsMaterialUpdate(prev: Scene3DObject, next: Scene3DObject): boolean {
  return (
    needsMaterialRebuild(prev, next) ||
    prev.color !== next.color ||
    prev.metalness !== next.metalness ||
    prev.roughness !== next.roughness ||
    prev.wireframe !== next.wireframe ||
    prev.flatShading !== next.flatShading ||
    prev.opacity !== next.opacity ||
    prev.emissive !== next.emissive ||
    prev.emissiveIntensity !== next.emissiveIntensity ||
    // Read when the material was made and never again: a leaf turned
    // double-sided, a star field taken out of the fog, stayed as it was.
    prev.doubleSided !== next.doubleSided ||
    prev.alphaTest !== next.alphaTest ||
    prev.fog !== next.fog ||
    prev.bumpScale !== next.bumpScale
  );
}

/**
 * Whether a light casts shadows, and for a directional light the map it
 * casts them into: written when the light is made, and again whenever its
 * spec is brought up to date. These were read when the light was made and
 * hardly again: a light told to cast shadows afterwards cast none, one told
 * to stop went on, and a new map size or near and far distance changed
 * nothing.
 */
function writeLightShadow(light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight, spec: Scene3DLight): void {
  const cast = !!spec.castShadow;
  const shadow = light.shadow;
  if (light.castShadow !== cast) {
    light.castShadow = cast;
    // A light that has stopped has no use for the map it drew into.
    if (!cast && shadow.map) {
      shadow.map.dispose();
      shadow.map = null;
    }
  }
  if (!cast) return;
  // A sun's map is 1024 and its bias -0.0005 unless it says. A point or spot light's are
  // three's own (512 and none), which is what theirs always were: these settings were a
  // sun's alone, and one written on a lamp was never applied.
  const sun = light instanceof THREE.DirectionalLight;
  // The size asked for is kept beside the light, and it is that the next asking is held
  // against. three writes the size it could make back into `shadow.mapSize` (a map larger
  // than the device takes is made smaller), so held against that, a size the device could
  // not give was "another size" on every update, and its map was thrown away and made again
  // each time the lights were handed over.
  const asked = wholeAbove(spec.shadowMapSize, sun ? 1024 : 512);
  if (light.userData.softnShadowMapSize !== asked) {
    light.userData.softnShadowMapSize = asked;
    if (shadow.mapSize.width !== asked || shadow.mapSize.height !== asked) {
      shadow.mapSize.set(asked, asked);
      // A map of another size is another map: three makes it when it next draws.
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
    }
  }
  shadow.bias = finiteOr(spec.shadowBias, sun ? -0.0005 : 0);
  // Off the surface along its normal, by so many units: none unless asked for.
  shadow.normalBias = Math.max(0, finiteOr(spec.shadowNormalBias, 0));
  if (!sun) {
    // How near and how far a lamp's shadows are drawn. A light with a `distance` draws them
    // that far, which three sees to itself on every frame. A lamp's shadows are drawn through
    // a lens, which has no picture for a nearest distance of nothing or less: such a value,
    // and a farthest that is not beyond the nearest, are not taken.
    const lamp = shadow.camera as THREE.PerspectiveCamera;
    const near = aboveZero(spec.shadowNear) ?? 0.5;
    const asksFar = aboveZero(spec.shadowFar);
    const far = asksFar !== undefined && asksFar > near ? asksFar : Math.max(500, near * 2);
    const reach = typeof spec.distance === 'number' && spec.distance > 0 ? lamp.far : far;
    if (lamp.near !== near || lamp.far !== reach) {
      lamp.near = near;
      lamp.far = reach;
      lamp.updateProjectionMatrix();
    }
    return;
  }
  // The box a sun shadows when it names no size: 15 units each way, from 0.5 to 150 deep, as it
  // always was. (The released code wrote these to the light as it was made and never asked for
  // the box to be worked out again; three does that itself when it first makes the light's
  // shadow map, so they were what every scene got. Read without that, the default was once
  // taken here for three's own 5 and 500, which would have left everything further than 5
  // units from the middle with no shadow.)
  const size = aboveZero(spec.shadowCameraSize) ?? 15;
  const near = finiteOr(spec.shadowNear, 0.5);
  const asksFar = finiteOr(spec.shadowFar, 150);
  const far = asksFar > near ? asksFar : near + 150;
  const cam = (shadow as THREE.DirectionalLightShadow).camera;
  if (cam.left !== -size || cam.right !== size || cam.top !== size || cam.bottom !== -size || cam.near !== near || cam.far !== far) {
    cam.left = -size;
    cam.right = size;
    cam.top = size;
    cam.bottom = -size;
    cam.near = near;
    cam.far = far;
    cam.updateProjectionMatrix();
  }
}

function createLight(spec: Scene3DLight): THREE.Light {
  const color = spec.color || '#ffffff';
  const intensity = spec.intensity ?? 1;

  switch (spec.type) {
    case 'ambient':
      return new THREE.AmbientLight(color, intensity);
    case 'directional': {
      const light = new THREE.DirectionalLight(color, intensity);
      if (spec.position) light.position.set(spec.position.x, spec.position.y, spec.position.z);
      writeLightShadow(light, spec);
      return light;
    }
    case 'point': {
      const light = new THREE.PointLight(color, intensity, spec.distance ?? 0, spec.decay ?? 2);
      if (spec.position) light.position.set(spec.position.x, spec.position.y, spec.position.z);
      writeLightShadow(light, spec);
      return light;
    }
    case 'spot': {
      const light = new THREE.SpotLight(color, intensity, spec.distance ?? 0, spec.angle ?? 0.5, spec.penumbra ?? 0.3, spec.decay ?? 2);
      if (spec.position) light.position.set(spec.position.x, spec.position.y, spec.position.z);
      writeLightShadow(light, spec);
      return light;
    }
    case 'hemisphere':
      return new THREE.HemisphereLight(color, spec.groundColor || '#444444', intensity);
    default:
      return new THREE.AmbientLight(color, intensity);
  }
}

/** What the render loop needs to know about a light it may have to carry. */
function tagLight(light: THREE.Light, spec: Scene3DLight): void {
  // A light that followed the camera and no longer does goes back to shining
  // at the middle of the world, from where its spec says.
  if (
    followsCamera(light.userData.__softnFollow) &&
    !followsCamera(spec.follow) &&
    light instanceof THREE.DirectionalLight
  ) {
    light.target.position.set(0, 0, 0);
    light.target.updateMatrixWorld();
    if (!spec.position) light.position.set(0, 1, 0);
  }
  light.userData.__softnLightType = spec.type;
  light.userData.__softnAttach = spec.attach;
  light.userData.__softnFollow = spec.type === 'directional' ? spec.follow : undefined;
  light.userData.__softnOffset = new THREE.Vector3(spec.position?.x ?? 0, spec.position?.y ?? 0, spec.position?.z ?? 0);
}

/** Whether a light's `follow` is one of the two that carry it with the camera. */
function followsCamera(follow: unknown): follow is 'camera' | 'view' {
  return follow === 'camera' || follow === 'view';
}

/** Whether the render loop, not the spec, says where a light stands. */
function isCarried(spec: Scene3DLight): boolean {
  return spec.attach === 'camera' || (spec.type === 'directional' && followsCamera(spec.follow));
}

/**
 * What a scene that names no lights is lit by: enough to see what was put
 * in it. A scene with no `lights` used to be black objects on a dark
 * ground, which is what a first `<Scene3D objects={…} />` showed. The sun
 * casts shadows, which are drawn only when the scene asks for `shadows`.
 */
const DEFAULT_LIGHTS: Scene3DLight[] = [
  { id: '__softn-default-ambient', type: 'ambient', intensity: 0.6 },
  {
    id: '__softn-default-sun',
    type: 'directional',
    intensity: 2,
    // Above, and off to one side and the front: three faces of a box are
    // three different shades.
    position: { x: 5, y: 10, z: 7.5 },
    castShadow: true,
  },
];

const followRight = new THREE.Vector3();
const followUp = new THREE.Vector3();
const followDir = new THREE.Vector3();
const followAt = new THREE.Vector3();
const followMiddle = new THREE.Vector3();
const followSight = new THREE.Vector3();
/** How far ahead of the camera the middle of a `follow: 'view'` light's shadow box is, as a share of the box's half-width. */
const AHEAD_OF_CAMERA = 0.8;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);

/**
 * Stand a directional light where its offset puts it from the camera, and
 * aim it at the camera, so the box its shadows are drawn in is around
 * whatever the camera is near. The middle of that box moves in whole texels
 * of the shadow map along the light's own axes: moved freely, every shadow
 * edge would crawl as the camera walks.
 *
 * With `ahead` (`follow: 'view'`) the box is not about the camera but about
 * the point `0.8` of its half-width in front of the camera, along the line
 * of sight: a box about the camera has half of itself behind the camera,
 * where nothing is seen, and this one spends the same map on the picture.
 */
function followCamera(light: THREE.DirectionalLight, cam: THREE.Camera, ahead = false): void {
  const offset = light.userData.__softnOffset as THREE.Vector3 | undefined;
  // No position given is three's own default for the light: straight above.
  if (offset && offset.lengthSq() > 0) followDir.copy(offset);
  else followDir.set(0, 1, 0);
  const distance = followDir.length();
  followDir.divideScalar(distance);
  followRight.crossVectors(WORLD_UP, followDir);
  if (followRight.lengthSq() < 1e-8) followRight.crossVectors(WORLD_X, followDir);
  followRight.normalize();
  followUp.crossVectors(followDir, followRight);

  const shadowCam = light.shadow?.camera;
  const mapWidth = light.shadow?.mapSize?.width ?? 0;
  const texel = shadowCam && mapWidth > 0 ? (shadowCam.right - shadowCam.left) / mapWidth : 0;
  const snap = (value: number) => (texel > 0 ? Math.round(value / texel) * texel : value);
  // What the box is about: the camera, or the point ahead of it. From the
  // camera's own turn, not its matrices, which are this frame's only once
  // the frame is drawn.
  followMiddle.copy(cam.position);
  if (ahead && shadowCam) {
    followMiddle.addScaledVector(followSight.set(0, 0, -1).applyQuaternion(cam.quaternion), AHEAD_OF_CAMERA * shadowCam.right);
  }
  const along = followMiddle.dot(followDir);
  const across = snap(followMiddle.dot(followRight));
  const up = snap(followMiddle.dot(followUp));
  followAt.set(0, 0, 0).addScaledVector(followDir, along).addScaledVector(followRight, across).addScaledVector(followUp, up);

  light.target.position.copy(followAt);
  light.target.updateMatrixWorld();
  light.position.copy(followAt).addScaledVector(followDir, distance);
}

/** The helper grid a scene asked for. */
function createGridHelper(grid: NonNullable<Scene3DProps['grid']>): THREE.GridHelper {
  const size = typeof grid === 'object' ? (grid.size ?? 50) : 50;
  const divisions = typeof grid === 'object' ? (grid.divisions ?? 50) : 50;
  const colorCenter = typeof grid === 'object' ? (grid.centerColor ?? '#6366f1') : '#6366f1';
  const colorGrid = typeof grid === 'object' ? (grid.color ?? '#334155') : '#334155';
  const gridHelper = new THREE.GridHelper(size, divisions, colorCenter, colorGrid);
  if (typeof grid === 'object' && grid.position) {
    gridHelper.position.set(grid.position.x, grid.position.y, grid.position.z);
  }
  return gridHelper;
}

// Before the browser paints, where there is a browser; where there is none
// (a page drawn on a server) there is nothing to measure, and no warning.
const useBeforePaint = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** `value` where it is a number that is one (not NaN, not without end), and `otherwise` where it is not. */
function finiteOr(value: unknown, otherwise: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : otherwise;
}

/** `value` as a whole number of at least one, held to a size a shadow map can be asked for; `otherwise` where it is none. */
function wholeAbove(value: unknown, otherwise: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return otherwise;
  return Math.min(8192, Math.floor(value));
}

/** Whether `width` and `height` describe a shape: two lengths above zero. */
function isShape(width: unknown, height: unknown): boolean {
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
}

/**
 * A scene of `width` by `height` in a place `room` pixels wide: itself where
 * it fits, the same shape smaller where it does not. `room` is null, or
 * nothing, while it has not been measured.
 */
function sizeWithin(width: number, height: number, room: number | null): { width: number; height: number } {
  if (!isShape(width, height) || room === null || !(room > 0) || room >= width) return { width, height };
  return { width: Math.max(1, Math.round(room)), height: Math.max(1, Math.round((height * room) / width)) };
}

/** The most device pixels a scene draws for each CSS pixel, given its `maxPixelRatio`. */
function pixelRatioFor(maxPixelRatio: number): number {
  const most = Number.isFinite(maxPixelRatio) ? maxPixelRatio : 2;
  return Math.min(window.devicePixelRatio || 1, Math.max(0.5, most));
}

interface MeshEntry {
  mesh: THREE.Object3D;
  spec: Scene3DObject;
  baseY: number;
  loadVersion?: number; // tracks in-flight model loads to cancel stale ones
  /**
   * For a loaded model: the lease on the cached template behind `mesh`.
   * Released, never disposed — the geometry and textures are the cache's.
   */
  instance?: ModelInstance;
  /**
   * For a loaded model: its root as the loader made it. `mesh` itself,
   * unless `fit` put it in a holder that carries the object's transform.
   */
  model?: THREE.Object3D;
  /** For a loaded model: what it holds and how big it is. */
  info?: ModelContents;
  /** For a model: where its load stands. */
  load?: ModelLoadState;
  /** For a group: its children, at any depth, that `animate` keeps moving. */
  animated?: THREE.Object3D[];
  /** For a loaded model whose object has named `parts`: what moves them (model-parts.ts). */
  parts?: ModelParts;
  /** For a loaded model the scene has looked through: its cameras by name, found once (model-camera.ts). */
  cameras?: ModelCameras;
  /** For a loaded model whose object speaks of its `lights`: the lights that are in it (model-lights.ts). */
  lights?: ModelLights;
}

/**
 * Bring the lights that are in a loaded model up to date with its object's
 * `lights`. They are found the first time the object says anything of them:
 * a model whose object says nothing has them as its file does, and pays
 * nothing here.
 */
function lightModel(held: { lights?: ModelLights }, model: THREE.Object3D, spec: Scene3DObject): void {
  if (!held.lights) {
    if (spec.lights === undefined) return;
    held.lights = new ModelLights(model);
  }
  held.lights.apply(spec.lights, writeLightShadow);
}

/**
 * Bring a loaded model's named parts up to date with its object: taken to
 * what `parts` says over `ms` milliseconds, or at once with none. What moves
 * them is made the first time the object names a part, so a model that names
 * none pays nothing for it.
 */
function moveParts(
  held: { parts?: ModelParts },
  model: THREE.Object3D,
  instance: ModelInstance | undefined,
  spec: Scene3DObject,
  ms: number,
  animation: () => AnimationEntry | undefined
): void {
  if (!held.parts) {
    if (!namesParts(spec.parts)) return;
    held.parts = new ModelParts(model, {
      rest: instance?.rest,
      id: spec.id,
      file: instance?.key,
      // Whether a clip of this model is moving a node now: what a part that lets go gives the node back to.
      drives: (node, property) => clipDrives(animation(), node, property),
    });
  }
  held.parts.set(spec.parts, ms);
}

/** Which of a node's place, turn and size a clip has a track for, as bits. */
const MOVES: Record<string, number> = { position: 1, quaternion: 2, rotation: 2, scale: 4 };
const MOVES_OF: Record<PartProperty, number> = { position: 1, quaternion: 2, scale: 4 };
const movedByClip = new WeakMap<THREE.Object3D, Map<THREE.AnimationClip, Map<THREE.Object3D, number>>>();

/**
 * The nodes under `root` that `clip` moves, each with which of its place,
 * turn and size the clip has a track for: found as three's mixer finds the
 * node a track names, once for each clip of each copy of a model.
 */
function nodesMovedBy(clip: THREE.AnimationClip, root: THREE.Object3D): Map<THREE.Object3D, number> {
  let clips = movedByClip.get(root);
  if (!clips) {
    clips = new Map();
    movedByClip.set(root, clips);
  }
  let moved = clips.get(clip);
  if (!moved) {
    moved = new Map();
    for (const track of clip.tracks) {
      let parsed: { nodeName?: string; propertyName?: string };
      try {
        parsed = THREE.PropertyBinding.parseTrackName(track.name) as { nodeName?: string; propertyName?: string };
      } catch {
        continue;
      }
      const bit = MOVES[parsed.propertyName ?? ''];
      if (!bit) continue;
      const node = THREE.PropertyBinding.findNode(root, parsed.nodeName ?? '') as THREE.Object3D | null;
      if (node) moved.set(node, (moved.get(node) ?? 0) | bit);
    }
    clips.set(clip, moved);
  }
  return moved;
}

/**
 * Whether a clip of a model is moving `property` of `node` now: a clip that
 * is in force (playing, held at a second, or stood at its end), not one
 * that has been stopped or has ended and let go.
 */
function clipDrives(entry: AnimationEntry | undefined, node: THREE.Object3D, property: PartProperty): boolean {
  if (!entry) return false;
  const root = entry.mixer.getRoot() as THREE.Object3D;
  const bit = MOVES_OF[property];
  const drives = (action: THREE.AnimationAction): boolean =>
    action.enabled && action.isScheduled() && action.getEffectiveWeight() > 0 && ((nodesMovedBy(action.getClip(), root).get(node) ?? 0) & bit) !== 0;
  if (entry.together) return entry.together.actions.some(drives);
  for (const action of entry.actions.values()) if (drives(action)) return true;
  return false;
}

/**
 * Change a model's animation (`change` starts, stops or re-times its clips)
 * with its named parts lifted off its nodes meanwhile, so that the pose
 * three's mixer keeps of a node when a clip starts is the file's and not a
 * part's (model-parts.ts).
 */
function changeAnimation(parts: ModelParts | undefined, change: () => void): void {
  if (parts?.active) parts.atRest(change);
  else change();
}

/**
 * How a loaded model stands in the scene: as it is, taking the object's
 * transform itself, which is how it has always been; or, when `fit` rescales
 * it, inside a holder that takes the transform, so the fit and the object's
 * own `scale` and `position` do not overwrite each other.
 */
function seatModel(model: THREE.Object3D, info: ModelContents | undefined, spec: Scene3DObject): THREE.Object3D {
  model.removeFromParent();
  if (!wantsFit(spec.fit)) {
    restoreOwnTransform(model);
    return model;
  }
  const holder = new THREE.Group();
  // The holder is the object now. A model that stood bare until `fit` was
  // given carries the object's tags, and would go on answering the pointer
  // with what they said then.
  untagNode(model);
  holder.add(model);
  fitModel(model, info, spec.fit);
  return holder;
}

/** What every loaded model is given before it is shown, at the top level or in a group. */
function dressModel(model: THREE.Object3D, spec: Scene3DObject, renderer: THREE.WebGLRenderer | null): void {
  applyMaterialOverrides(model, spec);
  applyModelAppearance(model, spec.appearance);
  prepareModelMaterials(model, maxAnisotropy(renderer));
}

/** The renderer's anisotropy limit, or 1 for a renderer that cannot say (a test double). */
function maxAnisotropy(renderer: THREE.WebGLRenderer | null): number {
  const limit = renderer?.capabilities?.getMaxAnisotropy?.();
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : 1;
}

/** Take an entry's mesh out of the scene and give back what it held. */
function discardEntry(scene: THREE.Scene, entry: MeshEntry): void {
  scene.remove(entry.mesh);
  if (entry.instance) entry.instance.release();
  else disposeObject3D(entry.mesh);
}

interface AnimationEntry {
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  actions: Map<string, THREE.AnimationAction>;
  currentClip: string | null;
  warnedMissing: Set<string>; // 'missing' fires once per requested clip name
  /** For `clip: "*"`: every clip's action, and the one clock they are all held to. */
  together?: ClipsTogether;
  /** Says that a clip ran to its end: for the set played together, which the mixer does not time. */
  finished?: (clip: string) => void;
}

/** The camera of a model the scene looks through, when it looks through one (`on`), and the model it is in. */
type SceneModelView = Omit<ModelView, 'camera'> & { camera: Lens | null; on: boolean; model: THREE.Object3D | null };

/** `animation.clip` for every clip of the model at once. */
const ALL_CLIPS = '*';

/**
 * Every clip of a model played as one. Each clip's action is held, not
 * played: the scene keeps one clock for them all and puts each action at
 * that second on every frame, so a clip shorter than the longest stands at
 * its last pose until the longest has ended (where the mixer, left to time
 * each by itself, would have it start again early).
 */
interface ClipsTogether {
  actions: THREE.AnimationAction[];
  /** The earliest first key of the set, in the clips' own seconds: where the clock's 0 is. */
  start: number;
  /** From there to the end of the longest. */
  length: number;
  /** Seconds on the clock. */
  time: number;
  /** Held at `time` by the object (`time` or `progress`), not run. */
  held: boolean;
  playing: boolean;
  once: boolean;
  speed: number;
  /** A set played once has reached its end. */
  done: boolean;
}

/**
 * Where an object holds a clip, in seconds on a clock that starts at
 * `first` and is `length` long: `time` seconds in, or `progress` of the way
 * through; undefined when it holds it nowhere and the clip is played.
 */
function heldAt(spec: NonNullable<Scene3DObject['animation']>, length: number): number | undefined {
  if (typeof spec.time === 'number' && Number.isFinite(spec.time)) return Math.max(0, Math.min(length, spec.time));
  if (typeof spec.progress === 'number' && Number.isFinite(spec.progress)) return Math.max(0, Math.min(1, spec.progress)) * length;
  return undefined;
}

/** Put each action of a set played together at the clock's second: past a clip's own end is its end. */
function writeTogether(together: ClipsTogether): void {
  const at = together.start + together.time;
  for (const action of together.actions) action.time = Math.min(at, action.getClip().duration);
}

/** Bring the set of every clip up to date with its object, starting it if the model was playing something else. */
function playTogether(entry: AnimationEntry, spec: NonNullable<Scene3DObject['animation']>): void {
  let together = entry.together;
  if (!together) {
    // Whatever was playing stops: one clip is not faded into them all.
    entry.mixer.stopAllAction();
    let start = Infinity;
    let end = 0;
    const actions: THREE.AnimationAction[] = [];
    for (const clip of entry.clips) {
      start = Math.min(start, firstKeyOf(clip));
      end = Math.max(end, clip.duration);
      const action = entry.mixer.clipAction(clip);
      action.reset();
      action.clampWhenFinished = true;
      action.play();
      // Held where the clock says, on every frame: never run by the mixer.
      action.paused = true;
      actions.push(action);
    }
    if (!Number.isFinite(start)) start = 0;
    together = { actions, start, length: Math.max(0, end - start), time: 0, held: false, playing: true, once: false, speed: 1, done: false };
    entry.together = together;
    entry.currentClip = ALL_CLIPS;
  }
  const wasPlaying = together.playing;
  together.speed = typeof spec.speed === 'number' && Number.isFinite(spec.speed) ? spec.speed : 1;
  together.once = spec.loop === 'once';
  together.playing = spec.playing !== false;
  const at = heldAt(spec, together.length);
  together.held = at !== undefined;
  if (at !== undefined) {
    together.time = at;
    together.done = false;
  } else if (together.done && together.playing && (!together.once || !wasPlaying)) {
    // No longer played once, or set playing again after it had ended: it goes round again.
    if (together.once) together.time = 0;
    together.done = false;
  }
  writeTogether(together);
}

/**
 * One frame of a model's animation, `dt` seconds on: the clock of a set
 * played together is moved and its clips put there, and the mixer then
 * poses the model.
 */
function advanceAnimation(entry: AnimationEntry, dt: number): void {
  const together = entry.together;
  if (together) {
    if (!together.held && together.playing && !together.done) {
      let at = together.time + dt * together.speed;
      if (!(together.length > 0)) at = 0;
      else if (at >= together.length) {
        if (together.once) {
          at = together.length;
          together.done = true;
        } else at %= together.length;
      } else if (at < 0) {
        // Run backwards past its start.
        if (together.once) {
          at = 0;
          together.done = true;
        } else at = together.length + (at % together.length);
      }
      together.time = at;
      if (together.done) entry.finished?.(ALL_CLIPS);
    }
    writeTogether(together);
  }
  entry.mixer.update(dt);
}

/**
 * Where a model's animation stands, in its clips' own seconds: the clock of
 * a set played together, or the time of the one clip that is playing or
 * held. Undefined for a model that is playing nothing.
 */
function clipSecondsOf(entry: AnimationEntry | undefined): number | undefined {
  if (!entry) return undefined;
  if (entry.together) return entry.together.start + entry.together.time;
  const action = entry.currentClip ? entry.actions.get(entry.currentClip) : undefined;
  return action ? action.time : undefined;
}

// Default cross-fade duration between clips (ms)
const DEFAULT_CROSSFADE_MS = 180;

// Apply an object's animation spec to its mixer entry. Callers must guard with
// a spec-change check — re-applying an unchanged spec would replay a finished
// one-shot clip.
function applyAnimationSpec(
  objectId: string,
  entry: AnimationEntry,
  spec: Scene3DObject['animation'],
  emitMissing: (info: { objectId: string; clip: string; type: 'missing' }) => void
) {
  if (!spec) {
    // Spec removed — stop playback rather than freeze mid-pose
    if (entry.currentClip) {
      entry.mixer.stopAllAction();
      entry.currentClip = null;
      entry.together = undefined;
    }
    return;
  }
  if (spec.clip === ALL_CLIPS) {
    playTogether(entry, spec);
    return;
  }
  if (entry.together) {
    // From every clip to one: they all stop, and the one starts as from nothing.
    entry.mixer.stopAllAction();
    entry.together = undefined;
    entry.currentClip = null;
  }
  const clipName = spec.clip ?? entry.clips[0]?.name;
  if (!clipName) return;
  const clip = entry.clips.find((c) => c.name === clipName);
  if (!clip) {
    if (!entry.warnedMissing.has(clipName)) {
      entry.warnedMissing.add(clipName);
      console.warn(`[Scene3D] Animation clip "${clipName}" not found on model "${objectId}"`);
      emitMissing({ objectId, clip: clipName, type: 'missing' });
    }
    return;
  }
  let action = entry.actions.get(clipName);
  if (!action) {
    action = entry.mixer.clipAction(clip);
    entry.actions.set(clipName, action);
  }
  if (spec.loop === 'once') {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = spec.clampWhenFinished ?? true;
  } else {
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = spec.clampWhenFinished ?? false;
  }
  action.timeScale = spec.speed ?? 1;
  // `time` and `progress` hold the clip at a point in it: a paused action is
  // still drawn, at whatever time it is given. `time` counts from the clip's
  // first key, `progress` from the clip's own nought as it always did.
  const timed = typeof spec.time === 'number' && Number.isFinite(spec.time);
  const first = timed ? firstKeyOf(clip) : 0;
  const point = heldAt(spec, clip.duration - first);
  const held = point !== undefined;
  if (entry.currentClip !== clipName) {
    const prev = entry.currentClip ? entry.actions.get(entry.currentClip) : undefined;
    action.reset().play();
    if (prev && prev !== action) {
      prev.crossFadeTo(action, (spec.crossFadeMs ?? DEFAULT_CROSSFADE_MS) / 1000, false);
    }
    entry.currentClip = clipName;
  } else if (
    !held &&
    spec.playing !== false &&
    spec.loop === 'once' &&
    !action.isRunning() &&
    action.time >= clip.duration
  ) {
    // Resuming a finished one-shot must replay it — un-pausing the clamped end
    // state alone would re-fire 'finished' every frame
    action.reset().play();
  }
  if (point !== undefined) {
    // A one-shot that ran to its end without clamping was switched off there.
    action.enabled = true;
    action.paused = true;
    action.time = first + point;
    return;
  }
  action.paused = spec.playing === false;
}

/** Who hears that a clip ended, or was not there. */
type AnimationListener = (info: Scene3DAnimationInfo) => void;

/**
 * The mixer for a model that has just loaded, playing what its object asks
 * for; undefined for a model with no clips, which says so once if a clip
 * was asked of it. `parentId` is the group, for a model that is in one.
 */
function startModelAnimation(
  model: THREE.Object3D,
  clips: THREE.AnimationClip[],
  spec: Scene3DObject,
  parentId: string | undefined,
  listener: AnimationListener
): AnimationEntry | undefined {
  const from = parentId === undefined ? {} : { parentId };
  if (clips.length === 0) {
    // Every clip of a model that has none is none: nothing is missing.
    if (spec.animation?.clip && spec.animation.clip !== ALL_CLIPS) {
      // A clip requested on a clipless model can never resolve — report once here
      console.warn(`[Scene3D] Animation clip "${spec.animation.clip}" not found on model "${spec.id}"`);
      listener({ objectId: spec.id, ...from, clip: spec.animation.clip, type: 'missing' });
    }
    return undefined;
  }
  const mixer = new THREE.AnimationMixer(model);
  mixer.addEventListener('finished', (e) => {
    listener({ objectId: spec.id, ...from, clip: e.action.getClip().name, type: 'finished' });
  });
  const entry: AnimationEntry = {
    mixer,
    clips,
    actions: new Map(),
    currentClip: null,
    warnedMissing: new Set(),
    finished: (clip) => listener({ objectId: spec.id, ...from, clip, type: 'finished' }),
  };
  applyAnimationSpec(spec.id, entry, spec.animation, (info) => listener({ ...info, ...from }));
  return entry;
}

/** Stop a mixer and let go of what it bound: freeing the mixer alone leaks its property bindings. */
function stopAnimation(entry: AnimationEntry): void {
  entry.mixer.stopAllAction();
  entry.mixer.uncacheRoot(entry.mixer.getRoot());
}

/** A model that is a group's child: the node the group holds for it, and what its load made. */
interface ChildModel {
  /** The group's child. It carries the object's transform; the model is added under it when it arrives. */
  holder: THREE.Group;
  spec: Scene3DObject;
  parentId: string;
  /** The number of the load in flight, or of the last one: a load that arrives under another is discarded. */
  version: number;
  load: ModelLoadState;
  /** What the scene's readiness knows this load as. */
  readinessKey: string;
  model?: THREE.Object3D;
  info?: ModelContents;
  instance?: ModelInstance;
  animation?: AnimationEntry;
  /** What moves its named `parts`, once it has loaded and its object names any. */
  parts?: ModelParts;
  /** Its cameras by name, found once, when the scene has looked through it. */
  cameras?: ModelCameras;
  /** The lights that are in it, once its object has spoken of its `lights`. */
  lights?: ModelLights;
}

/** What loading a group's models takes from the scene: read when it is used, not when the host is made. */
interface ChildModelScene {
  appId(): string | undefined;
  policy(): ModelResourcePolicy;
  renderer(): THREE.WebGLRenderer | null;
  /** What eases the scene's changes (motion.ts). */
  easer(): Easer;
  report(info: Scene3DModelStateInfo): void;
  animation: AnimationListener;
  /** A load began, or settled, or its model left: for the scene's readiness. */
  settled(key: string): void;
  /**
   * A model has just been put under its node. What a group passes down to
   * everything in it (its shadows, a camera-attached group's depth settings)
   * was passed down before the model was there.
   */
  arrived(holder: THREE.Object3D): void;
  /** Every model child alive, loading or loaded: the render loop advances the loaded ones. */
  all: Set<ChildModel>;
}

const CHILD_MODEL_KEY = '__softnChildModel';
let childModelCounter = 0;

/**
 * Models as children of groups.
 *
 * A group built its children as primitives and nothing else, so a `model`
 * among them was drawn as a one-unit box and nothing said why: a car could
 * not be a group of a body and four wheels. A model child is now loaded as a
 * top-level one is — through the same template cache and permission policy,
 * with the same states, retry, clips, appearance and `fit` — into a node of
 * its own in the group. Its geometry and textures stay the cache's: the node
 * carries a release that `disposeObject3D` calls in place of disposing it.
 */
function createChildModelHost(scene: ChildModelScene): ChildModelHost {
  const modelOf = (node: THREE.Object3D): ChildModel | undefined =>
    node.userData[CHILD_MODEL_KEY] as ChildModel | undefined;

  /** Give back what a load made, leaving the node in its group. */
  const drop = (child: ChildModel) => {
    if (child.animation) stopAnimation(child.animation);
    child.animation = undefined;
    child.parts = undefined;
    child.cameras = undefined;
    child.lights = undefined;
    if (child.model) child.holder.remove(child.model);
    child.instance?.release();
    child.instance = undefined;
    child.model = undefined;
    child.info = undefined;
  };

  const begin = (child: ChildModel, attempt: number, retry: boolean) => {
    const spec = child.spec;
    const url = spec.modelUrl as string;
    const bundlePath = scene.policy().assets?.pathOf?.(url);
    const format = spec.modelFormat ?? detectModelFormat(bundlePath ?? url);
    const { key, keepIdle } = modelTemplateAddress(scene.appId(), url, format, bundlePath);
    // The same URL again is a retry: the cache forgets what it holds for it.
    if (retry) modelTemplateCache.invalidate(key);
    drop(child);
    const version = ++_modelLoadCounter;
    child.version = version;
    child.load = { state: 'pending', attempt };
    scene.report({ objectId: spec.id, parentId: child.parentId, ...child.load });

    const settle = (state: ModelLoadState) => {
      child.load = state;
      scene.report({ objectId: child.spec.id, parentId: child.parentId, ...state });
      scene.settled(child.readinessKey);
    };
    modelTemplateCache
      .acquire(key, () => loadModelTemplate({ url, format, policy: scene.policy }), { keepIdle })
      .then((instance) => {
        // The node left its group, or was pointed at another file, meanwhile.
        if (child.version !== version) {
          instance.release();
          return;
        }
        const model = instance.object;
        // The spec of now: the group may have been reconciled during the load.
        const now = child.spec;
        fitModel(model, instance.info, now.fit);
        dressModel(model, now, scene.renderer());
        child.holder.add(model);
        // What it passes down to the nodes that have just arrived, and then
        // what the group it is in passes down, as a reconcile of that group
        // would. Where it stands is not written again: it may be on its way
        // somewhere.
        holdAtCamera(child.holder, now.attach === 'camera');
        scene.arrived(child.holder);
        child.model = model;
        child.info = instance.info;
        child.instance = instance;
        child.animation = startModelAnimation(model, instance.animations, now, child.parentId, scene.animation);
        // Its named parts as the object has them by now: put there, not eased there.
        moveParts(child, model, instance, now, 0, () => child.animation);
        lightModel(child, model, now);
        settle({ state: 'loaded', attempt, ...copyContents(instance.info) });
      })
      .catch((err: unknown) => {
        if (child.version !== version) return;
        console.error(`[Scene3D] Failed to load model "${spec.id}" from ${url}:`, err);
        settle({ state: 'error', attempt, error: err instanceof Error ? err.message : String(err) });
      });
  };

  return {
    owns: (node) => modelOf(node) !== undefined,

    create(spec, parentId) {
      const holder = new THREE.Group();
      const child: ChildModel = {
        holder,
        spec,
        parentId,
        version: 0,
        load: { state: 'pending', attempt: 1 },
        readinessKey: `child-model ${++childModelCounter} in ${parentId}`,
      };
      holder.userData[CHILD_MODEL_KEY] = child;
      holder.userData[RELEASE_KEY] = () => {
        // No load in flight is this node's any more.
        child.version = -1;
        drop(child);
        scene.all.delete(child);
        scene.settled(child.readinessKey);
      };
      scene.all.add(child);
      begin(child, 1, false);
      return holder;
    },

    patch(node, next, ms = 0) {
      const child = modelOf(node);
      if (!child || !next.modelUrl) return false;
      const prev = child.spec;
      // Another file is another node, and a first attempt.
      if (prev.modelUrl !== next.modelUrl || prev.modelFormat !== next.modelFormat) return false;
      child.spec = next;
      if ((prev.reload ?? 0) !== (next.reload ?? 0)) {
        begin(child, child.load.attempt + 1, true);
        return true;
      }
      if (child.model) {
        if (prev.fit !== next.fit) fitModel(child.model, child.info, next.fit);
        if (needsMaterialUpdate(prev, next)) applyMaterialOverrides(child.model, next, scene.easer(), ms);
        // Re-apply only on spec change — see applyAnimationSpec's guard note
        const animation = child.animation;
        if (animation && JSON.stringify(prev.animation) !== JSON.stringify(next.animation)) {
          changeAnimation(child.parts, () =>
            applyAnimationSpec(next.id, animation, next.animation, (info) => scene.animation({ ...info, parentId: child.parentId }))
          );
        }
        // Eased only while the scene is being drawn, as everything else is.
        if (prev.parts !== next.parts) moveParts(child, child.model, child.instance, next, scene.easer().live ? ms : 0, () => child.animation);
        if (prev.lights !== next.lights) lightModel(child, child.model, next);
      }
      return true;
    },
  };
}

// Freeing the mixer alone leaks property bindings — stop actions and uncache
// the root before dropping the entry
function disposeAnimationEntry(map: Map<string, AnimationEntry>, id: string) {
  const entry = map.get(id);
  if (!entry) return;
  stopAnimation(entry);
  map.delete(id);
}

// Drag detection threshold (pixels)
const DRAG_THRESHOLD = 4;

// Global monotonic counter for model load versioning (prevents stale loads after remove/re-add)
let _modelLoadCounter = 0;

/**
 * What the scene's readiness knows the environment's panorama as, beside the
 * ids of the models it waits for. No object has this id: one is text an app
 * wrote, and this begins with a character no app writes in one.
 */
const ENVIRONMENT_ASSET = '\u0000environment';

export function Scene3D({
  width: widthProp = 800,
  height: heightProp = 600,
  fill = false,
  objects = [],
  staticObjects,
  lights,
  camera: cameraProp,
  transition = 0,
  jumpDistance = 4,
  background = '#1a1a2e',
  sky,
  grid,
  crosshair: crosshairProp,
  gameControls = false,
  alpha = false,
  antialias = true,
  shadows = false,
  fog,
  orbitControls: _enableOrbitControls = false,
  orbit,
  autoRotate = false,
  autoRotateSpeed = 2,
  expandable = false,
  mouseLook: mouseLookProp = false,
  mouseLookSensitivity = 0.003,
  pointerLock: enablePointerLock = false,
  pitchLimit = 0.8,
  cameraSmoothing = 0,
  maxPixelRatio = 2,
  toneMapping = 'aces',
  environment = 'none',
  environmentIntensity = .7,
  effects,
  toneMappingExposure = 1,
  onReady,
  onAssetsReady,
  onFirstFrame,
  onModelState,
  onClick,
  onMiss,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onHover,
  onHoverChange,
  onAnimation,
  onCameraChange,
  onStats,
  children,
  style,
  className,
}: Scene3DProps) {
  // A texture or a model named by URL is a fetch the scene performs on first
  // paint, from a host the bundle chose. The renderer's own URL scrub does not
  // know these keys — `textureUrl` and `modelUrl` mean nothing to an <img> —
  // so the same question is asked here, of the same policy: not egress at
  // all (a bundle asset), or `net` granted to a permitted host. What the
  // policy refuses is dropped from the object before anything is built.
  const capability = useCapabilityState();
  const judgeUrl = useMemo(() => {
    const egress =
      capability.permissions === null
        ? null
        : { consentPending: capability.consentPending, permissions: capability.permissions };
    return (url: string) => describeMarkupEgress(url, egress);
  }, [capability]);
  const allowUrl = useMemo(
    () =>
      (url: string | undefined): url is string =>
        typeof url === 'string' && url.length > 0 && judgeUrl(url).allowed,
    [judgeUrl]
  );
  // The app this scene is in: its bundle resolver, so a model's relative
  // URIs can be found in the archive; its id, so its cached models are its
  // own; whether the host is showing it, so a hidden tab draws nothing.
  const assets = useAppAssets();
  const appId = useAppScope().appId;
  const appIdRef = useRef(appId);
  appIdRef.current = appId;
  const active = useAppActive();
  const documentVisible = useDocumentVisible();
  // The same judge, for everything a model goes on to ask for. A load in
  // flight is handed a getter over this ref, read on every URL its loader
  // asks about, so a consent answer that arrives mid-load is the policy the
  // rest of that load sees.
  const policy = useMemo<ModelResourcePolicy>(() => ({ judge: judgeUrl, assets }), [judgeUrl, assets]);
  const policyRef = useRef(policy);
  policyRef.current = policy;

  // What an object's URLs were screened by, and each object that came out
  // of it changed. A game builds its objects in logic, which has no
  // `asset()`: a `modelUrl` or `textureUrl` with no scheme is a path in the
  // app's own bundle, offered to the host's resolver first, as
  // `softn.audio.play` offers a sound's (a path the resolver does not know
  // is left as written). Whatever comes back is then judged by the policy
  // above, exactly as a URL written out in full is. An object is screened
  // once for as long as the policy and the resolver stand, and comes out the
  // same object each time, so scenery handed over unchanged (`staticObjects`,
  // a group's children) is still seen to be unchanged below.
  const screening = useMemo(() => ({ allowUrl, assets }), [allowUrl, assets]);
  const screenedRef = useRef(new WeakMap<Scene3DObject, { by: object; out: Scene3DObject }>());
  const safeObjects = useMemo<Scene3DObject[]>(() => {
    const seen = screenedRef.current;
    const screenedUrl = (written: string): string | undefined => {
      const url = resolveBundleSrc(written, screening.assets);
      return screening.allowUrl(url) ? url : undefined;
    };
    const screened = (obj: Scene3DObject): Scene3DObject => {
      const known = seen.get(obj);
      if (known && known.by === screening) return known.out;
      let out = obj;
      if (obj.textureUrl) {
        const textureUrl = screenedUrl(obj.textureUrl);
        if (textureUrl !== obj.textureUrl) out = { ...out, textureUrl };
      }
      if (obj.modelUrl) {
        const modelUrl = screenedUrl(obj.modelUrl);
        if (modelUrl !== obj.modelUrl) out = { ...out, modelUrl };
      }
      if (Array.isArray(obj.children)) {
        const children = obj.children.map((child) => (child && typeof child === 'object' ? screened(child) : child));
        if (children.some((c, i) => c !== obj.children![i])) out = { ...out, children };
      }
      if (out !== obj) seen.set(obj, { by: screening, out });
      return out;
    };
    const usable = (arr: Scene3DObject[] | undefined) =>
      Array.isArray(arr)
        ? arr
            .filter(
              (obj): obj is Scene3DObject => !!obj && typeof obj.id === 'string' && obj.id.length > 0
            )
            .map(screened)
        : [];
    const dynamic = usable(objects);
    const fixed = usable(staticObjects);
    // Statics first, so ids stay in the order the scene declared them and a
    // dynamic object with a clashing id still wins the later reconcile pass.
    return fixed.length === 0 ? dynamic : fixed.concat(dynamic);
  }, [objects, staticObjects, screening]);
  // The environment, as the two things it can be: the studio room, or a
  // panorama of the app's own. The panorama's address is a path in the
  // bundle or a URL, resolved and judged as a model's is; what the policy
  // withholds is not loaded. Each part is a value of its own, so an
  // `environment` handed over as a new object on every tick, with the same
  // in it, sets nothing off.
  const studio = environment === 'studio';
  const environmentImage = isEnvironmentImage(environment) ? environment : null;
  const environmentWritten = environmentImage?.url;
  const environmentAsked = environmentImage?.format;
  const environmentUrl = useMemo(() => {
    if (!environmentWritten) return undefined;
    const url = resolveBundleSrc(environmentWritten, assets);
    return allowUrl(url) ? url : undefined;
  }, [environmentWritten, assets, allowUrl]);
  const environmentFormat = environmentUrl
    ? environmentFormatOf(environmentAsked, assets?.pathOf?.(environmentUrl) ?? environmentWritten ?? '')
    : 'image';
  const environmentLook = environmentLookOf(environmentImage);
  // No `lights` at all is not a wish for the dark (that is `lights={[]}`):
  // the scene is lit, unless its environment already lights it.
  const litByEnvironment = studio || environmentImage !== null;
  const safeLights = useMemo<Scene3DLight[]>(() => {
    if (lights === undefined) return litByEnvironment ? [] : DEFAULT_LIGHTS;
    return Array.isArray(lights)
      ? lights.filter((light): light is Scene3DLight => !!light && typeof light.type === 'string')
      : [];
  }, [lights, litByEnvironment]);

  // Pointer lock is mouse look with the cursor captured; either wins over
  // orbit controls, which cannot coexist with a steered camera.
  const enableMouseLook = mouseLookProp || enablePointerLock;
  const enableOrbitControls = _enableOrbitControls && !enableMouseLook;
  const crosshair = crosshairProp ?? (enablePointerLock && crosshairProp !== false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  /** The sky's gradient texture, while it is the scene's background. */
  const skyTextureRef = useRef<THREE.Texture | null>(null);
  /** What the background was last painted from (backgroundKey). */
  const backgroundKeyRef = useRef<string | null>(null);
  /** The scene's own background as last painted (its colour, its sky, or none): what stands behind a panorama that is not shown. */
  const ownBackgroundRef = useRef<THREE.Scene['background']>(null);
  /** The panorama the scene is lit by, when `environment` names one (environment.ts): made and disposed with the scene. */
  const environmentRef = useRef<SceneEnvironment | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Whether the browser gave the scene a WebGL context to draw with.
  const [noWebGL, setNoWebGL] = useState(false);
  // With `fill`, the box the scene sits in is the size; measured, not declared.
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  // Without it, the scene is `width` by `height` where there is room, and
  // never wider than the room there is: the width it was actually given.
  // A scene 800 pixels wide ran off the side of a phone.
  const [roomWidth, setRoomWidth] = useState<number | null>(null);
  // Before the browser paints, where there is one: the box's height follows
  // the width it was given, and a scene too wide for its place is not shown
  // for a moment at its full height first.
  useBeforePaint(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => {
      if (fill) {
        const r = el.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        setMeasured((m) => (m && m.w === w && m.h === h ? m : { w, h }));
        return;
      }
      // Nothing to go by while the scene is not laid out (a hidden tab):
      // the last width it had stands.
      const w = el.clientWidth;
      if (w > 0) setRoomWidth((known) => (known === w ? known : w));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);
  const fitted = sizeWithin(widthProp, heightProp, roomWidth);
  const width = fill ? (measured?.w ?? widthProp) : fitted.width;
  const height = fill ? (measured?.h ?? heightProp) : fitted.height;
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const effectsRigRef = useRef<EffectsRig | null>(null);
  // The shape (which passes) rebuilds the chain; the tune (their numbers)
  // is written into it. Neither reacts to an object prop the host recreates
  // each tick.
  const effectsPlan = planEffects(effects);
  const effectsShape = effectsShapeKey(effectsPlan);
  const effectsTune = effectsTuneKey(effectsPlan);
  const effectsPlanRef = useRef(effectsPlan);
  effectsPlanRef.current = effectsPlan;
  // Bumped for every rebuild request, so a chain whose modules arrive after
  // the next request, or after unmount, is not installed.
  const effectsVersionRef = useRef(0);
  // The camera drawn with: a perspective one or an orthographic one, and not
  // always the same object, since `camera.type` may change while the scene
  // stays. Everything that uses it reads it from here when it does.
  const cameraRef = useRef<SceneCamera | null>(null);
  /** Which kind `cameraRef` holds, and the numbers its picture is made from. */
  const orthographic = cameraProp?.type === 'orthographic';
  const cameraShapeRef = useRef<CameraShape>({ ...DEFAULT_CAMERA_SHAPE });
  /** The size the renderer was last given, in CSS pixels: what the camera's shape and the anchors go by. */
  const viewSizeRef = useRef({ width: 1, height: 1 });
  const controlsRef = useRef<OrbitControls | null>(null);
  /** Where the camera looks, for controls that arrive after it was set. */
  const lookAtRef = useRef({ x: 0, y: 0, z: 0 });
  const autoRotateRef = useRef({ autoRotate, autoRotateSpeed });
  autoRotateRef.current = { autoRotate, autoRotateSpeed };
  const meshMapRef = useRef<Map<string, MeshEntry>>(new Map());
  const loadVersionRef = useRef<Map<string, number>>(new Map());
  const animationMapRef = useRef<Map<string, AnimationEntry>>(new Map());
  const lightMapRef = useRef<Map<string, THREE.Light>>(new Map());
  const loopRef = useRef<FrameLoop | null>(null);
  const wantRunning = active && documentVisible;
  const wantRunningRef = useRef(wantRunning);
  wantRunningRef.current = wantRunning;
  const clockRef = useRef<THREE.Clock>(new THREE.Clock());
  const readyFiredRef = useRef(false);
  const onAssetsReadyRef = useRef(onAssetsReady);
  onAssetsReadyRef.current = onAssetsReady;
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;
  const onModelStateRef = useRef(onModelState);
  onModelStateRef.current = onModelState;
  // Armed by assets-ready; the next frame drawn fires first-frame.
  const firstFrameArmedRef = useRef(false);
  const firstFrameFiredRef = useRef(false);
  const requiredAssetsRef = useRef<RequiredAssets | null>(null);
  if (!requiredAssetsRef.current) {
    requiredAssetsRef.current = new RequiredAssets(() => {
      markInstant(MARK_ASSETS_READY);
      firstFrameArmedRef.current = true;
      onAssetsReadyRef.current?.();
    });
  }
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const onMissRef = useRef(onMiss);
  onMissRef.current = onMiss;
  const onPointerDownRef = useRef(onPointerDown);
  onPointerDownRef.current = onPointerDown;
  const onPointerMoveRef = useRef(onPointerMove);
  onPointerMoveRef.current = onPointerMove;
  const onPointerUpRef = useRef(onPointerUp);
  onPointerUpRef.current = onPointerUp;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onHoverChangeRef = useRef(onHoverChange);
  onHoverChangeRef.current = onHoverChange;
  const onAnimationRef = useRef(onAnimation);
  onAnimationRef.current = onAnimation;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const yawRef = useRef<number>(0);
  const pitchRef = useRef<number>(0);
  const camTargetRef = useRef<THREE.Vector3>(new THREE.Vector3());
  // The point the camera is to look at, and the point it is looking at now
  // on its way there: with `cameraSmoothing`, and when following, the view
  // turns to a new `lookAt` over a few frames as the position already did.
  // `aimingRef` is true while the view or the camera itself is on its way:
  // the camera is aimed on each frame then, and left alone otherwise (orbit
  // controls and mouse look turn it themselves).
  const lookTargetRef = useRef<THREE.Vector3>(new THREE.Vector3());
  const lookNowRef = useRef<THREE.Vector3>(new THREE.Vector3());
  const aimingRef = useRef(false);
  const followStateRef = useRef(createFollowState());
  /**
   * The camera of a model the scene is looking through (`camera.from`), as
   * the render loop last took it: `on` while one is in force. What depth of
   * field reads for `depthOfField: "camera"`.
   */
  const modelViewRef = useRef<SceneModelView>({ on: false, model: null, camera: null, name: '', seconds: 0, fov: undefined, film: undefined });
  const cameraSmoothingRef = useRef(cameraSmoothing);
  cameraSmoothingRef.current = cameraSmoothing;
  // What eases the scene's changes between updates (motion.ts): one for the
  // life of the component, told each render how far is too far to ease.
  const easerRef = useRef<Easer | null>(null);
  if (!easerRef.current) easerRef.current = new Easer();
  const easer = easerRef.current;
  easer.jump = Number.isFinite(jumpDistance) ? Math.max(0, jumpDistance) : 4;
  const jumpRef = useRef(easer.jump);
  jumpRef.current = easer.jump;
  const transitionRef = useRef(0);
  transitionRef.current = transitionOf(transition, 0);
  const orbitRef = useRef(orbit);
  orbitRef.current = orbit;
  // This scene's hold on the pictures round and soft particles are drawn
  // with (particle-sprites.ts): taken when a cloud first asks, let go of
  // with the scene.
  const spritesRef = useRef<ParticleSprites | null>(null);
  if (!spritesRef.current) spritesRef.current = new ParticleSprites();
  // The `<SceneAnchor>`s inside this scene, moved by its render loop.
  const anchorsRef = useRef<AnchorSet | null>(null);
  if (!anchorsRef.current) anchorsRef.current = new AnchorSet();
  /** Finds the node of an object by its id, for a camera that follows one and for the anchors. */
  const nodesRef = useRef<SceneNodes | null>(null);
  /** Set by the scene's set-up: asks again what is under a pointer that has not moved. */
  const hoverRecheckRef = useRef<(() => void) | null>(null);
  /** True from the moment the scene is drawn again until its next frame: that frame eases nothing. */
  const resumedRef = useRef(false);
  /**
   * For `onCameraChange`. `waiting` counts the frames since the person let
   * go of the orbit controls, while the scene waits for the camera to come
   * to rest to say where; 0 when it is not waiting. The rest is where the
   * camera was when they took hold, which tells an orbit from a click that
   * moved nothing.
   */
  const orbitRestRef = useRef({ waiting: 0, from: new THREE.Vector3(), fromTarget: new THREE.Vector3(), fromZoom: 1 });
  /**
   * What the orbit controls just disposed turned about, and the kind of
   * camera they were made for: read, and cleared, by the effect that makes
   * the next ones, which takes it up when it is making them for a camera of
   * the other kind.
   */
  const orbitLeftRef = useRef<{ target: { x: number; y: number; z: number }; orthographic: boolean } | null>(null);
  // Read where they are used, each time: a sensitivity slider and a pitch
  // limit were read once, when the scene was made, and never again.
  const mouseLookSensitivityRef = useRef(mouseLookSensitivity);
  mouseLookSensitivityRef.current = mouseLookSensitivity;
  const pitchLimitRef = useRef(pitchLimit);
  pitchLimitRef.current = pitchLimit;
  const cameraPropRef = useRef(cameraProp);
  cameraPropRef.current = cameraProp;
  /** The pixel ratio the renderer was last given. */
  const pixelRatioRef = useRef(1);
  /** Whether the renderer was made with smooth edges: `antialias` as it was when the scene was made. */
  const smoothEdgesRef = useRef(antialias);
  // Mouse look and pointer lock are set up by an effect of their own, which
  // can come and go while the scene stays. This is what the scene's render
  // loop and its click handling know of it: which is on, what to do each
  // frame for a locked pointer, and how to ask what a ray hits.
  const lookModeRef = useRef({ mouseLook: false, pointerLock: false });
  const pointerLockFrameRef = useRef<(() => void) | null>(null);
  const pickRef = useRef<((ndcX: number, ndcY: number) => PickedHit) | null>(null);
  const mouseLookOwnerRef = useRef<MouseLookOwner | null>(null);
  if (!mouseLookOwnerRef.current) {
    mouseLookOwnerRef.current = { token: Symbol('Scene3D mouse look'), yawRef, pitchRef };
  }
  // The models that are children of groups: loaded by a host that outlives
  // any one reconcile, and advanced by the render loop.
  const childModelsRef = useRef<Set<ChildModel>>(new Set());
  const childModelHostRef = useRef<ChildModelHost | null>(null);
  /** False while the scene is being taken down: what it lets go of then is no news for the app. */
  const standingRef = useRef(false);
  if (!childModelHostRef.current) {
    childModelHostRef.current = createChildModelHost({
      appId: () => appIdRef.current,
      policy: () => policyRef.current,
      renderer: () => rendererRef.current,
      easer: () => easer,
      report: (info) => onModelStateRef.current?.(info),
      animation: (info) => onAnimationRef.current?.(info),
      settled: (key) => {
        if (standingRef.current) requiredAssetsRef.current?.settle(key);
      },
      arrived: (holder) => {
        // The top-level object the model is in: the node that stands in the scene.
        let top = holder;
        while (top.parent && top.parent !== sceneRef.current) top = top.parent;
        for (const entry of meshMapRef.current.values()) {
          if (entry.mesh !== top) continue;
          // Its shadows and a camera-attached group's depth settings, for
          // the nodes that have just arrived. Where it stands is left alone.
          applyInherited(entry.mesh, entry.spec);
          break;
        }
      },
      all: childModelsRef.current,
    });
  }

  // Track last prop values to avoid resetting on reference-only changes
  const lastFogRef = useRef<string>('');
  const lastCamPosRef = useRef<string>('');
  const lastCamLookAtRef = useRef<string>('');
  const lastCamFovRef = useRef<number | undefined>(undefined);

  // The built-in game keys, on and off with `gameControls`. They were set up
  // with the scene and read once: a game that turned them on after the first
  // render heard no keys.
  useEffect(() => {
    if (!gameControls || typeof window === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;
    const keys = (window as unknown as { __softnKeys?: Record<string, boolean> }).__softnKeys || {
      w: false, a: false, s: false, d: false,
      up: false, down: false, left: false, right: false,
      space: false, shift: false,
    };
    (window as unknown as { __softnKeys: Record<string, boolean> }).__softnKeys = keys;

    const isUi = (t: EventTarget | null) => {
      if (!t || !(t instanceof HTMLElement)) return false;
      const tag = t.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || t.isContentEditable;
    };

    // A scene not on screen hears no key going down. A host that keeps
    // several apps open (SoftN Web's tabs) keeps a hidden app's scene
    // mounted, and Space pressed in the app on screen made the hidden
    // game jump. Keys still come up, so one held as the scene hides lets go.
    const isShown = () => {
      if (typeof container.checkVisibility === 'function') return container.checkVisibility();
      for (let node: Element | null = container; node; node = node.parentElement) {
        if (getComputedStyle(node).display === 'none') return false;
      }
      return container.isConnected;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isUi(e.target) || !isShown()) return;
      const k = e.key.toLowerCase();
      if (k === 'w') keys.w = true;
      if (k === 's') keys.s = true;
      if (k === 'a') keys.a = true;
      if (k === 'd') keys.d = true;
      if (e.key === 'ArrowUp') keys.up = true;
      if (e.key === 'ArrowDown') keys.down = true;
      if (e.key === 'ArrowLeft') keys.left = true;
      if (e.key === 'ArrowRight') keys.right = true;
      if (e.key === ' ' || e.code === 'Space') keys.space = true;
      if (e.key === 'Shift') keys.shift = true;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w') keys.w = false;
      if (k === 's') keys.s = false;
      if (k === 'a') keys.a = false;
      if (k === 'd') keys.d = false;
      if (e.key === 'ArrowUp') keys.up = false;
      if (e.key === 'ArrowDown') keys.down = false;
      if (e.key === 'ArrowLeft') keys.left = false;
      if (e.key === 'ArrowRight') keys.right = false;
      if (e.key === ' ' || e.code === 'Space') keys.space = false;
      if (e.key === 'Shift') keys.shift = false;
    };

    // A key held as the window loses focus, or as the scene goes, has no
    // keyup to come: the object is shared with the next scene, which walked
    // on by itself until the key was pressed and let go again.
    const releaseAll = () => {
      for (const key of Object.keys(keys)) keys[key] = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    gameControlScenes++;
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      // Let go only by the last scene listening: another still on screen
      // shares the map, and one scene's going took the key its player held.
      gameControlScenes--;
      if (gameControlScenes === 0) releaseAll();
    };
  }, [gameControls]);

  // Initialize renderer, scene, camera
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Capture the collections owned by this renderer instance. Cleanup must
    // dispose exactly these resources even if a later setup updates a ref.
    const meshMap = meshMapRef.current;
    const loadVersions = loadVersionRef.current;
    const animationMap = animationMapRef.current;
    const lightMap = lightMapRef.current;
    const childModels = childModelsRef.current;
    const sceneWindow = window as Scene3DWindow;
    const mouseLookOwner = mouseLookOwnerRef.current as MouseLookOwner;

    // A browser with WebGL switched off, blocked by policy, or out of
    // contexts gives none, and three throws from the constructor. That went
    // to the page's error box (`<Scene3D> Error creating WebGL context.`);
    // the scene says what it needs instead, and the rest of the page is
    // untouched.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias, alpha });
    } catch {
      setNoWebGL(true);
      return;
    }
    setNoWebGL(false);
    smoothEdgesRef.current = antialias;
    // The size the scene was rendered at, or what fits the place it has
    // turned out to stand in: measured here, so the first frame is drawn at
    // the size the next render will ask for.
    const initial = fill ? { width, height } : sizeWithin(widthProp, heightProp, wrapperRef.current?.clientWidth ?? null);
    renderer.setSize(initial.width, initial.height);
    viewSizeRef.current = { width: initial.width, height: initial.height };
    pixelRatioRef.current = pixelRatioFor(maxPixelRatio);
    renderer.setPixelRatio(pixelRatioRef.current);
    if (shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    if ('outputColorSpace' in renderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    if ('toneMapping' in renderer) {
      if (toneMapping === 'agx') renderer.toneMapping = THREE.AgXToneMapping;
      else if (toneMapping === 'linear') renderer.toneMapping = THREE.LinearToneMapping;
      else if (toneMapping === 'reinhard') renderer.toneMapping = THREE.ReinhardToneMapping;
      else if (toneMapping === 'cineon') renderer.toneMapping = THREE.CineonToneMapping;
      else if (toneMapping === 'none') renderer.toneMapping = THREE.NoToneMapping;
      else renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = toneMappingExposure;
    }
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // A handle for tests and debugging: what the canvas is drawing.
    (renderer.domElement as HTMLCanvasElement & { __softnScene?: THREE.Scene; __softnRenderer?: THREE.WebGLRenderer }).__softnScene = scene;
    (renderer.domElement as HTMLCanvasElement & { __softnRenderer?: THREE.WebGLRenderer }).__softnRenderer = renderer;
    // The same, for what is not a scene graph: the post-processing chain in
    // force and where each model's load stands.
    const handles = renderer.domElement as HTMLCanvasElement & {
      __softnEffects?: () => EffectsRig | null;
      __softnModelLoads?: () => Record<string, ModelLoadState>;
      __softnControls?: () => OrbitControls | null;
      __softnModelView?: () => SceneModelView;
    };
    handles.__softnEffects = () => effectsRigRef.current;
    // The orbit controls steering now, if any.
    handles.__softnControls = () => controlsRef.current;
    // The camera of a model the scene looks through, when it looks through one, and what it holds of it.
    handles.__softnModelView = () => modelViewRef.current;
    handles.__softnModelLoads = () => {
      const loads: Record<string, ModelLoadState> = {};
      meshMap.forEach((entry, id) => {
        if (entry.load) loads[id] = entry.load;
      });
      return loads;
    };
    skyTextureRef.current = paintBackground(scene, alpha, background, sky);
    backgroundKeyRef.current = backgroundKey(alpha, background, sky);
    ownBackgroundRef.current = scene.background;
    // A panorama to light the scene by, loaded by an effect of its own below.
    // One that the scene opened with is waited for by `onAssetsReady`, as a
    // model is.
    const sceneEnvironment = new SceneEnvironment(
      scene,
      () => ownBackgroundRef.current,
      () => {
        if (standingRef.current) requiredAssetsRef.current?.settle(ENVIRONMENT_ASSET);
      }
    );
    environmentRef.current = sceneEnvironment;

    // The camera's shape as the scene opens with it: near and far were fixed
    // at 0.1 and 1000 whatever was passed.
    const fov = cameraProp?.fov ?? 60;
    const shape: CameraShape = {
      fov,
      near: aboveZero(cameraProp?.near) ?? DEFAULT_CAMERA_SHAPE.near,
      far: aboveZero(cameraProp?.far) ?? DEFAULT_CAMERA_SHAPE.far,
      size: aboveZero(cameraProp?.size) ?? DEFAULT_CAMERA_SHAPE.size,
    };
    cameraShapeRef.current = shape;
    const firstCamera = createCamera(cameraProp?.type === 'orthographic', shape, initial.width, initial.height);
    const pos = cameraProp?.position ?? { x: 0, y: 3, z: 8 };
    firstCamera.position.set(pos.x, pos.y, pos.z);
    camTargetRef.current.set(pos.x, pos.y, pos.z);
    (renderer.domElement as HTMLCanvasElement & { __softnCamera?: THREE.Camera }).__softnCamera = firstCamera;
    const lookAt = cameraProp?.lookAt ?? { x: 0, y: 0, z: 0 };
    firstCamera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    lookAtRef.current = lookAt;
    lookTargetRef.current.set(lookAt.x, lookAt.y, lookAt.z);
    lookNowRef.current.set(lookAt.x, lookAt.y, lookAt.z);
    aimingRef.current = false;
    followStateRef.current.held = false;

    // Store initial camera values
    lastCamPosRef.current = JSON.stringify(pos);
    lastCamLookAtRef.current = JSON.stringify(lookAt);
    lastCamFovRef.current = fov;

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = firstCamera;
    standingRef.current = true;
    // The node of an object, by its id: for a camera that follows one, and
    // for the page content pinned to one.
    const nodes = new SceneNodes(
      (id) => meshMap.get(id)?.mesh,
      function* topLevelNodes() {
        for (const entry of meshMap.values()) yield entry.mesh;
      }
    );
    nodesRef.current = nodes;
    const findNode = (id: string) => nodes.find(id);
    const anchors = anchorsRef.current as AnchorSet;
    // The post-processing chain, when there is one, is built by its own
    // effect once its modules arrive; until then the frame goes straight to
    // the canvas.

    // Orbit controls, mouse look and pointer lock are each set up by an
    // effect of their own, below, so they can be turned on and off while the
    // scene stays. They were set up here, once, and a change of camera mode
    // did nothing until the whole scene was torn down and made again.

    // What the centre of the view, or a pointer, is aimed at. Camera-attached
    // objects (a held weapon) sit in front of everything and are skipped, as
    // is whatever said it is not to be picked (picking.ts).
    const raycaster = new THREE.Raycaster();
    // The node the last pick landed on: what `onHoverChange` goes by to know
    // that the object under a pointer at rest has left the scene.
    let pickedNode: THREE.Object3D | null = null;
    const pick = (ndcX: number, ndcY: number): PickedHit => {
      const empty = { objectId: '', instanceId: null, distance: null, point: null, normal: null };
      pickedNode = null;
      const cam = cameraRef.current;
      if (!cam) return empty;
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
      const roots: THREE.Object3D[] = [];
      meshMap.forEach((e) => {
        if (e.spec.attach !== 'camera') roots.push(e.mesh);
      });
      const hit = nearestHit(raycaster, roots);
      if (!hit) return empty;
      // Walk up to find which entry this belongs to (handles group children, model children, and tagged parts)
      const findHitId = (obj: THREE.Object3D): string | undefined => {
        if (obj.userData?.__softnId) return obj.userData.__softnId;
        for (const [id, e] of meshMap.entries()) {
          if (e.mesh === obj) return id;
        }
        if (obj.parent) return findHitId(obj.parent);
        return undefined;
      };
      const id = findHitId(hit.object);
      if (id === undefined) return empty;

      // The top-level object it is part of: the node that stands in the scene.
      let top: THREE.Object3D = hit.object;
      while (top.parent && top.parent !== scene) top = top.parent;
      let rootId = id;
      for (const [mid, e] of meshMap.entries()) {
        if (e.mesh === top) {
          rootId = mid;
          break;
        }
      }

      let normal: Scene3DHit['normal'] = null;
      if (hit.face) {
        const n = hit.face.normal.clone();
        const m = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
        n.applyMatrix3(m).normalize();
        normal = { x: n.x, y: n.y, z: n.z };
      }

      let cursor: string | undefined = undefined;
      let cur: THREE.Object3D | null = hit.object;
      while (cur) {
        if (cur.userData?.__softnCursor) {
          cursor = cur.userData.__softnCursor;
          break;
        }
        if (cur.userData?.__softnInteractive) {
          cursor = 'pointer';
          break;
        }
        cur = cur.parent;
      }

      pickedNode = hit.object;
      return {
        objectId: id,
        rootObjectId: rootId,
        cursor,
        instanceId: typeof hit.instanceId === 'number' ? hit.instanceId : null,
        distance: hit.distance,
        point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
        normal,
      };
    };

    pickRef.current = pick;
    const canvas = renderer.domElement;
    // Whether a pointer-locked scene holds the mouse now.
    const isLocked = () => lookModeRef.current.pointerLock && document.pointerLockElement === canvas;
    const swallowContextMenu = (e: Event) => e.preventDefault();
    // A right button that reaches the app as a drag must not also open the
    // browser menu on release; OrbitControls swallows it the same way.
    canvas.addEventListener('contextmenu', swallowContextMenu);

    // Where a pointer is: in the scene's own pixels, for the app, and as the
    // ray through it, for the pick.
    const pointerAt = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      return {
        ndcX: (x / rect.width) * 2 - 1,
        ndcY: -(y / rect.height) * 2 + 1,
        screen: { x, y },
      };
    };
    const NOTHING: PickedHit = { objectId: '', instanceId: null, distance: null, point: null, normal: null };

    // Drag-aware click: track mousedown position, only fire click if no significant drag
    let mouseDownX = 0;
    let mouseDownY = 0;
    let isDragging = false;
    let clickPointerId: number | null = null;

    const releaseClickPointerCapture = (pointerId: number) => {
      try {
        if (renderer.domElement.hasPointerCapture?.(pointerId)) {
          renderer.domElement.releasePointerCapture(pointerId);
        }
      } catch {
        // Capture may already have been released implicitly.
      }
    };

    // Left, middle and right buttons all flow through pointerdown/move/up
    // with `button` set, so an editor can pan on a right drag; only the left
    // button produces a click, which keeps the old click contract.
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button > 2 || clickPointerId !== null || isLocked()) return;
      clickPointerId = event.pointerId;
      mouseDownX = event.clientX;
      mouseDownY = event.clientY;
      isDragging = false;
      rest(event);
      try {
        renderer.domElement.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture can fail if the pointer has already ended.
      }
      if (onPointerDownRef.current) {
        const at = pointerAt(event.clientX, event.clientY);
        const hit = pick(at.ndcX, at.ndcY);
        onPointerDownRef.current({ ...hit, button: event.button, locked: false, screen: at.screen, dragged: false });
      }
    };

    // The pointer, moving. A mouse reports itself far more often than the
    // screen is drawn, and each report used to cast a ray and call into the
    // app's logic: with no button held (`onHover`), and with one held
    // (`onPointerMove`). The newest position of each is kept, and looked at
    // once a frame.
    let hoverAt: { x: number; y: number } | null = null;
    let moveAt: { x: number; y: number; button: number } | null = null;
    let pointerFrame = 0;
    // Where the pointer was last known to be over the scene; not known once it has left.
    const resting = { x: 0, y: 0, known: false };
    // Set when the object under a pointer at rest has gone: look again where it rests.
    let lookAgain = false;
    // What was under the pointer when it was last looked at; nothing, to begin with.
    let hovered: {
      objectId: string;
      rootObjectId: string | undefined;
      instanceId: number | null;
      node: THREE.Object3D | null;
    } | null = null;
    const restingCursor = () => (lookModeRef.current.mouseLook ? 'grab' : 'default');
    const flushMove = () => {
      const where = moveAt;
      moveAt = null;
      if (!where || !onPointerMoveRef.current) return;
      const at = pointerAt(where.x, where.y);
      const hit = pick(at.ndcX, at.ndcY);
      onPointerMoveRef.current({ ...hit, button: where.button, locked: false, screen: at.screen, dragged: isDragging });
    };
    const flushHover = () => {
      const moved = hoverAt;
      hoverAt = null;
      const again = lookAgain;
      lookAgain = false;
      const where = moved ?? (again && resting.known ? resting : null);
      if (!where || isLocked()) return;
      const at = pointerAt(where.x, where.y);
      const hit = pick(at.ndcX, at.ndcY);
      const info: Scene3DHit = { ...hit, button: -1, locked: false, screen: at.screen, dragged: false };
      // `onHover` is the pointer moving; a look taken because the scene
      // changed under a pointer at rest is not that.
      if (moved) onHoverRef.current?.(info);
      const now =
        hit.objectId === ''
          ? null
          : { objectId: hit.objectId, rootObjectId: hit.rootObjectId, instanceId: hit.instanceId, node: pickedNode };
      const same =
        hovered === now ||
        (hovered !== null &&
          now !== null &&
          hovered.objectId === now.objectId &&
          hovered.rootObjectId === now.rootObjectId &&
          hovered.instanceId === now.instanceId);
      hovered = now;
      if (!same) onHoverChangeRef.current?.(info);
      canvas.style.cursor = hit.cursor || restingCursor();
    };
    const flushPointer = () => {
      pointerFrame = 0;
      flushMove();
      flushHover();
    };
    const askForPointerFrame = () => {
      if (!pointerFrame) pointerFrame = requestAnimationFrame(flushPointer);
    };
    const rest = (event: PointerEvent) => {
      resting.x = event.clientX;
      resting.y = event.clientY;
      resting.known = true;
    };
    // The scene's objects changed. If what was under the pointer is no
    // longer in the scene, the pointer is over something else now, or over
    // nothing, though it has not moved: `onHoverChange` never said so, and a
    // highlight or a tooltip stayed on a thing that had gone.
    hoverRecheckRef.current = () => {
      if (hovered === null || !hovered.node || !resting.known || clickPointerId !== null) return;
      let node: THREE.Object3D | null = hovered.node;
      while (node && node !== scene) node = node.parent;
      if (node === scene) return;
      lookAgain = true;
      askForPointerFrame();
    };

    const handlePointerMove = (event: PointerEvent) => {
      rest(event);
      if (event.pointerId === clickPointerId) {
        const dx = event.clientX - mouseDownX;
        const dy = event.clientY - mouseDownY;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          isDragging = true;
        }
        if (onPointerMoveRef.current) {
          moveAt = { x: event.clientX, y: event.clientY, button: event.button };
          askForPointerFrame();
        }
      } else if (!isLocked()) {
        hoverAt = { x: event.clientX, y: event.clientY };
        askForPointerFrame();
      }
    };

    // The pointer left the scene: nothing of it is under the pointer now.
    const handlePointerLeave = (event: PointerEvent) => {
      hoverAt = null;
      lookAgain = false;
      resting.known = false;
      // A move with a button held that has not been reported yet still will be.
      if (pointerFrame && !moveAt) {
        cancelAnimationFrame(pointerFrame);
        pointerFrame = 0;
      }
      if (hovered === null) return;
      hovered = null;
      const at = pointerAt(event.clientX, event.clientY);
      onHoverChangeRef.current?.({ ...NOTHING, button: -1, locked: false, screen: at.screen, dragged: false });
      if (!isLocked()) canvas.style.cursor = restingCursor();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== clickPointerId) return;
      clickPointerId = null;
      releaseClickPointerCapture(event.pointerId);
      rest(event);
      // The last place it moved to, if that has not been said yet, before the release.
      flushMove();

      // A click is a left press that came up where it went down.
      const dragged = isDragging;
      const clicked = !dragged && event.button === 0;
      if (!onPointerUpRef.current && !(clicked && (onClickRef.current || onMissRef.current))) return;
      const at = pointerAt(event.clientX, event.clientY);
      const hit = pick(at.ndcX, at.ndcY);
      const info: Scene3DHit = { ...hit, button: event.button, locked: false, screen: at.screen, dragged };
      onPointerUpRef.current?.(info);
      if (!clicked) return;
      // A click reports what it landed on, as it always has; one that landed
      // on nothing is a miss, which is how a selection is clicked away.
      if (hit.objectId !== '') onClickRef.current?.(info);
      else onMissRef.current?.(info);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== clickPointerId) return;
      clickPointerId = null;
      isDragging = true;
      // A move not yet reported is not reported for a press that was called off.
      moveAt = null;
      if (event.type !== 'lostpointercapture') releaseClickPointerCapture(event.pointerId);
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('pointercancel', handlePointerCancel);
    renderer.domElement.addEventListener('lostpointercapture', handlePointerCancel);
    renderer.domElement.addEventListener('pointerleave', handlePointerLeave);

    const attachedOffset = new THREE.Vector3();
    const attachedRotation = new THREE.Euler();
    const attachedQuat = new THREE.Quaternion();

    const followState = followStateRef.current;

    // A camera that is in a model (`camera.from`): which one the scene looks
    // through in this frame, and what the film's record says of it. One
    // record for the scene's life, written on each frame the view is taken.
    const modelView = modelViewRef.current;
    const lens = {
      aspect: 1,
      fov: undefined as number | undefined,
      near: undefined as number | undefined,
      far: undefined as number | undefined,
      sceneFar: undefined as number | undefined,
    };
    // Where the scene's own camera stood, how it was turned and what it was
    // looking at when a model's view was taken: where it goes back to when
    // the model's view is left and the `camera` prop does not say.
    const stoodAt = {
      held: false,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      lookNow: new THREE.Vector3(),
      lookTarget: new THREE.Vector3(),
      orbiting: false,
      orbitTarget: new THREE.Vector3(),
    };
    /**
     * Stand the scene's camera where the model's camera is, as the model is
     * drawn now: after its clip and its parts have been applied. False while
     * the model has not loaded or has no such camera, and the view is the
     * `camera` prop's as it always was.
     */
    const takeModelView = (cam: SceneCamera, given: Scene3DCamera): boolean => {
      const id = given.from as string;
      let held: { cameras?: ModelCameras } | undefined;
      let model: THREE.Object3D | undefined;
      let info: ModelContents | undefined;
      let animation: AnimationEntry | undefined;
      let spec: Scene3DObject | undefined;
      const top = meshMap.get(id);
      if (top) {
        held = top;
        model = top.model;
        info = top.info;
        animation = animationMap.get(id);
        spec = top.spec;
      } else {
        const child = findNode(id)?.userData[CHILD_MODEL_KEY] as ChildModel | undefined;
        if (child) {
          held = child;
          model = child.model;
          info = child.info;
          animation = child.animation;
          spec = child.spec;
        }
      }
      if (!held || !model) return false;
      const cameras = (held.cameras ??= modelCameras(model));
      const name = typeof given.name === 'string' && given.name !== '' ? given.name : undefined;
      // The film's second is the object's own `time` where it gives one: a
      // film is not held to the length of a clip, nor does it need one.
      const time = spec?.animation?.time;
      if (!chooseModelView(cameras, info?.film, clipSecondsOf(animation), name, modelView as ModelView, typeof time === 'number' ? time : undefined)) return false;
      if (!modelView.on) {
        // The scene's own view, before this one is written over it.
        stoodAt.held = true;
        stoodAt.position.copy(cam.position);
        stoodAt.quaternion.copy(cam.quaternion);
        stoodAt.lookNow.copy(lookNowRef.current);
        stoodAt.lookTarget.copy(lookTargetRef.current);
        const controls = controlsRef.current;
        stoodAt.orbiting = !!controls;
        if (controls) stoodAt.orbitTarget.copy(controls.target);
      }
      const size = viewSizeRef.current;
      lens.aspect = size.height > 0 ? size.width / size.height : 1;
      lens.fov = modelView.fov;
      lens.near = aboveZero(given.near);
      lens.far = aboveZero(given.far);
      // What the scene's far is with no model's camera in force: for a camera whose file gave it none.
      lens.sceneFar = cameraShapeRef.current.far;
      if (!lookThrough(cam, modelView.camera as Lens, lens)) return false;
      modelView.model = model;
      return true;
    };
    /**
     * The view is the scene's own again, at once: the shape the `camera`
     * prop gives it, and where the camera would be had the model's view
     * never been taken. That is where the prop puts it and looking where the
     * prop says, for what the prop gives; and for what it does not, where
     * the camera stood and how it was turned before (its first place, or
     * where the person had orbited it to), not where the model's camera
     * happened to be on its last frame.
     */
    const leaveModelView = (cam: SceneCamera) => {
      const size = viewSizeRef.current;
      shapeCamera(cam, cameraShapeRef.current, size.width, size.height);
      const given = cameraPropRef.current;
      const before = stoodAt.held;
      stoodAt.held = false;
      if (given?.position) cam.position.set(given.position.x, given.position.y, given.position.z);
      else if (before) cam.position.copy(stoodAt.position);
      camTargetRef.current.copy(cam.position);
      const controls = controlsRef.current;
      if (given?.lookAt || !before) {
        const at = given?.lookAt ?? lookAtRef.current;
        lookTargetRef.current.set(at.x, at.y, at.z);
        lookNowRef.current.copy(lookTargetRef.current);
        cam.lookAt(lookNowRef.current);
        controls?.target.copy(lookNowRef.current);
      } else {
        lookTargetRef.current.copy(stoodAt.lookTarget);
        lookNowRef.current.copy(stoodAt.lookNow);
        cam.quaternion.copy(stoodAt.quaternion);
        // Orbit controls turn about what they turned about; ones made since turn about what the view looks at.
        controls?.target.copy(stoodAt.orbiting ? stoodAt.orbitTarget : lookNowRef.current);
      }
      aimingRef.current = false;
    };
    // The renderer's own counters, for the readout; a test's stand-in has none.
    const counters = (renderer as { info?: THREE.WebGLInfo }).info;
    const stats = new StatsMeter();
    let statsOn = false;

    // A camera that was following and no longer is (it was told to stop, or
    // its object has gone) is the `camera` prop's again: back where the prop
    // puts it, eased or at once as any other move is, and for orbit controls
    // turning about what it was looking at.
    const stopFollowing = (cam: SceneCamera) => {
      const controls = controlsRef.current;
      if (controls) {
        controls.target.copy(lookNowRef.current);
        aimingRef.current = false;
        return;
      }
      const given = cameraPropRef.current;
      const smooth = cameraSmoothingRef.current > 0;
      const jump = jumpRef.current;
      if (given?.position) {
        camTargetRef.current.set(given.position.x, given.position.y, given.position.z);
        if (!smooth || (jump > 0 && camTargetRef.current.distanceTo(cam.position) > jump)) {
          cam.position.copy(camTargetRef.current);
        }
      } else {
        camTargetRef.current.copy(cam.position);
      }
      if (given?.lookAt) {
        lookTargetRef.current.set(given.lookAt.x, given.lookAt.y, given.lookAt.z);
        aimingRef.current = true;
        if (!smooth || (jump > 0 && lookTargetRef.current.distanceTo(lookNowRef.current) > jump)) {
          lookNowRef.current.copy(lookTargetRef.current);
        }
      } else {
        aimingRef.current = false;
      }
    };

    // One frame: advance what moves, then draw. Scheduled by the loop below,
    // which runs only while the app is shown.
    const renderFrame = () => {
      const cam = cameraRef.current;
      if (!cam) return;
      const dt = clockRef.current.getDelta();
      const elapsed = clockRef.current.getElapsedTime();
      // Scale rotation by delta time (values are per-frame at 60fps ≈ 0.01667s)
      const dtScale = dt / 0.01667;

      // The first frame since the scene was last not being drawn takes
      // nothing part of the way: whatever changed meanwhile is where it is.
      const resumed = resumedRef.current;
      resumedRef.current = false;
      // What `transition` is taking somewhere goes on its way (motion.ts).
      // From here on a change is eased; while the scene was not being drawn
      // it was written at once.
      easer.live = wantRunningRef.current;
      if (easer.busy) easer.advance(dt * 1000);

      // `animate`: a turn and a bob the scene keeps up by itself, for a
      // top-level object and for a group's child alike.
      const move = (node: THREE.Object3D, anim: NonNullable<Scene3DObject['animate']>, baseY: number) => {
        if (anim.rotateX) node.rotation.x += anim.rotateX * dtScale;
        if (anim.rotateY) node.rotation.y += anim.rotateY * dtScale;
        if (anim.rotateZ) node.rotation.z += anim.rotateZ * dtScale;
        if (anim.floatAmplitude) {
          const speed = anim.floatSpeed ?? 1;
          node.position.y = baseY + Math.sin(elapsed * speed) * anim.floatAmplitude;
        }
      };
      meshMap.forEach((entry) => {
        if (entry.spec.animate) move(entry.mesh, entry.spec.animate, entry.baseY);
        if (entry.animated) {
          for (const node of entry.animated) {
            move(
              node,
              node.userData.__softnAnimate as NonNullable<Scene3DObject['animate']>,
              (node.userData.__softnBaseY as number | undefined) ?? 0
            );
          }
        }
      });

      // Clip mixers take real delta seconds, not the 60fps-normalised dtScale
      animationMap.forEach((entry) => advanceAnimation(entry, dt));
      // A model's named parts are written after its clip and its appearance:
      // where `parts` speaks of a node it has the last word (model-parts.ts).
      const elapsedMs = dt * 1000;
      meshMap.forEach((entry) => {
        if (entry.model) applyModelAppearance(entry.model, entry.spec.appearance, dt);
        if (entry.parts) entry.parts.frame(elapsedMs);
      });
      // The same for the models that are children of groups.
      childModels.forEach((child) => {
        if (child.animation) advanceAnimation(child.animation, dt);
        if (child.model) applyModelAppearance(child.model, child.spec.appearance, dt);
        if (child.parts) child.parts.frame(elapsedMs);
      });

      // A pointer-locked scene's own work for the frame: taking or giving
      // back the pointer when a script asks, and its readout.
      pointerLockFrameRef.current?.();

      const smoothing = cameraSmoothingRef.current;
      const mouseLook = lookModeRef.current.mouseLook;
      const controls = controlsRef.current;
      const jump = jumpRef.current;

      // A camera that follows an object: where it should stand and what it
      // should look at, from where the object is drawn in this frame, which
      // is part of the way to where the last tick put it when the object is
      // being eased. Worked out in the app's logic it moved thirty times a
      // second, and shook against a world drawn at sixty.
      // A camera that is in a model: the view is that camera, taken now that
      // the model's clip and its parts are where this frame has them. Never
      // eased, so a cut is one frame through one camera and the next through
      // another; and nothing else places or turns the camera meanwhile.
      const given = cameraPropRef.current;
      const through = !!given && typeof given.from === 'string' && given.from !== '' && takeModelView(cam, given);
      if (!through && (modelView.camera !== null || modelView.model !== null || modelView.film !== undefined)) {
        // Nothing of a model's is kept once its view is not the scene's: its
        // camera is a node of a copy of the model that may have been given
        // back, and held here it kept the whole copy from being let go.
        modelView.model = null;
        modelView.camera = null;
        modelView.film = undefined;
        modelView.fov = undefined;
        modelView.name = '';
      }
      if (modelView.on !== through) {
        modelView.on = through;
        if (!through) leaveModelView(cam);
      }

      let following = false;
      const follow = cameraPropRef.current?.follow;
      if (!through && follow && typeof follow.target === 'string' && follow.target !== '' && !mouseLook) {
        const node = findNode(follow.target);
        if (node) {
          following = true;
          const moved = followGoal(node, follow, followState, camTargetRef.current, lookTargetRef.current);
          // At once with no smoothing, when the object was put somewhere
          // else, and in the first frame after the scene was not drawn.
          if (!(smoothing > 0) || resumed || (jump > 0 && moved > jump)) {
            cam.position.copy(camTargetRef.current);
            lookNowRef.current.copy(lookTargetRef.current);
          }
          aimingRef.current = true;
        }
      }
      if (!following && followState.held) {
        followState.held = false;
        if (!through) stopFollowing(cam);
      }
      // Orbit controls wait while the camera follows, or is a model's: both cannot place it.
      const led = following || through;
      if (controls && controls.enabled === led) controls.enabled = !led;
      // While the person steers with orbit controls the camera is theirs:
      // it used to be pulled back toward `camera.position` every frame. A
      // turn it was part of the way through is dropped, so the camera stays
      // as they leave it when the controls go.
      const placed = !through && (following || !controls);
      if (!placed) aimingRef.current = false;

      // Ease toward the last position the host gave, frame-rate independent.
      if (smoothing > 0 && placed) {
        if (resumed) {
          cam.position.copy(camTargetRef.current);
        } else {
          cam.position.lerp(camTargetRef.current, 1 - Math.pow(1 - Math.min(0.95, smoothing), dtScale));
        }
      }

      // The view turns to a new `lookAt` as the position moves to a new
      // place: eased, where it used to snap on each tick. Only while either
      // is on its way: the camera is aimed on each frame of a move as well,
      // so it goes on looking at its `lookAt` from every place it passes.
      if (aimingRef.current && placed && !mouseLook) {
        const look = lookNowRef.current;
        const want = lookTargetRef.current;
        if (smoothing > 0 && !resumed) look.lerp(want, 1 - Math.pow(1 - Math.min(0.95, smoothing), dtScale));
        else look.copy(want);
        if (!following && look.distanceToSquared(want) < 1e-10) {
          look.copy(want);
          if (!(smoothing > 0) || cam.position.distanceToSquared(camTargetRef.current) < 1e-14) aimingRef.current = false;
        }
        cam.lookAt(look);
      }

      // Mouse look: apply yaw + pitch to camera every frame (60fps, no React)
      if (mouseLook && !through) {
        const ownsGlobals = isActiveMouseLookOwner(mouseLookOwner);
        const yaw = ownsGlobals ? (sceneWindow.__scene3dYaw ?? yawRef.current) : yawRef.current;
        yawRef.current = yaw;
        const pitch = ownsGlobals
          ? (sceneWindow.__scene3dPitch ?? pitchRef.current)
          : pitchRef.current;
        pitchRef.current = pitch;
        // Where the view looks is on the window for the app's logic to read
        // (`softn.scene.yaw`). Logic that goes takes what it wrote there with
        // it (a newer version of the app handed over in place), and the logic
        // that follows read 0 while the view looked elsewhere, so "forward"
        // was one fixed way until the mouse next moved. Said again here.
        if (ownsGlobals) {
          if (sceneWindow.__scene3dYaw === undefined) sceneWindow.__scene3dYaw = yaw;
          if (sceneWindow.__scene3dPitch === undefined) sceneWindow.__scene3dPitch = pitch;
        }
        const cp = Math.cos(pitch);
        cam.lookAt(
          cam.position.x + Math.sin(yaw) * cp * 5,
          cam.position.y + Math.sin(pitch) * 5,
          cam.position.z + Math.cos(yaw) * cp * 5
        );
      }

      if (controls && !led) {
        const moving = controls.update();
        // Where the person has taken the camera is where it is to be: when
        // the controls go, the easing has nowhere else to take it back to.
        camTargetRef.current.copy(cam.position);
        // The person let go (orbitRestRef): the controls go on gliding for
        // a few frames, and where the camera comes to rest is what the app
        // is told, so it can show the same view another time.
        const rest = orbitRestRef.current;
        if (rest.waiting > 0) {
          if (moving === true && !controls.autoRotate && rest.waiting < 120) {
            rest.waiting += 1;
          } else {
            rest.waiting = 0;
            // A press that moved nothing is a click, not an orbit.
            const turned =
              cam.position.distanceToSquared(rest.from) > 1e-12 ||
              controls.target.distanceToSquared(rest.fromTarget) > 1e-12 ||
              cam.zoom !== rest.fromZoom;
            if (turned) onCameraChangeRef.current?.(describeCamera(cam, controls.target));
          }
        }
      }

      // Camera-attached objects follow the view after it has settled for the
      // frame, so a weapon never trails a turn by a frame.
      lightMap.forEach((light) => {
        const follows: unknown = light.userData.__softnFollow;
        if (followsCamera(follows) && light instanceof THREE.DirectionalLight) {
          followCamera(light, cam, follows === 'view');
          return;
        }
        if (light.userData.__softnAttach !== 'camera') return;
        const off = (light.userData.__softnOffset as THREE.Vector3 | undefined) ?? new THREE.Vector3();
        attachedOffset.copy(off).applyQuaternion(cam.quaternion).add(cam.position);
        light.position.copy(attachedOffset);
        if (light instanceof THREE.SpotLight) {
          // Aim along the view: the target is a point well ahead of the camera.
          attachedOffset.set(0, 0, -30).applyQuaternion(cam.quaternion).add(cam.position);
          light.target.position.copy(attachedOffset);
          light.target.updateMatrixWorld();
        }
      });
      // A sun that is in a model, casting shadows: its box is kept about what the camera sees.
      meshMap.forEach((entry) => {
        if (entry.lights?.follows) entry.lights.aim(cam);
      });
      childModels.forEach((child) => {
        if (child.lights?.follows) child.lights.aim(cam);
      });
      meshMap.forEach((entry) => {
        if (entry.spec.attach !== 'camera') return;
        const off = entry.spec.position ?? { x: 0, y: 0, z: 0 };
        attachedOffset.set(off.x, off.y, off.z).applyQuaternion(cam.quaternion).add(cam.position);
        entry.mesh.position.copy(attachedOffset);
        const rot = entry.spec.rotation;
        attachedRotation.set(rot?.x ?? 0, rot?.y ?? 0, rot?.z ?? 0);
        entry.mesh.quaternion.copy(cam.quaternion).multiply(attachedQuat.setFromEuler(attachedRotation));
      });

      // Page content pinned to places in the scene, put where this frame
      // draws them: one transform written into each that has moved.
      if (anchors.size > 0) {
        const view = viewSizeRef.current;
        anchors.project(cam, view.width, view.height, findNode);
      }

      // The readout, when the app asked for one: the renderer's counters are
      // then cleared here, once a frame, so that they add up over every pass
      // of a frame drawn with effects.
      const wantStats = !!onStatsRef.current;
      if (wantStats !== statsOn) {
        statsOn = wantStats;
        stats.reset();
        if (counters) counters.autoReset = !wantStats;
      }
      if (statsOn) counters?.reset();

      const rig = effectsRigRef.current;
      if (rig) {
        if (rig.grain) rig.grain.uniforms.time.value = (performance.now() % 100000) / 1000;
        rig.render();
      } else {
        renderer.render(scene, cam);
      }
      if (statsOn) {
        const readout = stats.frame(dt, counters?.render);
        if (readout) onStatsRef.current?.(readout);
      }
      if (firstFrameArmedRef.current && !firstFrameFiredRef.current) {
        firstFrameFiredRef.current = true;
        markInstant(MARK_FIRST_FRAME);
        onFirstFrameRef.current?.();
      }
    };

    // The first frame is drawn here, whether or not the app is shown, so
    // "renderer ready" means what it says; the loop then runs only while
    // the app is active and the document visible.
    const loop = new FrameLoop(clockRef.current, renderFrame);
    loopRef.current = loop;
    renderFrame();
    loop.setRunning(wantRunningRef.current);

    if (!readyFiredRef.current) {
      readyFiredRef.current = true;
      markInstant(MARK_RENDERER_READY);
      onReady?.();
    }

    return () => {
      loop.dispose();
      if (loopRef.current === loop) loopRef.current = null;
      if (clickPointerId !== null) {
        const pointerId = clickPointerId;
        clickPointerId = null;
        releaseClickPointerCapture(pointerId);
      }
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('pointercancel', handlePointerCancel);
      renderer.domElement.removeEventListener('lostpointercapture', handlePointerCancel);
      renderer.domElement.removeEventListener('pointerleave', handlePointerLeave);
      if (pointerFrame) cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      hoverAt = null;
      moveAt = null;
      hoverRecheckRef.current = null;
      nodesRef.current = null;
      // Nothing of this scene is on its way anywhere once it has gone.
      easer.finishAll();
      easer.live = false;
      canvas.removeEventListener('contextmenu', swallowContextMenu);
      if (pickRef.current === pick) pickRef.current = null;
      // Mouse look, pointer lock and orbit controls are let go by their own
      // effects, which are cleaned up after this one.
      animationMap.forEach((entry) => stopAnimation(entry));
      animationMap.clear();
      // A group's model children are handed back to the cache as their
      // groups are discarded; that a model which had not arrived is let go
      // here does not make the scene ready.
      standingRef.current = false;
      meshMap.forEach((entry) => discardEntry(scene, entry));
      meshMap.clear();
      // Nor is a camera of one of its models left to look through.
      modelView.on = false;
      modelView.model = null;
      modelView.camera = null;
      modelView.film = undefined;
      // No cloud of this scene is left to draw with them.
      spritesRef.current?.dispose();
      childModels.clear();
      loadVersions.clear();
      lightMap.forEach((light) => {
        scene.remove(light);
        if ('dispose' in light && typeof light.dispose === 'function') light.dispose();
      });
      lightMap.clear();
      // The panorama, and with it the copy three filtered for lighting.
      sceneEnvironment.dispose();
      if (environmentRef.current === sceneEnvironment) environmentRef.current = null;
      renderer.dispose();
      renderer.forceContextLoss();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      skyTextureRef.current?.dispose();
      skyTextureRef.current = null;
      backgroundKeyRef.current = null;
      ownBackgroundRef.current = null;
      // A chain still being fetched must not be installed on a dead renderer.
      effectsVersionRef.current += 1;
      if (effectsRigRef.current) {
        effectsRigRef.current.dispose();
        effectsRigRef.current = null;
      }
      if (rendererRef.current === renderer) rendererRef.current = null;
      if (sceneRef.current === scene) sceneRef.current = null;
      cameraRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The kind of camera, changed while the scene stays: a plan seen square on
  // and a view in perspective are one scene, not two. The new camera stands
  // where the old one stood and faces the way it faced, and whatever held
  // the old one is given the new: the canvas's handle, the effects chain,
  // and the orbit controls, which their own effect makes again for it.
  useEffect(() => {
    const renderer = rendererRef.current;
    const current = cameraRef.current;
    if (!renderer || !current) return;
    if (((current as THREE.OrthographicCamera).isOrthographicCamera === true) === orthographic) return;
    const view = viewSizeRef.current;
    const next = createCamera(orthographic, cameraShapeRef.current, view.width, view.height);
    next.position.copy(current.position);
    next.quaternion.copy(current.quaternion);
    cameraRef.current = next;
    (renderer.domElement as HTMLCanvasElement & { __softnCamera?: THREE.Camera }).__softnCamera = next;
    effectsRigRef.current?.setCamera(next);
  }, [orthographic]);

  // The helper grid, on, off or changed while the scene stays. Its key is
  // its value: a host that mirrors state hands over a new object each tick.
  const gridKey = grid ? JSON.stringify(grid) : '';
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !grid) return undefined;
    const helper = createGridHelper(grid);
    scene.add(helper);
    return () => {
      scene.remove(helper);
      helper.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridKey]);

  // Shadows, as a graphics setting that can be changed. A material is
  // compiled with or without the code that reads a shadow map, so each is
  // asked to compile again when the answer changes.
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!renderer || !scene || renderer.shadowMap.enabled === shadows) return;
    renderer.shadowMap.enabled = shadows;
    if (shadows) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.needsUpdate = true;
    scene.traverse((node) => {
      const held = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const material of Array.isArray(held) ? held : held ? [held] : []) material.needsUpdate = true;
    });
  }, [shadows]);

  // The pixel ratio, the same.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const ratio = pixelRatioFor(maxPixelRatio);
    if (ratio === pixelRatioRef.current) return;
    pixelRatioRef.current = ratio;
    renderer.setPixelRatio(ratio);
    effectsRigRef.current?.setPixelRatio(ratio);
  }, [maxPixelRatio]);

  // OrbitControls is a chunk of its own, taken only by a scene that asks
  // for it. The camera looks where it should from the first frame; the
  // controls adopt that target when they arrive, so their first update
  // does not swing the view to the origin. The loop reads them from the
  // ref, so steering starts the frame after. Turned off, they are disposed
  // and the camera stays where they left it.
  // They are made for one camera: when the kind of camera changes they are
  // made again for the new one, turning about what the old ones turned about.
  useEffect(() => {
    const renderer = rendererRef.current;
    const cam = cameraRef.current;
    // Left by the controls this effect has just disposed, if it has: taken
    // up only by ones made in their place for the other kind of camera.
    const left = orbitLeftRef.current;
    orbitLeftRef.current = null;
    const carried = left && left.orthographic !== orthographic ? left.target : null;
    if (!enableOrbitControls || !renderer || !cam) return undefined;
    // What this turn of the effect made, if its chunk arrived while it was still wanted.
    const mine: { wanted: boolean; controls: OrbitControls | null; keyRoot: Node | null } = { wanted: true, controls: null, keyRoot: null };
    const rest = orbitRestRef.current;
    importOrbitControls()
      .then(({ OrbitControls }) => {
        if (!mine.wanted || rendererRef.current !== renderer) return;
        // Where the controls put their key listener: the canvas's root as it is now (the document).
        mine.keyRoot = renderer.domElement.getRootNode();
        const created = new OrbitControls(cam, renderer.domElement);
        const target = carried ?? lookAtRef.current;
        created.target.set(target.x, target.y, target.z);
        applyOrbitLimits(created, orbitRef.current);
        created.update();
        created.enableDamping = true;
        created.dampingFactor = 0.05;
        created.autoRotate = autoRotateRef.current.autoRotate;
        created.autoRotateSpeed = autoRotateRef.current.autoRotateSpeed;
        // The person takes hold, and lets go: where the camera was when they
        // took hold tells an orbit from a click that moved nothing.
        created.addEventListener('start', () => {
          rest.waiting = 0;
          rest.from.copy(cam.position);
          rest.fromTarget.copy(created.target);
          rest.fromZoom = cam.zoom;
        });
        created.addEventListener('end', () => {
          rest.waiting = 1;
        });
        mine.controls = created;
        controlsRef.current = created;
      })
      .catch((err: unknown) => {
        console.warn('[Scene3D] Orbit controls unavailable:', err);
      });
    return () => {
      mine.wanted = false;
      const created = mine.controls;
      mine.controls = null;
      rest.waiting = 0;
      // What they turned about, for controls made in their place when the kind of camera changes.
      orbitLeftRef.current = created
        ? { target: { x: created.target.x, y: created.target.y, z: created.target.z }, orthographic }
        : null;
      if (!created) return;
      created.dispose();
      // three takes its key listener off the canvas's root as that is when it is asked to,
      // and a scene that is going is asked after its canvas has left the page: the root is
      // then the canvas's own detached box, not the document the listener was put on, and it
      // stayed there for good, holding the camera, the canvas and the scene (a page that
      // swaps between views with an orbit scene in each kept every one it had shown). It is
      // taken off the root it was put on.
      const intercept = (created as unknown as { _interceptControlDown?: EventListener })._interceptControlDown;
      if (typeof intercept === 'function') mine.keyRoot?.removeEventListener('keydown', intercept, { capture: true });
      if (controlsRef.current === created) controlsRef.current = null;
    };
  }, [enableOrbitControls, orthographic]);

  // The limits on them, changed while they stay.
  const orbitKey = orbit ? JSON.stringify(orbit) : '';
  useEffect(() => {
    const controls = controlsRef.current;
    if (controls) applyOrbitLimits(controls, orbitRef.current);
  }, [orbitKey]);

  // What lights the scene by its surroundings (environment.ts): the studio
  // room, or a panorama of the app's own. One effect for the two, so that a
  // scene changing from either to the other is lit throughout: whichever
  // was lighting it stays until the new one is ready, and is then disposed.
  // (The room's cleanup used to clear the scene's lighting at once, and the
  // scene was dark for as long as the panorama took to arrive; and the
  // other way about while the room's chunk was fetched.)
  //
  // The room is generated independently from the model cache; changing
  // intensity does not regenerate it, and unmount releases what it holds.
  // It is a chunk of its own, fetched only by a scene that asks for studio
  // lighting; one no longer wanted when it arrives is not made.
  //
  // A panorama is fetched when its address or its kind changes, and never
  // for the same one handed over again. An address the permission policy
  // withholds is no environment, until it is allowed.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (studio && renderer) {
      environmentRef.current?.showRoom((wanted) =>
        importRoomEnvironment().then(({ RoomEnvironment }) => {
          if (!wanted() || rendererRef.current !== renderer) return null;
          const room = new RoomEnvironment();
          const generator = new THREE.PMREMGenerator(renderer);
          let target: THREE.WebGLRenderTarget;
          try { target = generator.fromScene(room, .04); }
          finally { room.dispose(); generator.dispose(); }
          return { texture: target.texture, dispose: () => target.dispose() };
        })
      );
      return;
    }
    // The largest picture the renderer draws, where it says: a panorama larger than that is refused.
    const most = (renderer as { capabilities?: { maxTextureSize?: unknown } } | null)?.capabilities?.maxTextureSize;
    environmentRef.current?.show(
      environmentUrl && environmentWritten
        ? {
            url: environmentUrl,
            written: environmentWritten,
            format: environmentFormat,
            policy: () => policyRef.current,
            maxTextureSize: typeof most === 'number' && most > 0 ? most : undefined,
          }
        : null
    );
  }, [studio, environmentUrl, environmentWritten, environmentFormat]);

  // How it is shown, written into the scene as it stands: behind everything
  // or not, turned, blurred and how bright. None of these fetches anything.
  // Not behind an orthographic camera: a panorama is a view outward from one
  // point, which a camera without perspective does not have, and three
  // draws it there as a small square in the middle of the picture. The
  // scene's own background stands, and the panorama still lights the scene.
  const { background: environmentBackdrop, rotation: environmentRotation, blur: environmentBlur, backgroundIntensity: environmentBackdropIntensity } = environmentLook;
  useEffect(() => {
    environmentRef.current?.setLook({
      background: environmentBackdrop && !orthographic,
      rotation: environmentRotation,
      blur: environmentBlur,
      backgroundIntensity: environmentBackdropIntensity,
    });
  }, [environmentBackdrop, environmentRotation, environmentBlur, environmentBackdropIntensity, orthographic]);

  // The app went to the background, or came back: stop drawing, or resume
  // with a fresh clock. Every mesh, mixer and load stays exactly as it was,
  // but for what was being eased somewhere: that is put where it was going,
  // and nothing is eased until the scene is drawn again, so an app that
  // comes back does not sweep everything across the view to where it has
  // got to since.
  const wasRunningRef = useRef(wantRunning);
  useEffect(() => {
    if (!wantRunning) {
      easer.finishAll();
      easer.live = false;
      // And the parts of models that were on their way.
      meshMapRef.current.forEach((entry) => entry.parts?.finish());
      childModelsRef.current.forEach((child) => child.parts?.finish());
    } else if (!wasRunningRef.current) {
      resumedRef.current = true;
    }
    wasRunningRef.current = wantRunning;
    loopRef.current?.setRunning(wantRunning);
  }, [wantRunning, easer]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.environmentIntensity = Number.isFinite(environmentIntensity)
      ? Math.max(0, Math.min(4, environmentIntensity)) : .7;
  }, [environmentIntensity, environment]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.toneMapping = toneMapping === 'agx' ? THREE.AgXToneMapping
      : toneMapping === 'linear' ? THREE.LinearToneMapping
      : toneMapping === 'reinhard' ? THREE.ReinhardToneMapping
      : toneMapping === 'cineon' ? THREE.CineonToneMapping
      : toneMapping === 'none' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = Number.isFinite(toneMappingExposure)
      ? Math.max(0, Math.min(8, toneMappingExposure)) : 1;
  }, [toneMapping, toneMappingExposure]);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (document.fullscreenElement !== wrapper) {
      wrapper.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // Listen for fullscreen changes to resize renderer. This scene's own: one
  // that asked whether anything was fullscreen grew to the window with
  // another (a 3D app in a hidden tab, full-screen buffers for nobody).
  useEffect(() => {
    const onFsChange = () => {
      const fs = !!wrapperRef.current && document.fullscreenElement === wrapperRef.current;
      setIsFullscreen(fs);
      const renderer = rendererRef.current;
      const cam = cameraRef.current;
      if (!renderer || !cam) return;
      const w = fs ? window.innerWidth : width;
      const h = fs ? window.innerHeight : height;
      renderer.setSize(w, h);
      effectsRigRef.current?.setSize(w, h);
      viewSizeRef.current = { width: w, height: h };
      shapeCamera(cam, cameraShapeRef.current, w, h);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [width, height]);

  // Update renderer size
  useEffect(() => {
    if (isFullscreen) return; // Don't override fullscreen dimensions
    const renderer = rendererRef.current;
    const cam = cameraRef.current;
    if (!renderer || !cam) return;
    // Until the room the scene has is known to this render (it is measured
    // after the first), the size is what the scene was made at: measured
    // there and then, not the full size this render still believes in.
    const size =
      !fill && roomWidth === null
        ? sizeWithin(widthProp, heightProp, wrapperRef.current?.clientWidth ?? null)
        : { width, height };
    renderer.setSize(size.width, size.height);
    effectsRigRef.current?.setSize(size.width, size.height);
    viewSizeRef.current = { width: size.width, height: size.height };
    shapeCamera(cam, cameraShapeRef.current, size.width, size.height);
    // `width` and `height` are worked out from everything else read here,
    // and a change that leaves them as they were is no new size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, isFullscreen]);

  // Which effects are on decides which passes exist: a change here fetches
  // the post-processing modules (once per page) and rebuilds the chain,
  // disposing every pass of the old one. Until the chain exists the frame
  // goes straight to the canvas; a chain that arrives after a newer request
  // or after unmount is dropped.
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const cam = cameraRef.current;
    if (!renderer || !scene || !cam) return;
    const version = ++effectsVersionRef.current;
    if (effectsShape === '') {
      effectsRigRef.current?.dispose();
      effectsRigRef.current = null;
      return;
    }
    // Depth of field and occlusion are a pass each, fetched only by a chain that has one.
    const wanted = effectsPlanRef.current;
    Promise.all([
      importPostprocessing(),
      wanted?.depthOfField ? importBokehPass() : undefined,
      wanted?.ambientOcclusion ? importGTAOPass() : undefined,
    ])
      .then(([passes, bokeh, gtao]) => {
        if (effectsVersionRef.current !== version || rendererRef.current !== renderer) return;
        const size = new THREE.Vector2();
        renderer.getSize(size);
        effectsRigRef.current?.dispose();
        // The camera there is now: its kind may have changed while the modules were fetched.
        const camera = cameraRef.current ?? cam;
        const mods = { ...passes, BokehPass: bokeh?.BokehPass, GTAOPass: gtao?.GTAOPass };
        effectsRigRef.current = buildEffectsRig(mods, renderer, scene, camera, effectsPlanRef.current, size.x, size.y, {
          // Edges as smooth as the scene was made with: the canvas's own smoothing does not reach a frame drawn through the chain.
          antialias: smoothEdgesRef.current,
          find: (id) => nodesRef.current?.find(id) ?? null,
          // The camera of a model the scene looks through, for `depthOfField: "camera"`.
          view: () => modelViewRef.current,
        });
      })
      .catch((err: unknown) => {
        console.warn('[Scene3D] Post-processing unavailable; rendering plainly:', err);
      });
  }, [effectsShape]);

  // The numbers changed, the passes did not: write them into the chain in
  // place. A chain still being fetched reads the current plan when built.
  useEffect(() => {
    const rig = effectsRigRef.current;
    const plan = effectsPlanRef.current;
    if (rig && plan && rig.shape === effectsShape) rig.retune(plan);
  }, [effectsTune, effectsShape]);

  // Update background. The sky is part of it: this effect set the colour
  // over the sky the scene was made with, so a `sky` showed for one frame,
  // and its texture was never disposed.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const key = backgroundKey(alpha, background, sky);
    if (key === backgroundKeyRef.current) return;
    backgroundKeyRef.current = key;
    skyTextureRef.current?.dispose();
    skyTextureRef.current = paintBackground(scene, alpha, background, sky);
    // A panorama shown behind the scene stays over what was just painted.
    ownBackgroundRef.current = scene.background;
    environmentRef.current?.backgroundPainted();
  }, [background, alpha, sky]);

  // Update fog — compare values to avoid recreating on reference-only changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const fogKey = fog ? JSON.stringify(fog) : '';
    if (fogKey === lastFogRef.current) return;
    lastFogRef.current = fogKey;
    if (fog) {
      scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
    } else {
      scene.fog = null;
    }
  }, [fog]);

  // Update camera — compare actual values, not object reference.
  // When orbit controls are active, only update if values truly changed
  // (avoids resetting camera after every script-driven re-render).
  useEffect(() => {
    const cam = cameraRef.current;
    if (!cam || !cameraProp) return;
    const controls = controlsRef.current;
    const smooth = cameraSmoothingRef.current > 0;
    const jump = jumpRef.current;
    // A camera that follows an object is placed and aimed by the render
    // loop. What the prop says meanwhile is kept for when it stops.
    const following = followStateRef.current.held;
    // Whether this update put the camera somewhere else, and whether it was
    // put there at once or is on its way.
    let moved = false;
    let arrived = false;

    if (cameraProp.position) {
      const posKey = JSON.stringify(cameraProp.position);
      if (posKey !== lastCamPosRef.current) {
        lastCamPosRef.current = posKey;
        if (!following) {
          moved = true;
          camTargetRef.current.set(cameraProp.position.x, cameraProp.position.y, cameraProp.position.z);
          // A jump larger than a few metres is a teleport, not a step: no
          // easing. Nor while orbit controls steer, which the easing would
          // pull against for as long as they did.
          if (!smooth || controls || (jump > 0 && camTargetRef.current.distanceTo(cam.position) > jump)) {
            cam.position.copy(camTargetRef.current);
            arrived = true;
          }
          // Reset orbit controls target when camera moves programmatically
          if (controls && cameraProp.lookAt) {
            controls.target.set(cameraProp.lookAt.x, cameraProp.lookAt.y, cameraProp.lookAt.z);
          }
        }
      }
    }
    // Skip lookAt updates when mouse look owns the camera direction
    if (cameraProp.lookAt && !enableMouseLook) {
      const lookAtKey = JSON.stringify(cameraProp.lookAt);
      if (lookAtKey !== lastCamLookAtRef.current) {
        lastCamLookAtRef.current = lookAtKey;
        lookAtRef.current = cameraProp.lookAt;
        if (following) {
          // The render loop's, until it stops following.
        } else if (controls) {
          controls.target.set(cameraProp.lookAt.x, cameraProp.lookAt.y, cameraProp.lookAt.z);
        } else {
          // How far the point has been moved in this one update: from where the
          // view was last told to look, while it is still turning there, and
          // from where it looks otherwise (as for an object that is eased:
          // motion.ts has why it is not measured from where the view has got to).
          const told = aimingRef.current ? lookTargetRef.current : lookNowRef.current;
          const moved = Math.hypot(cameraProp.lookAt.x - told.x, cameraProp.lookAt.y - told.y, cameraProp.lookAt.z - told.z);
          const want = lookTargetRef.current.set(cameraProp.lookAt.x, cameraProp.lookAt.y, cameraProp.lookAt.z);
          const turn = want.distanceTo(lookNowRef.current);
          if (smooth && turn > 1e-9 && !(jump > 0 && moved > jump)) {
            // With `cameraSmoothing` the view turns there over the next
            // frames, as the position moves: it used to snap on the tick.
            aimingRef.current = true;
          } else {
            aimingRef.current = false;
            lookNowRef.current.copy(want);
            cam.lookAt(want);
          }
        }
      }
    }
    // A camera told where to look goes on looking there from wherever it is
    // put. It was turned only when `lookAt` itself changed: one carried round
    // a fixed point (`position` on a circle, `lookAt` its middle, which is how
    // anyone writes a camera that circles) looked the way it first had, and
    // off into nothing. Not under orbit controls, whose target was set above,
    // nor under mouse look or a follow, which have the direction.
    if (moved && cameraProp.lookAt && !controls && !enableMouseLook) {
      lookTargetRef.current.set(cameraProp.lookAt.x, cameraProp.lookAt.y, cameraProp.lookAt.z);
      if (!smooth) lookNowRef.current.copy(lookTargetRef.current);
      // Now, if the camera is already there; and by the render loop on every
      // frame of its way there, and of its turn if it is part-way through one.
      if (arrived) cam.lookAt(lookNowRef.current);
      aimingRef.current = smooth;
    }

    // The camera's shape: each number that is given and has changed. Near
    // and far were fixed at 0.1 and 1000 whatever was passed.
    const shape = cameraShapeRef.current;
    let reshaped = false;
    if (cameraProp.fov != null && cameraProp.fov !== lastCamFovRef.current) {
      lastCamFovRef.current = cameraProp.fov;
      shape.fov = cameraProp.fov;
      reshaped = true;
    }
    const near = aboveZero(cameraProp.near);
    if (near !== undefined && near !== shape.near) {
      shape.near = near;
      reshaped = true;
    }
    const far = aboveZero(cameraProp.far);
    if (far !== undefined && far !== shape.far) {
      shape.far = far;
      reshaped = true;
    }
    const size = aboveZero(cameraProp.size);
    if (size !== undefined && size !== shape.size) {
      shape.size = size;
      reshaped = true;
      // A size given is the size shown: what the person had zoomed an
      // orthographic camera to with the orbit controls is let go.
      if ((cam as THREE.OrthographicCamera).isOrthographicCamera && cam.zoom !== 1) cam.zoom = 1;
    }
    if (reshaped) {
      const view = viewSizeRef.current;
      shapeCamera(cam, shape, view.width, view.height);
    }
  }, [cameraProp, enableMouseLook]);

  // Mouse look and pointer lock, on and off while the scene stays: one
  // scene can be a plan, an orbit and a walk in turn, where it took three
  // scenes behind `if=` and a new WebGL context for each change of mode.
  // After the camera effect, so the view starts from where this render put
  // the camera.
  const lookContinuesRef = useRef(false);
  useEffect(() => {
    // Set by this effect's own cleanup: mouse look was on a moment ago, so
    // this is pointer lock going on or off under it, not mouse look starting.
    const continues = lookContinuesRef.current;
    lookContinuesRef.current = false;
    const renderer = rendererRef.current;
    const cam = cameraRef.current;
    if (!enableMouseLook || !renderer || !cam) return undefined;
    const canvas = renderer.domElement;
    const sceneWindow = window as Scene3DWindow;
    const mouseLookOwner = mouseLookOwnerRef.current as MouseLookOwner;
    const locking = enablePointerLock;
    const isLocked = () => locking && document.pointerLockElement === canvas;
    // The point the view is aimed at: one vector for the scene's life, written to when mouse look goes.
    const lookNow = lookNowRef.current;

    // The view starts out facing what the camera was last told to look at,
    // from where the camera is now: at mount that is the `camera` prop, as it
    // always was, and after an orbit it is what the orbit turned about. A
    // view that was already being steered is left facing where it faces.
    if (!continues) {
      const facing = cameraPropRef.current?.lookAt ?? lookAtRef.current;
      const dx = facing.x - cam.position.x;
      const dy = facing.y - cam.position.y;
      const dz = facing.z - cam.position.z;
      const hDist = Math.sqrt(dx * dx + dz * dz);
      yawRef.current = Math.atan2(dx, dz);
      pitchRef.current = hDist > 0 ? Math.atan2(dy, hDist) : 0;
    }
    activateMouseLookOwner(sceneWindow, mouseLookOwner);
    lookModeRef.current = { mouseLook: true, pointerLock: locking };

    // Turn the view by a mouse delta, whether it came from a drag or from a
    // captured pointer. Game logic may have written the yaw since the last
    // frame, so the current value is read back before it is moved. The
    // sensitivity and the pitch limit are read as they are now.
    const turnBy = (moveX: number, moveY: number) => {
      const ownsGlobals = isActiveMouseLookOwner(mouseLookOwner);
      let yaw = ownsGlobals ? (sceneWindow.__scene3dYaw ?? yawRef.current) : yawRef.current;
      let pitch = ownsGlobals ? (sceneWindow.__scene3dPitch ?? pitchRef.current) : pitchRef.current;
      yaw -= moveX * mouseLookSensitivityRef.current;
      pitch -= moveY * mouseLookSensitivityRef.current;
      const limit = Math.min(Math.max(pitchLimitRef.current, 0.1), 1.55);
      if (pitch > limit) pitch = limit;
      if (pitch < -limit) pitch = -limit;
      yawRef.current = yaw;
      pitchRef.current = pitch;
      if (ownsGlobals) {
        sceneWindow.__scene3dYaw = yaw;
        sceneWindow.__scene3dPitch = pitch;
      }
    };

    // Pointer lock: the canvas owns the mouse until Escape.
    let plMouseMove: ((e: MouseEvent) => void) | null = null;
    let plLockChange: (() => void) | null = null;
    let plMouseDown: ((e: MouseEvent) => void) | null = null;
    let plKeyDown: ((e: KeyboardEvent) => void) | null = null;
    // Whether the lock in force reports raw device movement.
    let rawInput = false;
    // What the mouse has been delivering, for the F8 readout.
    const look = { moves: 0, movesLastSecond: 0, lastDx: 0, lastDy: 0, since: performance.now(), dropped: 0 };
    let debugEl: HTMLDivElement | null = null;
    const requestLock = () => {
      if (!locking || isLocked()) return;
      // Raw (unadjusted) movement, with the plain request as the fallback.
      // Adjusted movement is unusable in Chromium under a HUD that re-lays
      // out every tick: it fires synthetic mousemove events carrying invented
      // deltas and the view spins on its own. Raw input only ever reports the
      // device. A page may opt out with window.__scene3dRawInput = false.
      const wantRaw = sceneWindow.__scene3dRawInput !== false;
      const request = canvas.requestPointerLock as ((opts?: { unadjustedMovement?: boolean }) => Promise<void> | void) | undefined;
      const plain = () => {
        rawInput = false;
        try {
          canvas.requestPointerLock();
        } catch {
          // Capture is a request, and the browser may refuse it.
        }
      };
      if (!wantRaw) {
        plain();
        return;
      }
      try {
        rawInput = true;
        const result = request?.call(canvas, { unadjustedMovement: true });
        if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(plain);
      } catch {
        plain();
      }
    };

    // Mouse-look: click/touch-and-drag on canvas to rotate camera (yaw + pitch)
    let lookingPointerId: number | null = null;
    let lastMX = 0;
    let lastMY = 0;

    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';

    const mlPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || lookingPointerId !== null) return;
      // With the pointer captured there is nothing to drag: the mouse itself
      // steers. A click while unlocked (re)takes the lock instead.
      if (locking) {
        if (!isLocked() && e.pointerType === 'mouse') requestLock();
        if (isLocked() || e.pointerType === 'mouse') return;
      }
      e.preventDefault();
      lookingPointerId = e.pointerId;
      lastMX = e.clientX;
      lastMY = e.clientY;
      canvas.style.cursor = 'grabbing';
      try {
        canvas.setPointerCapture?.(e.pointerId);
      } catch {
        // Capture is optional and can fail for a pointer that has already ended.
      }
    };

    const mlPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== lookingPointerId) return;
      const moveX = e.clientX - lastMX;
      const moveY = e.clientY - lastMY;
      lastMX = e.clientX;
      lastMY = e.clientY;
      turnBy(moveX, moveY);
    };

    const mlPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== lookingPointerId) return;
      lookingPointerId = null;
      canvas.style.cursor = 'grab';
    };

    canvas.addEventListener('pointerdown', mlPointerDown);
    canvas.addEventListener('pointermove', mlPointerMove);
    canvas.addEventListener('pointerup', mlPointerUp);
    canvas.addEventListener('pointercancel', mlPointerUp);
    canvas.addEventListener('lostpointercapture', mlPointerUp);

    if (locking) {
      canvas.style.cursor = 'crosshair';
      plMouseMove = (e: MouseEvent) => {
        if (!isLocked()) return;
        look.moves++;
        look.lastDx = e.movementX;
        look.lastDy = e.movementY;
        // Only the adjusted-movement fallback invents deltas (see above),
        // and only it needs them screened; raw input's large values are a
        // real flick of the wrist, coalesced into one event, and are kept.
        if (!rawInput && (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400)) {
          look.dropped++;
          return;
        }
        turnBy(e.movementX, e.movementY);
      };
      // F8 shows what the mouse is delivering; F9 switches raw and adjusted
      // input for the next lock. Both are for finding out why a mouse
      // misbehaves on a machine that is not in front of the author.
      plKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'F8') {
          e.preventDefault();
          if (debugEl) {
            debugEl.remove();
            debugEl = null;
          } else {
            debugEl = document.createElement('div');
            debugEl.style.cssText =
              'position:absolute;left:8px;bottom:8px;z-index:20;font:11px/1.5 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.72);padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre';
            wrapperRef.current?.appendChild(debugEl);
          }
        } else if (e.key === 'F9') {
          e.preventDefault();
          sceneWindow.__scene3dRawInput = sceneWindow.__scene3dRawInput === false;
          if (isLocked()) document.exitPointerLock();
        }
      };
      document.addEventListener('keydown', plKeyDown);
      plLockChange = () => {
        const locked = isLocked();
        canvas.style.cursor = locked ? 'none' : 'crosshair';
        if (isActiveMouseLookOwner(mouseLookOwner)) sceneWindow.__scene3dLocked = locked;
      };
      // Every button is a game action while locked; the browser's own drag
      // and context menu have no meaning with the cursor hidden.
      plMouseDown = (e: MouseEvent) => {
        const pick = pickRef.current;
        if (!isLocked() || !onClickRef.current || !pick) return;
        e.preventDefault();
        // What the middle of the view is aimed at, which is where the crosshair is.
        const rect = canvas.getBoundingClientRect();
        onClickRef.current({
          ...pick(0, 0),
          button: e.button,
          locked: true,
          screen: { x: rect.width / 2, y: rect.height / 2 },
          dragged: false,
        });
      };
      document.addEventListener('mousemove', plMouseMove);
      document.addEventListener('pointerlockchange', plLockChange);
      canvas.addEventListener('mousedown', plMouseDown);
      if (isActiveMouseLookOwner(mouseLookOwner)) sceneWindow.__scene3dLocked = false;

      // Each frame: take the pointer when a script asks (inside the click
      // that asked), give it back when one asks for that, and the readout.
      pointerLockFrameRef.current = () => {
        if (sceneWindow.__scene3dWantLock && !isLocked()) {
          sceneWindow.__scene3dWantLock = false;
          requestLock();
        } else if (sceneWindow.__scene3dWantLock && isLocked()) {
          sceneWindow.__scene3dWantLock = false;
        }
        // The opposite request: a script that has just opened a panel the
        // player must click on hands the pointer back. The flag is consumed
        // whether or not a lock was held, so setting it every frame is cheap
        // and harmless.
        if (sceneWindow.__scene3dReleaseLock) {
          sceneWindow.__scene3dReleaseLock = false;
          if (isLocked()) document.exitPointerLock();
        }
        // Whether the pointer is held is said again when it has been taken off
        // the window, as the view's direction is (in the render loop): logic
        // that wrote the name takes it away as it goes, and the logic after it
        // read "not held" with the pointer held, and paused the game.
        if (sceneWindow.__scene3dLocked === undefined && isActiveMouseLookOwner(mouseLookOwner)) sceneWindow.__scene3dLocked = isLocked();
        if (debugEl) {
          const now = performance.now();
          if (now - look.since >= 1000) {
            look.movesLastSecond = look.moves;
            look.moves = 0;
            look.since = now;
          }
          const mode = isLocked() ? (rawInput ? 'raw' : 'adjusted') : 'none';
          debugEl.textContent =
            `lock: ${mode}\nmoves/s: ${look.movesLastSecond}\nlast: ${look.lastDx}, ${look.lastDy}\ndropped: ${look.dropped}\nyaw: ${yawRef.current.toFixed(2)}  pitch: ${pitchRef.current.toFixed(2)}\nF9: ${sceneWindow.__scene3dRawInput === false ? 'adjusted' : 'raw'} next`;
        }
      };
    }

    return () => {
      canvas.removeEventListener('pointerdown', mlPointerDown);
      canvas.removeEventListener('pointermove', mlPointerMove);
      canvas.removeEventListener('pointerup', mlPointerUp);
      canvas.removeEventListener('pointercancel', mlPointerUp);
      canvas.removeEventListener('lostpointercapture', mlPointerUp);
      if (plMouseMove) document.removeEventListener('mousemove', plMouseMove);
      if (plKeyDown) document.removeEventListener('keydown', plKeyDown);
      if (debugEl) debugEl.remove();
      if (plLockChange) document.removeEventListener('pointerlockchange', plLockChange);
      if (plMouseDown) canvas.removeEventListener('mousedown', plMouseDown);
      if (locking) {
        if (document.pointerLockElement === canvas) {
          try {
            document.exitPointerLock();
          } catch {
            // Already released.
          }
        }
        if (isActiveMouseLookOwner(mouseLookOwner)) delete sceneWindow.__scene3dLocked;
      }
      // Clean up window globals used for mouse look communication
      releaseMouseLookOwner(sceneWindow, mouseLookOwner);
      lookModeRef.current = { mouseLook: false, pointerLock: false };
      pointerLockFrameRef.current = null;
      canvas.style.cursor = 'default';
      canvas.style.touchAction = '';
      // The camera is the `camera` prop's again: its `lookAt` is applied
      // afresh by the effect above, which runs when mouse look changes. With
      // `cameraSmoothing` the view turns to it from where it looks now, which
      // is where the mouse left it: the point it was last aimed at is from
      // before mouse look began, and turning from there swung the view away
      // and back, even to a `lookAt` it was already facing.
      lookNow.copy(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(5).add(cam.position));
      aimingRef.current = false;
      lastCamLookAtRef.current = '';
      lookContinuesRef.current = true;
    };
  }, [enableMouseLook, enablePointerLock]);

  // Update orbit controls
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = autoRotateSpeed;
  }, [autoRotate, autoRotateSpeed]);

  // Reconcile objects
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const meshMap = meshMapRef.current;
    const animationMap = animationMapRef.current;
    const required = requiredAssetsRef.current as RequiredAssets;
    const policy = policyRef.current;
    // The scene's `transition`: how long a change to an object that was
    // already there takes, unless the object gives its own.
    const sceneMs = transitionRef.current;
    const sprites = spritesRef.current as ParticleSprites;
    const build: GroupBuild = { policy, models: childModelHostRef.current as ChildModelHost, easer, ms: sceneMs, sprites };
    const currentIds = new Set(safeObjects.map((o) => o.id));

    const reportModel = (id: string, load: ModelLoadState) => {
      onModelStateRef.current?.({ objectId: id, ...load });
    };

    // Take an entry out of the scene: for good, or ahead of its replacement.
    // Either way a required model that had not settled no longer holds the
    // scene's readiness: the load it was waiting on is discarded here, and
    // whatever takes the id — a primitive, a group, another URL, a retry —
    // is a model added later, which readiness does not count.
    const remove = (id: string, entry: MeshEntry) => {
      disposeAnimationEntry(animationMap, id);
      easer.forget(entry.mesh);
      discardEntry(scene, entry);
      meshMap.delete(id);
      loadVersionRef.current.delete(id);
      required.settle(id);
    };

    // Remove meshes no longer in objects
    meshMap.forEach((entry, id) => {
      if (!currentIds.has(id)) remove(id, entry);
    });

    const startLoad = (obj: Scene3DObject, url: string, existing: MeshEntry | undefined) => {
      const bundlePath = policy.assets?.pathOf?.(url);
      const format = obj.modelFormat ?? detectModelFormat(bundlePath ?? url);
      // Filed under its archive path when the model is in the bundle, so
      // the template outlives the object URL the host minted for this open.
      const { key, keepIdle } = modelTemplateAddress(appIdRef.current, url, format, bundlePath);
      // The same URL again is a retry: the cache forgets what it holds for
      // it so the bytes are fetched afresh, and the attempt count goes on.
      const retry =
        !!existing &&
        existing.spec.type === 'model' &&
        existing.spec.modelUrl === url &&
        existing.spec.modelFormat === obj.modelFormat;
      const attempt = retry ? (existing.load?.attempt ?? 0) + 1 : 1;
      if (retry) modelTemplateCache.invalidate(key);
      if (existing) remove(obj.id, existing);

      // Bump load version to invalidate any in-flight load (global counter avoids reset on remove/re-add)
      const version = ++_modelLoadCounter;
      loadVersionRef.current.set(obj.id, version);

      // Create a placeholder group so transform/animation can start immediately
      const placeholder = new THREE.Group();
      tagNode(placeholder, obj);
      applyTransform(placeholder, obj, false);
      scene.add(placeholder);
      const pending: ModelLoadState = { state: 'pending', attempt };
      meshMap.set(obj.id, {
        mesh: placeholder,
        spec: obj,
        baseY: obj.position?.y ?? 0,
        loadVersion: version,
        load: pending,
      });
      reportModel(obj.id, pending);

      const settle = (state: ModelLoadState) => {
        const entry = meshMap.get(obj.id);
        if (entry) entry.load = state;
        reportModel(obj.id, state);
        required.settle(obj.id);
      };

      modelTemplateCache
        .acquire(key, () => loadModelTemplate({ url, format, policy: () => policyRef.current }), {
          keepIdle,
        })
        .then((instance) => {
          // Stale check — if version has changed, discard
          if (loadVersionRef.current.get(obj.id) !== version) {
            instance.release();
            return;
          }
          const loaded = instance.object;
          const { animations, info } = instance;
          // Reconciles during the load update the placeholder entry's spec in
          // place — the capture from load start may be stale
          const spec = meshMap.get(obj.id)?.spec ?? obj;
          // Replace placeholder with loaded model: itself, or the holder
          // that `fit` stands it in.
          scene.remove(placeholder);
          const mesh = seatModel(loaded, info, spec);
          tagNode(mesh, spec);
          applyTransform(mesh, spec, false);
          dressModel(loaded, spec, rendererRef.current);
          scene.add(mesh);
          meshMap.set(obj.id, {
            mesh,
            model: loaded,
            info,
            spec,
            baseY: spec.position?.y ?? 0,
            loadVersion: version,
            instance,
          });
          const animEntry = startModelAnimation(loaded, animations, spec, undefined, (event) =>
            onAnimationRef.current?.(event)
          );
          if (animEntry) animationMap.set(obj.id, animEntry);
          // Its named parts as the object has them by now: put there, not eased there.
          const arrived = meshMap.get(obj.id);
          if (arrived) {
            moveParts(arrived, loaded, instance, spec, 0, () => animationMap.get(obj.id));
            lightModel(arrived, loaded, spec);
          }
          // What is in the model goes with the news that it is there.
          settle({ state: 'loaded', attempt, ...copyContents(info) });
        })
        .catch((err: unknown) => {
          // Removal and unmount deliberately invalidate in-flight loads. A
          // rejection arriving afterwards is expected and must not report a
          // failure for a scene that no longer owns the request.
          if (loadVersionRef.current.get(obj.id) !== version) return;
          console.error(`[Scene3D] Failed to load model "${obj.id}" from ${url}:`, err);
          settle({ state: 'error', attempt, error: err instanceof Error ? err.message : String(err) });
        });
    };

    // Add or update meshes
    for (const obj of safeObjects) {
      const existing = meshMap.get(obj.id);
      // How long a change to this object takes: its own `transition`, or the scene's.
      const ms = transitionOf(obj.transition, sceneMs);

      if (obj.type === 'model' && obj.modelUrl) {
        const url = obj.modelUrl;
        // Model objects — load asynchronously
        const needsLoad =
          !existing ||
          existing.spec.modelUrl !== url ||
          existing.spec.modelFormat !== obj.modelFormat ||
          existing.spec.type !== 'model' ||
          (existing.spec.reload ?? 0) !== (obj.reload ?? 0);
        if (needsLoad) {
          startLoad(obj, url, existing);
        } else if (existing) {
          // Model URL unchanged — just update transform and material overrides
          const model = existing.model;
          if (model && wantsFit(existing.spec.fit) !== wantsFit(obj.fit)) {
            // `fit` given or taken away: the model moves into a holder, or
            // out of one, and is placed afresh. Whatever was easing the node
            // it had lets go of it: the model's own place is the fit's now.
            easer.forget(existing.mesh);
            easer.forget(model);
            scene.remove(existing.mesh);
            existing.mesh = seatModel(model, existing.info, obj);
            tagNode(existing.mesh, obj);
            applyTransform(existing.mesh, obj, false, easer);
            scene.add(existing.mesh);
          } else {
            // In a holder already, and fitted to another size.
            if (model && existing.mesh !== model && existing.spec.fit !== obj.fit) {
              fitModel(model, existing.info, obj.fit);
            }
            tagNode(existing.mesh, obj);
            applyTransform(existing.mesh, obj, true, easer, ms);
          }
          if (needsMaterialUpdate(existing.spec, obj)) {
            applyMaterialOverrides(model ?? existing.mesh, obj, easer, ms);
          }
          // Re-apply only on spec change — see applyAnimationSpec's guard note
          const animEntry = animationMap.get(obj.id);
          if (
            animEntry &&
            JSON.stringify(existing.spec.animation) !== JSON.stringify(obj.animation)
          ) {
            changeAnimation(existing.parts, () =>
              applyAnimationSpec(obj.id, animEntry, obj.animation, (info) => onAnimationRef.current?.(info))
            );
          }
          // Its named parts: a record handed over afresh on every tick is
          // compared part by part, and only what changed is written. Eased
          // only while the scene is being drawn, as everything else is.
          if (model && existing.spec.parts !== obj.parts) {
            moveParts(existing, model, existing.instance, obj, easer.live ? ms : 0, () => animationMap.get(obj.id));
          }
          if (model && existing.spec.lights !== obj.lights) lightModel(existing, model, obj);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (obj.type === 'model') {
        // A model with no file to load: none named, or one the permission
        // policy withheld. Nothing is drawn for it, and its node stays until
        // it names a file. It used to be drawn as a one-unit box, made anew
        // (geometry, material and all) on every reconcile.
        if (existing && existing.spec.type === 'model' && !existing.spec.modelUrl) {
          tagNode(existing.mesh, obj);
          applyTransform(existing.mesh, obj, true, easer, ms);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        } else {
          if (existing) remove(obj.id, existing);
          const empty = createEmptyModel();
          tagNode(empty, obj);
          applyTransform(empty, obj, false, easer);
          scene.add(empty);
          meshMap.set(obj.id, { mesh: empty, spec: obj, baseY: obj.position?.y ?? 0 });
        }
      } else if (obj.type === 'instanced') {
        // One mesh for many copies. A change of count, shape or texture
        // rebuilds it; a new placement array only rewrites the instance
        // buffers, and a change of colour or finish is written into the
        // material it has.
        const rebuild =
          !existing ||
          existing.spec.type !== 'instanced' ||
          needsGeometryUpdate(existing.spec, obj) ||
          needsMaterialRebuild(existing.spec, obj) ||
          instanceCount(existing.spec) !== instanceCount(obj);
        if (rebuild) {
          if (existing) remove(obj.id, existing);
          const mesh = createInstanced(obj, policy);
          tagNode(mesh, obj);
          applyTransform(mesh, obj, false, easer);
          scene.add(mesh);
          meshMap.set(obj.id, { mesh, spec: obj, baseY: obj.position?.y ?? 0 });
        } else if (existing) {
          // The batch as a whole is eased; where each copy stands is not.
          updateInstanced(existing.mesh as THREE.InstancedMesh, existing.spec, obj, easer, ms);
          tagNode(existing.mesh, obj);
          applyTransform(existing.mesh, obj, true, easer, ms);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (obj.type === 'group') {
        // A group's `transition` is its children's, unless a child gives its own.
        const within = ms === sceneMs ? build : { ...build, ms };
        if (!existing || existing.spec.type !== 'group') {
          if (existing) remove(obj.id, existing);
          const group = createGroup(obj, within);
          applyTransform(group, obj, false, easer);
          scene.add(group);
          meshMap.set(obj.id, {
            mesh: group,
            spec: obj,
            baseY: obj.position?.y ?? 0,
            animated: animatedChildren(group),
          });
        } else {
          // The children are reconciled by id; the group itself is patched.
          if (existing.spec.children !== obj.children) {
            reconcileGroupChildren(
              existing.mesh as THREE.Group,
              existing.spec.children,
              obj.children,
              obj.id,
              within
            );
            existing.animated = animatedChildren(existing.mesh);
          }
          tagNode(existing.mesh, obj);
          applyTransform(existing.mesh, obj, true, easer, ms);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (obj.type === 'particles') {
        if (!existing || existing.spec.type !== 'particles') {
          if (existing) remove(obj.id, existing);
          const points = createParticles(obj, sprites);
          tagNode(points, obj);
          applyTransform(points, obj, false, easer);
          scene.add(points);
          meshMap.set(obj.id, { mesh: points, spec: obj, baseY: obj.position?.y ?? 0 });
        } else {
          // Its colour, size, opacity and fog are written into the material
          // it has; a new colour or size used to make the whole cloud anew.
          const points = existing.mesh as THREE.Points;
          if (particleLookChanged(existing.spec, obj)) {
            writeParticleMaterialEased(points.material as THREE.PointsMaterial, obj, easer, ms, sprites);
          }
          updateParticles(points, obj);
          tagNode(points, obj);
          applyTransform(existing.mesh, obj, true, easer, ms);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (!existing) {
        // Primitive objects — create synchronously
        const geometry = createGeometry(obj);
        const material = createMaterial(obj, policy);
        const mesh = new THREE.Mesh(geometry, material);
        tagNode(mesh, obj);
        applyTransform(mesh, obj, false, easer);
        scene.add(mesh);
        meshMap.set(obj.id, { mesh, spec: obj, baseY: obj.position?.y ?? 0 });
      } else {
        // Primitive update
        if (existing.spec.type === 'model' || existing.spec.type === 'instanced' || existing.spec.type === 'group' || existing.spec.type === 'particles') {
          // Switching from a model/batch/group/particles to a primitive — remove the old mesh
          remove(obj.id, existing);
          const geometry = createGeometry(obj);
          const material = createMaterial(obj, policy);
          const mesh = new THREE.Mesh(geometry, material);
          tagNode(mesh, obj);
          applyTransform(mesh, obj, false, easer);
          scene.add(mesh);
          meshMap.set(obj.id, { mesh, spec: obj, baseY: obj.position?.y ?? 0 });
        } else {
          const existingMesh = existing.mesh as THREE.Mesh;
          if (needsGeometryUpdate(existing.spec, obj)) {
            existingMesh.geometry.dispose();
            existingMesh.geometry = createGeometry(obj);
          }
          updateMeshMaterial(existingMesh, existing.spec, obj, policy, easer, ms);
          tagNode(existingMesh, obj);
          applyTransform(existing.mesh, obj, true, easer, ms);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      }
    }

    // What was found by id before is looked for afresh; and a pointer at
    // rest over something that has just left the scene is looked under again.
    nodesRef.current?.changed();
    hoverRecheckRef.current?.();

    // The scene's first reconcile names the models it opened with; readiness
    // waits for those and no others.
    if (!required.hasBegun) {
      const loading: string[] = [];
      meshMap.forEach((entry, id) => {
        if (entry.load?.state === 'pending') loading.push(id);
      });
      // A model in a group is one of them as much as a top-level one.
      childModelsRef.current.forEach((child) => {
        if (child.load.state === 'pending') loading.push(child.readinessKey);
      });
      // And so is the panorama the scene is lit by, if it opened with one.
      if (environmentRef.current?.loading) loading.push(ENVIRONMENT_ASSET);
      required.begin(loading);
    }
  }, [safeObjects, easer]);

  // Reconcile lights — incremental to avoid flicker from remove-all/re-add
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const lightMap = lightMapRef.current;
    const currentIds = new Set(safeLights.map((s, i) => s.id || `light-${i}`));

    // Remove lights no longer present
    lightMap.forEach((light, id) => {
      if (!currentIds.has(id)) {
        scene.remove(light);
        if ('dispose' in light && typeof light.dispose === 'function') light.dispose();
        lightMap.delete(id);
      }
    });

    // Add or update lights
    safeLights.forEach((spec, i) => {
      const id = spec.id || `light-${i}`;
      const existing = lightMap.get(id);
      if (existing) {
        // Detect type change — must recreate the light object
        const existingType = existing.userData.__softnLightType as Scene3DLight['type'] | undefined;
        if (existingType && existingType !== spec.type) {
          scene.remove(existing);
          if ('dispose' in existing && typeof existing.dispose === 'function') existing.dispose();
          const light = createLight(spec);
          tagLight(light, spec);
          scene.add(light);
          lightMap.set(id, light);
        } else {
          // Update in-place — position, intensity, color, groundColor
          tagLight(existing, spec);
          // Whether it casts shadows, and the map a directional light casts
          // them into, as they are now: not as they were when it was made.
          if (
            existing instanceof THREE.DirectionalLight ||
            existing instanceof THREE.PointLight ||
            existing instanceof THREE.SpotLight
          ) {
            writeLightShadow(existing, spec);
          }
          if (existing instanceof THREE.SpotLight) {
            if (spec.angle != null) existing.angle = spec.angle;
            if (spec.penumbra != null) existing.penumbra = spec.penumbra;
            if (spec.distance != null) existing.distance = spec.distance;
            if (spec.decay != null) existing.decay = spec.decay;
          } else if (existing instanceof THREE.PointLight) {
            if (spec.distance != null) existing.distance = spec.distance;
            if (spec.decay != null) existing.decay = spec.decay;
          }
          // A light the render loop carries (attached to the camera, or
          // following it) is placed there, each frame.
          if (spec.position && 'position' in existing && !isCarried(spec)) {
            (existing as THREE.PointLight).position.set(
              spec.position.x,
              spec.position.y,
              spec.position.z
            );
          }
          if (spec.intensity != null) existing.intensity = spec.intensity;
          if (spec.color) existing.color.set(spec.color);
          if (spec.groundColor && existing instanceof THREE.HemisphereLight) {
            existing.groundColor.set(spec.groundColor);
          }
        }
      } else {
        const light = createLight(spec);
        tagLight(light, spec);
        scene.add(light);
        lightMap.set(id, light);
      }
    });
  }, [safeLights]);

  // The box the scene stands in. On its own it is `width` by `height`, as it
  // always was, wherever there is room for it; where there is not, it is as
  // wide as the room and as tall as keeps its shape (`fitted`, worked out
  // from the width it was given, above), with the canvas inside the same
  // size. The height is always a number of pixels. Left to the browser to
  // work out from the width (`height: auto` with an `aspect-ratio`), a scene
  // beside something taller in a row was stretched to that height round an
  // unstretched canvas, and one whose page gave it `width: 100%` grew as
  // tall as that width's share, where it had been `height` tall. A `style` of
  // the page's own still has the last word, so `maxWidth: 'none'` is a scene
  // that runs past its container as it used to.
  const box: React.CSSProperties = isFullscreen
    ? { width: '100vw', height: '100vh' }
    : fill
      ? { width: '100%', height: '100%' }
      : isShape(widthProp, heightProp)
        ? { width: widthProp, maxWidth: '100%', height: fitted.height }
        : { width: widthProp, height: heightProp };

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{
        position: 'relative',
        ...box,
        overflow: 'hidden',
        ...(isFullscreen ? { background: '#000' } : style),
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {/* Page content pinned to places in the scene (`<SceneAnchor>`), laid
          over the canvas and moved by the render loop. The layer itself is
          not seen and takes no pointer: each anchor shows itself once the
          scene has put it somewhere, so anything else written inside a
          `<Scene3D>` stays unseen, as it always was. */}
      {children != null && children !== false && !noWebGL && (
        <SceneAnchorContext.Provider value={anchorsRef.current}>
          <div
            data-scene-anchors=""
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
              pointerEvents: 'none',
              visibility: 'hidden',
              zIndex: 2,
            }}
          >
            {children}
          </div>
        </SceneAnchorContext.Provider>
      )}
      {noWebGL && (
        <div
          role="note"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            boxSizing: 'border-box',
            textAlign: 'center',
            fontSize: '0.875rem',
            lineHeight: 1.4,
            color: 'var(--color-text-muted, inherit)',
            background: 'var(--color-surface, transparent)',
          }}
        >
          This 3D view needs WebGL, which this browser has not made available.
        </div>
      )}
      {crosshair && !noWebGL && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: 14,
            height: 14,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 5,
          }}
        >
          <div style={{ position: 'absolute', width: 2, height: 10, background: 'rgba(255,255,255,0.7)', borderRadius: 1 }} />
          <div style={{ position: 'absolute', width: 10, height: 2, background: 'rgba(255,255,255,0.7)', borderRadius: 1 }} />
        </div>
      )}
      {expandable && (
        <button
          onClick={toggleFullscreen}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 32,
            height: 32,
            background: 'rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 6,
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            padding: 0,
            zIndex: 10,
          }}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? '\u2716' : '\u26F6'}
        </button>
      )}
    </div>
  );
}
