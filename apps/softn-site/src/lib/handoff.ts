/**
 * Receiving a bundle handed over by Builder or Studio (audit SN-01), from the
 * shared bundle contract (@softn/bundle-format). The site is always the
 * `publish` destination, so these are the contract's functions with that
 * destination filled in; the IndexedDB database, store, record shape and
 * claim rules are the contract's, and a bundle staged for the runtime is
 * refused here exactly as before.
 */
import {
  describeHandoffFailure as describeFailure,
  handoffIdFrom as idFrom,
  takeBundleHandoff as take,
  type HandoffFailure,
  type HandoffResult,
} from '@softn/bundle-format/handoff';

export {
  HANDOFF_DB,
  HANDOFF_DB_VERSION,
  HANDOFF_STORE,
  HANDOFF_TTL_MS,
  HANDOFF_PARAM,
  resetHandoffClaims,
  sha256Hex,
} from '@softn/bundle-format/handoff';
export type { BundleHandoff, HandoffDestination, HandoffFailure, HandoffResult, HandoffSource } from '@softn/bundle-format/handoff';

/** Claim the hand-off `id` for the publish page: once, and only if it was staged for it. */
export function takeBundleHandoff(id: string | null, now = Date.now()): Promise<HandoffResult> {
  return take(id, 'publish', now);
}

/** Whether this page was opened for a hand-off (`?from=handoff`), and the id it names. */
export function handoffIdFrom(search = window.location.search): { opened: boolean; id: string | null } {
  return idFrom(search, 'publish');
}

export function openedForHandoff(search = window.location.search): boolean {
  return handoffIdFrom(search).opened;
}

export function describeHandoffFailure(reason: HandoffFailure): string {
  return describeFailure(reason, 'publish');
}
