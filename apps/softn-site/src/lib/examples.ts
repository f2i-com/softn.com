import { BUILDER_HREF, STUDIO_HREF, WEB_HREF } from './appUrls';

/** The example the front page teaches with: a real app, shipped with the site, that runs without an account or AI. */
export const FIELDNOTES_BUNDLE = '/examples/Fieldnotes.softn';

export function exampleLinks(bundle: string, back: string) {
  const query = `?open=${encodeURIComponent(bundle)}`;
  return {
    runtime: `${WEB_HREF}${query}&back=${encodeURIComponent(back)}`,
    builder: `${BUILDER_HREF}${query}&view=preview`,
    studio: `${STUDIO_HREF}${query}`,
  };
}

/** Fieldnotes in the runtime, with the way back to where the visitor came from. */
export function fieldnotesInRuntime(back: string): string {
  return exampleLinks(FIELDNOTES_BUNDLE, back).runtime;
}

/** Fieldnotes opened in Builder on its running preview, with Design, Code and Export (to publish) one click away. */
export const FIELDNOTES_STARTER = exampleLinks(FIELDNOTES_BUNDLE, '/#try-it').builder;
