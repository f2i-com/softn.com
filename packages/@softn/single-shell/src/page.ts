/**
 * A page of a site as the app: an `index.html` written as SoftN, run where it
 * is served, with no bundle built from it.
 *
 * The page names its files the way an HTML page does: `<script src="main.js">`,
 * `<link rel="stylesheet" href="styles.css">`, `<import Header
 * from="./header.html" />`, and `import "./cart.js"` in its code. They are
 * fetched from beside it, by the composer's own reading of those references,
 * and assembled as the standalone shell assembles a bundle's text
 * (assemble.ts): the same manifest read, composition, seeding and grant. A
 * `manifest.json` or `permission.json` beside the page is read when there is
 * one; without them the page is its own manifest, and it is granted nothing.
 *
 * Pictures and other files the page shows are not fetched here: the browser
 * loads them from the site by their paths, as it would for any page.
 */

import {
  UI_IMPORT_DECLARATION_PATTERN,
  logicImportPaths,
  pageLogicSources,
  pageStylesheetHrefs,
  parse,
  readManifest,
  resolveBundlePath,
} from '@softn/core';
import type { AssetResolver, BundleManifest } from '@softn/runtime-shell/bundleProcessor';
import { assembleApplication, mark } from './assemble';
import { digest, localUrl, type SingleConfig } from './config';
import type { LoadedPage } from './SingleApp';

/** Where the page is, and what of it is not the app's. */
export interface PageSource {
  /** The page's address. Its files resolve against the folder it is in. */
  pageUrl: string;
  /** The page's text, when the caller has it already. */
  text?: string;
  /** The addresses of the scripts that load the runtime: on the page, but no part of the app. */
  runtimeScripts?: readonly string[];
  /**
   * The address of the document the app is drawn in, which the browser reads
   * a picture's path against: the page's own, unless another page runs it
   * (`data-page`). The page's own when not said.
   */
  documentUrl?: string;
}

/** How much of a site a page may pull in: enough for any app, little enough that a loop of imports ends. */
const MAX_FILES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** The path of `url` inside the folder at `base`, or null when it is not inside it. */
function pathIn(base: URL, url: URL): string | null {
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
  return path === '' ? null : path;
}

/**
 * The page's text without the tags that load the runtime: they name a script
 * of the site's, and the composer would take such a tag for the app's code.
 */
export function withoutRuntimeScripts(text: string, pageUrl: string, runtimeScripts: readonly string[]): string {
  if (runtimeScripts.length === 0) return text;
  const runtime = new Set(runtimeScripts.map((src) => new URL(src, pageUrl).href));
  return text.replace(/<script\b([^>]*)>\s*<\/script\s*>|<script\b([^>]*)\/\s*>/gi, (tag, open?: string, closed?: string) => {
    const src = (open ?? closed ?? '').match(/\bsrc\s*=\s*(["'])([^"']+)\1/i)?.[2];
    if (!src) return tag;
    try {
      return runtime.has(new URL(src, pageUrl).href) ? '' : tag;
    } catch {
      return tag;
    }
  });
}

/** The page's title: its `<title>`, read as the parser reads it. */
function titleOf(text: string): string | undefined {
  try {
    const title = parse(text).title?.trim();
    return title ? title : undefined;
  } catch {
    return undefined;
  }
}

/** The collections the page binds, for the seed files a site may keep beside it (`xdb/<name>.xdb`). */
function collectionsOf(text: string): string[] {
  try {
    return (parse(text).data?.collections ?? []).map((collection) => collection.name);
  } catch {
    return [];
  }
}

/**
 * The path that leads from the folder of the document at `from` to `to`, on
 * the same site: `app/images/logo.png` from `/site/index.html` to
 * `/site/app/images/logo.png`, and the path itself where the two are in one
 * folder.
 */
export function pathFrom(from: URL, to: URL): string {
  if (from.origin !== to.origin) return to.href;
  const folder = from.pathname.split('/').slice(0, -1);
  const target = to.pathname.split('/');
  let shared = 0;
  while (shared < folder.length && shared < target.length - 1 && folder[shared] === target[shared]) shared++;
  return '../'.repeat(folder.length - shared) + target.slice(shared).join('/');
}

/**
 * Bundle paths for the site's files, from the page's folder: a resolver the
 * runtime can hand `asset()`, which answers where the file is from the
 * document the app is drawn in, so the browser reads it from the site, as it
 * reads an `<img>`. Where another page runs this one (`data-page`) that is
 * not the page's own folder. A path that climbs out of the folder is nothing.
 */
function siteFiles(base: URL, document: URL): AssetResolver {
  const resolve = ((path: string): string => {
    if (typeof path !== 'string' || path === '' || path.includes('..') || /^[a-z][a-z0-9+.-]*:|^\//i.test(path)) return '';
    return pathFrom(document, new URL(path.replace(/^\.\//, ''), base));
  }) as AssetResolver;
  resolve.pathOf = (url: string) => (/^[a-z][a-z0-9+.-]*:|^\//i.test(url) ? undefined : url);
  resolve.dispose = () => {};
  return resolve;
}

export async function loadPageApplication(
  source: PageSource,
  signal: AbortSignal,
  progress?: () => void
): Promise<LoadedPage> {
  const pageUrl = localUrl(source.pageUrl.split('#')[0], source.pageUrl.split('#')[0]);
  const page = new URL(pageUrl);
  const base = new URL('.', page);
  const mainPath = pathIn(base, page) ?? 'index.html';
  const textFiles = new Map<string, string>();
  let total = 0;

  /**
   * A file of the site, as text, or null when the site has none at that path.
   * `from` is where to read it, when that is not its path: the page itself,
   * reached by its folder's address (`/notes/`), which the server answers
   * with whatever its default page is called.
   */
  const fetchText = async (path: string, from?: URL): Promise<string | null> => {
    if (textFiles.has(path)) return textFiles.get(path)!;
    if (textFiles.size >= MAX_FILES) throw Error(`This page names more than ${MAX_FILES} files`);
    const url = from ?? new URL(path, base);
    if (!from && pathIn(base, url) !== path) throw Error(`${path} is not a file beside the page`);
    const response = await fetch(url, { signal, cache: 'no-cache', credentials: 'same-origin', redirect: 'error' });
    progress?.();
    if (response.status === 404) return null;
    if (!response.ok) throw Error(`${path} could not be read (HTTP ${response.status})`);
    // A host that answers every path it does not have with its index page
    // (an app host's fallback: Netlify's, Vercel's, many nginx sites') says
    // so in the page's type. A manifest, a seed or a script answered with a
    // page is a file the site does not have.
    if (!/\.html?$/i.test(path) && /text\/html/i.test(response.headers.get('content-type') ?? '')) return null;
    const text = await response.text();
    if (text.length > MAX_FILE_BYTES) throw Error(`${path} is larger than this page may load`);
    total += text.length;
    if (total > MAX_TOTAL_BYTES) throw Error('The files this page names are larger than it may load');
    textFiles.set(path, text);
    return text;
  };

  mark('softn:bundle-fetch:start');
  const pageText = withoutRuntimeScripts(source.text ?? (await fetchText(mainPath, page)) ?? '', pageUrl, source.runtimeScripts ?? []);
  if (pageText.trim() === '') throw Error('The page is empty');
  textFiles.set(mainPath, pageText);

  // What the pages name, by the composer's own rules, each followed once.
  const pages = [mainPath];
  const logic: string[] = [];
  const xdb: string[] = [];
  const resolveFrom = (from: string, written: string): string | null => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(written)) return null; // another site's; not loaded
    try {
      return resolveBundlePath(from, written);
    } catch {
      return null;
    }
  };
  const followLogic = async (path: string | null): Promise<void> => {
    if (path === null || logic.includes(path)) return;
    const text = await fetchText(path);
    if (text === null) return; // The composer says what is missing, in its words.
    logic.push(path);
    for (const imported of logicImportPaths(text, path)) await followLogic(imported);
  };
  for (let i = 0; i < pages.length; i++) {
    const from = pages[i];
    const text = textFiles.get(from)!;
    for (const src of pageLogicSources(text)) await followLogic(resolveFrom(from, src));
    for (const href of pageStylesheetHrefs(text)) {
      const path = resolveFrom(from, href);
      if (path !== null) await fetchText(path);
    }
    for (const match of text.matchAll(new RegExp(UI_IMPORT_DECLARATION_PATTERN.source, 'g'))) {
      const path = resolveFrom(from, match[3]);
      if (path === null || pages.includes(path)) continue;
      if ((await fetchText(path)) !== null) pages.push(path);
    }
    for (const name of collectionsOf(text)) {
      const path = `xdb/${name}.xdb`;
      if (!xdb.includes(path) && (await fetchText(path)) !== null) xdb.push(path);
    }
  }
  signal.throwIfAborted();

  // A manifest the site keeps is read for what a page cannot say (its id,
  // its theme, its Python packages); the page is the app's main whatever it
  // names. A declaration of what the app may use is the site's to give.
  const declared = await fetchText('manifest.json');
  let siteManifest: Record<string, unknown> = {};
  if (declared !== null) {
    try {
      const parsed = JSON.parse(declared) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) siteManifest = parsed as Record<string, unknown>;
    } catch {
      throw Error('The manifest.json beside the page is not valid JSON');
    }
  }
  await fetchText('permission.json');

  // The logic and seed files the manifest lists, which no page names: a
  // Python app's modules (`import helpers` names a module, not a file, so a
  // page cannot be followed to it) and the helpers a JavaScript app lists
  // there. Listed first, in the manifest's order, as the composer runs them.
  const listed = async (group: 'logic' | 'xdb', found: string[]): Promise<string[]> => {
    const files = siteManifest.files as Record<string, unknown> | undefined;
    const paths = files && typeof files === 'object' && Array.isArray(files[group]) ? (files[group] as unknown[]) : [];
    const kept: string[] = [];
    for (const written of paths) {
      if (typeof written !== 'string') continue;
      // The manifest's paths are from where it is: the page's folder.
      const path = resolveFrom('manifest.json', written.replace(/^\//, ''));
      if (path !== null && !kept.includes(path) && (await fetchText(path)) !== null) kept.push(path);
    }
    return [...kept, ...found.filter((path) => !kept.includes(path))];
  };
  const title = titleOf(pageText) ?? (typeof siteManifest.name === 'string' ? siteManifest.name : undefined) ?? 'Application';
  const manifest = {
    ...siteManifest,
    name: typeof siteManifest.name === 'string' && siteManifest.name ? siteManifest.name : title,
    version: typeof siteManifest.version === 'string' && siteManifest.version ? siteManifest.version : '1.0.0',
    main: mainPath,
    files: { ui: pages, logic: await listed('logic', logic), xdb: await listed('xdb', xdb), assets: [] },
  };
  textFiles.set('manifest.json', JSON.stringify(manifest));
  mark('softn:bundle-fetch:end');

  // One site, one store: every page of it reads the same records, whatever
  // its name, and a site that names itself in its manifest keeps them under
  // that name.
  const id = typeof siteManifest.id === 'string' && siteManifest.id ? siteManifest.id : 'site';
  const hash = await digest(new TextEncoder().encode([...textFiles.entries()].map(([path, text]) => `${path}\n${text}`).join('\n\u0000')));
  const { raw: _raw, ...app } = await assembleApplication({
    textFiles,
    readManifest: () => readManifest<BundleManifest>(textFiles),
    appId: 'page:' + base.pathname + ':' + id,
    grantScope: base.href + hash,
    signal,
  });
  const config: SingleConfig = {
    version: 1,
    id,
    title,
    bundle: pageUrl,
    loadingText: 'Loading…',
    theme: 'light',
    layout: 'page',
  };
  // Each page of the site starts the app at its own address, so its links are
  // the browser's: one shown in place would have the address of another.
  const documentUrl = new URL(source.documentUrl ?? pageUrl);
  return { config, ...app, assets: siteFiles(base, documentUrl), followsLinks: false };
}
