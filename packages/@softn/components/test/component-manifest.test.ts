/**
 * component-manifest.json is generated from the component sources and
 * committed; it is what an editor's palette and property panel can be built
 * from. It must describe the tree it sits in, and every name the registry
 * entries register must be a component it describes.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildManifest, manifestPath } from '../scripts/generate-manifest.mjs';

type Manifest = ReturnType<typeof buildManifest>;

describe('component-manifest.json', () => {
  const committed: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fresh = buildManifest();

  it('matches the component sources (run `npm run generate:manifest -w @softn/components` after changing props)', () => {
    expect(committed).toEqual(fresh);
  });

  it('describes every component the registry entries register', () => {
    const described = new Set(fresh.components.map((c) => c.name));
    const unknown = Object.entries(fresh.registered).flatMap(([entry, names]) =>
      names.filter((name) => !described.has(name)).map((name) => `${entry}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });

  it('records the props interface of every registered component', () => {
    const registered = new Set(Object.values(fresh.registered).flat());
    const withoutProps = fresh.components.filter((c) => registered.has(c.name) && c.props === null).map((c) => c.name);
    // Components that take no props at all are allowed to say so.
    expect(withoutProps).toEqual([]);
  });
});
