/**
 * The page's side of a 3D scene, and where its Three.js comes from.
 *
 * A host that bundles Three.js hands its own over (`hostThree`), so the runtime folder need
 * not hold the library a second time. And a load that fails must cost the embedding page
 * nothing: v0.0.43 kept what the app had queued and asked for the library again the moment
 * the load failed, which failed again at once, in a loop that never gave the thread back.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ContainerArchive } from '../src/archive';
import type { ThreeSceneOp } from '../src/types';
import { SplitRealmSceneHost } from '../src/vendor/webgl-scene-host';

// The last place the scene host looks, after the host's own copy and the runtime folder's:
// the library as a package. In these tests it is not there either.
vi.mock('three', () => {
  throw new Error('three is not installed');
});

const FOLDER = 'http://softn.invalid/runtime/';
const archive = {} as ContainerArchive;
const ops = (): ThreeSceneOp[] => [['init', {}]] as unknown as ThreeSceneOp[];

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the Three.js a container draws a scene with', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a load that fails is given up for that mount: asked once, said once, and the page keeps its thread', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hostThree = vi.fn(() => Promise.reject(new Error('offline')));
    const host = new SplitRealmSceneHost(archive, FOLDER, hostThree);
    const canvas = document.createElement('canvas');

    host.enqueue(canvas, 1, ops());
    // A timer fires only if the thread is given back.
    await settle(400);
    expect(hostThree).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('3D scene renderer unavailable');

    // What the app goes on sending (a frame's worth, every frame) is not kept and starts no load.
    for (let frame = 0; frame < 120; frame += 1) host.enqueue(canvas, 1, ops());
    await settle();
    expect(hostThree).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((host as unknown as { pendingQueues: Map<number, unknown> }).pendingQueues.size).toBe(0);
    host.dispose();
  });

  it('the next mount asks again, and takes the host’s own Three.js before the folder’s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const three = { REVISION: 'host' };
    const hostThree = vi.fn(() => Promise.resolve(three));
    const host = new SplitRealmSceneHost(archive, FOLDER, hostThree);

    host.enqueue(document.createElement('canvas'), 1, []);
    await settle();
    expect(hostThree).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    // Loaded once for the page: a second scene does not ask for it again.
    const second = new SplitRealmSceneHost(archive, FOLDER, hostThree);
    second.enqueue(document.createElement('canvas'), 2, []);
    await settle();
    expect(hostThree).toHaveBeenCalledTimes(1);
    host.dispose();
    second.dispose();
  });
});
