import type * as UiAppSurfaceModule from '../components/UiAppSurface';

export type LoadedUiAppSurface = typeof UiAppSurfaceModule;

let cachedUiSurface: LoadedUiAppSurface | null = null;
let pendingUiSurface: Promise<LoadedUiAppSurface> | null = null;

export function getLoadedUiAppSurface(): LoadedUiAppSurface | null {
  return cachedUiSurface;
}

export function preloadUiAppSurface(): Promise<LoadedUiAppSurface> {
  if (cachedUiSurface) return Promise.resolve(cachedUiSurface);
  if (!pendingUiSurface) {
    pendingUiSurface = import('../components/UiAppSurface').then((mod) => {
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
  await preloadUiAppSurface();
}
