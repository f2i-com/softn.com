import { BUILDER_HREF, WEB_HREF } from './appUrls';

/** The example the front page teaches with: a real app, shipped with the site, that runs without an account or AI. */
export const FIELDNOTES_BUNDLE = '/examples/Fieldnotes.softn';

/** Fieldnotes in the runtime, with the way back to where the visitor came from. */
export function fieldnotesInRuntime(back: string): string {
  return `${WEB_HREF}?open=${encodeURIComponent(FIELDNOTES_BUNDLE)}&back=${encodeURIComponent(back)}`;
}

/** Fieldnotes opened in Builder on its running preview, with Design, Code and Export (to publish) one click away. */
export const FIELDNOTES_STARTER = `${BUILDER_HREF}?open=${encodeURIComponent(FIELDNOTES_BUNDLE)}&view=preview`;
