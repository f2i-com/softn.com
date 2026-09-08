/**
 * One parsed document per source string.
 *
 * A source is parsed more than once on its way to the screen: SoftNWithXDB
 * parses it to find the `<data>` block, and the SoftNRenderer under it parses
 * the same string again to render it — twice on every load, and twice again
 * on every source change, including the hot-reload keystrokes that leave the
 * source as it was. The document is never written to after the parser
 * returns it (test/ast-immutability.test.tsx holds that: a deep-frozen
 * document mounts, re-renders and remounts without a TypeError), so every
 * stage can be handed the same one.
 *
 * The cache is small and keyed by content: eight entries, least recently
 * used out first, keyed by the source string itself and the parser's
 * {@link PARSER_VERSION}. Eight covers the tabs softn-web keeps mounted plus
 * a reload's worth of edits; the sources are the host's own strings, so a
 * key costs a reference, not a copy. A parse that throws stores nothing —
 * the next caller sees the same throw it would have seen without the cache.
 *
 * What is shared is the document and the diagnostics on it. VM state,
 * subscriptions and permissions are made per renderer instance from the
 * document, and nothing here changes that.
 */

import type { SoftNDocument } from './ast';
import { parse, PARSER_VERSION } from './parser';

/** How many documents are kept. */
export const PARSE_CACHE_ENTRIES = 8;

interface ParseCacheEntry {
  version: number;
  document: SoftNDocument;
}

// A Map iterates in insertion order, and re-inserting moves a key to the end,
// which is all an LRU of eight needs. The version is held on the entry rather
// than folded into the key so a lookup never builds a copy of the source.
const cache = new Map<string, ParseCacheEntry>();
let hits = 0;
let misses = 0;

/**
 * Parse `source`, or return the document a previous call parsed it into.
 *
 * The same source and version give the same object, for as long as it has
 * not been pushed out by eight newer sources. `version` defaults to the
 * parser's own and exists for tests and for a host carrying a document
 * across parser builds; any other value simply never hits.
 */
export function parseCached(source: string, version: number = PARSER_VERSION): SoftNDocument {
  const entry = cache.get(source);
  if (entry && entry.version === version) {
    hits += 1;
    cache.delete(source);
    cache.set(source, entry);
    return entry.document;
  }
  misses += 1;
  const document = parse(source);
  // An entry for this source under another version is stale, and deleting
  // first also puts the fresh one at the young end.
  cache.delete(source);
  cache.set(source, { version, document });
  while (cache.size > PARSE_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return document;
}

/** Drop every held document. For tests, and for a host that knows its sources are gone. */
export function clearParseCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/**
 * How the cache has been doing since it was last cleared: `misses` is the
 * number of parses actually run, `hits` the number saved. A mount whose stages
 * share one document shows one miss and the rest hits.
 */
export function getParseCacheStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: cache.size };
}
