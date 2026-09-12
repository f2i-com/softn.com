/**
 * Handing the project to the runtime or the publish page.
 *
 * The bundle is staged in this origin's IndexedDB under an id addressed to
 * the receiving page, and the address that claims it is handed back for
 * the person to open — by their own click on a link, which is never
 * popup-blocked and never navigates this tab unless they choose the link
 * that does. The earlier `window.open(…, 'noopener')` returned null on
 * success as well as when blocked, and the fallback that read null as
 * "blocked" navigated the editor away on every successful open.
 *
 * In development the receivers can run on other ports — other origins —
 * and share no storage; that is noticed before staging.
 */

import { handoffUrl, sameOriginTarget, stageBundleHandoff, type HandoffDestination } from '@softn/core';
import { RUNTIME_URL, SITE_URL } from './siteUrls';
import { isDesktop } from './desktop';

export type { HandoffDestination } from '@softn/core';

export interface ReadyHandoff {
  to: HandoffDestination;
  url: string;
  name: string;
}

export type HandoffOutcome = { ok: true; ready: ReadyHandoff } | { ok: false; message: string };

export function handoffBase(to: HandoffDestination): string {
  return to === 'runtime' ? RUNTIME_URL : SITE_URL;
}

export function destinationLabel(to: HandoffDestination): string {
  return to === 'runtime' ? 'the runtime' : 'the publish page';
}

/** Stage `bytes` for `to`; resolve with the address to open, or why not. Nothing here navigates. */
export async function prepareHandoff(
  to: HandoffDestination,
  bytes: Uint8Array,
  name: string,
  deps: { stage?: typeof stageBundleHandoff; sameOrigin?: (target: string) => boolean } = {},
): Promise<HandoffOutcome> {
  const base = handoffBase(to);
  if (isDesktop()) {
    return { ok: false, message: `Save your app with Export .softn, then open that file in ${destinationLabel(to)}. Your desktop files stay on this device until you choose to import or publish them.` };
  }
  if (!(deps.sameOrigin ?? sameOriginTarget)(base)) {
    const label = destinationLabel(to);
    return {
      ok: false,
      message: `${label.charAt(0).toUpperCase()}${label.slice(1)} is on another origin here (${base}), so it cannot see what this page stages. Export the bundle and open the file there instead.`,
    };
  }
  const staged = await (deps.stage ?? stageBundleHandoff)(bytes, name || 'app', 'builder', to);
  if (!staged) return { ok: false, message: 'This browser could not hold the bundle for the next page. Export it and open the file there instead.' };
  return { ok: true, ready: { to, url: handoffUrl(base, to, staged.id), name: name || 'app' } };
}
