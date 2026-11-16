/**
 * On-Demand Legacy v1 `.ui` Bundle Compatibility Loader (`/runtime/compat/legacy-ui.js`).
 *
 * Loaded ONLY when `<softn-app>` encounters a v1 `.softn` archive whose entry point
 * ends in `.ui` (e.g. `ui/main.ui`). Modern HTML/JS/TS containers never fetch this chunk,
 * keeping `softn.js` 100% React-free.
 */

import type { ContainerArchive } from '../archive';

export interface LegacyMountHandle {
  dispose(): void;
}

export async function mountLegacyUiBundle(
  mountTarget: HTMLElement,
  archive: ContainerArchive,
  runtimeUrl = '/runtime/'
): Promise<LegacyMountHandle> {
  // Attempt workspace / host dynamic import of legacy v1 renderer if installed,
  // else load standalone `/runtime/compat/v1-bridge.js`.
  try {
    const base = runtimeUrl.replace(/\/?$/, '/');
    const mod = (await import(/* @vite-ignore */ `${base}compat/v1-bridge.js`)) as {
      mountV1Bundle: (el: HTMLElement, archive: ContainerArchive) => Promise<LegacyMountHandle>;
    };
    return await mod.mountV1Bundle(mountTarget, archive);
  } catch {
    const notice = document.createElement('div');
    notice.style.cssText =
      'padding:1.25rem;font-family:system-ui,sans-serif;font-size:0.875rem;color:#cbd5e1;background:#0f172a;border-radius:8px';
    notice.textContent = `Legacy SoftN v1 bundle "${archive.manifest.name}" (${archive.manifest.main}) detected. Provide /runtime/compat/v1-bridge.js to render v1 .ui markup.`;
    mountTarget.replaceChildren(notice);
    return {
      dispose() {
        mountTarget.replaceChildren();
      },
    };
  }
}
