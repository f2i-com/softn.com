import * as THREE from 'three';

/** Named, declarative appearance controls for imported assets. */
export interface ModelAppearance {
  morphs?: Record<string, number>;
  /** Optional per-target response time, 0–500 ms. Other morphs remain immediate. */
  morphSmoothingMs?: Record<string, number>;
  colors?: Record<string, string>;
  hiddenMeshes?: string[];
}
type State = { meshes: THREE.Mesh[]; colors: Map<THREE.Material, THREE.Color>; visible: Map<THREE.Object3D, boolean>; controlled: Map<THREE.Mesh, Set<number>>; defaults: Map<THREE.Mesh, number[]>; smoothed: Map<THREE.Mesh, Map<number, number>>; spec?: ModelAppearance };
const states = new WeakMap<THREE.Object3D, State>();
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export function applyModelAppearance(root: THREE.Object3D, spec?: ModelAppearance, deltaSeconds = 0): void {
  let state = states.get(root);
  if (!state) {
    state = { meshes: [], colors: new Map(), visible: new Map(), controlled: new Map(), defaults: new Map(), smoothed: new Map() };
    root.traverse(child => {
      state!.visible.set(child, child.visible);
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      state!.meshes.push(mesh);
      if (mesh.morphTargetInfluences) state!.defaults.set(mesh, [...mesh.morphTargetInfluences]);
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const color = (mat as THREE.MeshStandardMaterial).color;
        if (color) state!.colors.set(mat, color.clone());
      }
    });
    states.set(root, state);
  }
  if (state.spec !== spec) {
    const hidden = new Set(Array.isArray(spec?.hiddenMeshes) ? spec.hiddenMeshes.slice(0, 128) : []);
    for (const [node, visible] of state.visible) node.visible = visible && !hidden.has(node.name);
    for (const mesh of state.meshes) {
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const original = state.colors.get(mat), color = (mat as THREE.MeshStandardMaterial).color;
        if (!original || !color) continue;
        const tint = spec?.colors && owns(spec.colors, mat.name) ? spec.colors[mat.name] : undefined;
        if (typeof tint === 'string' && /^#[0-9a-f]{6}$/i.test(tint)) color.set(tint);
        else color.copy(original);
      }
    }
    state.spec = spec;
  }
  // Mixers may write morph arrays each frame. Reapply only explicitly named
  // customization targets afterwards; facial animation remains untouched.
  for (const mesh of state.meshes) {
    const dictionary = mesh.morphTargetDictionary, weights = mesh.morphTargetInfluences;
    if (!dictionary || !weights) continue;
    const previous = state.controlled.get(mesh) ?? new Set<number>();
    const next = new Set<number>();
    const smoothed = state.smoothed.get(mesh) ?? new Map<number, number>();
    if (spec?.morphs) for (const name of Object.keys(spec.morphs).slice(0, 64)) {
      if (!owns(dictionary, name)) continue;
      const index = dictionary[name], value = spec.morphs[name];
      const target = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      const duration = spec.morphSmoothingMs && owns(spec.morphSmoothingMs, name) ? spec.morphSmoothingMs[name] : 0;
      const ms = typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, Math.min(500, duration)) : 0;
      const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(.25, deltaSeconds)) : 0;
      // Keep interpolation state separate from the animation mixer, which may
      // overwrite this array before every call. A sparse control update should
      // not restart from the authored clip on each render frame.
      const previousValue = smoothed.get(index) ?? weights[index] ?? 0;
      const current = ms && dt ? previousValue + (target - previousValue) * (1 - Math.exp(-dt * 1000 / ms)) : target;
      weights[index] = Math.abs(current - target) < .001 ? target : current;
      smoothed.set(index, weights[index]);
      next.add(index);
    }
    for (const index of previous) if (!next.has(index)) { weights[index] = state.defaults.get(mesh)?.[index] ?? 0; smoothed.delete(index); }
    state.smoothed.set(mesh, smoothed);
    state.controlled.set(mesh, next);
  }
}
