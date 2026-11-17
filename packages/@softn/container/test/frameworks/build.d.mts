/** The apps here, by folder. */
export const FRAMEWORKS: readonly string[];

/** Build `names` into `<outRoot>/<name>/`, in a process of its own. Throws with the build's output when it fails. */
export function buildFrameworkApps(outRoot: string, names?: readonly string[]): void;

/** Every file under `dir`, by its path from there with forward slashes. */
export function readFolder(dir: string, prefix?: string): Record<string, Uint8Array>;
