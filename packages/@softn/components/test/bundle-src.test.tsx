/**
 * A sprite sheet and a tileset, named from logic by their path in the bundle.
 *
 * The same gap Scene3D had for models and textures: `src="assets/hero.png"`
 * (a value logic made, so no `asset()` was there to turn it into the bundle's
 * file) was put to the browser as it stood and asked of the page's own
 * address. Both components now offer a path with no scheme to the app's
 * resolver first, and judge what comes back by the app's permissions.
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
import { Sprite } from '../src/animation/Sprite';
import { TileMap } from '../src/animation/TileMap';
import { namesBundleFile, resolveBundleSrc } from '../src/utils/bundle-src';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A resolver that knows the given paths, and says what it was asked. */
function bundleOf(...paths: string[]) {
  const asked: string[] = [];
  const assets = ((path: string) => {
    asked.push(path);
    return paths.includes(path) ? `blob:https://host.test/minted/${path.replace(/\//g, '-')}` : '';
  }) as AppAssetResolver;
  return { assets, asked, url: (path: string) => `blob:https://host.test/minted/${path.replace(/\//g, '-')}` };
}

function inApp(
  assets: AppAssetResolver | undefined,
  child: React.ReactElement,
  capability: CapabilityState = { consentPending: false, permissions: {} }
): React.ReactElement {
  return (
    <AppScopeProvider value={{ appId: 'app-src', xdb: {} as XDBService, active: true, assets }}>
      <CapabilityProvider value={capability}>{child}</CapabilityProvider>
    </AppScopeProvider>
  );
}

describe('what names a file in the bundle', () => {
  it('is a path with no scheme, and nothing else', () => {
    expect(namesBundleFile('assets/hero.png')).toBe(true);
    expect(namesBundleFile('./assets/hero.png')).toBe(true);
    expect(namesBundleFile('hero.png')).toBe(true);
    expect(namesBundleFile('https://cdn.test/hero.png')).toBe(false);
    expect(namesBundleFile('blob:https://host.test/1')).toBe(false);
    expect(namesBundleFile('data:image/png;base64,AAAA')).toBe(false);
    expect(namesBundleFile('//cdn.test/hero.png')).toBe(false);
    expect(namesBundleFile('\\\\cdn.test\\hero.png')).toBe(false);
    expect(namesBundleFile('#hero')).toBe(false);
    expect(namesBundleFile('')).toBe(false);
    expect(namesBundleFile('   ')).toBe(false);
    expect(namesBundleFile(undefined)).toBe(false);
    expect(namesBundleFile(42)).toBe(false);
    expect(namesBundleFile(['assets/hero.png'])).toBe(false);
  });

  it('is the resolver’s to turn into a URL; what it does not know, or cannot say, is left as written', () => {
    const bundle = bundleOf('assets/hero.png');
    expect(resolveBundleSrc('assets/hero.png', bundle.assets)).toBe(bundle.url('assets/hero.png'));
    expect(resolveBundleSrc('assets/missing.png', bundle.assets)).toBe('assets/missing.png');
    expect(resolveBundleSrc('https://cdn.test/hero.png', bundle.assets)).toBe('https://cdn.test/hero.png');
    expect(bundle.asked).toEqual(['assets/hero.png', 'assets/missing.png']);
    expect(resolveBundleSrc('assets/hero.png', undefined)).toBe('assets/hero.png');
    const throws = (() => {
      throw new Error('disposed');
    }) as unknown as AppAssetResolver;
    expect(resolveBundleSrc('assets/hero.png', throws)).toBe('assets/hero.png');
    const list = ['assets/hero.png'];
    expect(resolveBundleSrc(list, bundle.assets)).toBe(list);
  });
});

describe('Sprite', () => {
  const sheet = () => (container.firstElementChild as HTMLElement).style.backgroundImage;

  it('draws from the bundle’s file when its sheet is named by a path', () => {
    const bundle = bundleOf('assets/hero.png');
    act(() => root.render(inApp(bundle.assets, <Sprite src="assets/hero.png" />)));
    expect(sheet()).toBe(`url("${bundle.url('assets/hero.png')}")`);
  });

  it('draws a path the bundle does not have, and a URL in full, as written', () => {
    const bundle = bundleOf();
    act(() => root.render(inApp(bundle.assets, <Sprite src="sprites/served.png" />)));
    expect(sheet()).toBe('url("sprites/served.png")');
    act(() => root.render(inApp(bundle.assets, <Sprite src="blob:https://host.test/already" />)));
    expect(sheet()).toBe('url("blob:https://host.test/already")');
    expect(bundle.asked).toEqual(['sprites/served.png']);
  });

  it('draws as written where there is no app around it', () => {
    act(() => root.render(<Sprite src="assets/hero.png" />));
    expect(sheet()).toBe('url("assets/hero.png")');
  });

  it('draws nothing when the resolver answers with an address the app may not reach', () => {
    const remote = ((path: string) => `https://cdn.host.test/${path}`) as AppAssetResolver;
    act(() => root.render(inApp(remote, <Sprite src="assets/hero.png" />)));
    expect(sheet()).toBe('');
    act(() =>
      root.render(
        inApp(remote, <Sprite src="assets/hero.png" />, {
          consentPending: false,
          permissions: { net: { enabled: true } },
        })
      )
    );
    expect(sheet()).toBe('url("https://cdn.host.test/assets/hero.png")');
  });
});

describe('TileMap', () => {
  /** Every address an image was asked to load from. */
  function watchImages(): string[] {
    const asked: string[] = [];
    class FakeImage {
      crossOrigin = '';
      onload: (() => void) | null = null;
      complete = false;
      naturalWidth = 32;
      naturalHeight = 32;
      set src(value: string) {
        asked.push(value);
      }
    }
    vi.stubGlobal('Image', FakeImage);
    return asked;
  }
  const layers = [[[0, 1], [1, 0]]];

  it('loads its tileset from the bundle’s file when it is named by a path, however it draws', () => {
    const asked = watchImages();
    const bundle = bundleOf('assets/tiles.png');
    act(() => root.render(inApp(bundle.assets, <TileMap src="assets/tiles.png" layers={layers} />)));
    expect(asked).toEqual([bundle.url('assets/tiles.png')]);
    act(() => root.render(inApp(bundle.assets, <TileMap src="assets/tiles.png" layers={layers} viewport />)));
    expect(asked).toEqual([bundle.url('assets/tiles.png'), bundle.url('assets/tiles.png')]);
  });

  it('loads a path the bundle does not have as written', () => {
    const asked = watchImages();
    act(() => root.render(inApp(bundleOf().assets, <TileMap src="tiles/served.png" layers={layers} />)));
    expect(asked).toEqual(['tiles/served.png']);
  });
});
