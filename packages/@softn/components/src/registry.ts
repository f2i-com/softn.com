/**
 * SoftN Component Registry
 *
 * Registers all built-in components — eagerly. This is the compatibility
 * path: Studio, the Builder, the desktop loader and the Vite plugin call
 * registerAllBuiltins() and get every component in the chunk that imported
 * it, Three.js included. The browser runtimes boot through
 * registerRuntimeComponents() in entries/lazy.ts instead, which registers
 * the same names but fetches each feature on demand; the set here is the
 * union of the entries so the two cannot drift apart by construction.
 */

import { ComponentRegistry, registerComponents, type SoftNComponent } from '@softn/core';
import { minimalComponents } from './entries/minimal';
import { chartComponents } from './entries/charts';
import { animationComponents } from './entries/animation';
import { editorComponents } from './entries/editors';
import { scene3dComponents } from './entries/scene3d';
import { smartComponents } from './entries/smart';
import { mediaComponents } from './entries/media';

/**
 * All built-in components
 */
export const builtinComponents = {
  ...minimalComponents,
  ...chartComponents,
  ...animationComponents,
  ...editorComponents,
  ...scene3dComponents,
  ...smartComponents,
  ...mediaComponents,
};

/**
 * Register all built-in components in the given registry
 */
export function registerBuiltinComponents(registry: ComponentRegistry): void {
  registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);
}

/**
 * Register all built-in components in the default registry
 */
export function registerAllBuiltins(): void {
  registerComponents(builtinComponents as unknown as Record<string, SoftNComponent>);
}
