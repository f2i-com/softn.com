/**
 * `@softn/container` — SoftN v2 Sandboxed Web App Container Runtime.
 *
 * Auto-registers `<softn-app>` in browser environments and exports the
 * programmatic container APIs. Zero React dependencies.
 */

import { defineSoftNAppElement } from './softn-app';

if (typeof window !== 'undefined' && typeof customElements !== 'undefined') {
  defineSoftNAppElement();
}

export { defineSoftNAppElement, mountSoftNContainer, type SoftNContainerHandle } from './softn-app';
export { ContainerArchive, resolveVfsPath, mimeTypeFor, VIRTUAL_ORIGIN, isLegacySoftNMarkup } from './archive';
export { selectEngineTier, loadZippEngine, engineFileFor, glueFileFor } from './zipp-loader';
export { containerRuntimeNeeds, preloadContainerFeatures, type ContainerRuntimeNeeds } from './runtime-needs';
export { transformEsModule, resolveModuleSpecifier, DEFAULT_VENDOR_IMPORT_MAP } from './esm-linker';
export { registerUiExtension, ensureUiExtension } from './ui-extensions/registry';
export { prepareHtmlDocument, sanitizeContainerCss, sanitizeHostAssetUrl } from './sanitize';
export { SOFTN_UI_CSS, SHADOW_HOST_BASE_CSS } from './ui-css';
export type * from './types';
