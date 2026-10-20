/**
 * Two small checks the readers of a bundle and of a session each had a copy
 * of: whether a value read from JSON is a record, and a path without the
 * leading slash a manifest may write.
 */

/** Whether `value` is a record: an object, and not a list or null. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `path` without a leading `/`: `/ui/main.ui` and `ui/main.ui` name one file of a bundle. */
export function stripSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
