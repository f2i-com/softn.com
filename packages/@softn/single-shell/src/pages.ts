/**
 * The pages of a bundle a link can go to: `<a href="about.html">` on a page
 * of an app written as a site. The app is composed again with that page as
 * its main one (what a browser does with a link, without leaving the app),
 * by the composer the runtime always uses, so a page shown by a link is the
 * page its own `main` would have been.
 */
import { composeBundleSource, parse, readManifest, resolveBundlePath, type ComposedBundleSource } from '@softn/core';

/**
 * The bundle path of the page `href` names from the page at `from`, or null
 * when it names none the bundle has: another site, a fragment, a file that
 * is not a page.
 */
export function bundlePageAt(textFiles: ReadonlyMap<string, string>, from: string, href: string): string | null {
  const written = href.trim().split(/[?#]/)[0];
  if (written === '' || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(written)) return null;
  let path: string;
  try {
    path = written.startsWith('/') ? resolveBundlePath('index', written.slice(1)) : resolveBundlePath(from, written);
  } catch {
    return null;
  }
  return /\.(html?|ui)$/i.test(path) && textFiles.has(path) ? path : null;
}

/** The app composed with the page at `path` as its main page. */
export function composePage(textFiles: ReadonlyMap<string, string>, path: string): ComposedBundleSource {
  const manifest = readManifest(textFiles);
  return composeBundleSource(textFiles, path, manifest.files.logic);
}

/** A page's own `<title>`, when it has one. */
export function pageTitle(textFiles: ReadonlyMap<string, string>, path: string): string | undefined {
  const text = textFiles.get(path);
  if (text === undefined) return undefined;
  try {
    return parse(text).title?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The bundle's main page, as its manifest names it. */
export function mainPage(textFiles: ReadonlyMap<string, string>): string | null {
  try {
    return readManifest(textFiles).main;
  } catch {
    return null;
  }
}
