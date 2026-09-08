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
 */

import * as THREE from 'three';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { PostprocessingModules } from './model-loaders';

export interface Scene3DEffects {
  bloom?: boolean | { strength?: number; radius?: number; threshold?: number };
  vignette?: number;
  grain?: number;
}

export interface EffectsPlan {
  bloom: { strength: number; radius: number; threshold: number } | null;
  vignette: number;
  grain: number;
}

// A NaN written into a pass is a NaN in every pixel it touches — a black
// frame with no error — so a number that is not finite is its default.
const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp01 = (value: number | undefined): number => Math.max(0, Math.min(1, finiteOr(value, 0)));

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
  if (!bloom && vignette === 0 && grain === 0) return null;
  return { bloom, vignette, grain };
}

/** Which passes exist. Two plans with the same shape share a rig. */
export function effectsShapeKey(plan: EffectsPlan | null): string {
  if (!plan) return '';
  return `${plan.bloom ? 'bloom' : ''}|${plan.vignette > 0 || plan.grain > 0 ? 'grain' : ''}`;
}

/** The numbers written into those passes. */
export function effectsTuneKey(plan: EffectsPlan | null): string {
  if (!plan) return '';
  const b = plan.bloom;
  return `${b ? `${b.strength},${b.radius},${b.threshold}` : ''}|${plan.vignette}|${plan.grain}`;
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

export interface EffectsRig {
  composer: EffectComposer;
  bloom: UnrealBloomPass | null;
  grain: ShaderPass | null;
  shape: string;
  setSize(width: number, height: number): void;
  /** Write a plan of the same shape into the existing passes. */
  retune(plan: EffectsPlan): void;
  /** Every pass this rig made, then the composer. */
  dispose(): void;
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
  height: number
): EffectsRig | null {
  if (!plan) return null;
  const composer = new mods.EffectComposer(renderer);
  composer.setSize(width, height);
  const owned: Pass[] = [];
  const add = <T extends Pass>(pass: T): T => {
    composer.addPass(pass);
    owned.push(pass);
    return pass;
  };
  add(new mods.RenderPass(scene, camera));
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
    shape: effectsShapeKey(plan),
    setSize: (w, h) => composer.setSize(w, h),
    retune: (next) => {
      if (bloom && next.bloom) {
        bloom.strength = next.bloom.strength;
        bloom.radius = next.bloom.radius;
        bloom.threshold = next.bloom.threshold;
      }
      if (grain) {
        grain.uniforms.vignette.value = next.vignette;
        grain.uniforms.grain.value = next.grain;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const pass of owned) pass.dispose();
      composer.dispose();
    },
  };
}
