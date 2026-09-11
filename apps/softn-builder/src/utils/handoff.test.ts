/**
 * Open in runtime and Publish stage the bundle and hand back a link; they
 * never navigate the editor.
 *
 * The dialog used to `window.open(target, '_blank', 'noopener')` and, on
 * a null return, `window.location.assign(target)`. A noopener open returns
 * null on success too, so every successful open also sent Builder itself
 * away. Pinned here: preparing a hand-off opens nothing and navigates
 * nowhere; the publish address is the site's /publish route; a receiver on
 * another origin is reported before anything is staged.
 */

import { describe, expect, it, vi } from 'vitest';
import { prepareHandoff } from './handoff';

const bytes = new Uint8Array([1, 2, 3]);
const stage = vi.fn(async (_b: Uint8Array, _n: string, _f: string, to: 'publish' | 'runtime') => ({ id: `id-${to}-0000000000`, to, digest: 'd' }));

describe('prepareHandoff', () => {
  it('answers a publish request with the /publish route and the staged id', async () => {
    const outcome = await prepareHandoff('publish', bytes, 'My App', { stage, sameOrigin: () => true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const url = new URL(outcome.ready.url, 'http://site.test');
    expect(url.pathname.endsWith('/publish')).toBe(true);
    expect(url.searchParams.get('from')).toBe('handoff');
    expect(url.searchParams.get('handoff')).toBe('id-publish-0000000000');
    expect(stage.mock.calls[0][2]).toBe('builder');
  });

  it('answers a runtime request with the runtime marker', async () => {
    const outcome = await prepareHandoff('runtime', bytes, 'My App', { stage, sameOrigin: () => true });
    expect(outcome.ok && new URL(outcome.ready.url, 'http://site.test').searchParams.get('open')).toBe('handoff');
  });

  it('reports another origin before staging, and a storage refusal as a message', async () => {
    const calls = stage.mock.calls.length;
    const cross = await prepareHandoff('runtime', bytes, 'My App', { stage, sameOrigin: () => false });
    expect(cross.ok).toBe(false);
    expect(stage.mock.calls.length).toBe(calls);
    const refused = await prepareHandoff('publish', bytes, 'My App', { stage: async () => null, sameOrigin: () => true });
    expect(!refused.ok && refused.message).toMatch(/Export/);
  });
});
