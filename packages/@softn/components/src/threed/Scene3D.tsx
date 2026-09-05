import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { isSafeUrl } from '@softn/core';

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

export type ModelFormat = 'gltf' | 'obj' | 'fbx' | 'stl';

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
  id: string;
  type: Scene3DShape | 'model' | 'instanced' | 'group' | 'particles';
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
  /** Custom cursor when hovering over this object (e.g. 'pointer', 'grab'). */
  cursor?: string;
  /** If true, hover sets cursor to pointer. */
  interactive?: boolean;
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
  /** Image texture URL (bundle asset or public image). */
  textureUrl?: string;
  /** Bump map depth multiplier (default 0.04). */
  bumpScale?: number;
  /** Cut-out threshold for a texture with transparent pixels (a decal). */
  alphaTest?: number;
  /** Draw both faces: a flat leaf or a decal seen from behind. */
  doubleSided?: boolean;
  /** Set false to keep the object out of the fog: a star field, a moon. */
  fog?: boolean;
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
  rootObjectId?: string;
  cursor?: string;
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
  /** Shadow map resolution in pixels (e.g. 1024 or 2048). Defaults to 1024. */
  shadowMapSize?: number;
  /** Directional light shadow camera frustum half-width/height (default 15). */
  shadowCameraSize?: number;
  /** Shadow bias to avoid self-shadowing acne (default -0.0005). */
  shadowBias?: number;
  shadowNear?: number;
  shadowFar?: number;
  /**
   * `'camera'` carries the light with the view: `position` is an offset in
   * camera space, and a spot light points where the camera points — a torch
   * in the player's hand, a miner's lamp on a helmet.
   */
  attach?: 'camera';
}

export interface Scene3DEffects {
  bloom?: boolean | { strength?: number; radius?: number; threshold?: number };
  vignette?: number;
  grain?: number;
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
  /**
   * Procedural atmospheric sky gradient: 'day' | 'sunset' | 'night' | 'dusk' |
   * 'overcast' | 'dawn' | { top: string; bottom: string; middle?: string }.
   */
  sky?: 'day' | 'sunset' | 'night' | 'dusk' | 'overcast' | 'dawn' | { top: string; bottom: string; middle?: string };
  /** Ground / level editor helper grid. */
  grid?: boolean | { size?: number; divisions?: number; color?: string; centerColor?: string; position?: { x: number; y: number; z: number } };
  /** Whether to show a first-person aiming crosshair (defaults to true when pointerLock is active). */
  crosshair?: boolean;
  /** Built-in keyboard game controls listener (WASD, Arrows, Space, Shift) synced to window.__softnKeys. */
  gameControls?: boolean;
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
  /** Tone mapping curve for cinematic highlights. Defaults to 'aces'. */
  toneMapping?: 'aces' | 'linear' | 'reinhard' | 'cineon' | 'none';
  /** Exposure multiplier for tone mapping (default 1.0). */
  toneMappingExposure?: number;
  /**
   * Post-processing. Bloom makes emissive things glow; vignette darkens the
   * corners (0..1); grain adds film noise (0..1). Any effect switches the
   * frame to a composer with tone mapping applied at the end.
   */
  effects?: Scene3DEffects;
  onReady?: () => void;
  onClick?: (info: Scene3DHit) => void;
  onPointerDown?: (info: Scene3DHit) => void;
  onPointerMove?: (info: Scene3DHit) => void;
  onPointerUp?: (info: Scene3DHit) => void;
  onHover?: (info: Scene3DHit) => void;
  onAnimation?: (info: { objectId: string; clip: string; type: 'finished' | 'missing' }) => void;
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

const proceduralTextureCache = new Map<string, THREE.CanvasTexture>();

function createProceduralTexture(type: string, baseColorStr?: string, repeat?: { x: number; y: number }): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const key = `${type}_${baseColorStr || ''}_${repeat?.x ?? 1}_${repeat?.y ?? 1}`;
  const existing = proceduralTextureCache.get(key);
  if (existing) return existing;

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
  proceduralTextureCache.set(key, texture);
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

function createMaterial(obj: Scene3DObject): THREE.MeshStandardMaterial {
  const opacity = obj.opacity ?? 1;
  // Instance colours multiply the material's, so a palette needs a white base.
  const usesPalette = obj.type === 'instanced' && Array.isArray(obj.palette) && obj.palette.length > 0;

  let map: THREE.Texture | undefined;
  if (obj.texture) {
    const tex = createProceduralTexture(obj.texture, obj.color, obj.textureRepeat);
    if (tex) map = tex;
  } else if (obj.textureUrl && isSafeUrl(obj.textureUrl)) {
    try {
      const tex = new THREE.TextureLoader().load(obj.textureUrl);
      if (obj.textureRepeat) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(obj.textureRepeat.x, obj.textureRepeat.y);
      }
      map = tex;
    } catch {
      // Ignore texture load failure
    }
  }

  // A decal texture has transparent pixels: cut them out, and draw the
  // decal a hair in front of whatever it sits on rather than z-fighting.
  const cutout = obj.texture === 'bullethole' || obj.texture === 'blood' || obj.texture === 'scorch';
  const mat = new THREE.MeshStandardMaterial({
    color: usesPalette ? '#ffffff' : (obj.texture ? '#ffffff' : (obj.color || '#6366f1')),
    metalness: obj.metalness ?? (obj.texture === 'metal' ? 0.6 : (obj.texture === 'rust' ? 0.35 : 0.1)),
    roughness: obj.roughness ?? (obj.texture === 'metal' ? 0.3 : (obj.texture === 'tile' ? 0.25 : (obj.texture === 'rust' ? 0.8 : 0.6))),
    wireframe: obj.wireframe ?? false,
    flatShading: obj.flatShading ?? false,
    opacity,
    transparent: opacity < 1 || cutout,
    side: obj.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    fog: obj.fog ?? true,
    ...(map ? (cutout ? { map } : { map, bumpMap: map, bumpScale: obj.bumpScale ?? 0.03 }) : {}),
    ...(obj.emissive ? { emissive: new THREE.Color(obj.emissive) } : {}),
    ...(obj.emissiveIntensity != null ? { emissiveIntensity: obj.emissiveIntensity } : {}),
  });
  if (cutout || obj.alphaTest != null) {
    mat.alphaTest = obj.alphaTest ?? 0.08;
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
  }
  return mat;
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

/**
 * A post-processing chain for the requested effects, or null when none are
 * on, in which case the scene renders straight to the canvas as before.
 */
function buildComposer(renderer: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, effects: Scene3DEffects | undefined, width: number, height: number): { composer: EffectComposer; grain: ShaderPass | null } | null {
  if (!effects) return null;
  const bloomOn = !!effects.bloom;
  const vignette = Math.max(0, Math.min(1, effects.vignette ?? 0));
  const grain = Math.max(0, Math.min(1, effects.grain ?? 0));
  if (!bloomOn && vignette === 0 && grain === 0) return null;
  const composer = new EffectComposer(renderer);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, cam));
  if (bloomOn) {
    const b = typeof effects.bloom === 'object' ? effects.bloom : {};
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), b.strength ?? 0.45, b.radius ?? 0.4, b.threshold ?? 0.85));
  }
  // Tone mapping and the sRGB conversion the renderer would have done.
  composer.addPass(new OutputPass());
  if (vignette > 0 || grain > 0) {
    const pass = new ShaderPass(GrainVignetteShader);
    pass.uniforms.vignette.value = vignette;
    pass.uniforms.grain.value = grain;
    composer.addPass(pass);
    return { composer, grain: pass };
  }
  return { composer, grain: null };
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
    }
  });
}

// Dispose all geometries, materials, and textures in an Object3D hierarchy
function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh || (child as THREE.Points).isPoints) {
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

function createParticles(obj: Scene3DObject): THREE.Points {
  const geom = new THREE.BufferGeometry();
  const positions = obj.particlePositions ?? [];
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (obj.particleColors && obj.particleColors.length > 0) {
    geom.setAttribute('color', new THREE.Float32BufferAttribute(obj.particleColors, 3));
  }
  const mat = new THREE.PointsMaterial({
    size: obj.particleSize ?? 0.3,
    color: obj.color || '#ffffff',
    transparent: (obj.opacity ?? 1) < 1,
    opacity: obj.opacity ?? 0.8,
    fog: obj.fog ?? true,
    vertexColors: !!(obj.particleColors && obj.particleColors.length > 0),
    depthWrite: false,
  });
  const points = new THREE.Points(geom, mat);
  points.userData.__softnId = obj.id;
  return points;
}

function updateParticles(points: THREE.Points, obj: Scene3DObject): void {
  const geom = points.geometry;
  const positions = obj.particlePositions ?? [];
  const currentPos = geom.getAttribute('position');
  if (!currentPos || currentPos.count !== Math.floor(positions.length / 3)) {
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  } else {
    (currentPos as THREE.BufferAttribute).copyArray(positions);
    currentPos.needsUpdate = true;
  }
  if (obj.particleColors && obj.particleColors.length > 0) {
    const currentCols = geom.getAttribute('color');
    if (!currentCols || currentCols.count !== Math.floor(obj.particleColors.length / 3)) {
      geom.setAttribute('color', new THREE.Float32BufferAttribute(obj.particleColors, 3));
    } else {
      (currentCols as THREE.BufferAttribute).copyArray(obj.particleColors);
      currentCols.needsUpdate = true;
    }
  }
  geom.computeBoundingSphere();
}

function createSubObject(child: Scene3DObject, parentId: string): THREE.Object3D {
  let sub: THREE.Object3D;
  if (child.type === 'group') {
    sub = createGroup(child);
  } else if (child.type === 'particles') {
    sub = createParticles(child);
  } else if (child.type === 'instanced') {
    sub = createInstanced(child);
  } else {
    const geom = createGeometry(child);
    const mat = createMaterial(child);
    sub = new THREE.Mesh(geom, mat);
  }
  sub.userData.__softnId = child.id;
  sub.userData.__softnParentId = parentId;
  if (child.cursor) sub.userData.__softnCursor = child.cursor;
  if (child.interactive) sub.userData.__softnInteractive = child.interactive;
  applyTransform(sub, child, false);
  return sub;
}

function createGroup(obj: Scene3DObject): THREE.Group {
  const group = new THREE.Group();
  group.userData.__softnId = obj.id;
  group.userData.__softnGroup = true;
  if (obj.cursor) group.userData.__softnCursor = obj.cursor;
  if (obj.interactive) group.userData.__softnInteractive = obj.interactive;
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      if (!child || typeof child.id !== 'string') continue;
      const childObj = createSubObject(child, obj.id);
      group.add(childObj);
    }
  }
  return group;
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
    prev.flatShading !== next.flatShading ||
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
        const mapSize = spec.shadowMapSize ?? 1024;
        light.shadow.mapSize.width = mapSize;
        light.shadow.mapSize.height = mapSize;
        light.shadow.bias = spec.shadowBias ?? -0.0005;
        const camSize = spec.shadowCameraSize ?? 15;
        light.shadow.camera.left = -camSize;
        light.shadow.camera.right = camSize;
        light.shadow.camera.top = camSize;
        light.shadow.camera.bottom = -camSize;
        light.shadow.camera.near = spec.shadowNear ?? 0.5;
        light.shadow.camera.far = spec.shadowFar ?? 150;
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
  sky,
  grid,
  crosshair: crosshairProp,
  gameControls = false,
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
  toneMapping = 'aces',
  effects,
  toneMappingExposure = 1,
  onReady,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onHover,
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
  const crosshair = crosshairProp ?? (enablePointerLock && crosshairProp !== false);

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
  const composerRef = useRef<EffectComposer | null>(null);
  const grainPassRef = useRef<ShaderPass | null>(null);
  // Rebuilt only when the effect settings actually change, not on every
  // render of an object prop the host recreates each tick.
  const effectsKey = JSON.stringify(effects ?? null);
  const effectsRef = useRef(effects);
  effectsRef.current = effects;
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
  const onPointerDownRef = useRef(onPointerDown);
  onPointerDownRef.current = onPointerDown;
  const onPointerMoveRef = useRef(onPointerMove);
  onPointerMoveRef.current = onPointerMove;
  const onPointerUpRef = useRef(onPointerUp);
  onPointerUpRef.current = onPointerUp;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
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
    if ('outputColorSpace' in renderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    if ('toneMapping' in renderer) {
      if (toneMapping === 'linear') renderer.toneMapping = THREE.LinearToneMapping;
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
    if (!alpha) {
      if (sky) {
        const skyTex = createSkyTexture(sky);
        if (skyTex) scene.background = skyTex;
        else scene.background = new THREE.Color(background);
      } else {
        scene.background = new THREE.Color(background);
      }
    }

    if (grid) {
      const size = typeof grid === 'object' ? (grid.size ?? 50) : 50;
      const divisions = typeof grid === 'object' ? (grid.divisions ?? 50) : 50;
      const colorCenter = typeof grid === 'object' ? (grid.centerColor ?? '#6366f1') : '#6366f1';
      const colorGrid = typeof grid === 'object' ? (grid.color ?? '#334155') : '#334155';
      const gridHelper = new THREE.GridHelper(size, divisions, colorCenter, colorGrid);
      if (typeof grid === 'object' && grid.position) {
        gridHelper.position.set(grid.position.x, grid.position.y, grid.position.z);
      }
      scene.add(gridHelper);
    }

    let cleanupGameKeys: (() => void) | null = null;
    if (gameControls && typeof window !== 'undefined') {
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

      const onKeyDown = (e: KeyboardEvent) => {
        if (isUi(e.target)) return;
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

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      cleanupGameKeys = () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      };
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
    const built = buildComposer(renderer, scene, cam, effectsRef.current, width, height);
    composerRef.current = built ? built.composer : null;
    grainPassRef.current = built ? built.grain : null;

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

      let rootId = id;
      for (const [mid, e] of meshMap.entries()) {
        if (e.mesh === hit.object) {
          rootId = mid;
          break;
        }
        let p = hit.object.parent;
        while (p) {
          if (e.mesh === p) {
            rootId = mid;
            break;
          }
          p = p.parent;
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
    let plKeyDown: ((e: KeyboardEvent) => void) | null = null;
    // Whether the lock in force reports raw device movement.
    let rawInput = false;
    // What the mouse has been delivering, for the F8 readout.
    const look = { moves: 0, movesLastSecond: 0, lastDx: 0, lastDy: 0, since: performance.now(), dropped: 0 };
    let debugEl: HTMLDivElement | null = null;
    const requestLock = () => {
      if (!enablePointerLock || isLocked()) return;
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
          if (!isLocked() && e.pointerType === 'mouse') requestLock();
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
    }
    // A right button that reaches the app as a drag must not also open the
    // browser menu on release; OrbitControls swallows it the same way.
    canvas.addEventListener('contextmenu', swallowContextMenu);

    if (enablePointerLock) {
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

    // Left, middle and right buttons all flow through pointerdown/move/up
    // with `button` set, so an editor can pan on a right drag; only the left
    // button produces a click, which keeps the old click contract.
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button > 2 || clickPointerId !== null || isLocked()) return;
      clickPointerId = event.pointerId;
      mouseDownX = event.clientX;
      mouseDownY = event.clientY;
      isDragging = false;
      try {
        renderer.domElement.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture can fail if the pointer has already ended.
      }
      if (onPointerDownRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        const hit = pick(ndcX, ndcY);
        onPointerDownRef.current({ ...hit, button: event.button, locked: false });
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      if (event.pointerId === clickPointerId) {
        const dx = event.clientX - mouseDownX;
        const dy = event.clientY - mouseDownY;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          isDragging = true;
        }
        if (onPointerMoveRef.current) {
          const hit = pick(ndcX, ndcY);
          onPointerMoveRef.current({ ...hit, button: event.button, locked: false });
        }
      } else if (!isLocked()) {
        const hit = pick(ndcX, ndcY);
        if (onHoverRef.current) {
          onHoverRef.current({ ...hit, button: -1, locked: false });
        }
        if (hit.cursor) {
          renderer.domElement.style.cursor = hit.cursor;
        } else if (enableMouseLook) {
          renderer.domElement.style.cursor = 'grab';
        } else {
          renderer.domElement.style.cursor = 'default';
        }
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== clickPointerId) return;
      clickPointerId = null;
      releaseClickPointerCapture(event.pointerId);

      const rect = renderer.domElement.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = pick(ndcX, ndcY);

      if (onPointerUpRef.current) {
        onPointerUpRef.current({ ...hit, button: event.button, locked: false });
      }

      if (isDragging || !onClickRef.current || event.button !== 0) return;
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

      if (enablePointerLock) {
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
      }

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
      const composer = composerRef.current;
      if (composer) {
        const gp = grainPassRef.current;
        if (gp) gp.uniforms.time.value = (performance.now() % 100000) / 1000;
        composer.render();
      } else {
        renderer.render(scene, cam);
      }
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
      if (plKeyDown) document.removeEventListener('keydown', plKeyDown);
      if (debugEl) debugEl.remove();
      if (plLockChange) document.removeEventListener('pointerlockchange', plLockChange);
      if (plMouseDown) canvas.removeEventListener('mousedown', plMouseDown);
      if (cleanupGameKeys) cleanupGameKeys();
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
      if (composerRef.current) { composerRef.current.dispose(); composerRef.current = null; grainPassRef.current = null; }
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
        composerRef.current?.setSize(w, h);
        cam.aspect = w / h;
      } else {
        renderer.setSize(width, height);
        composerRef.current?.setSize(width, height);
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
    composerRef.current?.setSize(width, height);
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }, [width, height, isFullscreen]);

  // Effects switched on, off or retuned after mount: rebuild the composer.
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const cam = cameraRef.current;
    if (!renderer || !scene || !cam) return;
    if (composerRef.current) composerRef.current.dispose();
    const size = new THREE.Vector2();
    renderer.getSize(size);
    const built = buildComposer(renderer, scene, cam, effectsRef.current, size.x, size.y);
    composerRef.current = built ? built.composer : null;
    grainPassRef.current = built ? built.grain : null;
  }, [effectsKey]);

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
      } else if (obj.type === 'group') {
        const needsGroupRebuild =
          !existing ||
          existing.spec.type !== 'group' ||
          JSON.stringify(existing.spec.children) !== JSON.stringify(obj.children);
        if (needsGroupRebuild) {
          if (existing) {
            disposeAnimationEntry(animationMapRef.current, obj.id);
            scene.remove(existing.mesh);
            disposeObject3D(existing.mesh);
            loadVersionRef.current.delete(obj.id);
          }
          const group = createGroup(obj);
          applyTransform(group, obj, false);
          scene.add(group);
          meshMap.set(obj.id, { mesh: group, spec: obj, baseY: obj.position?.y ?? 0 });
        } else if (existing) {
          applyTransform(existing.mesh, obj, true);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (obj.type === 'particles') {
        const needsParticleRebuild =
          !existing ||
          existing.spec.type !== 'particles' ||
          existing.spec.color !== obj.color ||
          existing.spec.particleSize !== obj.particleSize;
        if (needsParticleRebuild) {
          if (existing) {
            disposeAnimationEntry(animationMapRef.current, obj.id);
            scene.remove(existing.mesh);
            disposeObject3D(existing.mesh);
            loadVersionRef.current.delete(obj.id);
          }
          const points = createParticles(obj);
          applyTransform(points, obj, false);
          scene.add(points);
          meshMap.set(obj.id, { mesh: points, spec: obj, baseY: obj.position?.y ?? 0 });
        } else if (existing) {
          updateParticles(existing.mesh as THREE.Points, obj);
          applyTransform(existing.mesh, obj, true);
          existing.spec = obj;
          existing.baseY = obj.position?.y ?? 0;
        }
      } else if (!existing) {
        // Primitive objects — create synchronously
        const geometry = createGeometry(obj);
        const material = createMaterial(obj);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.__softnId = obj.id;
        applyTransform(mesh, obj, false);
        scene.add(mesh);
        meshMap.set(obj.id, { mesh, spec: obj, baseY: obj.position?.y ?? 0 });
      } else {
        // Primitive update
        if (existing.spec.type === 'model' || existing.spec.type === 'instanced' || existing.spec.type === 'group' || existing.spec.type === 'particles') {
          // Switching from a model/batch/group/particles to a primitive — remove the old mesh
          disposeAnimationEntry(animationMapRef.current, obj.id);
          scene.remove(existing.mesh);
          disposeObject3D(existing.mesh);
          loadVersionRef.current.delete(obj.id);
          const geometry = createGeometry(obj);
          const material = createMaterial(obj);
          const mesh = new THREE.Mesh(geometry, material);
          mesh.userData.__softnId = obj.id;
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
          if (existing instanceof THREE.DirectionalLight && spec.castShadow) {
            if (spec.shadowBias != null) existing.shadow.bias = spec.shadowBias;
            if (spec.shadowCameraSize != null) {
              const camSize = spec.shadowCameraSize;
              existing.shadow.camera.left = -camSize;
              existing.shadow.camera.right = camSize;
              existing.shadow.camera.top = camSize;
              existing.shadow.camera.bottom = -camSize;
              existing.shadow.camera.updateProjectionMatrix();
            }
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
      {crosshair && (
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
