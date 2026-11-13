/**
 * A scene lit by a panorama of the app's own: `environment={{ url }}`.
 *
 * The files are written in the test (scene3d-panoramas) and read by three's
 * own readers through a stubbed `fetch`, so what the scene is given is what
 * a real `.hdr` or `.exr` makes. The scene and its textures are three's own;
 * only the renderer is a stand-in, so nothing here is about pixels: that the
 * light and the reflections come out right is checked in a browser.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AppScopeProvider,
  CapabilityProvider,
  type AppAssetResolver,
  type CapabilityState,
  type XDBService,
} from '@softn/core';
import { Scene3D, type Scene3DProps } from '../src/threed/Scene3D';
import { environmentFormatOf, environmentLookOf, SceneEnvironment } from '../src/threed/environment';
import { stubFetch, stubFrames, tick, waitFor, type FetchBody, type FetchStub } from './scene3d-doubles';
import { exrBytes, hdrBytes, type Light } from './scene3d-panoramas';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  const { TestWebGLRenderer } = await import('./scene3d-doubles');
  class TestPMREMGenerator {
    fromScene() {
      return new actual.WebGLRenderTarget(16, 16);
    }
    dispose() {}
  }
  return { ...actual, WebGLRenderer: TestWebGLRenderer, PMREMGenerator: TestPMREMGenerator };
});

import * as THREE from 'three';

// Two pixels: a sun four times as bright as white beside a dim blue.
const SUN: Light = [4, 0.8, 0];
const DUSK: Light = [0, 0, 0.5];
const twoPixels = (x: number): Light => (x === 0 ? SUN : DUSK);

let container: HTMLDivElement;
let root: Root;
let fetched: FetchStub;
let warned: ReturnType<typeof vi.spyOn>;
/** What each address answers with; one that is held answers when the test lets it go. */
let files: Record<string, FetchBody>;
let held: Map<string, () => void>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubFrames();
  warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
  files = {
    'https://skies.test/noon.hdr': hdrBytes(2, 1, twoPixels),
    'https://skies.test/dusk.hdr': hdrBytes(2, 1, () => DUSK),
    'https://skies.test/noon.exr': exrBytes(2, 1, twoPixels),
    'https://skies.test/broken.hdr': 'not a picture of anything',
    // Files that are not what they say: a pixel short of the two its header declares; sixty bytes that declare a
    // gigabyte; and nine bytes of an OpenEXR header whose first name never ends.
    'https://skies.test/short.hdr': hdrBytes(2, 1, twoPixels).slice(0, -4),
    'https://skies.test/huge.hdr': new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 8192 +X 16384\n'), 2, 2, 0x40, 0]),
    'https://skies.test/nine.exr': Uint8Array.from(atob('di8xAQIAAABB'), (c) => c.charCodeAt(0)),
  };
  held = new Map();
  const routes: Record<string, (url: string) => FetchBody | Promise<FetchBody>> = {};
  for (const url of [...Object.keys(files), 'https://skies.test/slow.hdr']) {
    routes[url] = (asked) =>
      asked.endsWith('slow.hdr')
        ? new Promise<FetchBody>((resolve) => held.set(asked, () => resolve(hdrBytes(2, 1, twoPixels))))
        : files[asked];
  }
  fetched = stubFetch(routes);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = (props: Partial<Scene3DProps>) => act(() => root.render(<Scene3D lights={[]} {...props} />));
const sceneOf = () => (container.querySelector('canvas') as HTMLCanvasElement & { __softnScene: THREE.Scene }).__softnScene;
const lit = () => sceneOf().environment !== null;
/** The light values of a panorama's pixels, as three read them. */
function lightOf(texture: THREE.Texture): number[] {
  const data = (texture.image as { data: Uint16Array | Float32Array }).data;
  return Array.from(data, (v) => (data instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat(v) : v));
}
async function letGo(url: string): Promise<void> {
  await waitFor(() => held.has(url), `${url} to be asked for`);
  await act(async () => {
    held.get(url)?.();
    held.delete(url);
    await tick(12);
  });
}

describe('`environment` as a file', () => {
  it('lights the scene with an .hdr: three’s own reader, a panorama by longitude and latitude, with its real light values', async () => {
    show({ environment: { url: 'https://skies.test/noon.hdr' } });
    expect(sceneOf().environment).toBeNull();
    await waitFor(lit, 'the panorama');
    const texture = sceneOf().environment as THREE.DataTexture;
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    // Light, not the colours of a screen: nothing is to be decoded from it.
    expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    expect([texture.image.width, texture.image.height]).toEqual([2, 1]);
    const light = lightOf(texture);
    // The sun is four times white: a value an ordinary picture cannot hold.
    expect(light.slice(0, 3).map((v) => Math.round(v * 100) / 100)).toEqual([4, 0.8, 0]);
    expect(light.slice(4, 7)).toEqual([0, 0, 0.5]);
    // At the strength `environmentIntensity` gives, which is 0.7 unless it says.
    expect(sceneOf().environmentIntensity).toBe(0.7);
    // Not shown behind the scene unless asked: the scene's own colour stands.
    expect((sceneOf().background as THREE.Color).isColor).toBe(true);
    expect(fetched.calls).toEqual(['https://skies.test/noon.hdr']);
  });

  it('reads an .exr the same way', async () => {
    show({ environment: { url: 'https://skies.test/noon.exr' } });
    await waitFor(lit, 'the panorama');
    const texture = sceneOf().environment as THREE.DataTexture;
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    const light = lightOf(texture).map((v) => Math.round(v * 100) / 100);
    expect(light.slice(0, 3)).toEqual([4, 0.8, 0]);
    expect(light.slice(4, 7)).toEqual([0, 0, 0.5]);
  });

  it('takes its kind from `format` where the address does not say, and an ordinary picture is in a screen’s colours', async () => {
    files['https://skies.test/sky?v=3'] = hdrBytes(2, 1, twoPixels);
    fetched = stubFetch({ 'https://skies.test/sky?v=3': () => files['https://skies.test/sky?v=3'] });
    show({ environment: { url: 'https://skies.test/sky?v=3', format: 'hdr' } });
    await waitFor(lit, 'the panorama');
    expect(lightOf(sceneOf().environment as THREE.Texture)[0]).toBeCloseTo(4, 2);

    // A picture is read by the browser, which jsdom does not do: the image three made for it is told it has loaded.
    const images: HTMLImageElement[] = [];
    const make = document.createElementNS.bind(document);
    vi.spyOn(document, 'createElementNS').mockImplementation(((ns: string, name: string) => {
      const element = make(ns, name);
      if (name === 'img') images.push(element as HTMLImageElement);
      return element;
    }) as typeof document.createElementNS);
    const before = sceneOf().environment;
    show({ environment: { url: 'https://skies.test/street.jpg' } });
    await waitFor(() => images.length === 1, 'the picture to be asked for');
    expect(images[0].src).toBe('https://skies.test/street.jpg');
    // Until it arrives the scene is lit by what it had.
    expect(sceneOf().environment).toBe(before);
    await act(async () => {
      images[0].dispatchEvent(new Event('load'));
      await tick();
    });
    const picture = sceneOf().environment as THREE.Texture;
    expect(picture).not.toBe(before);
    expect(picture.image).toBe(images[0]);
    expect(picture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(picture.mapping).toBe(THREE.EquirectangularReflectionMapping);

    expect(environmentFormatOf(undefined, 'assets/sky.HDR')).toBe('hdr');
    expect(environmentFormatOf(undefined, 'https://x.test/sky.exr?size=2k#top')).toBe('exr');
    expect(environmentFormatOf(undefined, 'assets/sky.webp')).toBe('image');
    expect(environmentFormatOf(undefined, 'blob:https://x.test/1b2c')).toBe('image');
    expect(environmentFormatOf('exr', 'blob:https://x.test/1b2c')).toBe('exr');
    // A format that is none of the three is no format.
    expect(environmentFormatOf('tiff', 'assets/sky.hdr')).toBe('hdr');
  });

  it('shows it behind the scene when asked, blurred and as bright as asked, and turns light and background together', async () => {
    show({ environment: { url: 'https://skies.test/noon.hdr', background: true, blur: 0.4, backgroundIntensity: 0.5, rotation: 1.25 } });
    await waitFor(lit, 'the panorama');
    const scene = sceneOf();
    const texture = scene.environment;
    expect(scene.background).toBe(texture);
    expect(scene.backgroundBlurriness).toBe(0.4);
    expect(scene.backgroundIntensity).toBe(0.5);
    // About the upright axis and no other, and the same turn for both.
    expect([scene.environmentRotation.x, scene.environmentRotation.y, scene.environmentRotation.z]).toEqual([0, 1.25, 0]);
    expect([scene.backgroundRotation.x, scene.backgroundRotation.y, scene.backgroundRotation.z]).toEqual([0, 1.25, 0]);

    // The numbers follow, with nothing fetched again.
    show({ environment: { url: 'https://skies.test/noon.hdr', background: true, blur: 2, backgroundIntensity: 3, rotation: -0.5 } });
    expect(scene.environment).toBe(texture);
    expect(scene.backgroundBlurriness).toBe(1);
    expect(scene.backgroundIntensity).toBe(3);
    expect(scene.environmentRotation.y).toBe(-0.5);
    expect(scene.backgroundRotation.y).toBe(-0.5);

    // Taken from behind the scene, the scene's own background is what it was, drawn as it was.
    show({ environment: { url: 'https://skies.test/noon.hdr', rotation: -0.5 }, background: '#204060' });
    expect(scene.environment).toBe(texture);
    expect((scene.background as THREE.Color).getHexString()).toBe('204060');
    expect(scene.backgroundBlurriness).toBe(0);
    expect(scene.backgroundIntensity).toBe(1);
    expect(scene.backgroundRotation.y).toBe(0);
    expect(scene.environmentRotation.y).toBe(-0.5);
    expect(fetched.calls).toHaveLength(1);
  });

  it('stays behind the scene when the scene’s own background is painted afresh, and gives way to the new one after', async () => {
    show({ environment: { url: 'https://skies.test/noon.hdr', background: true }, background: '#101010' });
    await waitFor(lit, 'the panorama');
    const scene = sceneOf();
    const texture = scene.environment;
    show({ environment: { url: 'https://skies.test/noon.hdr', background: true }, background: '#ff0000' });
    expect(scene.background).toBe(texture);
    show({ environment: { url: 'https://skies.test/noon.hdr' }, background: '#ff0000' });
    expect((scene.background as THREE.Color).getHexString()).toBe('ff0000');
  });

  it('is not fetched again for the same thing handed over as a new object, and frees what another replaces once that has arrived', async () => {
    show({ environment: { url: 'https://skies.test/noon.hdr', background: true } });
    await waitFor(lit, 'the panorama');
    const scene = sceneOf();
    const noon = scene.environment as THREE.Texture;
    const freed = vi.spyOn(noon, 'dispose');
    for (let i = 0; i < 5; i++) show({ environment: { url: 'https://skies.test/noon.hdr', background: true } });
    expect(fetched.calls).toHaveLength(1);
    expect(scene.environment).toBe(noon);

    show({ environment: { url: 'https://skies.test/slow.hdr', background: true } });
    // Still lit, and still backed, by the one it had.
    expect(scene.environment).toBe(noon);
    expect(scene.background).toBe(noon);
    expect(freed).not.toHaveBeenCalled();
    await letGo('https://skies.test/slow.hdr');
    expect(scene.environment).not.toBe(noon);
    expect(scene.background).toBe(scene.environment);
    expect(freed).toHaveBeenCalledOnce();
  });

  it('warns once of a file that cannot be loaded, naming it as it was written, and leaves the scene as it was', async () => {
    show({ environment: { url: 'https://skies.test/noon.hdr', background: true } });
    await waitFor(lit, 'the panorama');
    const scene = sceneOf();
    const noon = scene.environment;
    for (const url of ['https://skies.test/broken.hdr', 'https://skies.test/missing.hdr']) {
      warned.mockClear();
      show({ environment: { url, background: true } });
      await waitFor(() => warned.mock.calls.length > 0, 'the warning');
      await act(() => tick());
      show({ environment: { url, background: true } });
      await act(() => tick());
      const about = warned.mock.calls.filter((call: unknown[]) => String(call[0]).includes('environment'));
      expect(about).toHaveLength(1);
      expect(String(about[0][0])).toContain(`"${url}"`);
      expect(scene.environment).toBe(noon);
      expect(scene.background).toBe(noon);
    }
  });

  it(
    'refuses a file that is not the picture its header declares, before it replaces anything: the scene stays lit by what it had',
    async () => {
      show({ environment: { url: 'https://skies.test/noon.hdr', background: true } });
      await waitFor(lit, 'the panorama');
      const scene = sceneOf();
      const noon = scene.environment as THREE.Texture;
      const freed = vi.spyOn(noon, 'dispose');
      const cases: Array<[string, string]> = [
        // It used to be read to a short array, put in place of the one showing, and refused by the graphics card: lit by black.
        ['https://skies.test/short.hdr', 'it declares a picture of 2 by 1 and is too short to hold one'],
        ['https://skies.test/huge.hdr', 'it is 16384 by 8192, and a panorama may be 8192 by 4096 at most'],
        // It used to stop the page for good.
        ['https://skies.test/nine.exr', 'a name in its header does not end'],
      ];
      for (const [url, why] of cases) {
        warned.mockClear();
        show({ environment: { url, background: true } });
        await waitFor(() => warned.mock.calls.length > 0, 'the warning');
        await act(() => tick());
        const about = warned.mock.calls.filter((call: unknown[]) => String(call[0]).includes('environment'));
        expect(about).toHaveLength(1);
        expect(String(about[0][0])).toContain(`"${url}" could not be loaded; the scene is lit as it was`);
        expect(about[0][1]).toBe(why);
        expect(scene.environment).toBe(noon);
        expect(scene.background).toBe(noon);
        expect(freed).not.toHaveBeenCalled();
      }
      // One larger than the renderer says it can draw: the same.
      (container.querySelector('canvas') as unknown as { __softnRenderer: { capabilities: { maxTextureSize?: number } } }).__softnRenderer.capabilities.maxTextureSize = 1;
      warned.mockClear();
      show({ environment: { url: 'https://skies.test/dusk.hdr', background: true } });
      await waitFor(() => warned.mock.calls.length > 0, 'the warning');
      expect(warned.mock.calls[0][1]).toBe('it is 2 by 1, larger than this device can draw (1 either way)');
      expect(scene.environment).toBe(noon);
      expect(freed).not.toHaveBeenCalled();
    },
    4000
  );

  it('stays lit while it changes between the studio room and a panorama, whichever way: what was lighting it stays until the new one is ready', async () => {
    show({ environment: 'studio' });
    await waitFor(lit, 'the room');
    const scene = sceneOf();
    const room = scene.environment as THREE.Texture;
    expect(room.mapping).not.toBe(THREE.EquirectangularReflectionMapping);
    // The room is a picture three drew into a target of its own, and is freed with that.
    const roomFreed = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');

    // To a panorama that takes its time: the room lights the scene for as long as it takes.
    show({ environment: { url: 'https://skies.test/slow.hdr', background: true, rotation: 1 } });
    await waitFor(() => held.has('https://skies.test/slow.hdr'), 'the panorama to be asked for');
    expect(scene.environment).toBe(room);
    expect(roomFreed).not.toHaveBeenCalled();
    // The room is not turned or shown behind the scene: those are the panorama's.
    expect(scene.environmentRotation.y).toBe(0);
    expect((scene.background as THREE.Color).isColor).toBe(true);
    await letGo('https://skies.test/slow.hdr');
    const sky = scene.environment as THREE.Texture;
    expect(sky).not.toBe(room);
    expect(sky.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(scene.background).toBe(sky);
    expect(scene.environmentRotation.y).toBe(1);
    expect(roomFreed).toHaveBeenCalledOnce();

    // And back: the panorama lights it until the room has been made (its chunk is fetched first).
    const skyFreed = vi.spyOn(sky, 'dispose');
    show({ environment: 'studio' });
    expect(scene.environment).toBe(sky);
    expect(skyFreed).not.toHaveBeenCalled();
    await waitFor(() => scene.environment !== sky, 'the room');
    const again = scene.environment as THREE.Texture;
    expect(again).not.toBeNull();
    expect(again.mapping).not.toBe(THREE.EquirectangularReflectionMapping);
    expect(skyFreed).toHaveBeenCalledOnce();
    // The panorama's turn and its place behind the scene went with it.
    expect(scene.environmentRotation.y).toBe(0);
    expect((scene.background as THREE.Color).isColor).toBe(true);

    // A panorama that cannot be loaded leaves the room lighting the scene; and none is none at once.
    warned.mockClear();
    show({ environment: { url: 'https://skies.test/missing.hdr' } });
    await waitFor(() => warned.mock.calls.length > 0, 'the warning');
    await act(() => tick());
    expect(scene.environment).toBe(again);
    show({ environment: 'none' });
    expect(scene.environment).toBeNull();
  });

  it('survives the scene’s kind of camera changing: an orthographic camera is lit by it, and shows the scene’s own background', async () => {
    const environment = { url: 'https://skies.test/noon.hdr', background: true, rotation: 0.5, blur: 0.2 };
    show({ environment, camera: { type: 'perspective' }, background: '#204060' });
    await waitFor(lit, 'the panorama');
    const scene = sceneOf();
    const texture = scene.environment;
    expect(scene.background).toBe(texture);
    // A camera without perspective has no view outward for a panorama to be: three draws one there as a small square.
    show({ environment, camera: { type: 'orthographic', size: 8 }, background: '#204060' });
    expect(sceneOf()).toBe(scene);
    expect(scene.environment).toBe(texture);
    expect(scene.environmentRotation.y).toBe(0.5);
    expect((scene.background as THREE.Color).getHexString()).toBe('204060');
    expect(scene.backgroundBlurriness).toBe(0);
    // And back.
    show({ environment, camera: { type: 'perspective' }, background: '#204060' });
    expect(scene.background).toBe(texture);
    expect(scene.backgroundBlurriness).toBe(0.2);
    expect(fetched.calls).toHaveLength(1);
  });

  it('frees the panorama when the scene goes back to none or to the studio room, and with the scene itself', async () => {
    show({ environment: { url: 'https://skies.test/noon.hdr', background: true, blur: 0.3, rotation: 2 }, background: '#204060' });
    await waitFor(lit, 'the panorama');
    const scene = sceneOf();
    const noon = scene.environment as THREE.Texture;
    const freed = vi.spyOn(noon, 'dispose');
    show({ environment: 'none', background: '#204060' });
    expect(freed).toHaveBeenCalledOnce();
    expect(scene.environment).toBeNull();
    expect((scene.background as THREE.Color).getHexString()).toBe('204060');
    expect([scene.backgroundBlurriness, scene.backgroundIntensity, scene.environmentRotation.y, scene.backgroundRotation.y]).toEqual([0, 1, 0, 0]);

    // To the studio room, which is made as it always was, and back to a file.
    show({ environment: 'studio' });
    await waitFor(lit, 'the room');
    const room = scene.environment as THREE.Texture;
    expect(room.mapping).not.toBe(THREE.EquirectangularReflectionMapping);
    show({ environment: { url: 'https://skies.test/dusk.hdr' } });
    await waitFor(() => scene.environment !== null && scene.environment !== room, 'the second panorama');
    const dusk = scene.environment as THREE.Texture;
    expect(dusk.mapping).toBe(THREE.EquirectangularReflectionMapping);
    const gone = vi.spyOn(dusk, 'dispose');
    act(() => root.unmount());
    expect(gone).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('lights the scene by itself: the two lights of a scene that names none are left out, as with the studio room', async () => {
    const lightsIn = () => sceneOf().children.filter((node) => (node as THREE.Light).isLight).length;
    act(() => root.render(<Scene3D />));
    expect(lightsIn()).toBe(2);
    act(() => root.render(<Scene3D environment={{ url: 'https://skies.test/noon.hdr' }} />));
    expect(lightsIn()).toBe(0);
    act(() => root.render(<Scene3D environment={{ url: 'https://skies.test/noon.hdr' }} lights={[{ type: 'ambient' }]} />));
    expect(lightsIn()).toBe(1);
    await waitFor(lit, 'the panorama');
  });
});

describe('a panorama in the app’s own bundle', () => {
  function inApp(assets: AppAssetResolver, child: React.ReactElement, capability: CapabilityState = { consentPending: false, permissions: {} }) {
    return (
      <AppScopeProvider value={{ appId: 'app-skies', xdb: {} as XDBService, active: true, assets }}>
        <CapabilityProvider value={capability}>{child}</CapabilityProvider>
      </AppScopeProvider>
    );
  }

  it('is named by its path, as a model is: the resolver is asked, and its kind is told by the file’s own name', async () => {
    // The host's address for the file says nothing of what it is.
    const minted = 'blob:https://host.test/8d1f';
    const asked: string[] = [];
    const assets = ((path: string) => {
      asked.push(path);
      return path === 'assets/sky.hdr' ? minted : '';
    }) as AppAssetResolver;
    assets.pathOf = (url: string) => (url === minted ? 'assets/sky.hdr' : undefined);
    fetched = stubFetch({ [minted]: () => hdrBytes(2, 1, twoPixels) });
    act(() => root.render(inApp(assets, <Scene3D lights={[]} environment={{ url: 'assets/sky.hdr' }} />)));
    await waitFor(lit, 'the panorama');
    expect(asked).toContain('assets/sky.hdr');
    // Nothing was asked of the page's own address.
    expect(fetched.calls).toEqual([minted]);
    expect(lightOf(sceneOf().environment as THREE.Texture)[0]).toBeCloseTo(4, 2);
  });

  it('is not fetched from a host the app may not reach, and is once it may', async () => {
    const assets = (() => '') as AppAssetResolver;
    const environment = { url: 'https://skies.test/noon.hdr' };
    const net = { net: { enabled: true, allowed_hosts: ['skies.test'] } as { enabled: boolean } };
    // While the person has not answered, and from a host that was not asked for.
    for (const withheld of [
      { consentPending: true, permissions: net },
      { consentPending: false, permissions: { net: { enabled: true, allowed_hosts: ['elsewhere.test'] } as { enabled: boolean } } },
    ] satisfies CapabilityState[]) {
      act(() => root.render(inApp(assets, <Scene3D lights={[]} environment={environment} />, withheld)));
      await act(() => tick());
      expect(fetched.calls).toEqual([]);
      expect(sceneOf().environment).toBeNull();
    }
    act(() => root.render(inApp(assets, <Scene3D lights={[]} environment={environment} />, { consentPending: false, permissions: net })));
    await waitFor(lit, 'the panorama');
    expect(fetched.calls).toEqual(['https://skies.test/noon.hdr']);
  });
});

describe('the scene’s readiness and its environment', () => {
  it('`onAssetsReady` waits for the panorama the scene opened with, and the first frame after has it', async () => {
    const events: string[] = [];
    const milestones = {
      onReady: () => events.push('ready'),
      onAssetsReady: () => events.push(`assets (lit: ${lit()})`),
      onFirstFrame: () => events.push('first frame'),
    };
    show({ environment: { url: 'https://skies.test/slow.hdr' }, ...milestones });
    await act(() => tick());
    expect(events).toEqual(['ready']);
    await letGo('https://skies.test/slow.hdr');
    expect(events).toEqual(['ready', 'assets (lit: true)']);
  });

  it('does not wait for one that fails, nor for one given later, nor for one let go of before it arrived', async () => {
    const events: string[] = [];
    const onAssetsReady = () => events.push('assets');
    show({ environment: { url: 'https://skies.test/missing.hdr' }, onAssetsReady });
    await waitFor(() => events.length === 1, 'the scene to be ready');
    expect(warned).toHaveBeenCalled();
    act(() => root.unmount());

    root = createRoot(container);
    events.length = 0;
    show({ onAssetsReady });
    expect(events).toEqual(['assets']);
    show({ environment: { url: 'https://skies.test/slow.hdr' }, onAssetsReady });
    await letGo('https://skies.test/slow.hdr');
    expect(events).toEqual(['assets']);
    act(() => root.unmount());

    root = createRoot(container);
    events.length = 0;
    show({ environment: { url: 'https://skies.test/slow.hdr' }, onAssetsReady });
    await waitFor(() => held.has('https://skies.test/slow.hdr'), 'the panorama to be asked for');
    expect(events).toEqual([]);
    show({ environment: 'none', onAssetsReady });
    expect(events).toEqual(['assets']);
    // It arrives to no one, and is freed.
    await letGo('https://skies.test/slow.hdr');
    expect(sceneOf().environment).toBeNull();
  });
});

describe('SceneEnvironment', () => {
  it('disposes a panorama that arrives after another was asked for, and never shows it', async () => {
    const scene = new THREE.Scene();
    const own = new THREE.Color('#123456');
    scene.background = own;
    const made: Array<{ texture: THREE.Texture; arrive: () => void }> = [];
    const settled = vi.fn();
    const environment = new SceneEnvironment(scene, () => own, settled, () => {
      const texture = new THREE.Texture();
      return new Promise<THREE.Texture>((resolve) => made.push({ texture, arrive: () => resolve(texture) }));
    });
    environment.setLook(environmentLookOf({ url: 'a', background: true }));
    const ask = (url: string) => environment.show({ url, written: url, format: 'hdr', policy: { judge: () => ({ allowed: true }) } });
    ask('https://x.test/a.hdr');
    ask('https://x.test/b.hdr');
    // The first is given up: it is no longer waited for.
    expect(settled).toHaveBeenCalledOnce();
    const late = vi.spyOn(made[0].texture, 'dispose');
    made[0].arrive();
    await tick();
    expect(late).toHaveBeenCalledOnce();
    expect(scene.environment).toBeNull();
    expect(scene.background).toBe(own);
    made[1].arrive();
    await tick();
    expect(scene.environment).toBe(made[1].texture);
    expect(scene.background).toBe(made[1].texture);
    expect(settled).toHaveBeenCalledTimes(2);
    environment.dispose();
    expect(scene.environment).toBeNull();
    expect(scene.background).toBe(own);
  });

  it('reads a look’s numbers, each left out or not a number as its default', () => {
    expect(environmentLookOf(null)).toEqual({ background: false, rotation: 0, blur: 0, backgroundIntensity: 1 });
    expect(environmentLookOf({ url: 'a', background: true, rotation: 2, blur: 0.5, backgroundIntensity: 2 })).toEqual({
      background: true,
      rotation: 2,
      blur: 0.5,
      backgroundIntensity: 2,
    });
    expect(environmentLookOf({ url: 'a', rotation: Number.NaN, blur: -3, backgroundIntensity: -1 })).toEqual({
      background: false,
      rotation: 0,
      blur: 0,
      backgroundIntensity: 0,
    });
  });
});
