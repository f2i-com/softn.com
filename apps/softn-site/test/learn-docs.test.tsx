/**
 * The documentation section on the front door is derived from the generated
 * card data, links to the static guides with ordinary anchors the SPA router
 * leaves alone, and stays in step with the content the guides are built from.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LearnDocs } from '../src/components/LearnDocs';
import landing from '../../../docs/generated/landing.json';
import content from '../../../docs/content/softn-docs.json';
import { selectPage } from '../src/lib/router';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('renders one card per generated guide, in order, as plain links under /docs/', () => {
  act(() => root.render(<LearnDocs />));
  const cards = [...host.querySelectorAll<HTMLAnchorElement>('a.learn-card')];
  expect(cards.map((a) => a.getAttribute('href'))).toEqual(landing.cards.map((c) => c.href));
  expect(cards.map((a) => a.querySelector('.learn-title')?.textContent)).toEqual(landing.cards.map((c) => c.label));
  for (const card of cards) expect(card.getAttribute('href')).toMatch(/^\/docs\/[a-z0-9-]+\/$/);
  const cta = host.querySelector<HTMLAnchorElement>('a.cta');
  expect(cta?.getAttribute('href')).toBe('/docs/');
  expect(cta?.textContent).toContain(landing.cta.label);
  expect(host.querySelector('h2')?.textContent).toBe(landing.title);
  // The guides are pages beside the site, never routes of it: the SPA must
  // not claim them, or a click would render its not-found page instead.
  expect(selectPage('/docs/')).toEqual({ kind: 'not-found' });
});

it('is generated from the same content the guides are built from', () => {
  const byId = new Map<string, { slug: string; title: string }>(content.pages.map((p: { id: string; slug: string; title: string }) => [p.id, p]));
  expect(landing.cards).toHaveLength(content.landing.cards.length);
  for (const [i, card] of content.landing.cards.entries()) {
    const page = byId.get(card.pageId)!;
    expect(landing.cards[i].href).toBe(`${content.site.basePath}${page.slug}/`);
    expect(landing.cards[i].label).toBe(card.label);
  }
});
