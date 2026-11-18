import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';
import {
  SoftNWithXDB,
  XDBStorageNotice,
  bundlePageAt,
  composePage,
  mainPage,
  pageTitle,
} from '@softn/core';
export { preloadRememberedFirstDraw } from '@softn/core/renderer';
export { loadXDBData, processBundle } from '@softn/runtime-shell/bundleProcessor';
import { createImportResolver } from '@softn/runtime-shell/bundleProcessor';

let componentsRegistered = false;

/**
 * Registers SoftN's `.ui` built-in components once when the `.ui` surface
 * chunk is loaded on demand. Web Container pages never import this module.
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
  createImportResolver,
  mainPage,
  pageTitle,
};
