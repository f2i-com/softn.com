/**
 * What every workspace's vitest config shares, so a workspace's own file says
 * only what is particular to it.
 *
 *   import { defineWorkspaceTest } from '../../vitest.base.mjs';
 *   export default defineWorkspaceTest({ test: { environment: 'jsdom' } });
 *
 * - `test.environment` is `node` unless the workspace says otherwise; a
 *   single file that renders can mark itself `@vitest-environment jsdom`.
 * - `test.include` is `test/**` unless the workspace keeps its tests beside
 *   the sources.
 * - `resolve.dedupe` for React everywhere: the tests do not go through
 *   @vitejs/plugin-react, which sets this for the app build, and without it
 *   `react` can resolve twice — once nested under a workspace, once hoisted
 *   for a package it renders — and a hook rendered across the two copies
 *   gets a null dispatcher.
 * - Coverage never counts build output or the tests themselves.
 *
 * `test` and `resolve` are merged one level deep, so a workspace's `include`
 * replaces the default rather than adding to it (which `mergeConfig` from
 * vite would do). Anything else in the overrides is taken as given.
 */
import { defineConfig } from 'vitest/config';

export const DEDUPE = ['react', 'react-dom'];

export const COVERAGE_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/dist-desktop/**',
  '**/target/**',
  '**/test/**',
  '**/tests/**',
  '**/*.test.*',
  '**/*.config.*',
];

export function defineWorkspaceTest(overrides = {}) {
  const { test = {}, resolve = {}, ...rest } = overrides;
  return defineConfig({
    ...rest,
    test: {
      environment: 'node',
      include: ['test/**/*.test.{ts,tsx}'],
      coverage: { exclude: COVERAGE_EXCLUDE, ...(test.coverage ?? {}) },
      ...test,
    },
    resolve: {
      ...resolve,
      dedupe: [...new Set([...DEDUPE, ...(resolve.dedupe ?? [])])],
    },
  });
}
