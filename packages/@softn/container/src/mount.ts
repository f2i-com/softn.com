/**
 * `@softn/container/mount` — Slim main-thread entry for mounting `<softn-app>`.
 *
 * Exports only `mountSoftNContainer`, `defineSoftNAppElement`, and container
 * error/type definitions so hosts (`WebContainerView`) never pull Worker-only
 * or backend-only modules (`worker-runtime`, `esm-linker`, `jsx-transform`,
 * `backend-runtime`, `xdb-sql-bridge`, `htaccess`) onto the main thread.
 */

import { defineSoftNAppElement } from './softn-app';

if (typeof window !== 'undefined' && typeof customElements !== 'undefined') {
  defineSoftNAppElement();
}

export { defineSoftNAppElement, mountSoftNContainer, type SoftNContainerHandle } from './softn-app';
export { SoftNContainerError } from './types';
export type * from './types';
