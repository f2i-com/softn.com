/**
 * Handing a project to the runtime or the publish page.
 *
 * Both receivers are pages of this origin in a deployment. The bundle is
 * staged in this origin's IndexedDB under an id addressed to the receiving
 * page, and the address that claims it is handed back for the person to
 * open — by their own click on a link, which is never popup-blocked and
 * never navigates the editor unless they choose the link that does. The
 * earlier `window.open(…, 'noopener')` returned null on success as well as
 * when blocked, and the fallback that read null as "blocked" navigated the
 * editor away on every successful open.
 *
 * In development the receivers can run on other ports — other origins —
 * and share no storage; that is noticed before staging. A desktop build
 * keeps files on the device; its answer is to export, never to stage.
 */

import {
  handoffUrl,
  sameOriginTarget,
  stageBundleHandoff,
  type HandoffDestination,
  type HandoffSource,
} from '@softn/bundle-format/handoff';

export type { HandoffDestination, HandoffSource } from '@softn/bundle-format/handoff';

/** A staged bundle, ready for its receiver, and the address that claims it. */
export interface ReadyHandoff {
  to: HandoffDestination;
  url: string;
  name: string;
  stagedAt: number;
}

export type HandoffOutcome = { ok: true; ready: ReadyHandoff } | { ok: false; message: string };

/** Where the receivers are: the runtime page and the site root (the publish page is its `/publish` route). */
export interface HandoffBases {
  runtime: string;
  site: string;
}

/** The receiving page's base address for a destination. */
export function handoffBase(to: HandoffDestination, bases: HandoffBases): string {
  return to === 'runtime' ? bases.runtime : bases.site;
}

export function destinationLabel(to: HandoffDestination): string {
  return to === 'runtime' ? 'the runtime' : 'the publish page';
}

export interface PrepareHandoffOptions {
  to: HandoffDestination;
  /** The bundle bytes, or how to build them (a build failure is a message, not a throw). */
  bundle: Uint8Array | (() => Uint8Array);
  name: string;
  /** Which editor is staging, recorded with the hand-off. */
  source: HandoffSource;
  bases: HandoffBases;
  /** A desktop build keeps files on the device: export instead of staging. */
  desktop?: boolean;
  stage?: typeof stageBundleHandoff;
  sameOrigin?: (target: string) => boolean;
}

/**
 * Stage the bundle for `to`. Resolves with the address to open once staged,
 * or with why it could not be. Nothing here navigates.
 */
export async function prepareHandoff(options: PrepareHandoffOptions): Promise<HandoffOutcome> {
  const { to, bases } = options;
  const base = handoffBase(to, bases);
  if (options.desktop) {
    return {
      ok: false,
      message: `Save your app with Export .softn, then open that file in ${destinationLabel(to)}. Your desktop files stay on this device until you choose to import or publish them.`,
    };
  }
  if (!(options.sameOrigin ?? sameOriginTarget)(base)) {
    return {
      ok: false,
      message: `${capitalise(destinationLabel(to))} is on another origin here (${base}), so it cannot see what this page stages. Export the bundle and open the file there instead.`,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = typeof options.bundle === 'function' ? options.bundle() : options.bundle;
  } catch (err) {
    return { ok: false, message: `The bundle could not be built: ${err instanceof Error ? err.message : String(err)}` };
  }
  const name = options.name || 'app';
  const staged = await (options.stage ?? stageBundleHandoff)(bytes, name, options.source, to);
  if (!staged) {
    return { ok: false, message: 'This browser could not hold the bundle for the next page. Export it and open the file there instead.' };
  }
  return { ok: true, ready: { to, url: handoffUrl(base, to, staged.id), name, stagedAt: Date.now() } };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
