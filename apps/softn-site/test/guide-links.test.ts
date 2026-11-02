/**
 * Every guide the site's own pages link to (src/lib/guides.ts) is a page the docs build makes, and a link to a part
 * of one names a section that page has: the guides are generated from docs/content/softn-docs.json, so a renamed page
 * or section shows up here rather than as a dead link on the front page.
 */
import { expect, it } from 'vitest';
import * as guides from '../src/lib/guides';
import content from '../../../docs/content/softn-docs.json';

const pages = (content as { pages: Array<{ slug: string }> }).pages;

it('links only to guides and sections that exist', () => {
  const links: Array<[string, string]> = Object.entries(guides as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  expect(links.length).toBeGreaterThanOrEqual(6);
  for (const [name, href] of links) {
    const match = /^\/docs\/([a-z0-9-]+)\/(?:#([a-z0-9-]+))?$/.exec(href);
    expect(match, `${name}: ${href} is a guide's address`).not.toBeNull();
    const page = pages.find((p) => p.slug === match![1]);
    expect(page, `${name}: no guide called ${match![1]}`).toBeDefined();
    if (match![2]) expect(JSON.stringify(page), `${name}: ${match![1]} has no section ${match![2]}`).toContain(`"id":"${match![2]}"`);
  }
});
