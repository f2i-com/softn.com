/**
 * Handing the project to the runtime or the publish page: Builder's
 * signature on the shared hand-off (@softn/editor-shared, which explains
 * why the outcome is a link for the person to click and never a
 * `window.open`). Builder stages bytes it already has; a desktop build is
 * told to export instead, because its files stay on the device.
 */

import { prepareHandoff as prepare, destinationLabel, handoffBase as base, type HandoffDestination, type HandoffOutcome } from '@softn/editor-shared/handoff';
import type { stageBundleHandoff } from '@softn/core';
import { RUNTIME_URL, SITE_URL } from './siteUrls';
import { isDesktop } from './desktop';

export type { HandoffDestination, HandoffOutcome, ReadyHandoff } from '@softn/editor-shared/handoff';
export { destinationLabel };

const BASES = { runtime: RUNTIME_URL, site: SITE_URL };

export function handoffBase(to: HandoffDestination): string {
  return base(to, BASES);
}

/** Stage `bytes` for `to`; resolve with the address to open, or why not. Nothing here navigates. */
export function prepareHandoff(
  to: HandoffDestination,
  bytes: Uint8Array,
  name: string,
  deps: { stage?: typeof stageBundleHandoff; sameOrigin?: (target: string) => boolean } = {},
): Promise<HandoffOutcome> {
  return prepare({ to, bundle: bytes, name, source: 'builder', bases: BASES, desktop: isDesktop(), ...deps });
}
