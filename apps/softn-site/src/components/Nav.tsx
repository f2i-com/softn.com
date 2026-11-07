import React from 'react';
import { ProductBar, type ProductLink } from '@softn/brand';
import { BUILDER_HREF, REPO_URL, STUDIO_HREF, WEB_HREF } from '../lib/appUrls';
import { useRoute } from '../lib/router';

/**
 * The same bar the runtime, Studio and Builder wear, with the same six products, on every page
 * of the site, told where the site's siblings live — in production they are directories of this
 * origin; under a standalone `npm run dev:site` they are ports, and appUrls knows which. Moving
 * between the site and the tools is one product either way.
 */
export function Nav(): React.ReactElement {
  const route = useRoute();
  const current = route.path === '/' ? 'home' : route.path === '/publish' ? 'publish' : route.path.startsWith('/app') ? 'apps' : null;
  return (
    <ProductBar
      current={current}
      sticky
      urls={{ home: '/', apps: '/apps', publish: '/publish', runtime: WEB_HREF, studio: STUDIO_HREF, builder: BUILDER_HREF, repo: REPO_URL }}
    />
  );
}

/** The front page's own places, in the order the page has them. */
export const LANDING_LINKS: ProductLink[] = [
  { id: 'apps', label: 'Explore apps', href: '/apps' },
  { id: 'create', label: 'Create', href: '#create' },
  { id: 'how', label: 'How it works', href: '#how' },
];

/**
 * The front page's sub-header, under the product bar: what a newcomer is looking for on this
 * page — apps to try, a way to make one, how it works. Only the front page has it; every other
 * page has the product bar alone.
 */
export function LandingNav(): React.ReactElement {
  return (
    <nav className="landing-nav" aria-label="On this page">
      <div className="wrap landing-nav-inner">
        {LANDING_LINKS.map((link) => (
          <a key={link.id} href={link.href}>
            {link.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
