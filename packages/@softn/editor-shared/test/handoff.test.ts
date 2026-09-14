/**
 * The shared hand-off: the outcome is an address for the person to open,
 * never a navigation; a desktop build is told to export; another-origin
 * receivers are refused before staging; a build failure and a storage
 * refusal are messages.
 */
import { describe, expect, it, vi } from 'vitest';
import { destinationLabel, handoffBase, prepareHandoff } from '../src/handoff';

const bases = { runtime: 'http://site.test/web/', site: 'http://site.test/' };
const bytes = new Uint8Array([1, 2, 3]);
const stage = vi.fn(async (_b: Uint8Array, _n: string, _f: string, to: 'publish' | 'runtime') => ({ id: `id-${to}-0000000000`, to, digest: 'd' }));

describe('prepareHandoff', () => {
  it('stages for the publish page and answers with the /publish route', async () => {
    const outcome = await prepareHandoff({ to: 'publish', bundle: bytes, name: 'My App', source: 'builder', bases, stage, sameOrigin: () => true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const url = new URL(outcome.ready.url);
    expect(url.pathname).toBe('/publish');
    expect(url.searchParams.get('handoff')).toBe('id-publish-0000000000');
    expect(outcome.ready.stagedAt).toBeGreaterThan(0);
    expect(stage.mock.calls.at(-1)?.[2]).toBe('builder');
  });

  it('builds the bundle when given a builder, and reports a build that fails', async () => {
    const built = await prepareHandoff({ to: 'runtime', bundle: () => bytes, name: '', source: 'studio', bases, stage, sameOrigin: () => true });
    expect(built.ok && built.ready.name).toBe('app');
    const failed = await prepareHandoff({ to: 'runtime', bundle: () => { throw new Error('no manifest'); }, name: 'x', source: 'studio', bases, stage, sameOrigin: () => true });
    expect(failed).toEqual({ ok: false, message: 'The bundle could not be built: no manifest' });
  });

  it('tells a desktop build to export, before any origin or storage question', async () => {
    const calls = stage.mock.calls.length;
    const outcome = await prepareHandoff({ to: 'runtime', bundle: bytes, name: 'x', source: 'builder', bases, desktop: true, stage, sameOrigin: () => false });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toMatch(/Export \.softn.*the runtime/);
    expect(stage.mock.calls.length).toBe(calls);
  });

  it('refuses another origin before staging, and a storage refusal is a message', async () => {
    const calls = stage.mock.calls.length;
    const cross = await prepareHandoff({ to: 'publish', bundle: bytes, name: 'x', source: 'studio', bases, stage, sameOrigin: () => false });
    expect(!cross.ok && cross.message).toMatch(/^The publish page is on another origin here \(http:\/\/site\.test\/\)/);
    expect(stage.mock.calls.length).toBe(calls);
    const refused = await prepareHandoff({ to: 'publish', bundle: bytes, name: 'x', source: 'studio', bases, stage: async () => null, sameOrigin: () => true });
    expect(!refused.ok && refused.message).toMatch(/could not hold the bundle/);
  });

  it('names the receivers', () => {
    expect(handoffBase('runtime', bases)).toBe(bases.runtime);
    expect(handoffBase('publish', bases)).toBe(bases.site);
    expect(destinationLabel('runtime')).toBe('the runtime');
    expect(destinationLabel('publish')).toBe('the publish page');
  });
});
