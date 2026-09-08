/**
 * Model states, same-URL retry, and the three milestones.
 *
 * The loader is mocked at `parse` and held open per model, so a test decides
 * when each one settles; the bytes come from a stubbed fetch, so a retry is
 * visible as a second request for the same URL.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Scene3D, type Scene3DModelStateInfo, type Scene3DObject } from '../src/threed/Scene3D';
import { modelTemplateCache } from '../src/threed/model-cache';
import { stubFetch, stubFrames, tick, waitFor, type FetchStub, type FrameStub } from './scene3d-doubles';

type Pending = {
  resolve: (value: { scene: import('three').Object3D; animations: [] }) => void;
  reject: (error: unknown) => void;
};
const parses = vi.hoisted(() => new Map<string, Pending[]>());

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  return { ...actual, WebGLRenderer: TestWebGLRenderer };
});

// Each fixture's JSON carries a `name`; the mock files the parse under it.
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    parse(data: ArrayBuffer, _path: string, resolve: Pending['resolve'], reject: Pending['reject']) {
      const { name } = JSON.parse(new TextDecoder().decode(data)) as { name: string };
      const list = parses.get(name) ?? [];
      list.push({ resolve, reject });
      parses.set(name, list);
    }
  },
}));

import * as THREE from 'three';

// URLs and fixture names carry the test's number: the template cache is
// page-wide, and a load one test left in flight must not be the load the
// next test joins.
let run = 0;
const fixture = (name: string) => JSON.stringify({ asset: { version: '2.0' }, name: `${run}/${name}` });
const url = (name: string) => `https://models.test/${run}/${name}.gltf`;
const model = (id: string, name = id, extra: Partial<Scene3DObject> = {}): Scene3DObject => ({
  id,
  type: 'model',
  modelUrl: url(name),
  ...extra,
});

let container: HTMLDivElement;
let root: Root;
let frames: FrameStub;
let fetched: FetchStub;
let states: Scene3DModelStateInfo[];
let marks: string[];
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  run += 1;
  parses.clear();
  states = [];
  marks = [];
  frames = stubFrames();
  fetched = stubFetch({
    [url('a')]: () => fixture('a'),
    [url('b')]: () => fixture('b'),
    [url('c')]: () => fixture('c'),
  });
  vi.spyOn(performance, 'mark').mockImplementation(((name: string) => {
    marks.push(name);
    return undefined as unknown as PerformanceMark;
  }) as typeof performance.mark);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  modelTemplateCache.clearIdle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const onModelState = (info: Scene3DModelStateInfo) => states.push(info);
const of = (id: string) => states.filter((s) => s.objectId === id);
const parsing = (name: string) => () => (parses.get(`${run}/${name}`)?.length ?? 0) > 0;
const takeParse = (name: string): Pending => {
  const pending = parses.get(`${run}/${name}`)?.shift();
  if (!pending) throw new Error(`no parse pending for ${name}`);
  return pending;
};
const loaded = () => ({ scene: new THREE.Group(), animations: [] as [] });

describe('model states', () => {
  it('reports pending, then loaded, with the attempt number', async () => {
    act(() => root.render(<Scene3D objects={[model('a')]} onModelState={onModelState} />));
    expect(of('a')).toEqual([{ objectId: 'a', state: 'pending', attempt: 1 }]);
    await waitFor(parsing('a'), 'the bytes to reach the loader');
    await act(async () => {
      takeParse('a').resolve(loaded());
      await tick();
    });
    expect(of('a').at(-1)).toEqual({ objectId: 'a', state: 'loaded', attempt: 1 });
    const loads = (container.querySelector('canvas') as HTMLCanvasElement & {
      __softnModelLoads: () => Record<string, { state: string }>;
    }).__softnModelLoads();
    expect(loads.a.state).toBe('loaded');
  });

  it('reports an error with its message, and a `reload` fetches the same URL again', async () => {
    act(() => root.render(<Scene3D objects={[model('a')]} onModelState={onModelState} />));
    await waitFor(parsing('a'), 'the bytes to reach the loader');
    await act(async () => {
      takeParse('a').reject(new Error('corrupt header'));
      await tick();
    });
    expect(of('a').at(-1)).toEqual({ objectId: 'a', state: 'error', attempt: 1, error: 'corrupt header' });
    expect(fetched.calls.filter((u) => u === url('a'))).toHaveLength(1);

    act(() => root.render(<Scene3D objects={[model('a', 'a', { reload: 1 })]} onModelState={onModelState} />));
    expect(of('a').at(-1)).toEqual({ objectId: 'a', state: 'pending', attempt: 2 });
    await waitFor(parsing('a'), 'the retry to reach the loader');
    expect(fetched.calls.filter((u) => u === url('a'))).toHaveLength(2);
    await act(async () => {
      takeParse('a').resolve(loaded());
      await tick();
    });
    expect(of('a').at(-1)).toEqual({ objectId: 'a', state: 'loaded', attempt: 2 });

    // An unchanged `reload` is not a retry.
    act(() => root.render(<Scene3D objects={[model('a', 'a', { reload: 1 })]} onModelState={onModelState} />));
    expect(of('a')).toHaveLength(4);
  });

  it('starts the attempt count over when the URL changes', async () => {
    act(() => root.render(<Scene3D objects={[model('m', 'a', { reload: 3 })]} onModelState={onModelState} />));
    act(() => root.render(<Scene3D objects={[model('m', 'b', { reload: 3 })]} onModelState={onModelState} />));
    expect(of('m').map((s) => s.attempt)).toEqual([1, 1]);
  });

  it('does not report a load the scene has since replaced', async () => {
    act(() => root.render(<Scene3D objects={[model('m', 'a')]} onModelState={onModelState} />));
    await waitFor(parsing('a'), 'a to reach the loader');
    act(() => root.render(<Scene3D objects={[model('m', 'b')]} onModelState={onModelState} />));
    await waitFor(parsing('b'), 'b to reach the loader');
    await act(async () => {
      takeParse('a').resolve(loaded());
      takeParse('b').resolve(loaded());
      await tick();
    });
    expect(of('m').map((s) => s.state)).toEqual(['pending', 'pending', 'loaded']);
  });
});

describe('milestones', () => {
  function mountWith(objects: Scene3DObject[], events: string[]) {
    act(() =>
      root.render(
        <Scene3D
          objects={objects}
          onReady={() => events.push('ready')}
          onAssetsReady={() => events.push('assets')}
          onFirstFrame={() => events.push('frame')}
          onModelState={onModelState}
        />
      )
    );
  }

  it('fire in order: renderer ready, assets ready once every model settled, then the next frame', async () => {
    const events: string[] = [];
    mountWith([model('a'), model('b'), { id: 'floor', type: 'plane' }], events);
    expect(events).toEqual(['ready']);
    expect(marks).toEqual(['softn:scene3d-renderer-ready']);

    await waitFor(() => parsing('a')() && parsing('b')(), 'both to reach the loader');
    await act(async () => {
      takeParse('a').resolve(loaded());
      await tick();
    });
    expect(events).toEqual(['ready']);
    // A failure settles a model as surely as a success: the scene is what
    // it is going to be.
    await act(async () => {
      takeParse('b').reject(new Error('gone'));
      await tick();
    });
    expect(events).toEqual(['ready', 'assets']);
    expect(marks).toEqual(['softn:scene3d-renderer-ready', 'softn:scene3d-assets-ready']);

    act(() => frames.runFrame());
    expect(events).toEqual(['ready', 'assets', 'frame']);
    expect(marks.at(-1)).toBe('softn:scene3d-first-frame');
    act(() => frames.runFrame());
    expect(events).toEqual(['ready', 'assets', 'frame']);
  });

  it('a scene with no models is asset-ready at once, and useful on its next frame', () => {
    const events: string[] = [];
    mountWith([{ id: 'floor', type: 'plane' }], events);
    expect(events).toEqual(['ready', 'assets']);
    act(() => frames.runFrame());
    expect(events).toEqual(['ready', 'assets', 'frame']);
  });

  it('waits only for the models the scene opened with', async () => {
    const events: string[] = [];
    mountWith([model('a')], events);
    await waitFor(parsing('a'), 'a to reach the loader');
    act(() =>
      root.render(
        <Scene3D
          objects={[model('a'), model('c')]}
          onAssetsReady={() => events.push('assets')}
          onModelState={onModelState}
        />
      )
    );
    await act(async () => {
      takeParse('a').resolve(loaded());
      await tick();
    });
    // c is still loading; it was not part of the first reconcile.
    expect(events).toEqual(['ready', 'assets']);
  });

  it('a model removed before it settled no longer holds readiness', async () => {
    const events: string[] = [];
    mountWith([model('a'), model('b')], events);
    await waitFor(() => parsing('a')() && parsing('b')(), 'both to reach the loader');
    await act(async () => {
      takeParse('a').resolve(loaded());
      await tick();
    });
    expect(events).toEqual(['ready']);
    act(() => root.render(<Scene3D objects={[model('a')]} onAssetsReady={() => events.push('assets')} />));
    expect(events).toEqual(['ready', 'assets']);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('a required model that is replaced before it settled', () => {
  it('no longer holds readiness, whatever takes its id', async () => {
    const events: string[] = [];
    act(() =>
      root.render(
        <Scene3D
          objects={[model('a'), model('b'), model('c')]}
          onAssetsReady={() => events.push('assets')}
          onModelState={onModelState}
        />
      )
    );
    await waitFor(() => parsing('a')() && parsing('b')() && parsing('c')(), 'all three to reach the loader');
    // The same ids, now a box and a group: a script swapped placeholders for
    // the real thing, or a model URL was withheld and the object drew as a
    // primitive. Their loads are discarded; c is still the scene's.
    act(() =>
      root.render(
        <Scene3D
          objects={[{ id: 'a', type: 'box' }, { id: 'b', type: 'group', children: [] }, model('c')]}
          onAssetsReady={() => events.push('assets')}
          onModelState={onModelState}
        />
      )
    );
    expect(events).toEqual([]);
    await act(async () => {
      takeParse('c').resolve(loaded());
      await tick();
    });
    expect(events).toEqual(['assets']);
    expect(marks).toContain('softn:scene3d-assets-ready');

    // The discarded loads arrive to no one.
    await act(async () => {
      takeParse('a').resolve(loaded());
      takeParse('b').resolve(loaded());
      await tick();
    });
    expect(of('a').map((s) => s.state)).toEqual(['pending']);
    expect(of('b').map((s) => s.state)).toEqual(['pending']);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('instances of one template', () => {
  // The materials are each instance's own; the textures behind them are the
  // template's, and a version bump on one is an upload for every renderer.
  it('upload its textures once, not once per instance', async () => {
    const map = new THREE.Texture();
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map })));
    const render = (ids: string[]) =>
      act(() =>
        root.render(<Scene3D objects={ids.map((id) => model(id, 'a'))} onModelState={onModelState} />)
      );
    render(['one', 'two']);
    await waitFor(parsing('a'), 'a to reach the loader');
    await act(async () => {
      takeParse('a').resolve({ scene, animations: [] });
      await tick();
    });
    const loadedIds = () => states.filter((s) => s.state === 'loaded').map((s) => s.objectId);
    expect(loadedIds()).toEqual(['one', 'two']);
    // The first instance set the map's anisotropy: one upload.
    expect(map.anisotropy).toBe(4);
    expect(map.version).toBe(1);

    render(['one', 'two', 'three']);
    await act(async () => {
      await tick();
    });
    expect(loadedIds()).toEqual(['one', 'two', 'three']);
    expect(map.version).toBe(1);
  });
});
