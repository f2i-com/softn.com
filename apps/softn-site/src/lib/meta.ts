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

export const HOME_TITLE = 'SoftN — build apps you can run, edit and share';

export const HOME_DESCRIPTION =
  'Build apps you can run, edit and share: try a real app in your browser, change it visually, in JavaScript or Python, or with AI, and publish your own. The source travels in one .softn file.';

export const HOME_IMAGE_PATH = '/og.png';
export const HOME_IMAGE_ALT = 'SoftN — a directory of sandboxed apps, and the runtime that runs them.';

export interface PageMeta {
  /** Path of the canonical URL, on the canonical origin. */
  path: string;
  title?: string;
  description: string;
  indexable: boolean;
  /** Default social card image path (reset on SPA navigation away from `/app/<slug>`). */
  image?: string;
  imageAlt?: string;
}

export function metaFor(page: Page, query?: URLSearchParams): PageMeta {
  switch (page.kind) {
    case 'home':
      return {
        path: '/',
        title: HOME_TITLE,
        description: HOME_DESCRIPTION,
        indexable: true,
        image: HOME_IMAGE_PATH,
        imageAlt: HOME_IMAGE_ALT,
      };
    case 'directory': {
      const rawCat = (query?.get('category') ?? '').trim().toLowerCase();
      const rawSub = (query?.get('subcategory') ?? '').trim().toLowerCase();
      const cat = rawCat === 'all' ? '' : rawCat;
      const sub = rawSub === 'all' ? '' : rawSub;
      const rawPage = Number.parseInt((query?.get('page') ?? '').trim(), 10);
      const pageNum = Number.isFinite(rawPage) && rawPage > 1 ? rawPage : 1;
      const hasDynamicFilter = Boolean(
        query?.get('q')?.trim()
        || query?.get('tag')?.trim()
        || query?.get('author')?.trim()
        || query?.get('cap')?.trim()
        || query?.get('hosting')?.trim()
      );
      const params = new URLSearchParams();
      if (cat) params.set('category', cat);
      if (sub) params.set('subcategory', sub);
      if (pageNum > 1) params.set('page', String(pageNum));
      const qs = params.toString();
      return {
        path: qs ? `/apps?${qs}` : '/apps',
        title: cat
          ? `${cat.charAt(0).toUpperCase()}${cat.slice(1)} Apps${pageNum > 1 ? ` — Page ${pageNum}` : ''} — SoftN`
          : `Apps Directory${pageNum > 1 ? ` — Page ${pageNum}` : ''} — SoftN`,
        description:
          'Apps people made with SoftN: games, tools and experiments that run in your browser, with their source to read and remix.',
        indexable: !hasDynamicFilter,
        image: HOME_IMAGE_PATH,
        imageAlt: HOME_IMAGE_ALT,
      };
    }
    case 'publish': {
      const isParameterized = Boolean(query?.get('remix')?.trim() || query?.get('update')?.trim());
      return {
        path: '/publish',
        title: 'Publish a SoftN App — SoftN',
        description:
          'Put a .softn app in the SoftN directory. No account: publishing gives you an edit key, and a script can publish with one request.',
        indexable: !isParameterized,
        image: HOME_IMAGE_PATH,
        imageAlt: HOME_IMAGE_ALT,
      };
    }
    case 'app':
      return {
        path: `/app/${encodeURIComponent(page.slug)}`,
        description: 'A SoftN app: run it in your browser, read its source and remix it.',
        indexable: true,
      };
    case 'not-found':
      return {
        path: '/',
        description: HOME_DESCRIPTION,
        indexable: false,
        image: HOME_IMAGE_PATH,
        imageAlt: HOME_IMAGE_ALT,
      };
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
  if (doc.head.childElementCount === 0) {
    if (doc.documentElement) delete doc.documentElement.dataset.softnCanonicalOrigin;
    return doc.location?.origin ?? '';
  }
  const declared = doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href');
  try {
    if (declared) {
      const parsed = new URL(declared).origin;
      if (doc.documentElement) doc.documentElement.dataset.softnCanonicalOrigin = parsed;
      return parsed;
    }
  } catch {
    /* a relative or broken href: fall through */
  }
  const remembered = doc.documentElement?.dataset.softnCanonicalOrigin;
  if (remembered) return remembered;
  return doc.location?.origin ?? '';
}

export function applyMeta(meta: PageMeta, doc: Document = document): void {
  const origin = canonicalOrigin(doc);
  const url = `${origin}${meta.path}`;
  // Clean up route-scoped tags left over from previous pages during SPA transitions.
  doc.head.querySelectorAll('link[rel="prev"], link[rel="next"]').forEach((el) => el.remove());
  if (!meta.path.startsWith('/app/')) {
    doc.head.querySelector('meta[name="softn:app"]')?.remove();
  }
  const ogType = doc.head.querySelector<HTMLMetaElement>('meta[property="og:type"]');
  if (ogType) ogType.content = meta.path.startsWith('/app/') ? 'article' : 'website';

  if (meta.indexable) {
    const canonical = ensure(doc, 'link[rel="canonical"]', () => {
      const link = doc.createElement('link');
      link.rel = 'canonical';
      return link;
    });
    canonical.href = url;
    metaTag(doc, 'property', 'og:url').content = url;
  } else {
    // Avoid contradictory `noindex` + cross-URL `<link rel="canonical">` signals.
    doc.head.querySelector('link[rel="canonical"]')?.remove();
    doc.head.querySelector('meta[property="og:url"]')?.remove();
  }
  if (meta.title) setTitle(meta.title, doc);
  setDescription(meta.description, doc);
  if (meta.image) setImage(meta.image, meta.imageAlt, doc);
  const robots = doc.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (meta.indexable) {
    if (robots && /noindex/i.test(robots.content)) robots.remove();
  } else {
    metaTag(doc, 'name', 'robots').content = 'noindex';
  }
}

/** Update document title together with Open Graph and Twitter card titles. */
export function setTitle(title: string, doc: Document = document): void {
  const text = title.trim();
  if (!text) return;
  doc.title = text;
  metaTag(doc, 'property', 'og:title').content = text;
  metaTag(doc, 'name', 'twitter:title').content = text;
}

/** Update Open Graph and Twitter card image tags on SPA navigation. */
export function setImage(imageUrl: string, alt?: string, doc: Document = document): void {
  const raw = imageUrl.trim();
  if (!raw) return;
  const origin = canonicalOrigin(doc);
  const abs = /^https?:\/\//i.test(raw) ? raw : `${origin}${raw.startsWith('/') ? raw : `/${raw}`}`;
  metaTag(doc, 'property', 'og:image').content = abs;
  metaTag(doc, 'name', 'twitter:image').content = abs;
  if (alt && alt.trim()) {
    metaTag(doc, 'property', 'og:image:alt').content = alt.trim();
    metaTag(doc, 'name', 'twitter:image:alt').content = alt.trim();
  }
}

/** A page with a better description than its route's — an app's own — sets it here. */
export function setDescription(description: string, doc: Document = document): void {
  const text = description.trim();
  if (!text) return;
  metaTag(doc, 'name', 'description').content = text;
  metaTag(doc, 'property', 'og:description').content = text;
  metaTag(doc, 'name', 'twitter:description').content = text;
}
