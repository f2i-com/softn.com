import * as THREE from 'three';

/** Named, declarative appearance controls for imported assets. */
export interface ModelAppearance {
  morphs?: Record<string, number>;
  /** Optional per-target response time, 0–500 ms. Other morphs remain immediate. */
  morphSmoothingMs?: Record<string, number>;
  /**
   * A tint for each material, by the material's name (the "loaded" state of
   * `onModelState` lists them). Any colour three.js reads: a name (`red`),
   * three or six hex digits after a hash, `rgb(255, 0, 0)` or
   * `hsl(0, 100%, 50%)`. It multiplies the material's own texture. One that
   * cannot be read leaves the material as it was, with a console warning.
   */
  colors?: Record<string, string>;
  hiddenMeshes?: string[];
}

/** How many colours are remembered: a tint that is animated is a new text every frame. */
const MAX_READ_COLOURS = 512;
/** Each text asked for as a colour, with what three made of it; null when it could not be read. */
const readColours = new Map<string, THREE.Color | null>();

/**
 * `text` as three reads a colour, or null, decided without setting off the
 * warning three logs for one it does not read (it would log on every use):
 * one of three's own colour names, three or six hex digits after a hash, or
 * an `rgb()` or `hsl()` form it parses.
 */
function parseColour(text: string): THREE.Color | null {
  const style = text.trim();
  const call = /^(\w+)\(([^)]*)\)/.exec(style);
  if (call) {
    if (!/^(rgba?|hsla?)$/.test(call[1])) return null;
    // These forms fail quietly, leaving the colour as it was: a channel no
    // colour has says whether anything was read.
    const probe = new THREE.Color();
    probe.r = -1;
    probe.setStyle(style);
    return probe.r === -1 ? null : probe;
  }
  const hex = /^#([A-Fa-f\d]+)$/.exec(style);
  if (hex) return hex[1].length === 3 || hex[1].length === 6 ? new THREE.Color(style) : null;
  return Object.prototype.hasOwnProperty.call(THREE.Color.NAMES, style.toLowerCase()) ? new THREE.Color(style) : null;
}

/**
 * `value` as a colour, or null. Asked once for each text, so a tint handed
 * over afresh on every tick is parsed once, and one that cannot be read is
 * warned about once. `what` names the value in that warning.
 */
export function readColour(value: unknown, what: string): THREE.Color | null {
  // A value that is not text is filed under words no colour is written in,
  // so it cannot be mistaken for one that is.
  const key = typeof value === 'string' ? value : `not text: ${String(value)}`;
  const known = readColours.get(key);
  if (known !== undefined) return known;
  const colour = typeof value === 'string' ? parseColour(value) : null;
  if (colour === null) {
    console.warn(
      `[Scene3D] ${what} is ${JSON.stringify(typeof value === 'string' ? value : String(value))}, ` +
        'which is not a colour three.js can read; the material keeps its own colour.'
    );
  }
  if (readColours.size >= MAX_READ_COLOURS) readColours.clear();
  readColours.set(key, colour);
  return colour;
}
type State = { meshes: THREE.Mesh[]; colors: Map<THREE.Material, THREE.Color>; visible: Map<THREE.Object3D, boolean>; controlled: Map<THREE.Mesh, Set<number>>; defaults: Map<THREE.Mesh, number[]>; smoothed: Map<THREE.Mesh, Map<number, number>>; tinted: Set<THREE.Material>; spec?: ModelAppearance; looks?: string; hidden?: Set<string> };
/**
 * What of an appearance is written once and stands: which meshes are hidden and which
 * materials are tinted. As text, because a list handed over from logic is a new list on
 * every tick, and the same appearance arrives as another object each time.
 */
function looksOf(spec: ModelAppearance | undefined): string | null {
  if (!spec) return '';
  try {
    return JSON.stringify([spec.hiddenMeshes ?? null, spec.colors ?? null]);
  } catch {
    // Not something that can be told from the last one: written again.
    return null;
  }
}
const states = new WeakMap<THREE.Object3D, State>();
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
/**
 * Set on a node of a model that something other than its appearance has
 * switched off (a light of the model, under the object's `lights: false`).
 * An appearance shows and hides by name; it is not what switched this off
 * and does not switch it back on: the node stays off through every change of
 * `hiddenMeshes` and `colors` until what set this takes it away.
 */
export const SWITCHED_OFF_KEY = '__softnSwitchedOff';
const switchedOff = (node: THREE.Object3D): boolean => node.userData[SWITCHED_OFF_KEY] === true;
/**
 * Whether a node of the model `root` is shown as far as its file and
 * `appearance.hiddenMeshes` go: what it is given back when something else
 * that hid or showed it (`parts`) lets go of it. Undefined for a model no
 * appearance was ever written into, and for a node that is not of it.
 */
export function shownByAppearance(root: THREE.Object3D, node: THREE.Object3D): boolean | undefined {
  const state = states.get(root);
  const own = state?.visible.get(node);
  if (!state || own === undefined) return undefined;
  return own && !(state.hidden?.has(node.name) ?? false) && !switchedOff(node);
}
export function applyModelAppearance(root: THREE.Object3D, spec?: ModelAppearance, deltaSeconds = 0): void {
  let state = states.get(root);
  if (!state) {
    state = { meshes: [], colors: new Map(), visible: new Map(), controlled: new Map(), defaults: new Map(), smoothed: new Map(), tinted: new Set() };
    root.traverse(child => {
      // As the file has it: a node something else has already switched off was not hidden by its file.
      state!.visible.set(child, child.visible || switchedOff(child));
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
  const looks = state.spec !== spec || state.looks === undefined ? looksOf(spec) : state.looks;
  state.spec = spec;
  // Written when it is another appearance, not whenever it is another object: it was written
  // again on every tick, over whatever else had coloured the model since.
  if (looks === null || looks !== state.looks) {
    state.looks = looks ?? undefined;
    const hidden = new Set(Array.isArray(spec?.hiddenMeshes) ? spec.hiddenMeshes.slice(0, 128) : []);
    state.hidden = hidden;
    for (const [node, visible] of state.visible) node.visible = visible && !hidden.has(node.name) && !switchedOff(node);
    for (const mesh of state.meshes) {
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const original = state.colors.get(mat), color = (mat as THREE.MeshStandardMaterial).color;
        if (!original || !color) continue;
        const tint: unknown = spec?.colors && owns(spec.colors, mat.name) ? spec.colors[mat.name] : undefined;
        // No tint, however that is said, is the material's own colour and nothing to warn of.
        const none = tint === undefined || tint === null || tint === '';
        const read = none ? null : readColour(tint, `appearance.colors.${mat.name}`);
        if (read) {
          color.copy(read);
          state.tinted.add(mat);
        } else if (state.tinted.delete(mat)) {
          // A tint taken away is the material's own colour again. One that was never tinted
          // here is left as it is: the object's own `color` may have coloured it.
          color.copy(original);
        }
      }
    }
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
