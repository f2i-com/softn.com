/**
 * The runtime registration in entries/lazy.ts against the eager one in
 * registry.ts: the same names, and nothing heavy evaluated before it is
 * asked for. Scene3D stands in for every feature because it is the one
 * whose eager evaluation costs the most — Three.js and the model loaders
 * come in with it — and the mock below counts how often that happens.
 *
 * The parity test imports registry.ts inside the test, not at the top: that
 * module evaluates Scene3D on purpose, and doing so at file load would run
 * the mock before the first test could see it unrun.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentRegistry } from '@softn/core';
import {
  ensureRuntimeComponents,
  lazyComponentRegistrations,
  registerRuntimeComponents,
  runtimeComponentNames,
} from '../src/entries/lazy';

const scene3dModule = vi.hoisted(() => ({ evaluations: 0 }));

vi.mock('../src/threed/Scene3D', () => {
  scene3dModule.evaluations += 1;
  return {
    Scene3D: function Scene3DMock() {
      return null;
    },
  };
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('registerRuntimeComponents', () => {
  it('registers Scene3D as a loader that has not run, and runs it on preload', async () => {
    const registry = new ComponentRegistry();
    registerRuntimeComponents(registry);

    expect(scene3dModule.evaluations).toBe(0);
    expect(registry.getLoadState('Scene3D')).toBe('idle');
    expect(registry.getFeature('Scene3D')).toBe('scene3d');
    expect(registry.getLoadState('Button')).toBe('eager');
    expect(registry.getLoadState('LineChart')).toBe('idle');
    expect(registry.getFeature('QRReader')).toBe('media');
    // The light groups are loaders a page's first draw waits for; the heavy
    // features are drawn around.
    expect(registry.getLoadState('Select')).toBe('idle');
    expect(registry.getFeature('Select')).toBe('controls');
    expect(registry.firstDrawLoads(['Scene3D', 'LineChart', 'Button'])).toBeNull();
    expect(registry.firstDrawLoads(['Select'])).not.toBeNull();

    await registry.preload(['Scene3D']);
    expect(scene3dModule.evaluations).toBe(1);
    expect(registry.getLoadState('Scene3D')).toBe('loaded');
    const loaded = await registry.load('Scene3D');
    expect(typeof loaded).toBe('function');
    expect((loaded as { name?: string }).name).toBe('Scene3DMock');

    // Two registries share the module: the import() is cached by the runtime
    // and the mock factory, like a real module, evaluates once.
    const another = new ComponentRegistry();
    registerRuntimeComponents(another);
    await another.preload(['Scene3D']);
    expect(scene3dModule.evaluations).toBe(1);
  });

  it('resolves every lazy name to a component through its feature entry', async () => {
    const registry = new ComponentRegistry();
    registerRuntimeComponents(registry);
    for (const name of Object.keys(lazyComponentRegistrations)) {
      const component = await registry.load(name);
      expect(typeof component, name).toBe('function');
    }
  });

  it('registers exactly the names registerAllBuiltins does', async () => {
    const { builtinComponents } = await import('../src/registry');
    const expected = Object.keys(builtinComponents).sort();

    const registry = new ComponentRegistry();
    registerRuntimeComponents(registry);
    expect(registry.getNames().sort()).toEqual(expected);
    expect([...runtimeComponentNames].sort()).toEqual(expected);
    expect(new Set(runtimeComponentNames).size).toBe(runtimeComponentNames.length);
  });

  it('starts with the start-up set and fetches the five groups, which together are the minimal set', async () => {
    const { essentialComponents } = await import('../src/entries/essentials');
    const { minimalComponents } = await import('../src/entries/minimal');
    const groups = await Promise.all([
      import('../src/entries/controls').then((m) => m.controlComponents),
      import('../src/entries/feedback').then((m) => m.feedbackComponents),
      import('../src/entries/data').then((m) => m.dataComponents),
      import('../src/entries/display').then((m) => m.displayComponents),
      import('../src/entries/navigation').then((m) => m.navigationComponents),
    ]);
    const parts = [essentialComponents, ...groups].map((record) => Object.keys(record));
    const all = parts.flat();
    expect(new Set(all).size, 'no name in two of them').toBe(all.length);
    expect([...all].sort()).toEqual(Object.keys(minimalComponents).sort());

    const registry = new ComponentRegistry();
    registerRuntimeComponents(registry);
    for (const name of parts[0]) expect(registry.getLoadState(name), name).toBe('eager');
    for (const name of parts.slice(1).flat()) {
      expect(registry.getLoadState(name), name).toBe('idle');
      expect(registry.firstDrawLoads([name]), name).not.toBeNull();
    }
  });
});

describe('ensureRuntimeComponents', () => {
  it('registers once per registry, so a feature already fetched is not fetched again', async () => {
    const registry = new ComponentRegistry();
    ensureRuntimeComponents(registry);
    await registry.preload(['LineChart']);
    expect(registry.getLoadState('LineChart')).toBe('loaded');
    // A second module that registers the components leaves the load as it is.
    ensureRuntimeComponents(registry);
    expect(registry.getLoadState('LineChart')).toBe('loaded');
    // Another registry gets its own.
    const other = new ComponentRegistry();
    ensureRuntimeComponents(other);
    expect(other.getLoadState('LineChart')).toBe('idle');
  });
});

describe('the emitted entries', () => {
  const dist = resolve(packageRoot, 'dist');
  const built = existsSync(resolve(dist, 'lazy.js'));
  if (!built) {
    console.warn('[lazy-entries] dist/ is not built; the emitted-graph checks are skipped');
  }

  it.skipIf(!built)('keep every feature behind import() in lazy.js', () => {
    const lazy = readFileSync(resolve(dist, 'lazy.js'), 'utf8');
    const staticImports = [
      ...lazy.matchAll(/^(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const source of staticImports) {
      expect(source, `lazy.js statically imports ${source}`).not.toMatch(
        /^three|scene3d|charts|editors|smart|media|animation|pickers|games|controls|feedback|data|display|navigation|minimal/
      );
    }
    for (const feature of [
      'controls',
      'feedback',
      'data',
      'display',
      'navigation',
      'scene3d',
      'charts',
      'editors',
      'smart',
      'media',
      'animation',
      'pickers',
      'games',
    ]) {
      expect(lazy).toContain(`import('./${feature}.js')`);
    }
    expect(lazy).not.toMatch(/from ['"]three/);
  });

  it.skipIf(!built)('keep three out of minimal.js and theme.js and their chunks', () => {
    for (const entry of ['minimal', 'essentials', 'theme', 'lazy']) {
      const seen = new Set<string>();
      const queue = [`${entry}.js`];
      while (queue.length) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(resolve(dist, file), 'utf8');
        expect(text, `${entry}.js reaches three through ${file}`).not.toMatch(/from ['"]three/);
        for (const m of text.matchAll(/from\s+['"]\.\/(chunk-[^'"]+\.js)['"]/g)) queue.push(m[1]);
        for (const m of text.matchAll(/^import\s+['"]\.\/(chunk-[^'"]+\.js)['"]/gm))
          queue.push(m[1]);
      }
    }
  });

  it('are exported with types and a default, one per entry', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { types?: string; default?: string } | string>;
      sideEffects?: boolean;
    };
    for (const entry of [
      'minimal',
      'essentials',
      'controls',
      'feedback',
      'data',
      'display',
      'navigation',
      'lazy',
      'theme',
      'scene3d',
      'charts',
      'editors',
      'smart',
      'media',
      'animation',
    ]) {
      const sub = pkg.exports[`./${entry}`];
      expect(sub, `./${entry}`).toEqual({
        types: `./dist/${entry}.d.ts`,
        default: `./dist/${entry}.js`,
      });
    }
    // The root barrel is tree-shaken out of a host that imports a single
    // component from it only if the package says it may be.
    expect(pkg.sideEffects).toBe(false);
  });
});
