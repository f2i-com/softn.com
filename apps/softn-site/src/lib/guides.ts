/**
 * Guides the site's own pages point at. They are static pages beside the site (generated from
 * docs/content/softn-docs.json); test/guide-links.test.ts holds every one to a page the docs build has.
 */

/** What carries across from an HTML page, what SoftN adds, and what does not run as it would in a browser tab. */
export const HTML_GUIDE_HREF = '/docs/html-and-softn/';

/** What is inside a .softn file. */
export const FORMAT_GUIDE_HREF = '/docs/softn-app-format/';

/** Publishing to the directory, by hand or with one request. */
export const PUBLISHING_GUIDE_HREF = '/docs/publishing/';

/** Hosting an app with accounts, a shared database and server code. */
export const FORMLOGIC_GUIDE_HREF = '/docs/formlogic/';

/** Where an app's data is kept. */
export const DATA_GUIDE_HREF = '/docs/offline-local-data/';

/** What an app may use, and how it asks. */
export const PERMISSIONS_GUIDE_HREF = '/docs/permissions/';

/** An AI agent building an app on a FormLogic site and preparing it for the directory, with the person approving. */
export const AI_PUBLISHING_GUIDE_HREF = '/docs/ai-publishing/';
