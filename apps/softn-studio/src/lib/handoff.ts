/**
 * Handing the project to the runtime or the publish page.
 *
 * Both are pages of this origin in a deployment. The bundle is staged in
 * this origin's IndexedDB under an id addressed to that page, and the page
 * is opened with the id in its address. The opening is the person's own
 * click on a link, after the staging has finished — not a `window.open`
 * from inside an async handler. A `noopener` open returns null whether it
 * succeeded or was blocked, so the earlier "if it returned null, navigate
 * this tab instead" fallback sent the editor away on every successful
 * open, leaving two receiver pages and no Studio. A link the person clicks
 * is never popup-blocked, carries `rel="noopener"` so the receiver has no
 * handle on the editor, and says where it goes.
 *
 * In development the receivers can run on other ports — other origins —
 * and share no storage. That is noticed here, before staging, so the
 * answer is "export the file" rather than a receiver that finds nothing.
 */

import { handoffUrl, sameOriginTarget, stageBundleHandoff, type HandoffDestination } from '@softn/core';
import { buildBundle } from './exportBundle';
import { RUNTIME_URL, SITE_URL } from './siteUrls';
import type { VFSFile } from '../types/studio';

export type { HandoffDestination } from '@softn/core';

/** A staged bundle, ready for its receiver, and the address that claims it. */
export interface ReadyHandoff {
  to: HandoffDestination;
  url: string;
  name: string;
  stagedAt: number;
}

export type HandoffOutcome = { ok: true; ready: ReadyHandoff } | { ok: false; message: string };

/** The receiving page's base address for a destination. */
export function handoffBase(to: HandoffDestination): string {
  return to === 'runtime' ? RUNTIME_URL : SITE_URL;
}

export function destinationLabel(to: HandoffDestination): string {
  return to === 'runtime' ? 'the runtime' : 'the publish page';
}

/**
 * Build the bundle and stage it for `to`. Resolves with the address to open
 * once staged, or with why it could not be. Nothing here navigates.
 */
export async function prepareHandoff(
  to: HandoffDestination,
  files: Map<string, VFSFile>,
  projectName: string,
  deps: { stage?: typeof stageBundleHandoff; sameOrigin?: (target: string) => boolean; build?: typeof buildBundle } = {},
): Promise<HandoffOutcome> {
  const base = handoffBase(to);
  const sameOrigin = deps.sameOrigin ?? sameOriginTarget;
  if (!sameOrigin(base)) {
    return {
      ok: false,
      message: `${capitalise(destinationLabel(to))} is on another origin here (${base}), so it cannot see what this page stages. Export the bundle and open the file there instead.`,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = (deps.build ?? buildBundle)(files);
  } catch (err) {
    return { ok: false, message: `The bundle could not be built: ${err instanceof Error ? err.message : String(err)}` };
  }
  const name = projectName || 'app';
  const staged = await (deps.stage ?? stageBundleHandoff)(bytes, name, 'studio', to);
  if (!staged) {
    return { ok: false, message: 'This browser could not hold the bundle for the next page. Export it and open the file there instead.' };
  }
  return { ok: true, ready: { to, url: handoffUrl(base, to, staged.id), name, stagedAt: Date.now() } };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
