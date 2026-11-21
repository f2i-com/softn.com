/// <reference types="vite/client" />
import type * as UiSurfaceModule from './UiApplicationSurface';

export type LoadedUiSurface = typeof UiSurfaceModule;

let cachedUiSurface: LoadedUiSurface | null = null;
let pendingUiSurface: Promise<LoadedUiSurface> | null = null;

export function getLoadedUiSurface(): LoadedUiSurface | null {
  return cachedUiSurface;
}

export function preloadUiSurface(): Promise<LoadedUiSurface> {
  if (cachedUiSurface) return Promise.resolve(cachedUiSurface);
  if (!pendingUiSurface) {
    pendingUiSurface = import('./UiApplicationSurface').then((mod) => {
      mod.initUiRuntimeComponents();
      cachedUiSurface = mod;
      return mod;
    }).catch((error) => {
      pendingUiSurface = null;
      throw error;
    });
  }
  return pendingUiSurface;
}

if (import.meta.env.MODE === 'test') {
  await preloadUiSurface();
}
