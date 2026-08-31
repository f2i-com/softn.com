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

export interface Scene3DObject {
  id: string;
  type:
    | 'box'
    | 'sphere'
    | 'cylinder'
    | 'plane'
    | 'torus'
    | 'cone'
    | 'ring'
    | 'dodecahedron'
    | 'icosahedron'
    | 'octahedron'
    | 'model';
  modelUrl?: string;
  modelFormat?: ModelFormat;
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

export interface Scene3DLight {
  id?: string;
  type: 'ambient' | 'directional' | 'point' | 'spot' | 'hemisphere';
  color?: string;
  groundColor?: string;
  intensity?: number;
  position?: { x: number; y: number; z: number };
  castShadow?: boolean;
}

export interface Scene3DProps {
  width?: number;
  height?: number;
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
  onReady?: () => void;
  onClick?: (info: { objectId: string }) => void;
  onAnimation?: (info: { objectId: string; clip: string; type: 'finished' | 'missing' }) => void;
  style?: React.CSSProperties;
  className?: string;
}

function createGeometry(obj: Scene3DObject): THREE.BufferGeometry {
  const w = obj.width ?? 1;
  const h = obj.height ?? 1;
  const d = obj.depth ?? 1;
  const r = obj.radius ?? 0.5;

  switch (obj.type) {
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
  return new THREE.MeshStandardMaterial({
    color: obj.color || '#6366f1',
    metalness: obj.metalness ?? 0.1,
    roughness: obj.roughness ?? 0.5,
    wireframe: obj.wireframe ?? false,
    opacity,
    transparent: opacity < 1,
    ...(obj.emissive ? { emissive: new THREE.Color(obj.emissive) } : {}),
    ...(obj.emissiveIntensity != null ? { emissiveIntensity: obj.emissiveIntensity } : {}),
  });
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

  if (obj.position) {
    mesh.position.x = obj.position.x;
    // Skip Y if float animation is active on update — animation loop owns position.y
    if (!isUpdate || !anim?.floatAmplitude) {
      mesh.position.y = obj.position.y;
    }
    mesh.position.z = obj.position.z;
  }

  if (obj.rotation) {
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
      const light = new THREE.PointLight(color, intensity);
      if (spec.position) light.position.set(spec.position.x, spec.position.y, spec.position.z);
      if (spec.castShadow) light.castShadow = true;
      return light;
    }
    case 'spot': {
      const light = new THREE.SpotLight(color, intensity);
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
  width = 800,
  height = 600,
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
  mouseLook: enableMouseLook = false,
  mouseLookSensitivity = 0.003,
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

  // Mouse look takes priority over orbit controls — they cannot coexist
  const enableOrbitControls = _enableOrbitControls && !enableMouseLook;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
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
    renderer.setPixelRatio(window.devicePixelRatio);
    if (shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    if (!alpha) {
      scene.background = new THREE.Color(background);
    }

    const fov = cameraProp?.fov ?? 60;
    const cam = new THREE.PerspectiveCamera(fov, width / height, 0.1, 1000);
    const pos = cameraProp?.position ?? { x: 0, y: 3, z: 8 };
    cam.position.set(pos.x, pos.y, pos.z);
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

    // Mouse-look: click/touch-and-drag on canvas to rotate camera (yaw + pitch)
    let mlPointerDown: ((e: PointerEvent) => void) | null = null;
    let mlPointerMove: ((e: PointerEvent) => void) | null = null;
    let mlPointerUp: ((e: PointerEvent) => void) | null = null;
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

        // Read latest yaw (game logic keyboard may also write to it)
        const ownsGlobals = isActiveMouseLookOwner(mouseLookOwner);
        let yaw = ownsGlobals ? (sceneWindow.__scene3dYaw ?? yawRef.current) : yawRef.current;
        let pitch = pitchRef.current;
        yaw -= dx * mouseLookSensitivity;
        pitch -= dy * mouseLookSensitivity;
        // Clamp pitch to ~45 degrees up/down
        if (pitch > 0.8) pitch = 0.8;
        if (pitch < -0.8) pitch = -0.8;

        yawRef.current = yaw;
        pitchRef.current = pitch;
        if (ownsGlobals) {
          sceneWindow.__scene3dYaw = yaw;
          sceneWindow.__scene3dPitch = pitch;
        }
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
      if (event.button !== 0 || clickPointerId !== null) return;
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

      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2();
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, cam);

      const meshes = Array.from(meshMap.values()).map((e) => e.mesh);
      const intersects = raycaster.intersectObjects(meshes, true);
      if (intersects.length > 0) {
        const hit = intersects[0].object;
        // Walk up to find which root entry this belongs to (handles model children)
        const findEntry = (obj: THREE.Object3D): [string, MeshEntry] | undefined => {
          for (const [id, e] of meshMap.entries()) {
            if (e.mesh === obj) return [id, e];
          }
          if (obj.parent) return findEntry(obj.parent);
          return undefined;
        };
        const entry = findEntry(hit);
        if (entry) {
          onClickRef.current({ objectId: entry[0] });
        }
      }
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
        cam.position.set(cameraProp.position.x, cameraProp.position.y, cameraProp.position.z);
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
        if (existing.spec.type === 'model') {
          // Switching from model to primitive — remove old model
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
          light.userData.__softnLightType = spec.type;
          scene.add(light);
          lightMap.set(id, light);
        } else {
          // Update in-place — position, intensity, color, groundColor
          if (spec.position && 'position' in existing) {
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
        light.userData.__softnLightType = spec.type;
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
        width: isFullscreen ? '100vw' : width,
        height: isFullscreen ? '100vh' : height,
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
