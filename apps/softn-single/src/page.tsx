/**
 * The runtime for a page of a site: what `softn.js` loads when a site's own
 * `index.html` names it. The page is the app (see @softn/single-shell's
 * page.ts); this mounts the shell in place of what the browser was given.
 *
 * The shell is reached through import() so that the stylesheets it brings are
 * added to the page when it loads: this entry is a module a page imports, not
 * a page of the build's own, so nothing else would link them.
 */

import { adoptHeadMetas, pageHeadMetas } from '@softn/single-shell/headMetas';

/** What `softn.js` leaves for this entry: the page, and the script that loaded it. */
interface PageBoot {
  pageUrl: string;
  runtimeScripts: string[];
}

declare global {
  interface Window {
    __softnPage?: PageBoot;
  }
}

async function boot(): Promise<void> {
  // The page's viewport and colours, from the text `softn.js` turned the rest
  // of its head into, before anything is drawn: the loading screen is then
  // laid out at the phone's width too, not at a desktop's. The shell reads
  // them again from the page it fetches, which covers a page run by another
  // (`data-page`) and one whose head the browser parsed itself.
  const written = document.querySelector('plaintext');
  if (written?.textContent) adoptHeadMetas(pageHeadMetas(written.textContent));
  // The app is drawn in this document, whichever page it was written in.
  const page = { ...(window.__softnPage ?? { pageUrl: location.href, runtimeScripts: [] }), documentUrl: location.href };
  const [{ createRoot }, { registerRuntimeComponents }, shell] = await Promise.all([
    import('react-dom/client'),
    import('@softn/components/lazy'),
    import('./page-shell'),
  ]);
  registerRuntimeComponents();
  // What the browser drew of the page, or the plaintext `softn.js` turned the
  // rest of it into, is not the app: the app is drawn from the page's text.
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  document.documentElement.removeAttribute('data-softn-page-loading');
  createRoot(root).render(shell.pageApp(page));
}

void boot();

export {};
