/// <reference types="vite/client" />
import type * as UiLoaderSurfaceModule from './UiLoaderSurface';

export type LoadedUiLoaderSurface = typeof UiLoaderSurfaceModule;

let cachedUiSurface: LoadedUiLoaderSurface | null = null;
let pendingUiSurface: Promise<LoadedUiLoaderSurface> | null = null;

export function getLoadedUiLoaderSurface(): LoadedUiLoaderSurface | null {
  return cachedUiSurface;
}

export function preloadUiLoaderSurface(): Promise<LoadedUiLoaderSurface> {
  if (cachedUiSurface) return Promise.resolve(cachedUiSurface);
  if (!pendingUiSurface) {
    pendingUiSurface = import('./UiLoaderSurface').then((mod) => {
      mod.initUiRuntimeComponents();
      cachedUiSurface = mod;
      return mod;
    });
  }
  return pendingUiSurface;
}

if (import.meta.env.MODE === 'test') {
  await preloadUiLoaderSurface();
}
