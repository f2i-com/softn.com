/**
 * How a page names a picture of the project's own.
 *
 * A running app is given a file of its bundle by `asset("assets/logo.png")`,
 * which hands back an address the browser can load. The path on its own,
 * `src="assets/logo.png"`, is an address beside the page, where nothing is:
 * an Image written that way is "Failed to load" in Preview and in the app.
 *
 * The property panel's own list of assets wrote the path, and the canvas
 * found the file by it and drew the picture, so what the Builder made looked
 * right on the canvas and was broken everywhere it ran. The list writes the
 * call now, and the canvas draws a picture for the call and for nothing the
 * app would not load.
 */

/** `asset("assets/logo.png")`, as the list of assets writes it for a `src`. */
export function assetCall(path: string): string {
  return `asset(${JSON.stringify(path)})`;
}

/**
 * The path an expression asks `asset` for, when it is that call with one
 * plain string and nothing else; null for anything worked out when the app
 * runs (`asset(folder + name)`), which the canvas cannot know.
 */
export function assetCallPath(expression: unknown): string | null {
  if (typeof expression !== 'string') return null;
  const call = /^\s*asset\(\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*\)\s*$/.exec(expression);
  if (!call) return null;
  return call[1] ?? call[2] ?? null;
}

/** The project's asset a path names, by the path a page would write for it. */
export function assetNamed<T extends { name: string; bundlePath?: string }>(path: string, assets: readonly T[]): T | undefined {
  const wanted = path.trim().replace(/^\.?\//, '').replace(/^assets\//, '');
  if (wanted === '') return undefined;
  return assets.find((asset) => {
    const name = (asset.bundlePath ?? asset.name).replace(/^assets\//, '');
    return name === wanted || name.endsWith(`/${wanted}`);
  });
}
