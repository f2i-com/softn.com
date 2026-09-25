import type { Page } from './router';

/**
 * The head of the document, per page.
 *
 * index.html is one file for every route, so without this every page of the
 * site declared itself a copy of the front page: `<link rel="canonical">`
 * pointed at `https://softn.com/` from /apps, /publish and every app's page,
 * which asks a search engine to drop them in favour of `/`. The title was
 * already set per page; the canonical URL, the description and their Open
 * Graph twins now follow it, and a path the site does not have says
 * `noindex` rather than being indexed as a second copy of the 404 page.
 */

export const HOME_TITLE = 'SoftN — create, refine and run your own apps';

export const HOME_DESCRIPTION =
  'Create apps with your own AI or by hand, in JavaScript or Python, and run them in your browser. Keep the source in one .softn file and share what you make.';

export interface PageMeta {
  /** Path of the canonical URL, on the canonical origin. */
  path: string;
  description: string;
  indexable: boolean;
}

export function metaFor(page: Page): PageMeta {
  switch (page.kind) {
    case 'home':
      return { path: '/', description: HOME_DESCRIPTION, indexable: true };
    case 'directory':
      return {
        path: '/apps',
        description:
          'Apps people made with SoftN: games, tools and experiments that run in your browser, with their source to read and remix.',
        indexable: true,
      };
    case 'publish':
      return {
        path: '/publish',
        description:
          'Put a .softn app in the SoftN directory. No account: publishing gives you an edit key, and a script can publish with one request.',
        indexable: true,
      };
    case 'app':
      return {
        path: `/app/${encodeURIComponent(page.slug)}`,
        description: 'A SoftN app: run it in your browser, read its source and remix it.',
        indexable: true,
      };
    case 'not-found':
      return { path: '/', description: HOME_DESCRIPTION, indexable: false };
  }
}

function ensure<T extends HTMLElement>(doc: Document, selector: string, create: () => T): T {
  const found = doc.head.querySelector<T>(selector);
  if (found) return found;
  const element = create();
  doc.head.appendChild(element);
  return element;
}

function metaTag(doc: Document, attribute: 'name' | 'property', key: string): HTMLMetaElement {
  return ensure(doc, `meta[${attribute}="${key}"]`, () => {
    const meta = doc.createElement('meta');
    meta.setAttribute(attribute, key);
    return meta;
  });
}

/**
 * The origin canonical URLs are written on: the one index.html declares, so a
 * deployment that rewrites it keeps its own, and this page's origin if the
 * file declares none.
 */
function canonicalOrigin(doc: Document): string {
  const declared = doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href');
  try {
    if (declared) return new URL(declared).origin;
  } catch {
    /* a relative or broken href: fall through */
  }
  return doc.location?.origin ?? '';
}

export function applyMeta(meta: PageMeta, doc: Document = document): void {
  const url = `${canonicalOrigin(doc)}${meta.path}`;
  const canonical = ensure(doc, 'link[rel="canonical"]', () => {
    const link = doc.createElement('link');
    link.rel = 'canonical';
    return link;
  });
  canonical.href = url;
  metaTag(doc, 'property', 'og:url').content = url;
  setDescription(meta.description, doc);
  const robots = doc.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (meta.indexable) robots?.remove();
  else metaTag(doc, 'name', 'robots').content = 'noindex';
}

/** A page with a better description than its route's — an app's own — sets it here. */
export function setDescription(description: string, doc: Document = document): void {
  const text = description.trim();
  if (!text) return;
  metaTag(doc, 'name', 'description').content = text;
  metaTag(doc, 'property', 'og:description').content = text;
}
