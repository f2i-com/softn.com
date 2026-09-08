/**
 * The parse cache: one document per source, shared by every stage that asks.
 *
 * The first half drives the cache directly. The second mounts SoftNWithXDB —
 * the component that used to parse its source twice, once to find the data
 * block and once more inside the renderer it wraps — and counts parses: one,
 * with every further ask a hit that returns that same object, under
 * StrictMode too.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as parserModule from '../src/parser/parser';
import {
  PARSER_VERSION,
  PARSE_CACHE_ENTRIES,
  clearParseCache,
  getParseCacheStats,
  parseCached,
} from '../src/parser';
import { SoftNWithXDB } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('parseCached', () => {
  beforeEach(() => {
    clearParseCache();
  });

  it('returns the same document for the same source', () => {
    const first = parseCached('<div>{x}</div>');
    const second = parseCached('<div>{x}</div>');
    expect(second).toBe(first);
    expect(getParseCacheStats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  it('returns a different document for a different source', () => {
    const a = parseCached('<div>a</div>');
    const b = parseCached('<div>b</div>');
    expect(b).not.toBe(a);
    expect(getParseCacheStats()).toEqual({ hits: 0, misses: 2, size: 2 });
  });

  it('keeps the parse diagnostics on the shared document', () => {
    // Fault-tolerant parsing recovers and reports; the report travels with
    // the document, so the renderer logs it from a hit exactly as from a miss.
    const source = '<div><span>unclosed</div>';
    const doc = parseCached(source);
    expect(doc.diagnostics?.length ?? 0).toBeGreaterThan(0);
    expect(parseCached(source).diagnostics).toBe(doc.diagnostics);
  });

  it('holds eight documents and drops the least recently used', () => {
    const sources = Array.from({ length: PARSE_CACHE_ENTRIES + 1 }, (_, i) => `<div>${i}</div>`);
    const first = parseCached(sources[0]);
    const second = parseCached(sources[1]);
    for (const source of sources.slice(2, PARSE_CACHE_ENTRIES)) parseCached(source);
    expect(getParseCacheStats().size).toBe(PARSE_CACHE_ENTRIES);

    // Touching the oldest makes it the youngest.
    expect(parseCached(sources[0])).toBe(first);
    // So the ninth pushes out the second, not the first.
    parseCached(sources[PARSE_CACHE_ENTRIES]);
    expect(getParseCacheStats().size).toBe(PARSE_CACHE_ENTRIES);
    expect(parseCached(sources[0])).toBe(first);
    expect(parseCached(sources[1])).not.toBe(second);
  });

  it('does not cache a parse that throws', () => {
    const spy = vi.spyOn(parserModule, 'parse').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    try {
      expect(() => parseCached('<div>x</div>')).toThrow('boom');
      const doc = parseCached('<div>x</div>');
      expect(doc.type).toBe('Document');
      expect(spy).toHaveBeenCalledTimes(2);
      // The successful parse is what is kept.
      expect(parseCached('<div>x</div>')).toBe(doc);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('keys on the parser version', () => {
    const source = '<div>v</div>';
    const current = parseCached(source);
    expect(parseCached(source, PARSER_VERSION)).toBe(current);
    const bumped = parseCached(source, PARSER_VERSION + 1);
    expect(bumped).not.toBe(current);
    // The newer version replaced the entry: the old one is a miss again.
    expect(parseCached(source)).not.toBe(current);
    expect(getParseCacheStats().size).toBe(1);
  });

  it('forgets everything on clear', () => {
    const source = '<div>c</div>';
    const doc = parseCached(source);
    clearParseCache();
    expect(getParseCacheStats()).toEqual({ hits: 0, misses: 0, size: 0 });
    expect(parseCached(source)).not.toBe(doc);
  });
});

// A data block, so SoftNWithXDB has something to find, and a marker to wait
// for.
const SHARED_SOURCE = `<data>
  <collection name="notes" as="notes" />
</data>

<div><span class="up">up</span></div>`;

describe('SoftNWithXDB and the renderer it wraps', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    clearParseCache();
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  async function settle(ms = 0): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  it.each([
    { name: 'plain', strict: false },
    { name: 'under StrictMode', strict: true },
  ])('parse the source once and share the document, $name', async ({ strict }) => {
    const spy = vi.spyOn(parserModule, 'parse');
    try {
      const tree = <SoftNWithXDB source={SHARED_SOURCE} appId={`share-${strict}`} />;
      await act(async () => {
        root.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
      });
      for (let i = 0; i < 40 && !container.querySelector('.up'); i++) await settle(10);
      expect(container.querySelector('.up')).not.toBeNull();

      // One parse ran; the data-block scan, the renderer's source effect and
      // StrictMode's replayed effects were all hits...
      expect(spy).toHaveBeenCalledTimes(1);
      const stats = getParseCacheStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBeGreaterThanOrEqual(1);
      // ...on the very object that one parse produced.
      expect(parseCached(SHARED_SOURCE)).toBe(spy.mock.results[0].value);
    } finally {
      spy.mockRestore();
    }
  });
});
