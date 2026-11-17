/**
 * Which engine runs a bundle: SoftN's own, or the web container (@softn/container).
 *
 * One rule, said here, for everything that has to answer: the runtimes that open a bundle,
 * and Studio and the Builder, which preview a project as it will run and export it.
 *
 *   - A bundle with a `manifest.json` says so itself: `"engine": 2` (or `"container": true`)
 *     is the web container. Said nowhere, it is a SoftN bundle, as every bundle with a
 *     manifest was before the container existed.
 *   - A bundle with no manifest at all is a web container when it has a page to open: a
 *     zipped `dist/` folder, which no earlier SoftN accepted.
 *
 * Not a guess from what the entry page looks like. v0.0.43 took a manifest's bundle for a
 * container when its page had a `<script type="module">` (unless it listed `files.ui`), and
 * Studio and the Builder each had a rule of their own (any TypeScript file, any doctype). A
 * SoftN HTML page is HTML with a module script too, so some SoftN apps were moved to the
 * container, which has none of SoftN's components, bindings or capabilities; and a project
 * could be previewed on one engine and exported for the other.
 */

/** Whether a manifest says its bundle runs in the web container. */
export function declaresContainer(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  const declared = manifest as { engine?: unknown; container?: unknown };
  return declared.engine === 2 || declared.container === true;
}

/**
 * Whether a project with this manifest is a web container to the editors: it says so, and the
 * entry it names, when it names one, is a page. A manifest that says `"engine": 2` over a
 * `.ui` entry is run by every runtime as the SoftN bundle its entry is (the container reads
 * pages, not `.ui`), so an editor that went by the declaration alone previewed one engine
 * and exported for the other. A manifest that names no entry yet is a project being written.
 */
export function manifestRunsInContainer(manifest: unknown): boolean {
  if (!declaresContainer(manifest)) return false;
  const main = (manifest as { main?: unknown }).main;
  return typeof main !== 'string' || main === '' || /\.html?$/i.test(main);
}

/**
 * The page a bundle with no manifest opens, from its file names: `index.html`, else
 * `app.html`, else the first page at its root by name. Null when it has none, which is a
 * bundle nothing can open.
 */
export function zeroConfigEntry(names: Iterable<string>): string | null {
  const root: string[] = [];
  for (const name of names) {
    if (name === 'index.html') return 'index.html';
    if (!name.includes('/') && /\.html?$/i.test(name)) root.push(name);
  }
  if (root.includes('app.html')) return 'app.html';
  return root.sort()[0] ?? null;
}
