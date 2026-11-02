import React from 'react';
import { ProductBar, type ProductLink } from '@softn/brand';
import { BUILDER_HREF, REPO_URL, STUDIO_HREF, WEB_HREF } from '../lib/appUrls';
import { useRoute } from '../lib/router';

/**
 * The site's own destinations: what a newcomer is looking for — apps to try, a way to make one, how it works, the
 * guides — rather than the tools' names, which they meet inside the pages (Studio, Builder and the runtime are each
 * introduced where they are the next step, and listed in the footer). The runtime, Studio and Builder wear the same
 * bar with the six products, so moving between them still feels like one product.
 */
export const SITE_LINKS: ProductLink[] = [
  { id: 'apps', label: 'Explore apps', href: '/apps' },
  { id: 'create', label: 'Create', href: '/#create' },
  { id: 'how', label: 'How it works', href: '/#how' },
  { id: 'docs', label: 'Docs', href: '/docs/' },
];

/**
 * The same bar the runtime, Studio and Builder wear, told where the site's
 * siblings live — in production they are directories of this origin; under a
 * standalone `npm run dev:site` they are ports, and appUrls knows which.
 */
export function Nav(): React.ReactElement {
  const route = useRoute();
  const current = route.path === '/' ? 'home' : route.path.startsWith('/app') ? 'apps' : null;
  return (
    <ProductBar
      current={current}
      sticky
      links={SITE_LINKS}
      urls={{ home: '/', apps: '/apps', publish: '/publish', runtime: WEB_HREF, studio: STUDIO_HREF, builder: BUILDER_HREF, repo: REPO_URL }}
    />
  );
}
