// @vitest-environment jsdom
/**
 * Run and Publish stage the bundle and hand back a link; they never
 * navigate the editor.
 *
 * The bar used to `window.open(target, '_blank', 'noopener')` and, on a
 * null return, `window.location.assign(target)`. A noopener open returns
 * null on success too, so every successful Run also sent Studio itself to
 * the runtime. Pinned here: preparing a hand-off touches neither
 * `window.open` nor `location`; the outcome is an address for the person
 * to open; the publish address is the site's /publish route; a receiver on
 * another origin is reported before anything is staged; and a failure to
 * stage is a message, not a navigation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareHandoff } from '../src/lib/handoff';
import type { VFSFile } from '../src/types/studio';

const files = new Map<string, VFSFile>([
  ['manifest.json', { path: 'manifest.json', content: JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui' }), mimeType: 'application/json', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
  ['ui/main.ui', { path: 'ui/main.ui', content: '<App/>', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
]);

const stage = vi.fn(async (_bytes: Uint8Array, _name: string, _from: string, to: 'publish' | 'runtime') => ({ id: `id-${to}-0000000000`, to, digest: 'd' }));

beforeEach(() => {
  stage.mockClear();
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

describe('prepareHandoff', () => {
  it('stages for the publish page and answers with the /publish route, without opening or navigating', async () => {
    const before = window.location.href;
    const outcome = await prepareHandoff('publish', files, 'Notes', { stage, sameOrigin: () => true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.ready.to).toBe('publish');
    const url = new URL(outcome.ready.url, 'http://site.test');
    expect(url.pathname.endsWith('/publish')).toBe(true);
    expect(url.searchParams.get('from')).toBe('handoff');
    expect(url.searchParams.get('handoff')).toBe('id-publish-0000000000');
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0][2]).toBe('studio');
    expect(stage.mock.calls[0][3]).toBe('publish');
    expect(window.open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });

  it('stages for the runtime with the runtime marker', async () => {
    const outcome = await prepareHandoff('runtime', files, 'Notes', { stage, sameOrigin: () => true });
    expect(outcome.ok && new URL(outcome.ready.url, 'http://site.test').searchParams.get('open')).toBe('handoff');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('reports a receiver on another origin before staging anything', async () => {
    const outcome = await prepareHandoff('runtime', files, 'Notes', { stage, sameOrigin: () => false });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toMatch(/another origin/);
    expect(stage).not.toHaveBeenCalled();
  });

  it('reports storage that would not hold the bundle as a message, not a navigation', async () => {
    const before = window.location.href;
    const outcome = await prepareHandoff('publish', files, 'Notes', { stage: async () => null, sameOrigin: () => true });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toMatch(/Export/);
    expect(window.open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });
});
