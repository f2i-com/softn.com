/**
 * Global File Registry
 *
 * Shared registry for File objects referenced by UUID.
 * Used by FileChooser (component) and SoftNScriptRuntime (host calls)
 * to bridge file references across packages.
 */

import { randomUUID } from '../bundle/crypto';

const _registry = new Map<string, File>();
/** The refs each owner registered (a runtime's host gate), to release them all when it closes. */
const _owned = new WeakMap<object, Set<string>>();

/**
 * Register a File and return a UUID reference. With an `owner`, the ref is
 * released with releaseFilesOf(owner): a runtime registers what the person
 * chooses for its app under itself, so closing the app lets them go. A
 * FileChooser's files have no such owner (a ref it hands the app's logic may
 * be read after the chooser has gone) and stay for the page's life.
 */
export function registerFileRef(file: File, owner?: object): string {
  const ref = randomUUID();
  _registry.set(ref, file);
  if (owner) {
    let refs = _owned.get(owner);
    if (!refs) _owned.set(owner, (refs = new Set()));
    refs.add(ref);
  }
  return ref;
}

/** Retrieve a File by its reference UUID. */
export function getFileByRef(ref: string): File | undefined {
  return _registry.get(ref);
}

/** Remove a file from the registry. */
export function releaseFileRef(ref: string): void {
  _registry.delete(ref);
}

/** Remove every file `owner` registered. */
export function releaseFilesOf(owner: object): void {
  for (const ref of _owned.get(owner) ?? []) _registry.delete(ref);
  _owned.delete(owner);
}
