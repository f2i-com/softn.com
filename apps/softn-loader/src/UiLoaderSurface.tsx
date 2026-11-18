import { registerRuntimeComponents } from '@softn/components/lazy';
import { Spinner } from '@softn/components/essentials';
import { ThemeProvider } from '@softn/components/theme';
import { SoftNWithXDB, XDBStorageNotice } from '@softn/core';

let componentsRegistered = false;

export function initUiRuntimeComponents(): void {
  if (componentsRegistered) return;
  componentsRegistered = true;
  registerRuntimeComponents();
}

export { SoftNWithXDB, Spinner, ThemeProvider, XDBStorageNotice };
