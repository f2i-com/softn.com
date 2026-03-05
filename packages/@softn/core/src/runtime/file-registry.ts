/**
 * Global File Registry
 *
 * Shared registry for File objects referenced by UUID.
 * Used by FileChooser (component) and SoftNScriptRuntime (host calls)
 * to bridge file references across packages.
 */

const _registry = new Map<string, File>();

/** Register a File and return a UUID reference. */
export function registerFileRef(file: File): string {
  const ref = crypto.randomUUID();
  _registry.set(ref, file);
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
