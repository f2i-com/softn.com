import { useEffect, useState } from 'react';
import { listApps, type AppCard as AppCardData } from '../../lib/api';
import { pickFeatured } from './AppCard';

/**
 * The featured shelf, as it was the last time the directory answered.
 *
 * Kept in this browser so that a directory outage leaves the front page with
 * something to press rather than a headline over nothing. Shown only when
 * the live request fails, and always marked with when it was seen: a
 * visitor must not mistake last week's shelf for today's.
 */
const FEATURED_MEMORY = 'softn.site.featured';

export interface RememberedFeatured {
  at: number;
  items: AppCardData[];
}

export function rememberFeatured(items: AppCardData[], now = Date.now()): void {
  try {
    localStorage.setItem(FEATURED_MEMORY, JSON.stringify({ at: now, items } satisfies RememberedFeatured));
  } catch {
    // Storage blocked or full: the live shelf is still on screen.
  }
}

/**
 * Whether a stored item is a card as the directory sends one, in everything
 * the shelf reads from it.
 *
 * The store is the origin's, not this page's: Studio, Builder, the runtime
 * and whatever runs in them can write the same key. What comes back is
 * drawn — the page address into links, the picture address into images, the
 * colour into a style — so an item is kept only when its link is this site's
 * own page for its slug (and, for a linked app, an http(s) address), its
 * picture is one the directory serves and its colour is a colour. Having a
 * `slug` used to be the whole test: an item with a `javascript:` address was
 * a card on the front page, and one with nothing else threw while drawing,
 * which left the front page blank for as long as the directory was down.
 */
function isRememberedCard(value: unknown): value is AppCardData {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === 'string';
  if (!text(a.slug) || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(a.slug)) return false;
  if (!text(a.name) || !text(a.author) || !text(a.description) || !text(a.category)) return false;
  if (typeof a.runs !== 'number' || !Number.isFinite(a.runs)) return false;
  const rating = a.rating as { average?: unknown; count?: unknown } | null | undefined;
  if (!rating || typeof rating !== 'object' || typeof rating.average !== 'number' || typeof rating.count !== 'number') return false;
  if (a.thumbnailKind !== 'image' && a.thumbnailKind !== 'icon' && a.thumbnailKind !== 'placeholder') return false;
  if (!text(a.thumbnail) || (a.thumbnailKind !== 'placeholder' && !a.thumbnail.startsWith(`/api/apps/${a.slug}/`))) return false;
  if (a.primary !== null && !(text(a.primary) && /^#[0-9a-f]{6}$/i.test(a.primary))) return false;
  const urls = a.urls as { page?: unknown } | null | undefined;
  if (!urls || typeof urls !== 'object' || urls.page !== `/app/${a.slug}`) return false;
  if (a.external !== null && a.external !== undefined) {
    const external = a.external as { url?: unknown; host?: unknown };
    if (typeof external !== 'object' || !text(external.url) || !/^https?:\/\//i.test(external.url) || !text(external.host)) return false;
  }
  return true;
}

export function recallFeatured(): RememberedFeatured | null {
  try {
    const raw = localStorage.getItem(FEATURED_MEMORY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedFeatured> | null;
    if (!parsed || typeof parsed.at !== 'number' || !Array.isArray(parsed.items)) return null;
    const items = parsed.items.filter(isRememberedCard);
    return items.length > 0 ? { at: parsed.at, items } : null;
  } catch {
    return null;
  }
}

/**
 * The featured shelf: the most-played dozen, ranked by `pickFeatured`.
 * `featured` is null until the directory has answered. With `remember`, a
 * shelf that loads is kept in this browser and, when the directory cannot
 * answer, the last one kept stands in, with `seenAt` saying when it was
 * fetched; without it a failure is an empty shelf. Nothing is asked for
 * while `enabled` is false, and the shelf already shown stays as it is.
 */
export function useFeaturedShelf({ enabled = true, remember = false }: { enabled?: boolean; remember?: boolean } = {}): {
  featured: AppCardData[] | null;
  seenAt: number | null;
} {
  const [featured, setFeatured] = useState<AppCardData[] | null>(null);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const ac = new AbortController();
    listApps({ sort: 'runs', perPage: 12 }, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        const picked = pickFeatured(r.items);
        setFeatured(picked);
        setSeenAt(null);
        if (remember && picked.length > 0) rememberFeatured(picked);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        const remembered = remember ? recallFeatured() : null;
        setFeatured(remembered ? remembered.items : []);
        setSeenAt(remembered ? remembered.at : null);
      });
    return () => ac.abort();
  }, [enabled, remember]);
  return { featured, seenAt };
}
