import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { isSafeUrl } from '@softn/core';

type Scene3DWindow = Window & {
  __scene3dYaw?: number;
  __scene3dPitch?: number;
  /** True while a `pointerLock` scene owns the mouse; a game reads it to pause. */
  __scene3dLocked?: boolean;
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

export type ModelFormat = 'gltf' | 'obj' | 'fbx' | 'stl';

export type Scene3DShape =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'plane'
  | 'torus'
  | 'cone'
  | 'ring'
  | 'dodecahedron'
  | 'icosahedron'
  | 'octahedron';

export interface Scene3DObject {
  id: string;
  type: Scene3DShape | 'model' | 'instanced';
  modelUrl?: string;
  modelFormat?: ModelFormat;
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
   * `'camera'` pins the object to the camera: `position` becomes an offset in
   * camera space (x right, y up, z forward is negative) and `rotation` a local
   * turn — a first-person weapon, a held block, a helmet edge. It is moved by
   * the render loop every frame, so it never lags the view, and it is left out
   * of the centre-ray picking a pointer-locked scene reports.
   */
  attach?: 'camera';
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number } | number;
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  /** Torus tube thickness. Defaults to 40% of `radius` so small rings stay rings. */
  tube?: number;
  animate?: {
    rotateX?: number;
    rotateY?: number;
    rotateZ?: number;
    floatAmplitude?: number;
    floatSpeed?: number;
  };
  animation?: {
    clip?: string;
    playing?: boolean;
    loop?: 'once' | 'repeat';
    speed?: number;
    crossFadeMs?: number;
    clampWhenFinished?: boolean;
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
  button: number;
  locked: boolean;
  instanceId: number | null;
  distance: number | null;
  point: { x: number; y: number; z: number } | null;
  normal: { x: number; y: number; z: number } | null;
}

export interface Scene3DLight {
  id?: string;
  type: 'ambient' | 'directional' | 'point' | 'spot' | 'hemisphere';
  color?: string;
  groundColor?: string;
  intensity?: number;
  position?: { x: number; y: number; z: number };
  castShadow?: boolean;
  /** Spot cone half-angle in radians (default 0.5), and how soft its edge is, 0..1. */
  angle?: number;
  penumbra?: number;
  /** Point and spot: how far the light reaches (0 = no limit) and how fast it falls off. */
  distance?: number;
  decay?: number;
  /**
   * `'camera'` carries the light with the view: `position` is an offset in
   * camera space, and a spot light points where the camera points — a torch
   * in the player's hand, a miner's lamp on a helmet.
   */
  attach?: 'camera';
}

export interface Scene3DProps {
  width?: number;
  height?: number;
  /**
   * Size the canvas to whatever box it sits in, instead of `width`/`height`,
   * and follow that box as it changes — a game that wants the whole viewport
   * puts the scene in a fixed, inset-0 container and says `fill`.
   */
  fill?: boolean;
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
  lights?: Scene3DLight[];
  camera?: {
    position?: { x: number; y: number; z: number };
    lookAt?: { x: number; y: number; z: number };
    fov?: number;
  };
  background?: string;
  alpha?: boolean;
  antialias?: boolean;
  shadows?: boolean;
  fog?: { color: string; near: number; far: number };
  orbitControls?: boolean;
  autoRotate?: boolean;
  autoRotateSpeed?: number;
  expandable?: boolean;
  mouseLook?: boolean;
  mouseLookSensitivity?: number;
  /**
   * First-person mouse capture. A click on the canvas locks the pointer (the
   * browser's Escape releases it); while locked, moving the mouse turns the
   * camera and every button press is reported through `onClick` with what the
   * centre of the screen is pointing at. Implies `mouseLook`.
   */
  pointerLock?: boolean;
  /** How far the view may tilt, in radians (default 0.8 — about 45°). */
  pitchLimit?: number;
  /**
   * Ease the camera toward each new `camera.position` instead of jumping to
   * it, 0..1 per frame (0 = off). A game that moves its player thirty times
   * a second reads as sixty when the render loop closes the gap between
   * ticks; 0.35 keeps under a frame of lag.
   */
  cameraSmoothing?: number;
  /**
   * The most device pixels drawn per CSS pixel (default 2). A full-viewport
   * game on a high-density screen pays four times the fill rate at 2; 1 or
   * 1.25 keeps it fast with little visible cost.
   */
  maxPixelRatio?: number;
  onReady?: () => void;
  onClick?: (info: Scene3DHit) => void;
  onAnimation?: (info: { objectId: string; clip: string; type: 'finished' | 'missing' }) => void;
  style?: React.CSSProperties;
  className?: string;
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

function createMaterial(obj: Scene3DObject): THREE.MeshStandardMaterial {
  const opacity = obj.opacity ?? 1;
  // Instance colours multiply the material's, so a palette needs a white base.
  const usesPalette = obj.type === 'instanced' && Array.isArray(obj.palette) && obj.palette.length > 0;
  return new THREE.MeshStandardMaterial({
    color: usesPalette ? '#ffffff' : obj.color || '#6366f1',
    metalness: obj.metalness ?? 0.1,
    roughness: obj.roughness ?? 0.5,
    wireframe: obj.wireframe ?? false,
    opacity,
    transparent: opacity < 1,
    ...(obj.emissive ? { emissive: new THREE.Color(obj.emissive) } : {}),
    ...(obj.emissiveIntensity != null ? { emissiveIntensity: obj.emissiveIntensity } : {}),
  });
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
  const m = new THREE.Matrix4();
  const fallback = new THREE.Color(obj.color || '#6366f1');
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    m.makeTranslation(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0);
    mesh.setMatrixAt(i, m);
    if (palette) {
      const idx = data[o + 3] | 0;
      mesh.setColorAt(i, palette[idx] ?? fallback);
    }
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Without this the mesh is culled by its geometry's own bounds at the origin.
  mesh.computeBoundingSphere();
}

function createInstanced(obj: Scene3DObject): THREE.InstancedMesh {
  const count = Math.max(1, instanceCount(obj));
  const mesh = new THREE.InstancedMesh(createGeometry(obj), createMaterial(obj), count);
  mesh.frustumCulled = true;
  fillInstances(mesh, obj);
  return mesh;
}

// Detect model format from URL extension
function detectModelFormat(url: string): ModelFormat {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.glb') || clean.endsWith('.gltf')) return 'gltf';
  if (clean.endsWith('.obj')) return 'obj';
  if (clean.endsWith('.fbx')) return 'fbx';
  if (clean.endsWith('.stl')) return 'stl';
  return 'gltf'; // default
}

// Load a 3D model from URL, returns the root Object3D plus any animation clips
// (glTF carries them beside the scene, FBX on the group; OBJ/STL have none)
function loadModel(
  url: string,
  format?: ModelFormat
): Promise<{ object: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  // A scene names its own models, so this URL is bundle-supplied and gets the
  // same scheme check as every other source a bundle points at. The caller
  // already catches, and leaves the placeholder group in the scene.
  if (!isSafeUrl(url)) {
    return Promise.reject(new Error(`Unsafe model URL: ${url}`));
  }
  const fmt = format || detectModelFormat(url);
  return new Promise((resolve, reject) => {
    switch (fmt) {
      case 'gltf': {
        const loader = new GLTFLoader();
        loader.load(
          url,
          (gltf) => resolve({ object: gltf.scene, animations: gltf.animations ?? [] }),
          undefined,
          reject
        );
        break;
      }
      case 'obj': {
        const loader = new OBJLoader();
        loader.load(url, (group) => resolve({ object: group, animations: [] }), undefined, reject);
        break;
      }
      case 'fbx': {
        const loader = new FBXLoader();
        loader.load(
          url,
          (group) => resolve({ object: group, animations: group.animations ?? [] }),
          undefined,
          reject
        );
        break;
      }
      case 'stl': {
        const loader = new STLLoader();
        loader.load(
          url,
          (geometry) => {
            const material = new THREE.MeshStandardMaterial({ color: '#6366f1' });
            const mesh = new THREE.Mesh(geometry, material);
            resolve({ object: mesh, animations: [] });
          },
          undefined,
          reject
        );
        break;
      }
      default:
        reject(new Error(`Unsupported model format: ${fmt}`));
    }
  });
}

// Apply material overrides to all meshes in an Object3D hierarchy.
// Uses duck-typed property checks so it works with Standard, Phong, Lambert, and Basic materials.
function applyMaterialOverrides(root: THREE.Object3D, obj: Scene3DObject) {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      // Cast for property access; guard each with 'in' check for safety
      const m = mat as THREE.MeshStandardMaterial;
      if (obj.color && m.color) m.color.set(obj.color);
      if (obj.wireframe != null && 'wireframe' in mat) m.wireframe = obj.wireframe;
      if (obj.opacity != null) {
        mat.opacity = obj.opacity;
        mat.transparent = obj.opacity < 1;
      }
      if (obj.metalness != null && 'metalness' in mat) m.metalness = obj.metalness;
      if (obj.roughness != null && 'roughness' in mat) m.roughness = obj.roughness;
      if (obj.emissive && m.emissive) m.emissive.set(obj.emissive);
      if (obj.emissiveIntensity != null && 'emissiveIntensity' in mat)
        m.emissiveIntensity = obj.emissiveIntensity;
    }
  });
}

// Dispose all geometries, materials, and textures in an Object3D hierarchy
function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        // Dispose all texture properties to free GPU memory
        const m = mat as THREE.MeshStandardMaterial;
        m.map?.dispose();
        m.normalMap?.dispose();
        m.roughnessMap?.dispose();
        m.metalnessMap?.dispose();
        m.emissiveMap?.dispose();
        m.aoMap?.dispose();
        m.alphaMap?.dispose();
        m.envMap?.dispose();
        mat.dispose();
      }
    }
  });
}

// Apply transform but preserve animated axes to avoid snapping
function applyTransform(mesh: THREE.Object3D, obj: Scene3DObject, isUpdate: boolean) {
  const anim = obj.animate;

  // A camera-attached object is placed by the render loop from its offset;
  // its own position and rotation fields are read there, not here.
  if (obj.position && obj.attach !== 'camera') {
    mesh.position.x = obj.position.x;
    // Skip Y if float animation is active on update — animation loop owns position.y
    if (!isUpdate || !anim?.floatAmplitude) {
      mesh.position.y = obj.position.y;
    }
    mesh.position.z = obj.position.z;
  }

  if (obj.rotation && obj.attach !== 'camera') {
    // On update, skip axes owned by rotation animation to avoid snapping
    if (!isUpdate || !anim?.rotateX) mesh.rotation.x = obj.rotation.x;
    if (!isUpdate || !anim?.rotateY) mesh.rotation.y = obj.rotation.y;
    if (!isUpdate || !anim?.rotateZ) mesh.rotation.z = obj.rotation.z;
  }

  if (obj.scale != null) {
    if (typeof obj.scale === 'number') {
      mesh.scale.setScalar(obj.scale);
    } else {
      mesh.scale.set(obj.scale.x, obj.scale.y, obj.scale.z);
    }
  }
  // A camera-attached object is drawn last and without a depth test, so a
  // weapon held against a wall stays in front of the wall.
  if (obj.attach === 'camera') {
    mesh.renderOrder = 1000;
    mesh.traverse((child) => {
      const m = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const mats = Array.isArray(m) ? m : m ? [m] : [];
      for (const mat of mats) {
        mat.depthTest = false;
        mat.depthWrite = false;
      }
    });
  }
  const castShadow = obj.castShadow ?? false;
  const receiveShadow = obj.receiveShadow ?? false;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  // For models (groups), propagate shadow settings to children
  mesh.traverse((child) => {
    child.castShadow = castShadow;
    child.receiveShadow = receiveShadow;
  });
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

function needsMaterialUpdate(prev: Scene3DObject, next: Scene3DObject): boolean {
  return (
    prev.color !== next.color ||
    (prev.palette?.length ?? 0) !== (next.palette?.length ?? 0) ||
    prev.metalness !== next.metalness ||
    prev.roughness !== next.roughness ||
    prev.wireframe !== next.wireframe ||
    prev.opacity !== next.opacity ||
    prev.emissive !== next.emissive ||
    prev.emissiveIntensity !== next.emissiveIntensity
  );
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
      if (spec.castShadow) {
        light.castShadow = true;
        light.shadow.mapSize.width = 1024;
        light.shadow.mapSize.height = 1024;
      }
      return light;
    }
    case 'point': {
      const light = new THREE.PointLight(color, intensity, spec.distance ?? 0, spec.decay ?? 2);
      if (spec.position) light.position.set(spec.position.x, spec.position.y, spec.position.z);
      if (spec.castShadow) light.castShadow = true;
      return light;
    }
    case 'spot': {
      const light = new THREE.SpotLight(color, intensity, spec.distance ?? 0, spec.angle ?? 0.5, spec.penumbra ?? 0.3, spec.decay ?? 2);
      if (spec.position) light.position.set(spec.position.x, spec.position.y, spec.position.z);
      if (spec.castShadow) light.castShadow = true;
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
  light.userData.__softnLightType = spec.type;
  light.userData.__softnAttach = spec.attach;
  light.userData.__softnOffset = new THREE.Vector3(spec.position?.x ?? 0, spec.position?.y ?? 0, spec.position?.z ?? 0);
}

interface MeshEntry {
  mesh: THREE.Object3D;
  spec: Scene3DObject;
  baseY: number;
  loadVersion?: number; // tracks in-flight model loads to cancel stale ones
}

interface AnimationEntry {
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  actions: Map<string, THREE.AnimationAction>;
  currentClip: string | null;
  warnedMissing: Set<string>; // 'missing' fires once per requested clip name
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
    }
    return;
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
  if (entry.currentClip !== clipName) {
    const prev = entry.currentClip ? entry.actions.get(entry.currentClip) : undefined;
    action.reset().play();
    if (prev && prev !== action) {
      prev.crossFadeTo(action, (spec.crossFadeMs ?? DEFAULT_CROSSFADE_MS) / 1000, false);
    }
    entry.currentClip = clipName;
  } else if (
    spec.playing !== false &&
    spec.loop === 'once' &&
    !action.isRunning() &&
    action.time >= clip.duration
  ) {
    // Resuming a finished one-shot must replay it — un-pausing the clamped end
    // state alone would re-fire 'finished' every frame
    action.reset().play();
  }
  action.paused = spec.playing === false;
}

// Freeing the mixer alone leaks property bindings — stop actions and uncache
// the root before dropping the entry
function disposeAnimationEntry(map: Map<string, AnimationEntry>, id: string) {
  const entry = map.get(id);
  if (!entry) return;
  entry.mixer.stopAllAction();
  entry.mixer.uncacheRoot(entry.mixer.getRoot());
  map.delete(id);
}

// Drag detection threshold (pixels)
const DRAG_THRESHOLD = 4;

// Global monotonic counter for model load versioning (prevents stale loads after remove/re-add)
let _modelLoadCounter = 0;

export function Scene3D({
  width: widthProp = 800,
  height: heightProp = 600,
  fill = false,
  objects = [],
  staticObjects,
  lights = [],
  camera: cameraProp,
  background = '#1a1a2e',
  alpha = false,
  antialias = true,
  shadows = false,
  fog,
  orbitControls: _enableOrbitControls = false,
  autoRotate = false,
  autoRotateSpeed = 2,
  expandable = false,
  mouseLook: mouseLookProp = false,
  mouseLookSensitivity = 0.003,
  pointerLock: enablePointerLock = false,
  pitchLimit = 0.8,
  cameraSmoothing = 0,
  maxPixelRatio = 2,
  onReady,
  onClick,
  onAnimation,
  style,
  className,
}: Scene3DProps) {
  const safeObjects = useMemo<Scene3DObject[]>(() => {
    const usable = (arr: Scene3DObject[] | undefined) =>
      Array.isArray(arr)
        ? arr.filter(
            (obj): obj is Scene3DObject => !!obj && typeof obj.id === 'string' && obj.id.length > 0
          )
        : [];
    const dynamic = usable(objects);
    const fixed = usable(staticObjects);
    // Statics first, so ids stay in the order the scene declared them and a
    // dynamic object with a clashing id still wins the later reconcile pass.
    return fixed.length === 0 ? dynamic : fixed.concat(dynamic);
  }, [objects, staticObjects]);
  const safeLights = useMemo<Scene3DLight[]>(
    () =>
      Array.isArray(lights)
        ? lights.filter((light): light is Scene3DLight => !!light && typeof light.type === 'string')
        : [],
    [lights]
  );

  // Pointer lock is mouse look with the cursor captured; either wins over
  // orbit controls, which cannot coexist with a steered camera.
  const enableMouseLook = mouseLookProp || enablePointerLock;
  const enableOrbitControls = _enableOrbitControls && !enableMouseLook;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // With `fill`, the box the scene sits in is the size; measured, not declared.
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!fill) return undefined;
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => {
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      setMeasured((m) => (m && m.w === w && m.h === h ? m : { w, h }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);
  const width = fill ? (measured?.w ?? widthProp) : widthProp;
  const height = fill ? (measured?.h ?? heightProp) : heightProp;
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshMapRef = useRef<Map<string, MeshEntry>>(new Map());
  const loadVersionRef = useRef<Map<string, number>>(new Map());
  const animationMapRef = useRef<Map<string, AnimationEntry>>(new Map());
  const lightMapRef = useRef<Map<string, THREE.Light>>(new Map());
  const animFrameRef = useRef<number>(0);
  const clockRef = useRef<THREE.Clock>(new THREE.Clock());
  const readyFiredRef = useRef(false);
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const onAnimationRef = useRef(onAnimation);
  onAnimationRef.current = onAnimation;
  const yawRef = useRef<number>(0);
  const pitchRef = useRef<number>(0);
  const camTargetRef = useRef<THREE.Vector3>(new THREE.Vector3());
  const cameraSmoothingRef = useRef(cameraSmoothing);
  cameraSmoothingRef.current = cameraSmoothing;

  // Track last prop values to avoid resetting on reference-only changes
  const lastFogRef = useRef<string>('');
  const lastCamPosRef = useRef<string>('');
  const lastCamLookAtRef = useRef<string>('');
  const lastCamFovRef = useRef<number | undefined>(undefined);

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
    const sceneWindow = window as Scene3DWindow;
    const mouseLookOwner: MouseLookOwner = {
      token: Symbol('Scene3D mouse look'),
      yawRef,
      pitchRef,
    };

    const renderer = new THREE.WebGLRenderer({ antialias, alpha });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, Math.max(0.5, maxPixelRatio)));
    if (shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // A handle for tests and debugging: what the canvas is drawing.
    (renderer.domElement as HTMLCanvasElement & { __softnScene?: THREE.Scene; __softnRenderer?: THREE.WebGLRenderer }).__softnScene = scene;
    (renderer.domElement as HTMLCanvasElement & { __softnRenderer?: THREE.WebGLRenderer }).__softnRenderer = renderer;
    if (!alpha) {
      scene.background = new THREE.Color(background);
    }

    const fov = cameraProp?.fov ?? 60;
    const cam = new THREE.PerspectiveCamera(fov, width / height, 0.1, 1000);
    const pos = cameraProp?.position ?? { x: 0, y: 3, z: 8 };
    cam.position.set(pos.x, pos.y, pos.z);
    camTargetRef.current.set(pos.x, pos.y, pos.z);
    (renderer.domElement as HTMLCanvasElement & { __softnCamera?: THREE.Camera }).__softnCamera = cam;
    const lookAt = cameraProp?.lookAt ?? { x: 0, y: 0, z: 0 };
    cam.lookAt(lookAt.x, lookAt.y, lookAt.z);

    // Store initial camera values
    lastCamPosRef.current = JSON.stringify(pos);
    lastCamLookAtRef.current = JSON.stringify(lookAt);
    lastCamFovRef.current = fov;

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = cam;

    let controls: OrbitControls | null = null;
    if (enableOrbitControls) {
      controls = new OrbitControls(cam, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = autoRotateSpeed;
      controlsRef.current = controls;
    }

    // Turn the view by a mouse delta, whether it came from a drag or from a
    // captured pointer. Game logic may have written the yaw since the last
    // frame, so the current value is read back before it is moved.
    const turnBy = (dx: number, dy: number) => {
      const ownsGlobals = isActiveMouseLookOwner(mouseLookOwner);
      let yaw = ownsGlobals ? (sceneWindow.__scene3dYaw ?? yawRef.current) : yawRef.current;
      let pitch = ownsGlobals ? (sceneWindow.__scene3dPitch ?? pitchRef.current) : pitchRef.current;
      yaw -= dx * mouseLookSensitivity;
      pitch -= dy * mouseLookSensitivity;
      const limit = Math.min(Math.max(pitchLimit, 0.1), 1.55);
      if (pitch > limit) pitch = limit;
      if (pitch < -limit) pitch = -limit;
      yawRef.current = yaw;
      pitchRef.current = pitch;
      if (ownsGlobals) {
        sceneWindow.__scene3dYaw = yaw;
        sceneWindow.__scene3dPitch = pitch;
      }
    };

    // What the centre of the view, or a pointer, is aimed at. Camera-attached
    // objects (a held weapon) sit in front of everything and are skipped.
    const raycaster = new THREE.Raycaster();
    const pick = (ndcX: number, ndcY: number): Omit<Scene3DHit, 'button' | 'locked'> => {
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
      const meshes: THREE.Object3D[] = [];
      meshMap.forEach((e) => {
        if (e.spec.attach !== 'camera') meshes.push(e.mesh);
      });
      const intersects = raycaster.intersectObjects(meshes, true);
      const empty = { objectId: '', instanceId: null, distance: null, point: null, normal: null };
      if (intersects.length === 0) return empty;
      const hit = intersects[0];
      // Walk up to find which root entry this belongs to (handles model children)
      const findEntry = (obj: THREE.Object3D): string | undefined => {
        for (const [id, e] of meshMap.entries()) {
          if (e.mesh === obj) return id;
        }
        if (obj.parent) return findEntry(obj.parent);
        return undefined;
      };
      const id = findEntry(hit.object);
      if (id === undefined) return empty;
      let normal: Scene3DHit['normal'] = null;
      if (hit.face) {
        const n = hit.face.normal.clone();
        const m = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
        n.applyMatrix3(m).normalize();
        normal = { x: n.x, y: n.y, z: n.z };
      }
      return {
        objectId: id,
        instanceId: typeof hit.instanceId === 'number' ? hit.instanceId : null,
        distance: hit.distance,
        point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
        normal,
      };
    };

    // Mouse-look: click/touch-and-drag on canvas to rotate camera (yaw + pitch)
    let mlPointerDown: ((e: PointerEvent) => void) | null = null;
    let mlPointerMove: ((e: PointerEvent) => void) | null = null;
    let mlPointerUp: ((e: PointerEvent) => void) | null = null;
    // Pointer lock: the canvas owns the mouse until Escape.
    const canvas = renderer.domElement;
    const isLocked = () => enablePointerLock && document.pointerLockElement === canvas;
    let plMouseMove: ((e: MouseEvent) => void) | null = null;
    let plLockChange: (() => void) | null = null;
    let plMouseDown: ((e: MouseEvent) => void) | null = null;
    // Whether the lock in force reports raw device movement.
    let rawInput = false;
    const swallowContextMenu = (e: Event) => e.preventDefault();
    if (enableMouseLook) {
      const initYaw = Math.atan2(lookAt.x - pos.x, lookAt.z - pos.z);
      const dx = lookAt.x - pos.x,
        dy = lookAt.y - pos.y,
        dz = lookAt.z - pos.z;
      const hDist = Math.sqrt(dx * dx + dz * dz);
      const initPitch = hDist > 0 ? Math.atan2(dy, hDist) : 0;
      yawRef.current = initYaw;
      pitchRef.current = initPitch;
      activateMouseLookOwner(sceneWindow, mouseLookOwner);

      let lookingPointerId: number | null = null;
      let lastMX = 0;
      let lastMY = 0;

      renderer.domElement.style.cursor = 'grab';
      renderer.domElement.style.touchAction = 'none';

      mlPointerDown = (e: PointerEvent) => {
        if (e.button !== 0 || lookingPointerId !== null) return;
        // With the pointer captured there is nothing to drag: the mouse itself
        // steers. A click while unlocked (re)takes the lock instead.
        if (enablePointerLock) {
          if (!isLocked() && e.pointerType === 'mouse') {
            // Raw (unadjusted) movement, with the plain request as the
            // fallback. Adjusted movement is unusable here: when the page
            // re-lays out under a locked pointer (a HUD updating every tick),
            // Chromium fires synthetic mousemove events carrying large,
            // invented deltas, and the view spins on its own. Raw input only
            // ever reports the device.
            const request = canvas.requestPointerLock as ((opts?: { unadjustedMovement?: boolean }) => Promise<void> | void) | undefined;
            const plain = () => {
              rawInput = false;
              try {
                canvas.requestPointerLock();
              } catch {
                // Capture is a request, and the browser may refuse it.
              }
            };
            try {
              rawInput = true;
              const result = request?.call(canvas, { unadjustedMovement: true });
              if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(plain);
            } catch {
              plain();
            }
          }
          if (isLocked() || e.pointerType === 'mouse') return;
        }
        e.preventDefault();
        lookingPointerId = e.pointerId;
        lastMX = e.clientX;
        lastMY = e.clientY;
        renderer.domElement.style.cursor = 'grabbing';
        try {
          renderer.domElement.setPointerCapture?.(e.pointerId);
        } catch {
          // Capture is optional and can fail for a pointer that has already ended.
        }
      };

      mlPointerMove = (e: PointerEvent) => {
        if (e.pointerId !== lookingPointerId) return;
        const dx = e.clientX - lastMX;
        const dy = e.clientY - lastMY;
        lastMX = e.clientX;
        lastMY = e.clientY;
        turnBy(dx, dy);
      };

      mlPointerUp = (e: PointerEvent) => {
        if (e.pointerId !== lookingPointerId) return;
        lookingPointerId = null;
        renderer.domElement.style.cursor = 'grab';
      };

      renderer.domElement.addEventListener('pointerdown', mlPointerDown);
      renderer.domElement.addEventListener('pointermove', mlPointerMove);
      renderer.domElement.addEventListener('pointerup', mlPointerUp);
      renderer.domElement.addEventListener('pointercancel', mlPointerUp);
      renderer.domElement.addEventListener('lostpointercapture', mlPointerUp);
      canvas.addEventListener('contextmenu', swallowContextMenu);
    }

    if (enablePointerLock) {
      canvas.style.cursor = 'crosshair';
      plMouseMove = (e: MouseEvent) => {
        if (!isLocked()) return;
        // Only the adjusted-movement fallback invents deltas (see above),
        // and only it needs them screened; raw input's large values are a
        // real flick of the wrist, coalesced into one event, and are kept.
        if (!rawInput && (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400)) return;
        turnBy(e.movementX, e.movementY);
      };
      plLockChange = () => {
        const locked = isLocked();
        canvas.style.cursor = locked ? 'none' : 'crosshair';
        if (isActiveMouseLookOwner(mouseLookOwner)) sceneWindow.__scene3dLocked = locked;
      };
      // Every button is a game action while locked; the browser's own drag
      // and context menu have no meaning with the cursor hidden.
      plMouseDown = (e: MouseEvent) => {
        if (!isLocked() || !onClickRef.current) return;
        e.preventDefault();
        onClickRef.current({ ...pick(0, 0), button: e.button, locked: true });
      };
      document.addEventListener('mousemove', plMouseMove);
      document.addEventListener('pointerlockchange', plLockChange);
      canvas.addEventListener('mousedown', plMouseDown);
      if (isActiveMouseLookOwner(mouseLookOwner)) sceneWindow.__scene3dLocked = false;
    }

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

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || clickPointerId !== null || isLocked()) return;
      clickPointerId = event.pointerId;
      mouseDownX = event.clientX;
      mouseDownY = event.clientY;
      isDragging = false;
      try {
        renderer.domElement.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture can fail if the pointer has already ended.
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== clickPointerId || isDragging) return;
      const dx = event.clientX - mouseDownX;
      const dy = event.clientY - mouseDownY;
      if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
        isDragging = true;
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== clickPointerId) return;
      clickPointerId = null;
      releaseClickPointerCapture(event.pointerId);
      if (isDragging || !onClickRef.current) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = pick(ndcX, ndcY);
      // A plain click keeps its old contract: it reports only what it landed on.
      if (hit.objectId !== '') onClickRef.current({ ...hit, button: event.button, locked: false });
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== clickPointerId) return;
      clickPointerId = null;
      isDragging = true;
      if (event.type !== 'lostpointercapture') releaseClickPointerCapture(event.pointerId);
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('pointercancel', handlePointerCancel);
    renderer.domElement.addEventListener('lostpointercapture', handlePointerCancel);

    const attachedOffset = new THREE.Vector3();
    const attachedRotation = new THREE.Euler();
    const attachedQuat = new THREE.Quaternion();

    // Animation loop
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      const dt = clockRef.current.getDelta();
      const elapsed = clockRef.current.getElapsedTime();
      // Scale rotation by delta time (values are per-frame at 60fps ≈ 0.01667s)
      const dtScale = dt / 0.01667;

      meshMap.forEach((entry) => {
        const anim = entry.spec.animate;
        if (!anim) return;
        if (anim.rotateX) entry.mesh.rotation.x += anim.rotateX * dtScale;
        if (anim.rotateY) entry.mesh.rotation.y += anim.rotateY * dtScale;
        if (anim.rotateZ) entry.mesh.rotation.z += anim.rotateZ * dtScale;
        if (anim.floatAmplitude) {
          const speed = anim.floatSpeed ?? 1;
          entry.mesh.position.y = entry.baseY + Math.sin(elapsed * speed) * anim.floatAmplitude;
        }
      });

      // Clip mixers take real delta seconds, not the 60fps-normalised dtScale
      animationMap.forEach((entry) => entry.mixer.update(dt));

      // Ease toward the last position the host gave, frame-rate independent.
      const smoothing = cameraSmoothingRef.current;
      if (smoothing > 0) {
        const k = 1 - Math.pow(1 - Math.min(0.95, smoothing), dtScale);
        cam.position.lerp(camTargetRef.current, k);
      }

      // Mouse look: apply yaw + pitch to camera every frame (60fps, no React)
      if (enableMouseLook) {
        const ownsGlobals = isActiveMouseLookOwner(mouseLookOwner);
        const yaw = ownsGlobals ? (sceneWindow.__scene3dYaw ?? yawRef.current) : yawRef.current;
        yawRef.current = yaw;
        const pitch = ownsGlobals
          ? (sceneWindow.__scene3dPitch ?? pitchRef.current)
          : pitchRef.current;
        pitchRef.current = pitch;
        const cp = Math.cos(pitch);
        cam.lookAt(
          cam.position.x + Math.sin(yaw) * cp * 5,
          cam.position.y + Math.sin(pitch) * 5,
          cam.position.z + Math.cos(yaw) * cp * 5
        );
      }

      if (controls) controls.update();

      // Camera-attached objects follow the view after it has settled for the
      // frame, so a weapon never trails a turn by a frame.
      lightMap.forEach((light) => {
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
      meshMap.forEach((entry) => {
        if (entry.spec.attach !== 'camera') return;
        const off = entry.spec.position ?? { x: 0, y: 0, z: 0 };
        attachedOffset.set(off.x, off.y, off.z).applyQuaternion(cam.quaternion).add(cam.position);
        entry.mesh.position.copy(attachedOffset);
        const rot = entry.spec.rotation;
        attachedRotation.set(rot?.x ?? 0, rot?.y ?? 0, rot?.z ?? 0);
        entry.mesh.quaternion.copy(cam.quaternion).multiply(attachedQuat.setFromEuler(attachedRotation));
      });
      renderer.render(scene, cam);
    };
    animate();

    if (!readyFiredRef.current && onReady) {
      readyFiredRef.current = true;
      onReady();
    }

    return () => {
      cancelAnimationFrame(animFrameRef.current);
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
      if (mlPointerDown) renderer.domElement.removeEventListener('pointerdown', mlPointerDown);
      if (mlPointerMove) renderer.domElement.removeEventListener('pointermove', mlPointerMove);
      if (mlPointerUp) {
        renderer.domElement.removeEventListener('pointerup', mlPointerUp);
        renderer.domElement.removeEventListener('pointercancel', mlPointerUp);
        renderer.domElement.removeEventListener('lostpointercapture', mlPointerUp);
      }
      canvas.removeEventListener('contextmenu', swallowContextMenu);
      if (plMouseMove) document.removeEventListener('mousemove', plMouseMove);
      if (plLockChange) document.removeEventListener('pointerlockchange', plLockChange);
      if (plMouseDown) canvas.removeEventListener('mousedown', plMouseDown);
      if (enablePointerLock) {
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
      if (enableMouseLook) {
        releaseMouseLookOwner(sceneWindow, mouseLookOwner);
      }
      if (controls) controls.dispose();
      animationMap.forEach((entry) => {
        entry.mixer.stopAllAction();
        entry.mixer.uncacheRoot(entry.mixer.getRoot());
      });
      animationMap.clear();
      meshMap.forEach((entry) => {
        disposeObject3D(entry.mesh);
        scene.remove(entry.mesh);
      });
      meshMap.clear();
      loadVersions.clear();
      lightMap.forEach((light) => {
        scene.remove(light);
        if ('dispose' in light && typeof light.dispose === 'function') light.dispose();
      });
      lightMap.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      if (rendererRef.current === renderer) rendererRef.current = null;
      if (sceneRef.current === scene) sceneRef.current = null;
      if (cameraRef.current === cam) cameraRef.current = null;
      if (controlsRef.current === controls) controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (!document.fullscreenElement) {
      wrapper.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // Listen for fullscreen changes to resize renderer
  useEffect(() => {
    const onFsChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      const renderer = rendererRef.current;
      const cam = cameraRef.current;
      if (!renderer || !cam) return;
      if (fs) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        renderer.setSize(w, h);
        cam.aspect = w / h;
      } else {
        renderer.setSize(width, height);
        cam.aspect = width / height;
      }
      cam.updateProjectionMatrix();
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
    renderer.setSize(width, height);
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }, [width, height, isFullscreen]);

  // Update background
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!alpha) {
      scene.background = new THREE.Color(background);
    } else {
      scene.background = null;
    }
  }, [background, alpha]);

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

    if (cameraProp.position) {
      const posKey = JSON.stringify(cameraProp.position);
      if (posKey !== lastCamPosRef.current) {
        lastCamPosRef.current = posKey;
        camTargetRef.current.set(cameraProp.position.x, cameraProp.position.y, cameraProp.position.z);
        // A jump larger than a few metres is a teleport, not a step: no easing.
        if (!(cameraSmoothingRef.current > 0) || camTargetRef.current.distanceTo(cam.position) > 4) {
          cam.position.copy(camTargetRef.current);
        }
        // Reset orbit controls target when camera moves programmatically
        if (controlsRef.current && cameraProp.lookAt) {
          controlsRef.current.target.set(
            cameraProp.lookAt.x,
            cameraProp.lookAt.y,
            cameraProp.lookAt.z
          );
        }
      }
    }
    // Skip lookAt updates when mouse look owns the camera direction
    if (cameraProp.lookAt && !enableMouseLook) {
      const lookAtKey = JSON.stringify(cameraProp.lookAt);
      if (lookAtKey !== lastCamLookAtRef.current) {
        lastCamLookAtRef.current = lookAtKey;
        if (controlsRef.current) {
          controlsRef.current.target.set(
            cameraProp.lookAt.x,
            cameraProp.lookAt.y,
            cameraProp.lookAt.z
          );
        } else {
          cam.lookAt(cameraProp.lookAt.x, cameraProp.lookAt.y, cameraProp.lookAt.z);
        }
      }
    }
    if (cameraProp.fov != null && cameraProp.fov !== lastCamFovRef.current) {
      lastCamFovRef.current = cameraProp.fov;
      cam.fov = cameraProp.fov;
      cam.updateProjectionMatrix();
    }
  }, [cameraProp, enableMouseLook]);

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
    const currentIds = new Set(safeObjects.map((o) => o.id));

    // Remove meshes no longer in objects
    meshMap.forEach((entry, id) => {
      if (!currentIds.has(id)) {
        disposeAnimationEntry(animationMapRef.current, id);
        scene.remove(entry.mesh);
        disposeObject3D(entry.mesh);
        meshMap.delete(id);
        loadVersionRef.current.delete(id);
      }
    });

    // Add or update meshes
    for (const obj of safeObjects) {
      const existing = meshMap.get(obj.id);

      if (obj.type === 'model' && obj.modelUrl) {
        // Model objects — load asynchronously
        const needsLoad =
          !existing ||
          existing.spec.modelUrl !== obj.modelUrl ||
          existing.spec.modelFormat !== obj.modelFormat ||
          existing.spec.type !== 'model';
        if (needsLoad) {
          // Bump load version to invalidate any in-flight load (global counter avoids reset on remove/re-add)
          const version = ++_modelLoadCounter;
          loadVersionRef.current.set(obj.id, version);

          // Remove old entry if present
          if (existing) {
            disposeAnimationEntry(animationMapRef.current, obj.id);
            scene.remove(existing.mesh);
            disposeObject3D(existing.mesh);
            meshMap.delete(obj.id);
          }

          // Create a placeholder group so transform/animation can start immediately
          const placeholder = new THREE.Group();
          applyTransform(placeholder, obj, false);
          scene.add(placeholder);
          meshMap.set(obj.id, {
            mesh: placeholder,
            spec: obj,
            baseY: obj.position?.y ?? 0,
            loadVersion: version,
          });

          loadModel(obj.modelUrl, obj.modelFormat)
            .then(({ object: loaded, animations }) => {
              // Stale check — if version has changed, discard
              if (loadVersionRef.current.get(obj.id) !== version) {
                disposeObject3D(loaded);
                return;
              }
              // Reconciles during the load update the placeholder entry's spec in
              // place — the capture from load start may be stale
              const spec = meshMap.get(obj.id)?.spec ?? obj;
              // Replace placeholder with loaded model
              scene.remove(placeholder);
              applyTransform(loaded, spec, false);
              applyMaterialOverrides(loaded, spec);
              scene.add(loaded);
              meshMap.set(obj.id, {
                mesh: loaded,
                spec,
                baseY: spec.position?.y ?? 0,
                loadVersion: version,
              });
              if (animations.length > 0) {
                const mixer = new THREE.AnimationMixer(loaded);
                mixer.addEventListener('finished', (e) => {
                  onAnimationRef.current?.({
                    objectId: obj.id,
                    clip: e.action.getClip().name,
                    type: 'finished',
                  });
                });
                const animEntry: AnimationEntry = {
                  mixer,
                  clips: animations,
                  actions: new Map(),
                  currentClip: null,
                  warnedMissing: new Set(),
                };
                animationMapRef.current.set(obj.id, animEntry);
                applyAnimationSpec(obj.id, animEntry, spec.animation, (info) =>
                  onAnimationRef.current?.(info)
                );
              } else if (spec.animation?.clip) {
                // A clip requested on a clipless model can never resolve — report once here
                console.warn(
                  `[Scene3D] Animation clip "${spec.animation.clip}" not found on model "${obj.id}"`
                );
                onAnimationRef.current?.({
                  objectId: obj.id,
                  clip: spec.animation.clip,
                  type: 'missing',
                });
              }
            })
            .catch((err) => {
              // Removal and unmount deliberately invalidate in-flight loads. A
              // rejection arriving afterwards is expected and must not report a
              // failure for a scene that no longer owns the request.
              if (loadVersionRef.current.get(obj.id) === version) {
                console.error(
                  `[Scene3D] Failed to load model "${obj.id}" from ${obj.modelUrl}:`,
                  err
                );
              }
            });
        } else if (existing) {
          // Model URL unchanged — just update transform and material overrides
          applyTransform(existing.mesh, obj, true);
          if (needsMaterialUpdate(existing.spec, obj)) {
            applyMaterialOverrides(existing.mesh, obj);
          }
          // Re-apply only on spec change — see applyAnimationSpec's guard note
          const animEntry = animationMapRef.current.get(obj.id);
          if (
            animEntry &&
            JSON.stringify(existing.spec.animation) !== JSON.stringify(obj.animation)
          ) {
            applyAnimationSpec(obj.id, animEntry, obj.animation, (info) =>
              onAnimationRef.current?.(info)
            );
          }
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (obj.type === 'instanced') {
        // One mesh for many copies. Count, shape or material changes rebuild
        // it; a new placement array only rewrites the instance buffers.
        const rebuild =
          !existing ||
          existing.spec.type !== 'instanced' ||
          needsGeometryUpdate(existing.spec, obj) ||
          needsMaterialUpdate(existing.spec, obj) ||
          instanceCount(existing.spec) !== instanceCount(obj);
        if (rebuild) {
          if (existing) {
            disposeAnimationEntry(animationMapRef.current, obj.id);
            scene.remove(existing.mesh);
            disposeObject3D(existing.mesh);
            loadVersionRef.current.delete(obj.id);
          }
          const mesh = createInstanced(obj);
          applyTransform(mesh, obj, false);
          scene.add(mesh);
          meshMap.set(obj.id, { mesh, spec: obj, baseY: obj.position?.y ?? 0 });
        } else if (existing) {
          if (existing.spec.instances !== obj.instances || existing.spec.palette !== obj.palette) {
            fillInstances(existing.mesh as THREE.InstancedMesh, obj);
          }
          applyTransform(existing.mesh, obj, true);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (!existing) {
        // Primitive objects — create synchronously
        const geometry = createGeometry(obj);
        const material = createMaterial(obj);
        const mesh = new THREE.Mesh(geometry, material);
        applyTransform(mesh, obj, false);
        scene.add(mesh);
        meshMap.set(obj.id, { mesh, spec: obj, baseY: obj.position?.y ?? 0 });
      } else {
        // Primitive update
        if (existing.spec.type === 'model' || existing.spec.type === 'instanced') {
          // Switching from a model or a batch to a primitive — remove the old mesh
          disposeAnimationEntry(animationMapRef.current, obj.id);
          scene.remove(existing.mesh);
          disposeObject3D(existing.mesh);
          loadVersionRef.current.delete(obj.id);
          const geometry = createGeometry(obj);
          const material = createMaterial(obj);
          const mesh = new THREE.Mesh(geometry, material);
          applyTransform(mesh, obj, false);
          scene.add(mesh);
          meshMap.set(obj.id, { mesh, spec: obj, baseY: obj.position?.y ?? 0 });
        } else {
          const existingMesh = existing.mesh as THREE.Mesh;
          if (needsGeometryUpdate(existing.spec, obj)) {
            existingMesh.geometry.dispose();
            existingMesh.geometry = createGeometry(obj);
          }
          if (needsMaterialUpdate(existing.spec, obj)) {
            (existingMesh.material as THREE.Material).dispose();
            existingMesh.material = createMaterial(obj);
          }
          applyTransform(existing.mesh, obj, true);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      }
    }
  }, [safeObjects]);

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
          if (existing instanceof THREE.SpotLight) {
            if (spec.angle != null) existing.angle = spec.angle;
            if (spec.penumbra != null) existing.penumbra = spec.penumbra;
            if (spec.distance != null) existing.distance = spec.distance;
            if (spec.decay != null) existing.decay = spec.decay;
          } else if (existing instanceof THREE.PointLight) {
            if (spec.distance != null) existing.distance = spec.distance;
            if (spec.decay != null) existing.decay = spec.decay;
          }
          if (spec.position && 'position' in existing && spec.attach !== 'camera') {
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

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{
        position: 'relative',
        width: isFullscreen ? '100vw' : fill ? '100%' : width,
        height: isFullscreen ? '100vh' : fill ? '100%' : height,
        overflow: 'hidden',
        ...(isFullscreen ? { background: '#000' } : style),
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
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
