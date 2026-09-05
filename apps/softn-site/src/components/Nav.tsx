import React from 'react';
import { ProductBar } from '@softn/brand';
import { BUILDER_HREF, REPO_URL, STUDIO_HREF, WEB_HREF } from '../lib/appUrls';
import { useRoute } from '../lib/router';

/**
 * The same bar the runtime, Studio and Builder wear, told where the site's
 * siblings live — in production they are directories of this origin; under a
 * standalone `npm run dev:site` they are ports, and appUrls knows which.
 */
export function Nav(): React.ReactElement {
  const route = useRoute();
  const current = route.path === '/' ? 'home' : route.path === '/publish' ? 'publish' : route.path.startsWith('/app') ? 'apps' : null;
  return (
    <ProductBar
      current={current}
      urls={{ home: '/', apps: '/apps', publish: '/publish', runtime: WEB_HREF, studio: STUDIO_HREF, builder: BUILDER_HREF, repo: REPO_URL }}
    />
  );
}
