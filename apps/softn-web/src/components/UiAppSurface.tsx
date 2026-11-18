export { loadXDBData, processBundle } from '@softn/runtime-shell/bundleProcessor';
export { createLiveApp, preloadRememberedFirstDraw } from '@softn/core';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';
import {
  SoftNWithXDB,
  XDBStorageNotice,
  bundlePageAt,
  composePage,
  mainPage,
} from '@softn/core';

let componentsRegistered = false;

/**
 * Registers SoftN's `.ui` built-in components once when the `.ui` surface
 * chunk is loaded on demand. Web Container tabs and Home never load this chunk.
 */
export function initUiRuntimeComponents(): void {
  if (componentsRegistered) return;
  componentsRegistered = true;
  registerRuntimeComponents();
}

export {
  SoftNWithXDB,
  ThemeProvider,
  XDBStorageNotice,
  bundlePageAt,
  composePage,
  mainPage,
};
