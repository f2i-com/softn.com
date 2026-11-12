import React from 'react';
import { ProductBar } from '@softn/brand';
import { BUILDER_HREF, REPO_URL, STUDIO_HREF, WEB_HREF } from '../lib/appUrls';
import { useRoute } from '../lib/router';

/**
 * The same bar the runtime, Studio and Builder wear, with the same six products, on every page
 * of the site, told where the site's siblings live — in production they are directories of this
 * origin; under a standalone `npm run dev:site` they are ports, and appUrls knows which. Moving
 * between the site and the tools is one product either way.
 *
 * It is the only bar a page has. The front page used to put a second one under it (Explore apps,
 * Create, How it works): two of the three repeated the hero's own buttons a few lines below, and
 * on a phone the page began under three rows of links. Those places are the hero's actions now.
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
