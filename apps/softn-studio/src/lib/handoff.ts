/**
 * Handing the project to the runtime or the publish page: Studio's
 * signature on the shared hand-off (@softn/editor-shared, which explains
 * why the outcome is a link for the person to click and never a
 * `window.open`). Studio builds the bundle from its files first; a build
 * that fails is a message, not a navigation.
 */

import { prepareHandoff as prepare, destinationLabel, handoffBase as base, type HandoffDestination, type HandoffOutcome } from '@softn/editor-shared/handoff';
import type { stageBundleHandoff } from '@softn/core';
import { buildBundle } from './exportBundle';
import { RUNTIME_URL, SITE_URL } from './siteUrls';
import type { VFSFile } from '../types/studio';

export type { HandoffDestination, HandoffOutcome, ReadyHandoff } from '@softn/editor-shared/handoff';
export { destinationLabel };

const BASES = { runtime: RUNTIME_URL, site: SITE_URL };

/** The receiving page's base address for a destination. */
export function handoffBase(to: HandoffDestination): string {
  return base(to, BASES);
}

/**
 * Build the bundle and stage it for `to`. Resolves with the address to open
 * once staged, or with why it could not be. Nothing here navigates.
 */
export function prepareHandoff(
  to: HandoffDestination,
  files: Map<string, VFSFile>,
  projectName: string,
  deps: { stage?: typeof stageBundleHandoff; sameOrigin?: (target: string) => boolean; build?: typeof buildBundle } = {},
): Promise<HandoffOutcome> {
  const { build, ...rest } = deps;
  return prepare({ to, bundle: () => (build ?? buildBundle)(files), name: projectName, source: 'studio', bases: BASES, ...rest });
}
