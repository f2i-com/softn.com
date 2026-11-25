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
/** Owner object for each registered ref so one app's HostGate cannot read another app's file refs. */
const _refOwner = new Map<string, object>();

/**
 * Register a File and return a UUID reference. With an `owner`, the ref is
 * released with releaseFilesOf(owner): a runtime registers what the person
 * chooses for its app under itself, and a FileChooser under its app's
 * `filesOwner` (app-scope-context.ts), not under itself, since a ref it hands
 * the app's logic may be read after the chooser has gone; either way closing
 * the app lets them go. Without one (a FileChooser outside any app) the file
 * stays for the page's life.
 */
export function registerFileRef(file: File, owner?: object): string {
  const ref = randomUUID();
  _registry.set(ref, file);
  if (owner) {
    _refOwner.set(ref, owner);
    let refs = _owned.get(owner);
    if (!refs) _owned.set(owner, (refs = new Set()));
    refs.add(ref);
  }
  return ref;
}

/**
 * Retrieve a File by its reference UUID. When `requester` (a runtime HostGate) is provided,
 * enforces ownership isolation: a ref registered by another HostGate is never returned, and
 * a ref owned by a scoped `{ appId }` owner is only returned if the requester shares that appId.
 */
export function getFileByRef(ref: string, requester?: object & { appId?: () => string | undefined }): File | undefined {
  const file = _registry.get(ref);
  if (!file) return undefined;
  if (!requester) return file;
  const owner = _refOwner.get(ref);
  if (!owner || owner === requester) return file;
  // A ref registered via another runtime's `pickFile` (a HostGate) belongs strictly to that gate.
  if ('checkPermission' in owner) return undefined;
  // A ref registered via `<FileChooser>` carries `{ appId }` from AppScope; fail closed if owner
  // carries an appId and requester either lacks an appId or has a different appId.
  const ownerAppId = (owner as { appId?: unknown }).appId;
  const requesterAppId = typeof requester.appId === 'function' ? requester.appId() : undefined;
  if (typeof ownerAppId === 'string' && ownerAppId !== '' && ownerAppId !== requesterAppId) {
    return undefined;
  }
  return file;
}

/** Remove a file from the registry. */
export function releaseFileRef(ref: string): void {
  const owner = _refOwner.get(ref);
  if (owner) {
    _owned.get(owner)?.delete(ref);
    _refOwner.delete(ref);
  }
  _registry.delete(ref);
}

/** Remove every file `owner` registered. */
export function releaseFilesOf(owner: object): void {
  for (const ref of _owned.get(owner) ?? []) {
    _registry.delete(ref);
    _refOwner.delete(ref);
  }
  _owned.delete(owner);
}
